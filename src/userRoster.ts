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
  email: string;
  whatsappNumber: string | null;
}

interface SabaiUserRow {
  email: string;
  whatsapp_number: string | null;
}

export interface UserRoster {
  emails: Set<string>;
  whatsappNumbers: Set<string>;
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
  const data = (await response.json()) as { users?: SabaiUserRow[] };
  const emails = new Set<string>();
  const whatsappNumbers = new Set<string>();
  for (const row of data.users ?? []) {
    if (row.email) emails.add(row.email.toLowerCase());
    if (row.whatsapp_number) {
      const digits = normalizeWhatsAppId(row.whatsapp_number);
      if (digits) whatsappNumbers.add(digits);
    }
  }
  return { emails, whatsappNumbers };
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

export function isKnownEmailSender(roster: UserRoster, email: string | undefined | null): boolean {
  if (!email) return false;
  return roster.emails.has(email.trim().toLowerCase());
}

export function isKnownWhatsAppSender(
  roster: UserRoster,
  jidOrWaid: string | undefined | null,
): boolean {
  const digits = normalizeWhatsAppId(jidOrWaid);
  if (!digits) return false;
  return roster.whatsappNumbers.has(digits);
}
