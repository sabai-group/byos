/**
 * Scrubs supplier-identifying strings from message bodies (subject/text/html) before relay so Sabai
 * ingest does not see those names in content. The relay sends the Sabai-side supplier ID (numeric)
 * rather than any form of the supplier name. Relay auth uses SABAI_API_KEY over HTTPS.
 */
import { execFile } from "child_process";
import path from "path";

import OpenAI from "openai";

import { config } from "./config";
import type { RelayedAttachment } from "./relay";
import type { SupplierRecord, SupplierRoster } from "./suppliers";

export interface SupplierMatch {
  supplierId: string;
  canonicalName: string;
  matchedAlias?: string;
  confidence?: number;
  reasoning?: string;
}

export interface RedactedEmail {
  supplierMatch: SupplierMatch;
  redactedFrom: string;
  redactedSubject: string;
  redactedText: string;
  redactedHtml?: string;
}

export interface RedactedWhatsApp {
  supplierMatch: SupplierMatch;
  redactedFrom: string;
  redactedText: string;
  redactedMessages: Array<Record<string, unknown>>;
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerms(supplier: SupplierRecord): string[] {
  return Array.from(new Set([supplier.canonicalName, ...supplier.aliases].map((value) => value.trim()).filter(Boolean))).sort(
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

function findHeuristicSupplier(roster: SupplierRoster, haystacks: string[]): SupplierRecord | null {
  const combined = haystacks.join("\n").toLowerCase();
  let bestMatch: { supplier: SupplierRecord; alias: string } | null = null;
  for (const supplier of roster.suppliers) {
    for (const alias of normalizeTerms(supplier)) {
      if (alias && combined.includes(alias.toLowerCase())) {
        if (!bestMatch || alias.length > bestMatch.alias.length) {
          bestMatch = { supplier, alias };
        }
      }
    }
  }
  return bestMatch?.supplier ?? null;
}

function getSupplierByName(roster: SupplierRoster, canonicalName?: string): SupplierRecord | null {
  if (!canonicalName) return null;
  return (
    roster.suppliers.find((supplier) => supplier.canonicalName.toLowerCase() === canonicalName.trim().toLowerCase()) ?? null
  );
}

function buildHeuristicRedactions(inputs: string[], supplier: SupplierRecord): RedactionRule[] {
  const safeTerms = normalizeTerms(supplier).filter((term) => term.length >= 4 || /\s/.test(term));
  const redactions: RedactionRule[] = [];
  for (const input of inputs) {
    for (const term of safeTerms) {
      for (const match of input.matchAll(new RegExp(escapeRegExp(term), "gi"))) {
        if (!match[0]) continue;
        redactions.push({
          needle: match[0],
          replacement: "[REDACTED SUPPLIER]",
        });
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

async function runAiRedaction(
  roster: SupplierRoster,
  fields: { from: string; subject?: string; text?: string; channel: "email" | "whatsapp" },
): Promise<AiRedactionResult | null> {
  if (!client || roster.suppliers.length === 0) {
    return null;
  }

  const rosterSummary = roster.suppliers.map((supplier) => ({
    canonicalName: supplier.canonicalName,
    aliases: supplier.aliases,
  }));

  const response = await client.chat.completions.create({
    model: config.aiModel,
    // temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "supplier_redaction",
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
        content:
          "You identify which supplier sent a message and produce exact literal redaction rules. canonicalName must exactly match one supplier from the roster or be null. Each redaction must be a literal case-sensitive substring copied verbatim from the provided input. Never use regex syntax. If the supplier name is short or ambiguous, expand the needle with nearby words so it uniquely targets the supplier mention. Each replacement must preserve the surrounding text and replace only the supplier-identifying portion with [REDACTED SUPPLIER]. Use an empty redactions array when no redaction is needed.",
      },
      {
        role: "user",
        content: JSON.stringify({
          channel: fields.channel,
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

async function matchSupplier(
  roster: SupplierRoster,
  fields: { from: string; subject?: string; text?: string; channel: "email" | "whatsapp" },
): Promise<{ supplier: SupplierRecord; aiResult: AiRedactionResult | null }> {
  const aiResult = await runAiRedaction(roster, fields).catch((error) => {
    console.warn("AI redaction failed, falling back to heuristic matching.", error);
    return null;
  });
  console.log("aiResult", aiResult);
  const aiSupplier = getSupplierByName(roster, aiResult?.canonicalName);
  if (aiSupplier) {
    return { supplier: aiSupplier, aiResult };
  }

  const heuristicSupplier = findHeuristicSupplier(roster, [fields.from, fields.subject ?? "", fields.text ?? ""]);
  if (!heuristicSupplier) {
    throw new Error("Unable to determine supplier from inbound message.");
  }
  return { supplier: heuristicSupplier, aiResult };
}

export async function detectAndRedactEmail(
  roster: SupplierRoster,
  email: { from: string; subject?: string; text?: string; html?: string },
): Promise<RedactedEmail> {
  const { supplier, aiResult } = await matchSupplier(roster, {
    channel: "email",
    from: email.from,
    subject: email.subject,
    text: email.text,
  });
  const redactions = dedupeRedactions([
    ...(aiResult?.redactions ?? []),
    ...buildHeuristicRedactions([email.from, email.subject ?? "", email.text ?? "", email.html ?? ""], supplier),
  ]);

  return {
    supplierMatch: {
      supplierId: supplier.id,
      canonicalName: supplier.canonicalName,
      matchedAlias: aiResult?.matchedAlias,
      confidence: aiResult?.confidence,
      reasoning: aiResult?.reasoning,
    },
    redactedFrom: "Supplier Redacted <redacted@byos.invalid>",
    redactedSubject: redactText(email.subject, redactions),
    redactedText: redactText(email.text, redactions),
    redactedHtml: redactText(email.html, redactions),
  };
}

export async function detectAndRedactWhatsApp(
  roster: SupplierRoster,
  payload: { from: string; text?: string; messages: Array<Record<string, unknown>> },
): Promise<RedactedWhatsApp> {
  const { supplier, aiResult } = await matchSupplier(roster, {
    channel: "whatsapp",
    from: payload.from,
    text: payload.text,
  });
  const redactions = dedupeRedactions([
    ...(aiResult?.redactions ?? []),
    ...buildHeuristicRedactions(
      [payload.from, payload.text ?? "", ...payload.messages.map((message) => (typeof message.text === "string" ? message.text : ""))],
      supplier,
    ),
  ]);
  const redactedText = redactText(payload.text, redactions);
  const redactedMessages = payload.messages.map((message) => ({
    ...message,
    // from: "whatsapp:byos-redacted", // the original from is probably not the supplier, just an employee of the client
    text: typeof message.text === "string" ? redactText(message.text, redactions) : message.text,
  }));
  console.log("redactedText", redactedText);
  console.log("redactedMessages", redactedMessages);

  return {
    supplierMatch: {
      supplierId: supplier.id,
      canonicalName: supplier.canonicalName,
      matchedAlias: aiResult?.matchedAlias,
      confidence: aiResult?.confidence,
      reasoning: aiResult?.reasoning,
    },
    redactedFrom: "whatsapp:byos-redacted",
    redactedText,
    redactedMessages,
  };
}

const EXCEL_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
]);

const STRIP_SCRIPT = path.resolve(__dirname, "../scripts/strip_excel_images.py");

function isExcelAttachment(attachment: RelayedAttachment): boolean {
  return EXCEL_CONTENT_TYPES.has(attachment.contentType);
}

function stripImagesFromExcel(xlsxBytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = execFile("python3", [STRIP_SCRIPT], { maxBuffer: 100 * 1024 * 1024, encoding: "buffer" as any }, (error, stdout) => {
      if (error) {
        reject(new Error(`strip_excel_images.py failed: ${error.message}`));
        return;
      }
      resolve(stdout as unknown as Buffer);
    });
    proc.stdin!.end(xlsxBytes);
  });
}

/**
 * Process all attachments: strip embedded images from Excel files.
 * Non-Excel attachments are passed through unchanged.
 */
export async function redactAttachments(attachments: RelayedAttachment[]): Promise<RelayedAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (!isExcelAttachment(attachment)) {
        return attachment;
      }
      try {
        const raw = Buffer.from(attachment.contentBase64, "base64");
        const cleaned = await stripImagesFromExcel(raw);
        console.log(`Stripped images from Excel attachment (${raw.length} → ${cleaned.length} bytes)`);
        return {
          contentBase64: cleaned.toString("base64"),
          contentType: attachment.contentType,
          sizeBytes: cleaned.length,
        };
      } catch (error) {
        console.error("Failed to strip images from Excel attachment, relaying original:", error);
        return attachment;
      }
    }),
  );
}
