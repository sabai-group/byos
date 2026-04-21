/**
 * Scrubs supplier/buyer-identifying strings from message bodies (subject/text/html) before relay
 * so Sabai ingest does not see those names in content. The relay sends the Sabai-side contact ID
 * (numeric) rather than any form of the contact name. Relay auth uses SABAI_API_KEY over HTTPS.
 *
 * The `from` header is intentionally passed through unchanged. The sender on offers@/requests@
 * (and on forwarded WhatsApp threads) is intended to be an internal employee of the BYOS
 * customer relaying a supplier/buyer message, NOT the supplier/buyer themselves — keeping it
 * lets Sabai attribute the inbound to the human who actioned it. Any supplier/buyer identity
 * embedded inside the quoted thread body is still scrubbed via the redaction rules below.
 *
 * Kind-aware: the same pipeline is used for both "supplier" (offer lists from sellers) and
 * "buyer" (request lists from customers). The AI system prompt differs per kind; the
 * redaction label does NOT — every hit is replaced with the single generic marker
 * `[REDACTED]` because nothing downstream (Sabai ingest) keys off the distinction and a
 * shorter token saves prompt tokens on every subsequent LLM pass over the redacted body.
 * On a miss we always return a `RedactionMiss` sentinel so callers can bounce uniformly
 * (send a warning back to the sender) instead of crashing the inbound handler.
 *
 * HTML is handled by a second, PARALLEL AI call (`runAiHtmlRedaction`) that sees the
 * preprocessed HTML directly. Rationale: pass 1 only sees plaintext and emits substring
 * needles shaped like the text representation (e.g. `From: Info | Acme Distributors
 * <info@acme-distributors.example>`). That string never appears verbatim in HTML where
 * `<strong>Info | Acme Distributors</strong>&lt;<a href="mailto:…">info@…</a>&gt;` splits it
 * across tag boundaries, so the needle fails to substring-match and HTML leaks PII. Pass 2
 * therefore does its own entity identification against the HTML and emits tag-aware needles;
 * it also classifies each `<img>` as signature/logo (redact + drop the CID attachment) or
 * product/stock-list (keep). Both passes use the same model and fire concurrently, so the
 * wall-clock cost is roughly max(pass1, pass2) rather than the sum.
 */
import { execFile } from "child_process";
import path from "path";

import OpenAI from "openai";

import { config } from "./config";
import type { RelayedAttachment } from "./relay";
import type { ContactKind, ContactRecord, ContactRoster } from "./roster";

export interface ContactMatch {
  kind: ContactKind;
  contactId: string;
  canonicalName: string;
  matchedAlias?: string;
  confidence?: number;
  reasoning?: string;
}

export interface RedactedEmail {
  matched: true;
  contactMatch: ContactMatch;
  redactedFrom: string;
  redactedSubject: string;
  redactedText: string;
  redactedHtml?: string;
  /**
   * Content-IDs (bare — no `cid:` prefix, no angle brackets) of inline attachments
   * that pass 2 classified as signature/logo/contact-info images via `<img src="cid:…">`
   * in the HTML. Callers MUST filter `email.attachments` by `contentId` before relaying
   * so those images don't sneak through as standalone attachments. Always present;
   * empty when there were no HTML bodies or no inline images to drop.
   */
  droppedCids: string[];
}

export interface RedactedWhatsApp {
  matched: true;
  contactMatch: ContactMatch;
  redactedFrom: string;
  redactedText: string;
  redactedMessages: Array<Record<string, unknown>>;
}

/** Sentinel returned when we can't match a buyer/supplier so the caller can bounce
 *  (warn the sender) instead of crashing the inbound handler. */
export interface RedactionMiss {
  matched: false;
  reason: string;
}

export type EmailRedactionOutcome = RedactedEmail | RedactionMiss;
export type WhatsAppRedactionOutcome = RedactedWhatsApp | RedactionMiss;

/**
 * Single generic marker for every redacted substring. We deliberately do NOT
 * distinguish [REDACTED SUPPLIER] vs. [REDACTED BUYER] — nothing downstream
 * (Sabai ingest, offerbot parser, request LLM) keys off the distinction, and a
 * shorter token saves prompt tokens on every subsequent LLM pass over the
 * redacted body. See also redact_excel.py, which uses the same default.
 */
const REDACTION_LABEL = "[REDACTED]";

interface AiRedactionResult {
  canonicalName?: string;
  matchedAlias?: string;
  confidence?: number;
  reasoning?: string;
  redactions: string[];
}

interface AiHtmlRedactionResult {
  redactions: string[];
  imageIdsToRedact: string[];
}

const client = config.aiApiKey
  ? new OpenAI({
      apiKey: config.aiApiKey,
      baseURL: config.aiBaseUrl,
    })
  : null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerms(contact: ContactRecord): string[] {
  return Array.from(new Set([contact.canonicalName, ...contact.aliases].map((value) => value.trim()).filter(Boolean))).sort(
    (left, right) => right.length - left.length,
  );
}

/**
 * Unique-on-string with a longest-first ordering so overlapping needles replace
 * the broadest match before a narrower sub-string. Also drops empty entries and
 * the sentinel label itself so we never try to redact `[REDACTED]` into
 * `[REDACTED]` in a loop.
 */
/** @internal — exported only for byos/scripts/backfill_email_html_redaction.ts */
export function dedupeNeedles(needles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const needle of [...needles].sort((left, right) => right.length - left.length)) {
    if (!needle || needle === REDACTION_LABEL) continue;
    if (seen.has(needle)) continue;
    seen.add(needle);
    out.push(needle);
  }
  return out;
}

/** @internal — exported only for byos/scripts/backfill_email_html_redaction.ts */
export function redactText(input: string | undefined, needles: string[]): string {
  if (!input) return "";
  let output = input;
  for (const needle of dedupeNeedles(needles)) {
    if (!output.includes(needle)) continue;
    output = output.split(needle).join(REDACTION_LABEL);
  }
  return output;
}

function findHeuristicContact(roster: ContactRoster, haystacks: string[]): ContactRecord | null {
  const combined = haystacks.join("\n").toLowerCase();
  let bestMatch: { contact: ContactRecord; alias: string } | null = null;
  for (const contact of roster.contacts) {
    for (const alias of normalizeTerms(contact)) {
      if (alias && combined.includes(alias.toLowerCase())) {
        if (!bestMatch || alias.length > bestMatch.alias.length) {
          bestMatch = { contact, alias };
        }
      }
    }
  }
  return bestMatch?.contact ?? null;
}

function getContactByName(roster: ContactRoster, canonicalName?: string): ContactRecord | null {
  if (!canonicalName) return null;
  return (
    roster.contacts.find((contact) => contact.canonicalName.toLowerCase() === canonicalName.trim().toLowerCase()) ?? null
  );
}

function buildHeuristicRedactions(inputs: string[], contact: ContactRecord): string[] {
  const safeTerms = normalizeTerms(contact).filter((term) => term.length >= 4 || /\s/.test(term));
  const needles: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    for (const term of safeTerms) {
      for (const match of input.matchAll(new RegExp(escapeRegExp(term), "gi"))) {
        if (match[0]) needles.push(match[0]);
      }
    }
  }
  return dedupeNeedles(needles);
}

function isInternalEmailAddress(raw: string): boolean {
  if (config.internalEmailDomains.length === 0) return false;
  const addr = raw.toLowerCase().replace(/^mailto:/, "");
  const atIdx = addr.lastIndexOf("@");
  if (atIdx < 0) return false;
  const host = addr.slice(atIdx + 1).replace(/[^a-z0-9.-].*$/, "");
  return config.internalEmailDomains.some(
    (domain) => host === domain || host.endsWith("." + domain),
  );
}

/**
 * Defense-in-depth post-pass: once we have confirmed via AI/heuristic that a
 * message belongs to a known supplier/buyer, pattern-match on contact-details
 * that the LLM tends to miss in signature blocks — phone/fax/mobile numbers
 * (international or labeled), external email addresses, `mailto:` / `tel:`
 * hrefs, and bare URLs. These patterns are high-signal in trading-offer
 * context and unlikely to appear legitimately in offer bodies (prices carry
 * currency symbols, quantities carry units, etc.).
 *
 * Only invoked on the matched path, so we never scrub unrelated content.
 * Internal-safelisted email addresses (config.internalEmailDomains — usually
 * the BYOS customer's own corporate domain + the Sabai relay endpoint) pass
 * through unchanged so we don't redact the relaying employee's own address.
 */
/** @internal — exported only for byos/scripts/backfill_email_html_redaction.ts */
export function buildContactDetailRedactions(inputs: string[], existing: string[]): string[] {
  const alreadyRedacted = new Set(existing);
  const patterns: RegExp[] = [
    // `mailto:` hrefs (redact the whole href value so a lingering local-part
    // like `mailto:jane@[REDACTED].eu` is fully scrubbed — the domain alone
    // is already gone after the AI pass but the local-part still identifies).
    /mailto:[\w.+-]+(?:@[\w.\-\[\]]+)?/gi,
    // `tel:` hrefs — always external; no safelist exception.
    /tel:\+?[\d\s\-().\/]{5,}\d/gi,
    // Labeled phone/fax lines (international or national).
    /(?:Tel|Tel\.|Telephone|Telefon|Phone|Mob|Mob\.|Mobile|Cell|Cell\.|WhatsApp|Skype|Fax|Fax\.)\s*[:.\-]?\s*\+?[\d][\d\s\-().\/]{5,}\d/gi,
    // Bare international phone numbers (must start with +, >= 7 digits total so
    // we don't eat short codes or "+1" stray references).
    /\+\d[\d\s\-().\/]{6,}\d/g,
    // Loose external email addresses (internal-domain safelist applied below).
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
    // Bare URLs / www.* references in signatures.
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
  ];
  const needles: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) {
        const hit = match[0];
        if (!hit) continue;
        if (alreadyRedacted.has(hit)) continue;
        // Programmatic internal-domain safelist — skip emails/mailto on the
        // BYOS customer's own domain (those belong to the relaying employee
        // or the relay endpoint itself).
        if (hit.includes("@") && isInternalEmailAddress(hit)) continue;
        needles.push(hit);
      }
    }
  }
  return dedupeNeedles(needles);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeNeedleArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function parseAiRedactionResult(raw: string): AiRedactionResult | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      canonicalName: normalizeOptionalString(parsed.canonicalName),
      matchedAlias: normalizeOptionalString(parsed.matchedAlias),
      confidence: normalizeOptionalNumber(parsed.confidence),
      reasoning: normalizeOptionalString(parsed.reasoning),
      redactions: dedupeNeedles(normalizeNeedleArray(parsed.redactions)),
    };
  } catch {
    return null;
  }
}

function parseAiHtmlRedactionResult(raw: string): AiHtmlRedactionResult | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      redactions: dedupeNeedles(normalizeNeedleArray(parsed.redactions)),
      imageIdsToRedact: normalizeNeedleArray(parsed.imageIdsToRedact),
    };
  } catch {
    return null;
  }
}

function aiSystemPrompt(kind: ContactKind): string {
  const counterparty = kind === "buyer" ? "buyer" : "supplier";
  const counterpartyUpper = counterparty.toUpperCase();

  const identificationGuidance =
    kind === "buyer"
      ? // Mirrors the intuition of backend deduce_requester_name: the buyer is NOT
        // the sender (the sender is usually an internal employee relaying a
        // customer request), so look for explicit customer/client mentions.
        "You identify which buyer (the customer/client the message is about) sent or is referenced in a "
        + "message and produce exact literal redaction needles. The BUYER IS NOT THE SENDER — the sender is "
        + "usually an internal employee relaying a customer's request. Look for phrases like "
        + "'requester: ...', 'client: ...', 'customer is ...', 'for <name>', or other explicit mentions. "
      : "You identify which supplier (the seller the offer is from) is referenced in a message and "
        + "produce exact literal redaction needles. The SUPPLIER IS USUALLY NOT THE SENDER — the sender is "
        + "typically an internal employee forwarding a supplier's offer list. Look at quoted/forwarded "
        + "thread headers ('From: ...', 'Sent by ...'), email signatures, file/attachment names, and "
        + "explicit mentions in the body to identify the supplier. Do not assume the From: address of the "
        + "outermost message is the supplier. ";

  return (
    identificationGuidance
    + `canonicalName must exactly match one ${counterparty} from the roster or be null when the `
    + `${counterparty} is ambiguous or unknown — do NOT guess.\n\n`
    + "Every needle you emit will be replaced with the single generic marker `[REDACTED]` downstream, "
    + "so return only the needles themselves (literal substrings). Do NOT emit replacement strings and "
    + "do NOT wrap the needle in any marker.\n\n"
    + `REDACTION SCOPE — emit a needle for EVERY piece of ${counterparty}-identifying content you can `
    + "see, not just the company name. Downstream readers will use any of these signals to "
    + `re-identify the ${counterparty}, so all of them must be scrubbed:\n`
    + `  • Company / trade / brand names and any aliases of the ${counterparty}.\n`
    + "  • Contact-person names that appear in signatures, greetings, or 'From:' lines (first names, "
    + "    last names, initials, Mr./Ms./Dr. forms, and any 'Best regards, <name>' block).\n"
    + "  • Phone, mobile, fax, WhatsApp, and Skype numbers — in any format, with or without country "
    + "    code, whether labeled ('Tel:', 'Fax:', 'Mob:', 'T.', 'P.') or bare.\n"
    + "  • Postal / physical addresses — street + number, floor/office, city, postal code, region, "
    + "    country. Redact the full address line(s), not just the city.\n"
    + `  • Email addresses belonging to the ${counterparty} (personal, sales@…, info@…, etc.), `
    + `    including the local part, the full address, and the ${counterparty}'s email domain when it `
    + "    appears on its own.\n"
    + `  • Website URLs and social-media handles of the ${counterparty}.\n`
    + `  • Tax / VAT / registration numbers and company IDs tied to the ${counterparty}.\n`
    + "  • Logos/image references and attachment filenames that embed the company name.\n\n"
    + "Each needle must be a literal case-sensitive substring copied verbatim from the provided input. "
    + "Never use regex syntax. If a needle is short or ambiguous (e.g. a common first name), expand it "
    + "with nearby words so it uniquely targets the identifying mention and does not match unrelated "
    + "content. It is fine — and often correct — to emit many needles for a single message (one per "
    + "signature line, phone number, address line, etc.). Use an empty redactions array ONLY when the "
    + `message truly contains no ${counterparty}-identifying content.\n\n`
    + "Do NOT emit needles that target the outer sender's name or email address — that sender is the "
    + "relaying employee and must pass through unchanged.\n\n"
    + "EXAMPLE. Given a signature block like:\n"
    + "  Thank you,\n"
    + "  Best Regards,\n"
    + "  Jane Doe.\n"
    + "  Acme Beverages Ltd.\n"
    + "  12 Market Street, Office 3\n"
    + "  1010 Limassol, Cyprus\n"
    + "  Tel.: +357 25 123 456\n"
    + "  Fax: +357 25 123 457\n"
    + "  jane.doe@acme-bev.example | www.acme-bev.example\n"
    + "a correct response emits one needle per identifying line: 'Jane Doe.', "
    + "'Acme Beverages Ltd.', '12 Market Street, Office 3', '1010 Limassol, Cyprus', "
    + "'Tel.: +357 25 123 456', 'Fax: +357 25 123 457', and "
    + "'jane.doe@acme-bev.example | www.acme-bev.example'. Missing any of these is a FAILURE because the "
    + `${counterpartyUpper} can still be identified from what remains.`
  );
}

/** @internal — exported only for byos/scripts/backfill_email_html_redaction.ts */
export async function runAiRedaction(
  roster: ContactRoster,
  fields: { from: string; subject?: string; text?: string; channel: "email" | "whatsapp" },
): Promise<AiRedactionResult | null> {
  if (!client) {
    return null;
  }

  const rosterSummary = roster.contacts.map((contact) => ({
    canonicalName: contact.canonicalName,
    aliases: contact.aliases,
  }));

  const schemaName = roster.kind === "buyer" ? "buyer_redaction" : "supplier_redaction";

  const response = await client.chat.completions.create({
    model: config.aiModel,
    // temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            canonicalName: { type: ["string", "null"] },
            matchedAlias: { type: ["string", "null"] },
            confidence: { type: ["number", "null"] },
            reasoning: { type: ["string", "null"] },
            redactions: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["canonicalName", "matchedAlias", "confidence", "reasoning", "redactions"],
        },
      },
    } as any,
    messages: [
      {
        role: "system",
        content: aiSystemPrompt(roster.kind),
      },
      {
        role: "user",
        content: JSON.stringify({
          channel: fields.channel,
          kind: roster.kind,
          from: fields.from,
          subject: fields.subject ?? "",
          text: fields.text ?? "",
          roster: rosterSummary,
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return null;
  return parseAiRedactionResult(raw);
}

// =========================================================================
// Pass 2 — HTML-aware AI redaction
// =========================================================================
//
// Runs in parallel with pass 1 against the preprocessed HTML body. The model
// sees the actual markup (tags + attributes) and emits tag-aware substring
// needles that pass 1's plaintext-shaped needles can't produce — e.g. the
// `href` value of a `mailto:` anchor, or the visible anchor text of a URL
// whose href is a tracker wrapper. It also classifies each tagged `<img>` as
// signature/logo (redact + drop any cid: attachment) vs. product/stock-list
// (keep).

/**
 * Preprocess HTML for pass 2 + the later image-restoration step:
 *   - every `<img>` gets a stable `data-redact-id="img-N"` attribute (N grows
 *     in tag order). Any pre-existing `data-redact-id` is overwritten.
 *   - when an `<img>`'s `src` is a `data:image/…;base64,…` URI, swap the src
 *     for a tiny placeholder (`data:image/placeholder`) and stash the original
 *     in the returned side-map keyed by redact-id. Pass 2 doesn't need the
 *     base64 payload to classify — surrounding text, alt/title/class, and
 *     tag position are enough — and stripping the blob keeps the LLM payload
 *     small (empirically: 440KB → ~8KB in the 2737-2768 batch).
 *   - any bare `data:image/…;base64,…` URI appearing OUTSIDE an `<img>` tag
 *     (e.g. inline CSS `background-image: url(data:…)`) is replaced with the
 *     redaction label — those are vanishingly rare and never carry product
 *     content, so a blanket scrub is safer than trying to classify them.
 *
 * Non-`data:` srcs (URLs, `cid:…`) are left intact so pass 2 can see
 * signature-y CDN paths (`mail-sig`, `/signature/`, etc.) and cid references.
 */
export function preprocessHtmlForRedaction(html: string): {
  taggedHtml: string;
  imgSideMap: Record<string, string>;
} {
  if (!html) return { taggedHtml: "", imgSideMap: {} };
  const imgSideMap: Record<string, string> = {};
  let idx = 0;

  const tagged = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const id = `img-${idx++}`;
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const originalSrc = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "") : "";
    imgSideMap[id] = originalSrc;

    let out = tag;
    if (originalSrc.toLowerCase().startsWith("data:image") && /;base64,/i.test(originalSrc)) {
      out = out.replace(
        /\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        'src="data:image/placeholder"',
      );
    }
    if (/\bdata-redact-id\s*=/i.test(out)) {
      out = out.replace(
        /\bdata-redact-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        `data-redact-id="${id}"`,
      );
    } else {
      // Insert before the closing `>` (handles both `<img … >` and `<img … />`).
      out = out.replace(/(\s*\/?>)\s*$/, ` data-redact-id="${id}"$1`);
    }
    return out;
  });

  // Mop up stray base64 data-URIs that live outside <img> tags (inline CSS etc).
  // The `data:image/placeholder` we just inserted has no `;base64,` segment so
  // this pattern won't match it.
  const mopped = tagged.replace(
    /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
    REDACTION_LABEL,
  );

  return { taggedHtml: mopped, imgSideMap };
}

/**
 * After substring redaction has run on the tagged HTML this applies the pass-2
 * image decisions and strips every `data-redact-id` attribute so the wire
 * format stays clean:
 *   - `<img>` tags whose id is in `idsToRedact` are replaced WHOLESALE with the
 *     redaction label — no src leakage, no surviving attributes.
 *   - every other `<img>` has its original src restored from the side-map (if
 *     we had swapped in the base64 placeholder during preprocessing) and its
 *     `data-redact-id` attribute stripped.
 */
export function applyImageRedactions(
  html: string,
  imgSideMap: Record<string, string>,
  idsToRedact: Set<string>,
): string {
  return html.replace(/<img\b[^>]*?\bdata-redact-id\s*=\s*"([^"]+)"[^>]*>/gi, (tag, id: string) => {
    if (idsToRedact.has(id)) return REDACTION_LABEL;
    let out = tag;
    const originalSrc = imgSideMap[id];
    if (
      originalSrc !== undefined
      && originalSrc.toLowerCase().startsWith("data:image")
      && /;base64,/i.test(originalSrc)
    ) {
      out = out.replace(
        /\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
        () => `src="${originalSrc.replace(/"/g, "&quot;")}"`,
      );
    }
    out = out.replace(/\s*\bdata-redact-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return out;
  });
}

function htmlRedactionSystemPrompt(kind: ContactKind): string {
  const counterparty = kind === "buyer" ? "buyer" : "supplier";

  return (
    `You are given an HTML email body. Identify every piece of ${counterparty}-identifying content in `
    + "this HTML and emit literal case-sensitive HTML substrings so they can be redacted. Each substring "
    + "will be replaced downstream with the single marker `[REDACTED]` — you return only needles "
    + "(strings), never replacements.\n\n"
    + "TASK 1 — emit needles that target:\n"
    + `  • Company / brand / trade names and aliases of the ${counterparty} (match any roster entry).\n`
    + "  • Contact-person names (whether bare text or wrapped in <strong>, <b>, <span>, <td>, <a>, "
    + "    etc.).\n"
    + "  • Phone, fax, mobile, WhatsApp, and Skype numbers — any format.\n"
    + "  • Postal / physical addresses (full lines).\n"
    + "  • Email addresses — emit needles for BOTH the `href` value inside "
    + "    `<a href=\"mailto:…\">` AND the visible anchor text. If only the domain portion has already "
    + "    been scrubbed in the input, also emit the dangling local-part (e.g. `jane@`) that still "
    + "    identifies the contact.\n"
    + "  • Website URLs and social handles — emit the `href` value AND the visible anchor text "
    + "    separately (they often differ, e.g. a tracker-wrapped anchor showing `https://www.supplier.com`).\n"
    + "  • Tax / VAT / registration numbers.\n"
    + "  • `alt`, `title`, and `src` attribute values that contain identifying text.\n\n"
    + "Emit GRANULAR needles — one per distinct occurrence rather than a long compound string — so "
    + "substring matching still works in the presence of tag boundaries. For a block like:\n"
    + "  <strong>Acme Distributors</strong> &lt;<a href=\"mailto:info@acme-distributors.example\">info@acme-distributors.example</a>&gt;\n"
    + "a correct response emits SEPARATE needles: `Acme Distributors`, `<strong>Acme Distributors</strong>`, "
    + "`mailto:info@acme-distributors.example`, `info@acme-distributors.example`, and `www.acme-distributors.example` (if it "
    + "appears elsewhere). Do NOT emit one long compound match across tags.\n\n"
    + "Do NOT emit needles that match unrelated prices, quantities, SKUs, or product names. Do NOT "
    + "emit needles that target the outer sender's name or email address — that sender is the "
    + "relaying employee and must pass through unchanged. Pass 1 (operating on the plaintext) handles "
    + "the text/subject side separately; you only need to worry about the HTML.\n\n"
    + "TASK 2 — each `<img>` in the HTML has a `data-redact-id=\"img-N\"` attribute. Classify each "
    + "one and return in `imageIdsToRedact` ONLY the ids of images that are signature/logo/contact-info.\n"
    + "  SIGNALS FOR SIGNATURE / LOGO / CONTACT (redact it):\n"
    + "    • appears after a sign-off (\"Best regards\", \"Thank you\", \"Kind regards\", \"Sincerely\",\n"
    + "      \"Yours\");\n"
    + "    • sits inside a signature-like block with name / title / phone / address text nearby;\n"
    + "    • uses a signature-y path: src contains `mail-sig`, `/signature/`, `sig.png`, `/logo`,\n"
    + "      `email-signature`, or similar;\n"
    + "    • has no surrounding product context (no prices, SKUs, product names, table rows).\n"
    + "  SIGNALS FOR PRODUCT / STOCK-LIST (keep it — do NOT include the id):\n"
    + "    • appears inline with product names, prices, quantities, SKUs, bottle counts, or a\n"
    + "      pricing/stock table;\n"
    + "    • is the main body content rather than a trailing block;\n"
    + "    • the alt / title text names a product or \"price list\" / \"offer list\" / \"stock\".\n"
    + "  WHEN GENUINELY AMBIGUOUS, prefer KEEPING the image — a false positive here would hide the "
    + "actual offer content, whereas the textual redaction layer already scrubs PII around the image.\n\n"
    + "Return JSON of shape `{ redactions: string[], imageIdsToRedact: string[] }`. Use empty arrays "
    + "if there is nothing to redact."
  );
}

/** @internal — exported only for byos/scripts/backfill_email_html_redaction.ts */
export async function runAiHtmlRedaction(
  preprocessedHtml: string,
  roster: ContactRoster,
): Promise<AiHtmlRedactionResult | null> {
  if (!client || !preprocessedHtml) return null;

  const rosterSummary = roster.contacts.map((contact) => ({
    canonicalName: contact.canonicalName,
    aliases: contact.aliases,
  }));

  const response = await client.chat.completions.create({
    model: config.aiModel,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "html_redaction",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            redactions: {
              type: "array",
              items: { type: "string" },
            },
            imageIdsToRedact: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["redactions", "imageIdsToRedact"],
        },
      },
    } as any,
    messages: [
      { role: "system", content: htmlRedactionSystemPrompt(roster.kind) },
      {
        role: "user",
        content: JSON.stringify({
          kind: roster.kind,
          html: preprocessedHtml,
          roster: rosterSummary,
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return null;
  return parseAiHtmlRedactionResult(raw);
}

// =========================================================================
// Matching + orchestration
// =========================================================================

type MatchResult =
  | { matched: true; contact: ContactRecord; aiResult: AiRedactionResult | null }
  | { matched: false; reason: string };

async function matchContact(
  roster: ContactRoster,
  fields: { from: string; subject?: string; text?: string; channel: "email" | "whatsapp" },
): Promise<MatchResult> {
  const aiResult = await runAiRedaction(roster, fields).catch((error) => {
    console.warn(`AI ${roster.kind} redaction failed, falling back to heuristic matching.`, error);
    return null;
  });
  console.log(`aiResult (${roster.kind})`, aiResult);
  const aiContact = getContactByName(roster, aiResult?.canonicalName);
  if (aiContact) {
    return { matched: true, contact: aiContact, aiResult };
  }

  const heuristicContact = findHeuristicContact(roster, [fields.from, fields.subject ?? "", fields.text ?? ""]);
  if (heuristicContact) {
    return { matched: true, contact: heuristicContact, aiResult };
  }

  return { matched: false, reason: `Unable to determine ${roster.kind} from inbound message.` };
}

export async function detectAndRedactEmail(
  roster: ContactRoster,
  email: { from: string; subject?: string; text?: string; html?: string },
): Promise<EmailRedactionOutcome> {
  // Tag every <img> with a stable data-redact-id and swap base64 payloads for
  // placeholders. Sync + cheap; happens before either AI call.
  const { taggedHtml, imgSideMap } = preprocessHtmlForRedaction(email.html ?? "");

  // Fire pass 1 (text) and pass 2 (html) CONCURRENTLY. They don't depend on
  // each other — pass 1 is authoritative for contactMatch, pass 2 contributes
  // HTML-tag-aware needles and image classifications only. Running in parallel
  // keeps latency ≈ max(pass1, pass2) rather than the sum.
  const [pass1, pass2] = await Promise.all([
    matchContact(roster, {
      channel: "email",
      from: email.from,
      subject: email.subject,
      text: email.text,
    }),
    email.html
      ? runAiHtmlRedaction(taggedHtml, roster).catch((error) => {
          console.warn(
            `AI html redaction (pass 2) failed, falling back to pass-1 needles only.`,
            error,
          );
          return null;
        })
      : Promise.resolve(null),
  ]);

  if (!pass1.matched) {
    return { matched: false, reason: pass1.reason };
  }
  const { contact, aiResult } = pass1;

  const pass1Needles = aiResult?.redactions ?? [];
  const heuristicNeedles = buildHeuristicRedactions(
    [email.from, email.subject ?? "", email.text ?? "", taggedHtml],
    contact,
  );
  const pass2Needles = pass2?.redactions ?? [];
  const aggregatedNeedles = dedupeNeedles([
    ...pass1Needles,
    ...heuristicNeedles,
    ...pass2Needles,
  ]);
  // Defense-in-depth regex post-pass. Skip email.from: the outer sender
  // identifies the relaying employee and passes through unchanged.
  const detailNeedles = buildContactDetailRedactions(
    [email.subject ?? "", email.text ?? "", taggedHtml],
    aggregatedNeedles,
  );
  const allNeedles = dedupeNeedles([...aggregatedNeedles, ...detailNeedles]);

  const redactedText = redactText(email.text, allNeedles);
  const redactedSubject = redactText(email.subject, allNeedles);

  let redactedHtml: string | undefined;
  const droppedCids: string[] = [];
  if (email.html) {
    const idsToRedact = new Set(pass2?.imageIdsToRedact ?? []);
    // 1. Substring-scrub the tagged HTML using the merged needle set.
    let html = redactText(taggedHtml, allNeedles);
    // 2. Replace signature-classified <img>s wholesale; restore original src
    //    on kept images + strip the temporary data-redact-id attribute.
    html = applyImageRedactions(html, imgSideMap, idsToRedact);
    redactedHtml = html;

    // 3. Derive the list of `cid:…` content-ids to drop from attachments so
    //    the signature image doesn't sneak through as a standalone file. Only
    //    cid srcs contribute — URL-srced images aren't attachments.
    for (const id of idsToRedact) {
      const src = (imgSideMap[id] ?? "").trim();
      if (src.toLowerCase().startsWith("cid:")) {
        droppedCids.push(src.slice(4).trim());
      }
    }
  }

  return {
    matched: true,
    contactMatch: {
      kind: roster.kind,
      contactId: contact.id,
      canonicalName: contact.canonicalName,
      matchedAlias: aiResult?.matchedAlias,
      confidence: aiResult?.confidence,
      reasoning: aiResult?.reasoning,
    },
    // Pass the sender through unchanged: it identifies the employee who
    // relayed the message to BYOS, which Sabai needs for attribution. Any
    // supplier/buyer identity that also lives inside the body is already
    // scrubbed via allNeedles above.
    redactedFrom: email.from,
    redactedSubject,
    redactedText,
    redactedHtml,
    droppedCids,
  };
}

export async function detectAndRedactWhatsApp(
  roster: ContactRoster,
  payload: { from: string; text?: string; messages: Array<Record<string, unknown>> },
): Promise<WhatsAppRedactionOutcome> {
  const result = await matchContact(roster, {
    channel: "whatsapp",
    from: payload.from,
    text: payload.text,
  });
  if (!result.matched) {
    return { matched: false, reason: result.reason };
  }
  const { contact, aiResult } = result;
  const messageTexts = payload.messages.map((message) =>
    typeof message.text === "string" ? message.text : "",
  );
  const aiNeedles = aiResult?.redactions ?? [];
  const heuristicNeedles = buildHeuristicRedactions(
    [payload.from, payload.text ?? "", ...messageTexts],
    contact,
  );
  const aggregatedNeedles = dedupeNeedles([...aiNeedles, ...heuristicNeedles]);
  // Defense-in-depth regex post-pass. Skip payload.from: the per-message
  // sender passes through unchanged (same rationale as the email path).
  const detailNeedles = buildContactDetailRedactions(
    [payload.text ?? "", ...messageTexts],
    aggregatedNeedles,
  );
  const allNeedles = dedupeNeedles([...aggregatedNeedles, ...detailNeedles]);
  const redactedText = redactText(payload.text, allNeedles);
  // Per-message `from` is left intact: WhatsApp forwards rarely carry the
  // original sender's identity anyway, and when present it's the relaying
  // employee — same rationale as the email path above.
  const redactedMessages = payload.messages.map((message) => ({
    ...message,
    text: typeof message.text === "string" ? redactText(message.text, allNeedles) : message.text,
  }));
  console.log("redactedText", redactedText);
  console.log("redactedMessages", redactedMessages);

  return {
    matched: true,
    contactMatch: {
      kind: roster.kind,
      contactId: contact.id,
      canonicalName: contact.canonicalName,
      matchedAlias: aiResult?.matchedAlias,
      confidence: aiResult?.confidence,
      reasoning: aiResult?.reasoning,
    },
    redactedFrom: payload.from,
    redactedText,
    redactedMessages,
  };
}

const EXCEL_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
]);

const REDACT_EXCEL_SCRIPT = path.resolve(__dirname, "../scripts/redact_excel.py");

function isExcelAttachment(attachment: RelayedAttachment): boolean {
  return EXCEL_CONTENT_TYPES.has(attachment.contentType);
}

function redactExcelAttachment(xlsxBytes: Buffer, roster: ContactRoster): Promise<Buffer> {
  const rosterJson = JSON.stringify(
    roster.contacts.map((s) => ({ canonicalName: s.canonicalName, aliases: s.aliases })),
  );
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "python3",
      [REDACT_EXCEL_SCRIPT],
      {
        maxBuffer: 100 * 1024 * 1024,
        encoding: "buffer" as any,
        env: {
          ...process.env,
          CONTACT_ROSTER: rosterJson,
          CONTACT_KIND: roster.kind,
          // No REDACTION_LABEL override — redact_excel.py defaults to
          // "[REDACTED]", matching the generic marker used by the rest of the
          // pipeline. Left unset so a single env flip changes both sides.
        },
      },
      (error, stdout, stderr) => {
        if (stderr && (stderr as unknown as Buffer).length > 0) {
          console.log(`[redact_excel] ${(stderr as unknown as Buffer).toString("utf8").trim()}`);
        }
        if (error) {
          reject(new Error(`redact_excel.py failed: ${error.message}`));
          return;
        }
        resolve(stdout as unknown as Buffer);
      },
    );
    proc.stdin!.end(xlsxBytes);
  });
}

/**
 * Process all attachments: strip embedded images and redact contact-identifying
 * content from Excel files. Non-Excel attachments pass through unchanged.
 */
export async function redactAttachments(
  attachments: RelayedAttachment[],
  roster: ContactRoster,
): Promise<RelayedAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (!isExcelAttachment(attachment)) {
        return attachment;
      }
      try {
        const raw = Buffer.from(attachment.contentBase64, "base64");
        const cleaned = await redactExcelAttachment(raw, roster);
        console.log(`Redacted Excel attachment (${raw.length} → ${cleaned.length} bytes)`);
        return {
          contentBase64: cleaned.toString("base64"),
          contentType: attachment.contentType,
          sizeBytes: cleaned.length,
          // Preserve the inline metadata so the caller's cid-based filter can
          // still drop / identify this attachment after redaction.
          contentId: attachment.contentId,
          filename: attachment.filename,
        };
      } catch (error) {
        console.error("Failed to redact Excel attachment, relaying original:", error);
        return attachment;
      }
    }),
  );
}
