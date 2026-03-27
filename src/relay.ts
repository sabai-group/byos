/**
 * Relays redacted traffic to Sabai: SABAI_API_KEY in X-BYOS-API-Key authenticates the client (HTTPS).
 * AES-256-GCM encrypts canonical supplier names stored in Sabai's DB (see config.supplierEncryptionKey).
 * The relay payload sends the Sabai-side supplier ID directly — no encrypted name on the wire.
 */
import crypto from "crypto";

import { config } from "./config";
import type { SupplierMatch } from "./redact";

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
  supplierMatch: SupplierMatch;
}

export interface RelayedWhatsAppPayload {
  from: string;
  to?: string;
  text?: string;
  messages: Array<Record<string, unknown>>;
  attachments: RelayedAttachment[];
  metadata?: Record<string, unknown>;
  supplierMatch: SupplierMatch;
}

/** Derive a 32-byte key for AES-256-GCM. */
function deriveKey(): Buffer {
  return crypto.createHash("sha256").update(config.supplierEncryptionKey).digest();
}

/** AES-256-GCM encryption — base64(IV ‖ ciphertext ‖ authTag). */
export function encryptSupplierName(supplierName: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(supplierName, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

/** Inverse of encryptSupplierName. */
export function decryptSupplierName(encrypted: string): string {
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
function supplierMatchForRelay(match: SupplierMatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (match.confidence !== undefined) out.confidence = match.confidence;
  return out;
}

async function postRelayJson(pathname: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  console.log("disabled relaying to Sabai for debugging");
  console.log("body", body);
  // const response = await fetch(`${config.sabaiBaseUrl}${pathname}`, {
  //   method: "POST",
  //   headers: relayHeaders(),
  //   body,
  // });
  // if (!response.ok) {
  //   const text = await response.text();
  //   throw new Error(`BYOS relay failed (${response.status}): ${text}`);
  // }
}

/**
 * Maps a RelayedAttachment to the wire format for Sabai.
 * Filenames are never sent — they often contain supplier names
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
    supplier_match: supplierMatchForRelay(payload.supplierMatch),
    supplier_id: parseInt(payload.supplierMatch.supplierId, 10),
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
    supplier_match: supplierMatchForRelay(payload.supplierMatch),
    supplier_id: parseInt(payload.supplierMatch.supplierId, 10),
  });
}
