/**
 * Relays redacted traffic to Sabai: SABAI_API_KEY in X-BYOS-API-Key authenticates the client (HTTPS).
 * AES-256-GCM (config.contactEncryptionKey) encrypts canonical contact (supplier/buyer) names
 * stored in Sabai's DB. The relay payload sends the Sabai-side contact ID directly — no
 * encrypted name on the wire.
 */
import crypto from "crypto";

import { config } from "./config";
import type { ContactKind } from "./roster";
import type { ContactMatch } from "./redact";

export interface RelayedAttachment {
  contentBase64: string;
  contentType: string;
  sizeBytes?: number;
}

export interface RelayedEmailPayload {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments: RelayedAttachment[];
  metadata?: Record<string, unknown>;
  contactMatch: ContactMatch;
}

export interface RelayedWhatsAppPayload {
  from: string;
  to?: string;
  text?: string;
  messages: Array<Record<string, unknown>>;
  attachments: RelayedAttachment[];
  metadata?: Record<string, unknown>;
  contactMatch: ContactMatch;
}

/** Derive a 32-byte key for AES-256-GCM. */
function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(config.contactEncryptionKey).digest();
}

/** AES-256-GCM encryption — base64(IV ‖ ciphertext ‖ authTag). */
export function encryptContactName(name: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(name, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

/** Inverse of encryptContactName. */
export function decryptContactName(encrypted: string): string {
  const key = deriveKey();
  const data = Buffer.from(encrypted, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(-16);
  const ciphertext = data.subarray(12, -16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function relayHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-BYOS-API-Key": config.sabaiApiKey,
  };
}

/** Only non-identifying metadata for Sabai; names and AI reasoning stay on BYOS. */
function contactMatchForRelay(match: ContactMatch): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: match.kind };
  if (match.confidence !== undefined) out.confidence = match.confidence;
  return out;
}

function contactIdField(match: ContactMatch): { supplier_id?: number; buyer_id?: number } {
  const numericId = Number.parseInt(match.contactId, 10);
  if (!Number.isFinite(numericId)) return {};
  return match.kind === "buyer" ? { buyer_id: numericId } : { supplier_id: numericId };
}

async function postRelayJson(pathname: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  // console.log("disabled relaying to Sabai for debugging");
  // console.log("body", body);
  const response = await fetch(`${config.sabaiBaseUrl}${pathname}`, {
    method: "POST",
    headers: relayHeaders(),
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`BYOS relay failed (${response.status}): ${text}`);
  }
}

/**
 * Maps a RelayedAttachment to the wire format for Sabai.
 * Filenames are never sent — they often contain contact names
 * (e.g. "AcmeDistillers_pricelist.xlsx") which would leak identity.
 */
function attachmentForRelay(a: RelayedAttachment): Record<string, unknown> {
  return {
    content: a.contentBase64,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
  };
}

export async function relayEmail(payload: RelayedEmailPayload): Promise<void> {
  await postRelayJson("/byos/email", {
    source: "byos",
    channel: "email",
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: payload.attachments.map(attachmentForRelay),
    metadata: payload.metadata ?? {},
    contact_match: contactMatchForRelay(payload.contactMatch),
    ...contactIdField(payload.contactMatch),
  });
}

export async function relayWhatsApp(payload: RelayedWhatsAppPayload): Promise<void> {
  await postRelayJson("/byos/whatsapp", {
    source: "byos",
    channel: "whatsapp",
    from: payload.from,
    to: payload.to,
    text: payload.text,
    messages: payload.messages,
    attachments: payload.attachments.map(attachmentForRelay),
    metadata: payload.metadata ?? {},
    contact_match: contactMatchForRelay(payload.contactMatch),
    ...contactIdField(payload.contactMatch),
  });
}
