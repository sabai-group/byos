import type { Server as HttpServer } from "http";

import { validateConfig, config } from "./config";
import { detectAndRedactEmail, detectAndRedactWhatsApp, redactAttachments } from "./redact";
import { notifySenderBounceEmail } from "./notify";
import { relayEmail, relayWhatsApp } from "./relay";
import { fetchRoster } from "./roster";
import { startSmtpServer } from "./smtp";
import {
  fetchUserRoster,
  resolveEmailAttribution,
  resolveWhatsAppAttribution,
} from "./userRoster";
import { createWebApp } from "./web";
import { startWhatsAppService } from "./whatsapp";
import {
  notifyWhatsAppUnpairedNow,
  startWhatsAppUnpairedAlertLoop,
} from "./whatsappUnpairedAlert";
import { archiveEmail, archiveWhatsApp, type ArchiveOutcome } from "./archive";
import { endProcessing, startProcessing } from "./processing";

/** Build a short, single-line preview of a WhatsApp batch for the portal. */
function whatsappPreview(batch: { text?: string; messages: Array<Record<string, unknown>> }): string {
  const raw = (batch.text && batch.text.trim()) ||
    batch.messages
      .map((m) => (typeof m.text === "string" ? m.text : ""))
      .find((t) => t && t.trim()) ||
    "";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine || "(media only)";
}

function extractEmailAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  const trimmed = raw.trim();
  return trimmed.includes("@") ? trimmed : undefined;
}

/**
 * Archive an email failure (sender-rejected or contact-unmatched), then send
 * the Sabai bounce notification with the archive ID so the email can link
 * straight to the archived message. Archiving failure is non-fatal — the
 * notification still goes out, just without a portal link.
 */
async function archiveAndBouncEmail(
  email: Parameters<typeof archiveEmail>[0],
  outcome: Parameters<typeof archiveEmail>[1],
  reason: string,
): Promise<void> {
  const senderEmail = extractEmailAddress(email.from);
  const archiveId = await archiveEmail(email, outcome).catch((err: unknown) => {
    console.error("[byos:archive] email archive failed:", err);
    return undefined;
  });
  if (senderEmail) {
    await notifySenderBounceEmail({ senderEmail, kind: email.kind, reason, archiveId });
  }
}

async function main() {
  validateConfig();
  let shuttingDown = false;

  const whatsappService = await startWhatsAppService({
    onBecameUnpaired: (info) => {
      void notifyWhatsAppUnpairedNow(info);
    },
    onBatch: async (batch) => {
      const processingToken = startProcessing({
        channel: "whatsapp",
        subject: whatsappPreview(batch),
        from: batch.from,
      });
      try {
      const kind = config.whatsappContactKind;
      // Sender gate: only forward messages from known Sabai users for this
      // customer. Unknown senders get a one-line WhatsApp warning and we
      // never call fetchRoster / relay for them.
      const userRoster = await fetchUserRoster();
      const attributedTo = resolveWhatsAppAttribution(userRoster, batch.from);
      if (!attributedTo) {
        // Ghost unknown senders: random people who message the linked number
        // (and group chats, whose JID never matches a user) must NOT get an
        // automated reply — we silently drop the message and only archive it.
        console.warn(
          `[byos:whatsapp] Ignored unknown sender ${batch.from}: not registered as a Sabai user (no reply sent)`,
        );
        archiveWhatsApp(batch, { senderAccepted: false, rejectReason: "sender not registered as a Sabai user" }).catch((err: unknown) =>
          console.error("[byos:archive] whatsapp archive failed (sender rejected):", err),
        );
        return;
      }
      const roster = await fetchRoster(kind);
      const redacted = await detectAndRedactWhatsApp(roster, {
        from: batch.from,
        text: batch.text,
        messages: batch.messages,
      });
      if (!redacted.matched) {
        // Recognized Sabai user, but redaction couldn't identify the contact —
        // tell them so they can add the supplier/buyer and resend.
        console.warn(
          `[byos:whatsapp] unmatched ${kind} from ${batch.from}: ${redacted.reason}`,
        );
        await whatsappService.sendSenderWarning(
          batch.from,
          `BYOS couldn't identify the ${kind} on this message. Please add them in the BYOS portal and resend.`,
        );
        archiveWhatsApp(batch, { senderAccepted: true, unmatchedReason: redacted.reason }).catch((err: unknown) =>
          console.error("[byos:archive] whatsapp archive failed (unmatched):", err),
        );
        return;
      }
      const cleanedAttachments = await redactAttachments(batch.attachments, roster);
      await relayWhatsApp({
        from: redacted.redactedFrom,
        to: batch.to,
        text: redacted.redactedText,
        messages: redacted.redactedMessages,
        attachments: cleanedAttachments,
        metadata: {
          ...batch.metadata,
          waid: "redacted",
          byos_received_at: new Date().toISOString(),
        },
        contactMatch: redacted.contactMatch,
        attributedTo,
      });
      await whatsappService.sendSenderWarning(
        batch.from,
        "Received — your redacted message was forwarded to 365 and is currently being ingested",
      );
      const waOutcome: ArchiveOutcome = {
        senderAccepted: true,
        contactMatch: { kind: redacted.contactMatch.kind, confidence: redacted.contactMatch.confidence },
      };
      archiveWhatsApp(batch, waOutcome).catch((err: unknown) =>
        console.error("[byos:archive] whatsapp archive failed (relayed):", err),
      );
      } finally {
        endProcessing(processingToken);
      }
    },
  });

  const unpairedAlertLoop = startWhatsAppUnpairedAlertLoop(whatsappService);

  const webApp = createWebApp({
    getWhatsAppLinkState: () => whatsappService.getLinkState(),
    forceWhatsAppLink: () => whatsappService.forceQrForWeb(),
  });
  const httpServer: HttpServer = await new Promise((resolve) => {
    const server = webApp.listen(config.webPort, () => {
      console.log(`BYOS web UI listening on port ${config.webPort}`);
      resolve(server);
    });
  });

  const smtpServer = await startSmtpServer({
    onEmail: async (email) => {
      const processingToken = startProcessing({
        channel: "email",
        subject: (email.subject && email.subject.trim()) || "(no subject)",
        from: email.from,
      });
      try { 
      // Sender gate: only accept email from known Sabai users for this
      // customer. Unknown senders get the existing bounce flow with a
      // sender-not-registered reason and the message is not relayed.
      const senderEmail = extractEmailAddress(email.from);
      const userRoster = await fetchUserRoster();
      const attributedTo = resolveEmailAttribution(userRoster, senderEmail);
      if (!attributedTo) {
        const reason = "Sender is not registered as a 365 user.";
        console.warn(
          `[byos:smtp] rejected unknown sender from=${email.from} (to=${email.to}): ${reason}`,
        );
        await archiveAndBouncEmail(email, { senderAccepted: false, rejectReason: reason }, reason);
        return;
      }
      const roster = await fetchRoster(email.kind);
      const redacted = await detectAndRedactEmail(roster, email);
      if (!redacted.matched) {
        // Couldn't identify the contact — email the original sender a bounce
        // explanation via Sabai's SendGrid. Applies to both supplier (offers@)
        // and buyer (requests@) misses.
        //
        // We deliberately do NOT pass the original subject (or any other
        // inbound-message content) to Sabai here: this is exactly the path
        // where redaction failed, so the subject may still contain the
        // contact identifiers BYOS exists to keep on-prem.
        console.warn(
          `[byos:smtp] unmatched ${email.kind} from=${email.from} (to=${email.to}): ${redacted.reason}`,
        );
        await archiveAndBouncEmail(email, { senderAccepted: true, unmatchedReason: redacted.reason }, redacted.reason);
        return;
      }
      // Filter out inline CID attachments that pass 2 classified as signature
      // /logo images — they already got replaced by `[REDACTED]` inside the
      // HTML, and leaving them in the attachment list would let Sabai still
      // see the original image file. Non-CID attachments pass through.
      const droppedCidSet = new Set(redacted.droppedCids);
      const filteredAttachments = droppedCidSet.size
        ? email.attachments.filter((a) => !(a.contentId && droppedCidSet.has(a.contentId)))
        : email.attachments;
      if (droppedCidSet.size) {
        const droppedCount = email.attachments.length - filteredAttachments.length;
        console.log(
          `[byos:smtp] dropped ${droppedCount}/${email.attachments.length} inline signature attachment(s) `
            + `matching cids=${[...droppedCidSet].join(",")}`,
        );
      }
      const cleanedAttachments = await redactAttachments(filteredAttachments, roster);
      await relayEmail({
        from: redacted.redactedFrom,
        to: email.to,
        subject: redacted.redactedSubject,
        text: redacted.redactedText,
        html: redacted.redactedHtml,
        attachments: cleanedAttachments,
        metadata: {
          byos_received_at: new Date().toISOString(),
        },
        contactMatch: redacted.contactMatch,
        attributedTo,
      });
      const emailOutcome: ArchiveOutcome = {
        senderAccepted: true,
        contactMatch: { kind: redacted.contactMatch.kind, confidence: redacted.contactMatch.confidence },
      };
      archiveEmail(email, emailOutcome).catch((err: unknown) =>
        console.error("[byos:archive] email archive failed (relayed):", err),
      );
      } finally {
        endProcessing(processingToken);
      }
    },
  });

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("Shutting down BYOS services...");
    unpairedAlertLoop.stop();
    await whatsappService.shutdown().catch((error) => console.error("WhatsApp shutdown failed", error));
    await new Promise<void>((resolve, reject) =>
      smtpServer.close((error: Error | null | undefined) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error: Error | null | undefined) => (error ? reject(error) : resolve())),
    );
    process.exitCode = 0;
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Safety net: whatsapp-web.js's post-LOGOUT framenavigated → inject() can
  // still reject with "onQRChangedEvent already exists" if it races our
  // destroy. Do not let that take down SMTP/web.
  // https://github.com/wwebjs/whatsapp-web.js/issues/5682
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (
      msg.includes("already exists") &&
      (msg.includes("onQRChangedEvent") || msg.includes("page binding"))
    ) {
      console.warn("[byos] swallowed WWebJS post-logout reinject rejection:", msg);
      return;
    }
    console.error("[byos] unhandledRejection:", reason);
  });
}

main().catch((error) => {
  console.error("BYOS boot failed", error);
  process.exit(1);
});
