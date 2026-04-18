/**
 * Thin client for Sabai's /byos/notify-sender-bounce endpoint.
 *
 * Invoked when BYOS receives a message on requests@/offers@ but cannot
 * identify the buyer/supplier it's referring to. Sabai emails the original
 * sender a short explanation with a pointer to the BYOS portal.
 *
 * Only the email channel is proxied through the backend; WhatsApp sender
 * warnings are delivered by BYOS itself via the already-authenticated
 * whatsapp-web.js client (no phone-number resolution required).
 */
import { config } from "./config";
import type { ContactKind } from "./roster";

export interface SenderBounceEmailRequest {
  senderEmail: string;
  kind: ContactKind;
  reason: string;
  originalSubject?: string;
}

/** Best-effort; any failure is logged but does NOT block the SMTP response. */
export async function notifySenderBounceEmail(req: SenderBounceEmailRequest): Promise<void> {
  const body = JSON.stringify({
    channel: "email",
    sender_email: req.senderEmail,
    kind: req.kind,
    reason: req.reason,
    original_subject: req.originalSubject,
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
