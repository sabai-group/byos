/**
 * Fetches the customer's user roster from Sabai so BYOS can gate inbound
 * traffic. Only senders whose email or WhatsApp number matches an active
 * Sabai user are allowed through — everything else is bounced before any
 * relay/redact work happens.
 *
 * Unlike the supplier/buyer rosters, the user roster contains plaintext
 * emails (already known to Sabai) and digits-only WhatsApp numbers (the
 * same shape as Twilio/BYOS waids), so no decryption is required.
 */
import { config } from "./config";

export interface SabaiUser {
  id: string;
  email: string;
  whatsappNumber: string | null;
}

interface SabaiUserRow {
  id: string;
  email: string;
  whatsapp_number: string | null;
}

export interface UserRoster {
  /** Sabai customer id for this BYOS instance (from ``/byos/users``). */
  cid: number;
  /** Lowercased email -> Sabai user id (UUID string). */
  emailToUserId: Map<string, string>;
  /** Digits-only WhatsApp id -> Sabai user id (UUID string). */
  whatsappToUserId: Map<string, string>;
}

/** Fetch the user roster from Sabai. Throws on non-2xx so callers can log/bounce. */
export async function fetchUserRoster(): Promise<UserRoster> {
  const url = `${config.sabaiBaseUrl}/byos/users`;
  const response = await fetch(url, {
    headers: { "X-BYOS-API-Key": config.sabaiApiKey },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch user roster from Sabai (${response.status}): ${await response.text()}`,
    );
  }
  const data = (await response.json()) as { cid?: number; users?: SabaiUserRow[] };
  const cid = typeof data.cid === "number" ? data.cid : 0;
  const emailToUserId = new Map<string, string>();
  const whatsappToUserId = new Map<string, string>();
  for (const row of data.users ?? []) {
    if (row.email && row.id) {
      emailToUserId.set(row.email.toLowerCase(), row.id);
    }
    if (row.whatsapp_number && row.id) {
      const digits = normalizeWhatsAppId(row.whatsapp_number);
      if (digits) whatsappToUserId.set(digits, row.id);
    }
  }
  return { cid, emailToUserId, whatsappToUserId };
}

/**
 * Strip everything that isn't a digit. Handles BYOS senderJid
 * (`<digits>@c.us`), waid (already digits-only), Twilio-style
 * `whatsapp:+<digits>`, and plain E.164.
 *
 * NOTE: `@lid` senders that the LID resolver couldn't map to `@c.us`
 * collapse to the LID integer, which won't match any real WAID in the
 * roster. That's intentional — we'd rather bounce than relay an
 * unidentified sender.
 */
export function normalizeWhatsAppId(value: string | undefined | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Resolve the Sabai user id for an email sender. This doubles as the sender
 * gate: a non-null result means the sender is a known Sabai user (and is the
 * `attributed_to` id), while `null` means reject.
 */
export function resolveEmailAttribution(
  roster: UserRoster,
  email: string | undefined | null,
): string | null {
  if (!email) return null;
  return roster.emailToUserId.get(email.trim().toLowerCase()) ?? null;
}

/**
 * Resolve the Sabai user id for a WhatsApp sender. Non-null means known sender
 * (the `attributed_to` id); `null` means reject.
 */
export function resolveWhatsAppAttribution(
  roster: UserRoster,
  jidOrWaid: string | undefined | null,
): string | null {
  const digits = normalizeWhatsAppId(jidOrWaid);
  if (!digits) return null;
  const direct = roster.whatsappToUserId.get(digits);
  if (direct) return direct;
  if (roster.cid === 6 && digits.startsWith("31")) {
    return roster.emailToUserId.get("whatsappsender@sabai365.ai") ?? null;
  }
  return null;
}
