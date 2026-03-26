/**
 * Relays redacted traffic to Sabai: SABAI_API_KEY in X-BYOS-API-Key authenticates the client (HTTPS).
 * AES-256-SIV hides the canonical supplier name from Sabai (see config.supplierEncryptionKey).
 * Deterministic: same plaintext + key → same ciphertext, so Sabai can join on encrypted names.
 */
import crypto from "crypto";
import { aessiv } from "@noble/ciphers/aes.js";

import { config } from "./config";
import type { SupplierMatch } from "./redact";

export interface AttachmentManifest {
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface RelayedEmailPayload {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachmentManifests: AttachmentManifest[];
  metadata?: Record<string, unknown>;
  supplierMatch: SupplierMatch;
}

export interface RelayedWhatsAppPayload {
  from: string;
  to?: string;
  text?: string;
  messages: Array<Record<string, unknown>>;
  attachmentManifests: AttachmentManifest[];
  metadata?: Record<string, unknown>;
  supplierMatch: SupplierMatch;
}

/** Derive a 64-byte key for AES-256-SIV (two 32-byte sub-keys per RFC 5297). */
function deriveKey(): Uint8Array {
  return new Uint8Array(crypto.createHash("sha512").update(config.supplierEncryptionKey).digest());
}

/** AES-256-SIV deterministic encryption — single base64 blob (SIV tag ‖ ciphertext). No AAD. */
export function encryptSupplierName(supplierName: string): string {
  const key = deriveKey();
  const plaintext = new TextEncoder().encode(supplierName);
  const ciphertext = aessiv(key).encrypt(plaintext);
  return Buffer.from(ciphertext).toString("base64");
}

/** Inverse of encryptSupplierName. */
export function decryptSupplierName(encrypted: string): string {
  const key = deriveKey();
  const ciphertext = new Uint8Array(Buffer.from(encrypted, "base64"));
  const plaintext = aessiv(key).decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
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

export async function relayEmail(payload: RelayedEmailPayload): Promise<void> {
  await postRelayJson("/byos/email", {
    source: "byos",
    channel: "email",
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: [],
    attachment_manifests: payload.attachmentManifests.map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size_bytes: attachment.sizeBytes,
    })),
    metadata: payload.metadata ?? {},
    supplier_match: supplierMatchForRelay(payload.supplierMatch),
    encrypted_supplier_name: encryptSupplierName(payload.supplierMatch.canonicalName),
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
    attachments: [],
    attachment_manifests: payload.attachmentManifests.map((attachment) => ({
      filename: attachment.filename,
      content_type: attachment.contentType,
      size_bytes: attachment.sizeBytes,
    })),
    metadata: payload.metadata ?? {},
    supplier_match: supplierMatchForRelay(payload.supplierMatch),
    encrypted_supplier_name: encryptSupplierName(payload.supplierMatch.canonicalName),
  });
}
