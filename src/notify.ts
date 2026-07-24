/**
 * Thin clients for Sabai's /byos/notify-* endpoints.
 *
 * Email delivery always goes through the backend (SendGrid lives there).
 * WhatsApp sender warnings are delivered by BYOS itself via the already-
 * authenticated whatsapp-web.js client (no phone-number resolution required).
 */
import { config } from "./config";
import type { ContactKind } from "./roster";

export interface SenderBounceEmailRequest {
  senderEmail: string;
  kind: ContactKind;
  reason: string;
  /**
   * BYOS archive ID for the offending inbound, if it was archived locally.
   * When set, Sabai's bounce email links the customer straight to
   * `${byos_portal_url}/archive/${archiveId}` so they can review the original
   * message and add the missing contact in one click. Omitted when archiving
   * failed or hasn't run yet (e.g. transient disk error).
   */
  archiveId?: number;
}

/**
 * Best-effort; any failure is logged but does NOT block the SMTP response.
 *
 * Deliberately does NOT forward the original email subject (or any other
 * inbound-message content). The whole point of BYOS is that Sabai never sees
 * sender-side text that may contain unredacted contact identifiers, and the
 * unmatched-contact path is exactly the case where redaction couldn't run.
 * `reason` is a fixed BYOS-generated string and is safe to send verbatim.
 */
export async function notifySenderBounceEmail(req: SenderBounceEmailRequest): Promise<void> {
  const body = JSON.stringify({
    channel: "email",
    sender_email: req.senderEmail,
    kind: req.kind,
    reason: req.reason,
    archive_id: req.archiveId,
  });
  try {
    const response = await fetch(`${config.sabaiBaseUrl}/byos/notify-sender-bounce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BYOS-API-Key": config.sabaiApiKey,
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(
        `[byos:notify] notify-sender-bounce failed (${response.status}): ${text}`,
      );
    }
  } catch (error) {
    console.warn("[byos:notify] notify-sender-bounce threw:", error);
  }
}

export interface WhatsAppUnpairedNotifyRequest {
  status: string;
  lastError: string | null;
}

/**
 * Ask Sabai to email ``customer.whatsapp_unpaired_alert_recipients`` that this
 * Droplet's WhatsApp session is unpaired. Best-effort; failures are logged
 * only. Returns true when Sabai accepted the notify (HTTP 2xx and not
 * ``status=skipped``), so the caller can advance its once-per-day cadence.
 */
export async function notifyWhatsAppUnpaired(
  req: WhatsAppUnpairedNotifyRequest,
): Promise<boolean> {
  const body = JSON.stringify({
    status: req.status,
    last_error: req.lastError,
  });
  try {
    const response = await fetch(`${config.sabaiBaseUrl}/byos/notify-whatsapp-unpaired`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BYOS-API-Key": config.sabaiApiKey,
      },
      body,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      console.warn(
        `[byos:notify] notify-whatsapp-unpaired failed (${response.status}): ${text}`,
      );
      return false;
    }
    try {
      const parsed = JSON.parse(text) as { status?: string };
      if (parsed.status === "skipped") {
        console.log("[byos:notify] notify-whatsapp-unpaired skipped (no recipients configured)");
        return false;
      }
    } catch {
      // Non-JSON 2xx still counts as delivered.
    }
    return true;
  } catch (error) {
    console.warn("[byos:notify] notify-whatsapp-unpaired threw:", error);
    return false;
  }
}
