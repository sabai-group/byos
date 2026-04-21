/**
 * Tests for the HTML-aware redaction pipeline (byos/src/redact.ts).
 *
 * These cover:
 *   - HTML preprocessing: <img> tagging, base64 src swap, and the side-map
 *     needed to restore original srcs after pass 2.
 *   - Image redaction: wholesale replacement of signature <img>s, restoration
 *     of product images, and cleanup of the data-redact-id attribute.
 *   - End-to-end detectAndRedactEmail: the 2899-style signature-block fixture
 *     (text + <strong> + mailto: + cid-referenced signature image), parallel
 *     execution of the two AI calls, and propagation of `droppedCids`.
 *
 * The OpenAI client is mocked at module-load time; every AI call returned is
 * deterministic via `mockCreate.mockResolvedValueOnce`. We never touch the
 * network — `SABAI_API_KEY` / `SECRET_ENCRYPTION_KEY` are set so `config` is
 * happy even though we never exercise the relay path here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pre-seed env inside vi.hoisted so these writes happen BEFORE the hoisted
// `import { ... } from "../redact"` below. Vitest hoists `vi.mock` and
// `vi.hoisted` to the top of the file; regular statements run after imports,
// which would be too late for `config.ts` (imported transitively via redact.ts
// and evaluated once at module-load time — the AI `client` is null without
// a non-empty OPENAI_API_KEY). SABAI / SECRET envs are set too so anything
// that touches `config` elsewhere doesn't fail validation.
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-openai-key";
  process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "";
  process.env.SABAI_API_KEY = process.env.SABAI_API_KEY ?? "test-sabai-key";
  process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "test-secret-key";
});

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("openai", () => {
  class MockOpenAI {
    public chat = { completions: { create: mockCreate } };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI };
});

import {
  applyImageRedactions,
  detectAndRedactEmail,
  preprocessHtmlForRedaction,
} from "../redact";
import type { ContactRoster } from "../roster";

function makeRoster(): ContactRoster {
  return {
    kind: "supplier",
    updatedAt: new Date().toISOString(),
    contacts: [
      {
        id: "42",
        canonicalName: "Acme Distributors",
        aliases: ["Acme Distributors Ltd", "Acme-Distributors"],
      },
    ],
  };
}

function aiMessage(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

beforeEach(() => {
  mockCreate.mockReset();
});

// -------------------------------------------------------------------------
// preprocessHtmlForRedaction
// -------------------------------------------------------------------------

describe("preprocessHtmlForRedaction", () => {
  it("assigns sequential data-redact-id to every <img>", () => {
    const { taggedHtml, imgSideMap } = preprocessHtmlForRedaction(
      `<p>hi</p><img src="https://ex.com/a.png"><img src="cid:sig1">`,
    );
    expect(taggedHtml).toContain('data-redact-id="img-0"');
    expect(taggedHtml).toContain('data-redact-id="img-1"');
    expect(imgSideMap["img-0"]).toBe("https://ex.com/a.png");
    expect(imgSideMap["img-1"]).toBe("cid:sig1");
  });

  it("swaps base64 data-URI srcs for a small placeholder", () => {
    const bigBase64 = "data:image/png;base64," + "A".repeat(2000);
    const { taggedHtml, imgSideMap } = preprocessHtmlForRedaction(
      `<img alt="logo" src="${bigBase64}">`,
    );
    expect(taggedHtml).not.toContain("AAAA");
    expect(taggedHtml).toContain('src="data:image/placeholder"');
    expect(imgSideMap["img-0"]).toBe(bigBase64);
  });

  it("leaves URL and cid: srcs untouched in the tagged output", () => {
    const { taggedHtml } = preprocessHtmlForRedaction(
      `<img src="https://ex.com/a.png"><img src="cid:sig1">`,
    );
    expect(taggedHtml).toContain('src="https://ex.com/a.png"');
    expect(taggedHtml).toContain('src="cid:sig1"');
  });

  it("mops up stray base64 data-URIs that live outside <img>", () => {
    const { taggedHtml } = preprocessHtmlForRedaction(
      `<div style="background-image: url(data:image/png;base64,AAAABBBB)">x</div>`,
    );
    expect(taggedHtml).not.toContain("AAAABBBB");
    expect(taggedHtml).toContain("[REDACTED]");
  });

  it("is a no-op for empty HTML", () => {
    expect(preprocessHtmlForRedaction("")).toEqual({ taggedHtml: "", imgSideMap: {} });
  });
});

// -------------------------------------------------------------------------
// applyImageRedactions
// -------------------------------------------------------------------------

describe("applyImageRedactions", () => {
  it("replaces <img> wholesale when its id is in idsToRedact", () => {
    const html = `<p>x</p><img src="cid:sig1" data-redact-id="img-0">`;
    const out = applyImageRedactions(html, { "img-0": "cid:sig1" }, new Set(["img-0"]));
    expect(out).toBe(`<p>x</p>[REDACTED]`);
  });

  it("restores original base64 src and strips data-redact-id for kept images", () => {
    const originalSrc = "data:image/png;base64,AAAABBBB";
    const html = `<img src="data:image/placeholder" alt="price-list" data-redact-id="img-0">`;
    const out = applyImageRedactions(html, { "img-0": originalSrc }, new Set());
    expect(out).toContain(`src="${originalSrc}"`);
    expect(out).not.toContain("data-redact-id");
  });

  it("leaves URL srcs unchanged and still strips data-redact-id", () => {
    const html = `<img src="https://ex.com/a.png" data-redact-id="img-0">`;
    const out = applyImageRedactions(html, { "img-0": "https://ex.com/a.png" }, new Set());
    expect(out).toContain(`src="https://ex.com/a.png"`);
    expect(out).not.toContain("data-redact-id");
  });
});

// -------------------------------------------------------------------------
// detectAndRedactEmail — integration
// -------------------------------------------------------------------------

describe("detectAndRedactEmail", () => {
  it("scrubs 2899-style signature PII from BOTH text and HTML and drops cid: signature image", async () => {
    // Pass 1 sees plaintext; pass 2 sees HTML. We hand each one a tailored
    // needle set so the merge logic is exercised.
    mockCreate.mockResolvedValueOnce(
      aiMessage({
        canonicalName: "Acme Distributors",
        matchedAlias: null,
        confidence: 0.95,
        reasoning: null,
        redactions: ["Acme Distributors", "info@acme-distributors.example", "Best regards,\nJohn Doe"],
      }),
    );
    mockCreate.mockResolvedValueOnce(
      aiMessage({
        redactions: [
          "<strong>Acme Distributors</strong>",
          'mailto:info@acme-distributors.example',
          "info@acme-distributors.example",
          "www.acme-distributors.example",
          "Acme Distributors",
        ],
        imageIdsToRedact: ["img-0"],
      }),
    );

    const text = [
      "Dear buyer,",
      "Please find our latest offer attached.",
      "Best regards,",
      "John Doe",
      "Acme Distributors",
      "Tel: +31 20 123 4567",
      "info@acme-distributors.example | www.acme-distributors.example",
    ].join("\n");

    const html = `<div>
  <p>Dear buyer,</p>
  <p>Please find our latest offer attached.</p>
  <p>Best regards,<br>John Doe</p>
  <p><strong>Acme Distributors</strong> &lt;<a href="mailto:info@acme-distributors.example">info@acme-distributors.example</a>&gt;</p>
  <p>Tel: +31 20 123 4567 | <a href="https://www.acme-distributors.example">www.acme-distributors.example</a></p>
  <img src="cid:sig-logo-1" alt="Acme Distributors logo">
</div>`;

    const result = await detectAndRedactEmail(makeRoster(), {
      from: "employee@buyer-relay.example",
      subject: "Latest offer from Acme Distributors",
      text,
      html,
    });

    expect(result.matched).toBe(true);
    if (!result.matched) return; // type guard

    // Plaintext scrub ---------------------------------------------------------
    expect(result.redactedText).not.toMatch(/Acme Distributors/);
    expect(result.redactedText).not.toMatch(/info@acme-distributors/);
    expect(result.redactedText).not.toMatch(/www\.acme-distributors/);
    expect(result.redactedText).not.toMatch(/\+31 20 123 4567/);

    // Subject scrub -----------------------------------------------------------
    expect(result.redactedSubject).not.toMatch(/Acme Distributors/);

    // HTML scrub --------------------------------------------------------------
    const outHtml = result.redactedHtml ?? "";
    expect(outHtml).not.toMatch(/Acme Distributors/);
    expect(outHtml).not.toMatch(/info@acme-distributors/);
    expect(outHtml).not.toMatch(/www\.acme-distributors/);
    expect(outHtml).not.toMatch(/mailto:[A-Za-z0-9._+-]+@premium/);
    // The <img src="cid:sig-logo-1"> should be gone entirely.
    expect(outHtml).not.toMatch(/<img[^>]*cid:sig-logo-1/);
    // data-redact-id plumbing is an internal detail — it must not leak.
    expect(outHtml).not.toMatch(/data-redact-id/);

    // CID drop ----------------------------------------------------------------
    expect(result.droppedCids).toEqual(["sig-logo-1"]);

    // Employee/sender domain passes through (not touched by regex post-pass).
    expect(result.redactedFrom).toBe("employee@buyer-relay.example");
  });

  it("keeps product images when pass 2 returns an empty imageIdsToRedact", async () => {
    mockCreate.mockResolvedValueOnce(
      aiMessage({
        canonicalName: "Acme Distributors",
        matchedAlias: null,
        confidence: 0.9,
        reasoning: null,
        redactions: ["Acme Distributors"],
      }),
    );
    mockCreate.mockResolvedValueOnce(
      aiMessage({ redactions: [], imageIdsToRedact: [] }),
    );

    // The base64 blob is intentionally long enough to prove the side-map
    // restoration round-trips the full original src rather than the
    // `data:image/placeholder` token we swap in during preprocessing.
    const base64Src = "data:image/png;base64," + "A".repeat(500);
    const html = `<p>Pricing list:</p><img src="${base64Src}" alt="price-list">`;

    const result = await detectAndRedactEmail(makeRoster(), {
      from: "employee@buyer-relay.example",
      subject: "offer",
      text: "Pricing list attached",
      html,
    });

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    const outHtml = result.redactedHtml ?? "";
    expect(outHtml).toContain(`src="${base64Src}"`);
    expect(outHtml).not.toContain("data:image/placeholder");
    expect(outHtml).not.toContain("data-redact-id");
    expect(result.droppedCids).toEqual([]);
  });

  it("only returns droppedCids for cid: srcs (not URL or base64 srcs)", async () => {
    mockCreate.mockResolvedValueOnce(
      aiMessage({
        canonicalName: "Acme Distributors",
        matchedAlias: null,
        confidence: 0.9,
        reasoning: null,
        redactions: [],
      }),
    );
    // Redact all three images; only the cid-backed one should appear in
    // droppedCids. The URL and data: srcs stay out because they aren't inline
    // attachments.
    mockCreate.mockResolvedValueOnce(
      aiMessage({ redactions: [], imageIdsToRedact: ["img-0", "img-1", "img-2"] }),
    );

    const html =
      `<img src="https://ex.com/a.png">`
      + `<img src="cid:sig42">`
      + `<img src="data:image/png;base64,${"A".repeat(100)}">`;

    const result = await detectAndRedactEmail(makeRoster(), {
      from: "employee@buyer-relay.example",
      subject: "",
      text: "",
      html,
    });

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.droppedCids).toEqual(["sig42"]);
  });

  it("runs pass 1 and pass 2 concurrently (wall-clock ≈ max, not sum)", async () => {
    // Each AI call sleeps 80ms. Serialized → ~160ms. Parallel → ~80ms. A
    // generous ceiling below (150ms) still cleanly separates the two regimes
    // without being flaky on loaded CI boxes.
    const slowly = (payload: unknown) =>
      new Promise((resolve) => setTimeout(() => resolve(aiMessage(payload)), 80));

    mockCreate.mockImplementationOnce(() =>
      slowly({
        canonicalName: "Acme Distributors",
        matchedAlias: null,
        confidence: 0.9,
        reasoning: null,
        redactions: [],
      }),
    );
    mockCreate.mockImplementationOnce(() =>
      slowly({ redactions: [], imageIdsToRedact: [] }),
    );

    const start = Date.now();
    const result = await detectAndRedactEmail(makeRoster(), {
      from: "employee@buyer-relay.example",
      subject: "",
      text: "hello from Acme Distributors",
      html: "<p>hello from <strong>Acme Distributors</strong></p>",
    });
    const elapsed = Date.now() - start;

    expect(result.matched).toBe(true);
    expect(elapsed).toBeLessThan(150);
    // Sanity check — we did invoke the AI twice.
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
