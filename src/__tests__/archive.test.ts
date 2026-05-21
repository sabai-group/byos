/**
 * Tests for byos/src/archive.ts.
 *
 * Covers:
 *   - archiveEmail: writes meta.json + decoded attachment bytes, returns monotonically
 *     increasing IDs across sequential and concurrent calls.
 *   - archiveWhatsApp: same invariants for the WhatsApp batch shape.
 *   - Pruning: after writing the 101st entry the oldest entry is removed so exactly
 *     100 remain.
 *   - openArchiveAttachment: only storedAs values listed in meta.json are served;
 *     arbitrary path strings are rejected (path-traversal guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";

// Set required env vars before any module that imports config is loaded.
vi.hoisted(() => {
  process.env.SABAI_API_KEY = process.env.SABAI_API_KEY ?? "test-sabai-key";
  process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY ?? "test-secret-key";
});

// We override config.archiveDir per test via the module mock below.
// The actual archiveDir value is patched in beforeEach.
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      // archiveDir will be replaced by each test's beforeEach via the exported ref
      archiveDir: "/tmp/byos-archive-placeholder",
    },
  };
});

// Import AFTER mocks are set up.
import { config } from "../config";
import {
  archiveEmail,
  archiveWhatsApp,
  listArchive,
  openArchiveAttachment,
  readArchiveMeta,
  type ArchiveOutcome,
  type WhatsAppBatchPayload,
} from "../archive";
import type { InboundEmail } from "../smtp";

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

const OUTCOME_RELAYED: ArchiveOutcome = {
  senderAccepted: true,
  contactMatch: { kind: "supplier", confidence: 0.95 },
};

const OUTCOME_REJECTED: ArchiveOutcome = {
  senderAccepted: false,
  rejectReason: "not registered",
};

function makeEmail(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    kind: "supplier",
    localPart: "offers",
    from: "alice@example.com",
    to: "offers@byos.local",
    subject: "Price list Q2",
    text: "Hello, please find our list attached.",
    html: "<p>Hello</p>",
    attachments: [],
    ...overrides,
  };
}

function makeWhatsAppBatch(overrides: Partial<WhatsAppBatchPayload> = {}): WhatsAppBatchPayload {
  return {
    from: "15551234567@c.us",
    to: undefined,
    text: "Here is our list",
    messages: [{ from: "15551234567@c.us", text: "Here is our list", timestamp: Date.now() }],
    attachments: [],
    metadata: { waid: "15551234567" },
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// Test setup: give each test its own temp directory
// -----------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "byos-archive-test-"));
  // Patch the singleton config object used by archive.ts at runtime.
  // (The module mock above makes config a plain object we can mutate.)
  (config as Record<string, unknown>).archiveDir = tmpDir;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function numericDirs(): Promise<number[]> {
  const entries = await readdir(tmpDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number.parseInt(e.name, 10))
    .sort((a, b) => a - b);
}

// -----------------------------------------------------------------------
// archiveEmail
// -----------------------------------------------------------------------

describe("archiveEmail", () => {
  it("writes meta.json with correct fields and returns id=1 for first entry", async () => {
    const id = await archiveEmail(makeEmail(), OUTCOME_RELAYED);
    expect(id).toBe(1);

    const meta = await readArchiveMeta(1);
    expect(meta).not.toBeNull();
    expect(meta!.channel).toBe("email");
    expect(meta!.from).toBe("alice@example.com");
    expect((meta as any).subject).toBe("Price list Q2");
    expect(meta!.outcome).toMatchObject(OUTCOME_RELAYED);
  });

  it("returns monotonically increasing IDs across sequential calls", async () => {
    const ids = await Promise.all([
      archiveEmail(makeEmail(), OUTCOME_RELAYED),
      archiveEmail(makeEmail({ from: "bob@example.com" }), OUTCOME_REJECTED),
      archiveEmail(makeEmail({ from: "carol@example.com" }), OUTCOME_RELAYED),
    ]);
    // IDs must be 1, 2, 3 in some increasing order (serialized)
    const sorted = [...ids].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    // All unique
    expect(new Set(ids).size).toBe(3);
  });

  it("decodes and writes attachment bytes to disk", async () => {
    const content = "Hello attachment";
    const contentBase64 = Buffer.from(content).toString("base64");
    const email = makeEmail({
      attachments: [
        {
          contentBase64,
          contentType: "text/plain",
          sizeBytes: content.length,
          filename: "hello.txt",
        },
      ],
    });
    const id = await archiveEmail(email, OUTCOME_RELAYED);
    const meta = await readArchiveMeta(id);
    expect(meta!.attachments).toHaveLength(1);
    const { storedAs } = meta!.attachments[0];
    const onDisk = await readFile(
      path.join(tmpDir, String(id), "attachments", storedAs),
    );
    expect(onDisk.toString("utf-8")).toBe(content);
  });

  it("sanitizes attachment filenames with unsafe characters", async () => {
    const email = makeEmail({
      attachments: [
        { contentBase64: "YQ==", contentType: "text/plain", filename: "my file (v2).txt" },
      ],
    });
    const id = await archiveEmail(email, OUTCOME_RELAYED);
    const meta = await readArchiveMeta(id);
    expect(meta!.attachments[0].storedAs).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(meta!.attachments[0].filename).toBe("my file (v2).txt");
  });

  it("disambiguates collision when two attachments would have the same safe name", async () => {
    const email = makeEmail({
      attachments: [
        { contentBase64: "YQ==", contentType: "text/plain", filename: "report.txt" },
        { contentBase64: "Yg==", contentType: "text/plain", filename: "report.txt" },
      ],
    });
    const id = await archiveEmail(email, OUTCOME_RELAYED);
    const meta = await readArchiveMeta(id);
    const names = meta!.attachments.map((a) => a.storedAs);
    expect(new Set(names).size).toBe(2);
  });
});

// -----------------------------------------------------------------------
// archiveWhatsApp
// -----------------------------------------------------------------------

describe("archiveWhatsApp", () => {
  it("writes meta.json with correct fields and returns id=1 for first entry", async () => {
    const id = await archiveWhatsApp(makeWhatsAppBatch(), OUTCOME_RELAYED);
    expect(id).toBe(1);
    const meta = await readArchiveMeta(1);
    expect(meta!.channel).toBe("whatsapp");
    expect(meta!.from).toBe("15551234567@c.us");
    expect((meta as any).messages).toHaveLength(1);
    expect(meta!.outcome).toMatchObject(OUTCOME_RELAYED);
  });

  it("IDs continue from where email IDs left off", async () => {
    const id1 = await archiveEmail(makeEmail(), OUTCOME_RELAYED);
    const id2 = await archiveWhatsApp(makeWhatsAppBatch(), OUTCOME_RELAYED);
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });
});

// -----------------------------------------------------------------------
// Pruning
// -----------------------------------------------------------------------

describe("pruning", () => {
  it("keeps exactly 100 entries after writing the 101st", async () => {
    // Write 101 entries sequentially (the chain serializes them anyway, but
    // calling them in a loop makes the test deterministic about ordering too).
    for (let i = 0; i < 101; i++) {
      await archiveEmail(makeEmail(), OUTCOME_RELAYED);
    }
    const dirs = await numericDirs();
    expect(dirs).toHaveLength(100);
    // The oldest entry (id=1) should be gone; id=2 should be the minimum.
    expect(Math.min(...dirs)).toBe(2);
    expect(Math.max(...dirs)).toBe(101);
  }, 30_000); // allow time for 101 disk writes

  it("honors a custom config.archiveKeep value", async () => {
    (config as Record<string, unknown>).archiveKeep = 5;
    try {
      for (let i = 0; i < 7; i++) {
        await archiveEmail(makeEmail(), OUTCOME_RELAYED);
      }
      const dirs = await numericDirs();
      expect(dirs).toHaveLength(5);
      expect(Math.min(...dirs)).toBe(3);
      expect(Math.max(...dirs)).toBe(7);
    } finally {
      (config as Record<string, unknown>).archiveKeep = 100;
    }
  });
});

// -----------------------------------------------------------------------
// listArchive
// -----------------------------------------------------------------------

describe("listArchive", () => {
  it("returns entries newest first", async () => {
    await archiveEmail(makeEmail(), OUTCOME_RELAYED);
    await archiveEmail(makeEmail({ from: "bob@example.com" }), OUTCOME_RELAYED);
    const items = await listArchive();
    expect(items[0].id).toBe(2);
    expect(items[1].id).toBe(1);
  });
});

// -----------------------------------------------------------------------
// openArchiveAttachment — path-traversal guard
// -----------------------------------------------------------------------

describe("openArchiveAttachment", () => {
  it("returns the stream for a known storedAs value", async () => {
    const content = "secret pricelist";
    const email = makeEmail({
      attachments: [
        {
          contentBase64: Buffer.from(content).toString("base64"),
          contentType: "text/plain",
          filename: "list.txt",
        },
      ],
    });
    const id = await archiveEmail(email, OUTCOME_RELAYED);
    const meta = await readArchiveMeta(id);
    const storedAs = meta!.attachments[0].storedAs;

    const result = await openArchiveAttachment(id, storedAs);
    expect(result).not.toBeNull();

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result!.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      result!.stream.on("end", resolve);
      result!.stream.on("error", reject);
    });
    expect(Buffer.concat(chunks).toString("utf-8")).toBe(content);
  });

  it("returns null for an unknown storedAs (path-traversal guard)", async () => {
    const id = await archiveEmail(makeEmail(), OUTCOME_RELAYED);
    const result = await openArchiveAttachment(id, "../meta.json");
    expect(result).toBeNull();
  });

  it("returns null for an unknown storedAs with no attachments at all", async () => {
    const id = await archiveEmail(makeEmail({ attachments: [] }), OUTCOME_RELAYED);
    const result = await openArchiveAttachment(id, "anything.txt");
    expect(result).toBeNull();
  });

  it("returns null for a non-existent archive id", async () => {
    const result = await openArchiveAttachment(9999, "anything.txt");
    expect(result).toBeNull();
  });
});
