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
 * "buyer" (request lists from customers). The AI system prompt and the redaction label differ
 * per kind; on a miss we always return a `RedactionMiss` sentinel so callers can bounce
 * uniformly (send a warning back to the sender) instead of crashing the inbound handler.
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

interface RedactionRule {
  needle: string;
  replacement: string;
}

interface AiRedactionResult {
  canonicalName?: string;
  matchedAlias?: string;
  confidence?: number;
  reasoning?: string;
  redactions: RedactionRule[];
}

const client = config.aiApiKey
  ? new OpenAI({
      apiKey: config.aiApiKey,
      baseURL: config.aiBaseUrl,
    })
  : null;

function redactionLabel(kind: ContactKind): string {
  return kind === "buyer" ? "[REDACTED BUYER]" : "[REDACTED SUPPLIER]";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerms(contact: ContactRecord): string[] {
  return Array.from(new Set([contact.canonicalName, ...contact.aliases].map((value) => value.trim()).filter(Boolean))).sort(
    (left, right) => right.length - left.length,
  );
}

function dedupeRedactions(redactions: RedactionRule[]): RedactionRule[] {
  const seen = new Set<string>();
  return redactions
    .filter((rule) => rule.needle && rule.replacement && rule.needle !== rule.replacement)
    .sort((left, right) => right.needle.length - left.needle.length)
    .filter((rule) => {
      const key = `${rule.needle}\u0000${rule.replacement}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function redactText(input: string | undefined, redactions: RedactionRule[]): string {
  if (!input) return "";
  let output = input;
  for (const { needle, replacement } of dedupeRedactions(redactions)) {
    if (!output.includes(needle)) continue;
    output = output.split(needle).join(replacement);
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

function buildHeuristicRedactions(inputs: string[], contact: ContactRecord, kind: ContactKind): RedactionRule[] {
  const label = redactionLabel(kind);
  const safeTerms = normalizeTerms(contact).filter((term) => term.length >= 4 || /\s/.test(term));
  const redactions: RedactionRule[] = [];
  for (const input of inputs) {
    for (const term of safeTerms) {
      for (const match of input.matchAll(new RegExp(escapeRegExp(term), "gi"))) {
        if (!match[0]) continue;
        redactions.push({
          needle: match[0],
          replacement: label,
        });
      }
    }
  }
  return dedupeRedactions(redactions);
}

/**
 * Defense-in-depth post-pass: once we have confirmed via AI/heuristic that a
 * message belongs to a known supplier/buyer, pattern-match on contact-details
 * that the LLM tends to miss in signature blocks — phone/fax/mobile numbers
 * (international or labeled) and loose email addresses. These patterns are
 * high-signal in trading-offer context and unlikely to appear legitimately in
 * offer bodies (prices carry currency symbols, quantities carry units, etc.).
 *
 * Only invoked on the matched path, so we never scrub unrelated content.
 */
function buildContactDetailRedactions(inputs: string[], kind: ContactKind, existing: RedactionRule[]): RedactionRule[] {
  const label = redactionLabel(kind);
  // If an earlier redaction already turned a region into the label, don't
  // re-match inside the label itself (avoids pointless `[REDACTED SUPPLIER]`
  // containing a `+` being re-processed).
  const alreadyRedacted = new Set(existing.map((rule) => rule.replacement));
  const patterns: RegExp[] = [
    // Labeled phone/fax lines: captures the label + number together so the
    // "Tel:" / "Fax:" prefix is also hidden (otherwise a lone "Tel:" with the
    // number masked still signals that contact-info lived here, which is fine,
    // but the label itself carries no PII so we fold it in for cleaner output).
    /(?:Tel|Tel\.|Telephone|Telefon|Phone|Mob|Mob\.|Mobile|Cell|Cell\.|WhatsApp|Skype|Fax|Fax\.)\s*[:.\-]?\s*\+?[\d][\d\s\-().\/]{5,}\d/gi,
    // Bare international phone numbers (must start with +, >= 7 digits total
    // so we don't eat short codes or "+1" stray references).
    /\+\d[\d\s\-().\/]{6,}\d/g,
    // Email addresses — supplier/buyer sig-block emails. The outer `from` is
    // handled separately and passes through unchanged; this only scrubs
    // addresses that appear in the body/subject.
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
    // Bare URLs / www.* references in signatures.
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
  ];
  const redactions: RedactionRule[] = [];
  for (const input of inputs) {
    if (!input) continue;
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) {
        const hit = match[0];
        if (!hit) continue;
        if (alreadyRedacted.has(hit)) continue;
        redactions.push({ needle: hit, replacement: label });
      }
    }
  }
  return dedupeRedactions(redactions);
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

function normalizeRedactionRule(value: unknown): RedactionRule | null {
  if (!isRecord(value)) return null;
  const needle = typeof value.needle === "string" ? value.needle : "";
  const replacement = typeof value.replacement === "string" ? value.replacement : "";
  if (!needle || !replacement || needle === replacement) {
    return null;
  }
  return { needle, replacement };
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
      redactions: dedupeRedactions(
        Array.isArray(parsed.redactions)
          ? parsed.redactions
              .map((rule) => normalizeRedactionRule(rule))
              .filter((rule): rule is RedactionRule => rule !== null)
          : [],
      ),
    };
  } catch {
    return null;
  }
}

function aiSystemPrompt(kind: ContactKind): string {
  const label = redactionLabel(kind);
  const counterparty = kind === "buyer" ? "buyer" : "supplier";
  const counterpartyUpper = counterparty.toUpperCase();

  const identificationGuidance =
    kind === "buyer"
      ? // Mirrors the intuition of backend deduce_requester_name: the buyer is NOT
        // the sender (the sender is usually an internal employee relaying a
        // customer request), so look for explicit customer/client mentions.
        "You identify which buyer (the customer/client the message is about) sent or is referenced in a "
        + "message and produce exact literal redaction rules. The BUYER IS NOT THE SENDER — the sender is "
        + "usually an internal employee relaying a customer's request. Look for phrases like "
        + "'requester: ...', 'client: ...', 'customer is ...', 'for <name>', or other explicit mentions. "
      : "You identify which supplier (the seller the offer is from) is referenced in a message and "
        + "produce exact literal redaction rules. The SUPPLIER IS USUALLY NOT THE SENDER — the sender is "
        + "typically an internal employee forwarding a supplier's offer list. Look at quoted/forwarded "
        + "thread headers ('From: ...', 'Sent by ...'), email signatures, file/attachment names, and "
        + "explicit mentions in the body to identify the supplier. Do not assume the From: address of the "
        + "outermost message is the supplier. ";

  return (
    identificationGuidance
    + `canonicalName must exactly match one ${counterparty} from the roster or be null when the `
    + `${counterparty} is ambiguous or unknown — do NOT guess.\n\n`
    + `REDACTION SCOPE — emit a redaction for EVERY piece of ${counterparty}-identifying content you `
    + "can see, not just the company name. Downstream readers will use any of these signals to "
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
    + "Each redaction must be a literal case-sensitive substring copied verbatim from the provided "
    + "input. Never use regex syntax. If a needle is short or ambiguous (e.g. a common first name), "
    + "expand it with nearby words so it uniquely targets the identifying mention and does not match "
    + "unrelated content. Each replacement must preserve the surrounding text and replace only the "
    + `${counterparty}-identifying portion with ${label}. It is fine — and often correct — to emit many `
    + "redactions for a single message (one per signature line, phone number, address line, etc.). "
    + `Use an empty redactions array ONLY when the message truly contains no ${counterparty}-identifying `
    + "content.\n\n"
    + "Do NOT emit redactions that target the outer sender's name or email address — that sender is "
    + "the relaying employee and must pass through unchanged.\n\n"
    + "EXAMPLE. Given a signature block like:\n"
    + "  Thank you,\n"
    + "  Best Regards,\n"
    + "  Jane Doe.\n"
    + "  Acme Beverages Ltd.\n"
    + "  12 Market Street, Office 3\n"
    + "  1010 Limassol, Cyprus\n"
    + "  Tel.: +357 25 123 456\n"
    + "  Fax: +357 25 123 457\n"
    + "  jane.doe@acme-bev.com | www.acme-bev.com\n"
    + `a correct response emits one redaction per identifying line: 'Jane Doe.' → ${label}, `
    + `'Acme Beverages Ltd.' → ${label}, '12 Market Street, Office 3' → ${label}, '1010 Limassol, Cyprus' → ${label}, `
    + `'Tel.: +357 25 123 456' → ${label}, 'Fax: +357 25 123 457' → ${label}, `
    + `'jane.doe@acme-bev.com | www.acme-bev.com' → ${label}. Missing any of these is a FAILURE because `
    + `the ${counterpartyUpper} can still be identified from what remains.`
  );
}

async function runAiRedaction(
  roster: ContactRoster,
  fields: { from: string; subject?: string; text?: string; channel: "email" | "whatsapp" },
): Promise<AiRedactionResult | null> {
  if (!client || roster.contacts.length === 0) {
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
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  needle: { type: "string" },
                  replacement: { type: "string" },
                },
                required: ["needle", "replacement"],
              },
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
  const result = await matchContact(roster, {
    channel: "email",
    from: email.from,
    subject: email.subject,
    text: email.text,
  });
  if (!result.matched) {
    return { matched: false, reason: result.reason };
  }
  const { contact, aiResult } = result;
  const baseInputs = [email.subject ?? "", email.text ?? "", email.html ?? ""];
  const aiRedactions = aiResult?.redactions ?? [];
  const heuristicRedactions = buildHeuristicRedactions(
    [email.from, ...baseInputs],
    contact,
    roster.kind,
  );
  // const detailRedactions = buildContactDetailRedactions(
  //   // Deliberately skip `email.from`: the outer sender passes through unchanged.
  //   baseInputs,
  //   roster.kind,
  //   [...aiRedactions, ...heuristicRedactions],
  // );
  // const redactions = dedupeRedactions([...aiRedactions, ...heuristicRedactions, ...detailRedactions]);
  const redactions = [...aiRedactions, ...heuristicRedactions];

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
    // Pass the sender through unchanged: it identifies the employee who relayed
    // the message to BYOS, which Sabai needs for attribution. Supplier/buyer
    // identity that may also live inside the body is still scrubbed below.
    redactedFrom: email.from,
    redactedSubject: redactText(email.subject, redactions),
    redactedText: redactText(email.text, redactions),
    redactedHtml: redactText(email.html, redactions),
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
  const aiRedactions = aiResult?.redactions ?? [];
  const heuristicRedactions = buildHeuristicRedactions(
    [payload.from, payload.text ?? "", ...messageTexts],
    contact,
    roster.kind,
  );
  // const detailRedactions = buildContactDetailRedactions(
  //   // Skip `payload.from`: per-message sender passes through unchanged.
  //   [payload.text ?? "", ...messageTexts],
  //   roster.kind,
  //   [...aiRedactions, ...heuristicRedactions],
  // );
  // const redactions = dedupeRedactions([...aiRedactions, ...heuristicRedactions, ...detailRedactions]);
  const redactions = [...aiRedactions, ...heuristicRedactions];
  const redactedText = redactText(payload.text, redactions);
  // Per-message `from` is left intact: WhatsApp forwards rarely carry the
  // original sender's identity anyway, and when present it's the relaying
  // employee — same rationale as the email path above.
  const redactedMessages = payload.messages.map((message) => ({
    ...message,
    text: typeof message.text === "string" ? redactText(message.text, redactions) : message.text,
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
          REDACTION_LABEL: redactionLabel(roster.kind),
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
        };
      } catch (error) {
        console.error("Failed to redact Excel attachment, relaying original:", error);
        return attachment;
      }
    }),
  );
}
