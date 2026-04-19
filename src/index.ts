import type { Server as HttpServer } from "http";

import { validateConfig, config } from "./config";
import { detectAndRedactEmail, detectAndRedactWhatsApp, redactAttachments } from "./redact";
import { notifySenderBounceEmail } from "./notify";
import { relayEmail, relayWhatsApp } from "./relay";
import { fetchRoster } from "./roster";
import { startSmtpServer } from "./smtp";
import {
  fetchUserRoster,
  isKnownEmailSender,
  isKnownWhatsAppSender,
} from "./userRoster";
import { createWebApp } from "./web";
import { startWhatsAppService } from "./whatsapp";

function extractEmailAddress(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  const trimmed = raw.trim();
  return trimmed.includes("@") ? trimmed : undefined;
}

async function main() {
  validateConfig();
  let shuttingDown = false;

  const whatsappService = await startWhatsAppService({
    onBatch: async (batch) => {
      const kind = config.whatsappContactKind;
      // Sender gate: only forward messages from known Sabai users for this
      // customer. Unknown senders get a one-line WhatsApp warning and we
      // never call fetchRoster / relay for them.
      const userRoster = await fetchUserRoster();
      if (!isKnownWhatsAppSender(userRoster, batch.from)) {
        console.warn(
          `[byos:whatsapp] rejected unknown sender ${batch.from}: not registered as a Sabai user`,
        );
        await whatsappService.sendSenderWarning(
          batch.from,
          "BYOS only relays messages from registered Sabai users. Ask your admin to add your WhatsApp number to your Sabai account.",
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
        // BYOS couldn't identify the contact — warn the sender directly via
        // the same WhatsApp channel (no LID -> phone resolution needed).
        console.warn(
          `[byos:whatsapp] unmatched ${kind} from ${batch.from}: ${redacted.reason}`,
        );
        await whatsappService.sendSenderWarning(
          batch.from,
          `BYOS couldn't identify the ${kind} on this message. Please add them in the BYOS portal and resend.`,
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
      });
    },
  });

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
      // Sender gate: only accept email from known Sabai users for this
      // customer. Unknown senders get the existing bounce flow with a
      // sender-not-registered reason and the message is not relayed.
      const senderEmail = extractEmailAddress(email.from);
      const userRoster = await fetchUserRoster();
      if (!isKnownEmailSender(userRoster, senderEmail)) {
        const reason = "Sender is not registered as a Sabai user.";
        console.warn(
          `[byos:smtp] rejected unknown sender from=${email.from} (to=${email.to}): ${reason}`,
        );
        if (senderEmail) {
          await notifySenderBounceEmail({
            senderEmail,
            kind: email.kind,
            reason,
          });
        }
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
        const senderEmail = extractEmailAddress(email.from);
        console.warn(
          `[byos:smtp] unmatched ${email.kind} from=${email.from} (to=${email.to}): ${redacted.reason}`,
        );
        if (senderEmail) {
          await notifySenderBounceEmail({
            senderEmail,
            kind: email.kind,
            reason: redacted.reason,
          });
        }
        return;
      }
      const cleanedAttachments = await redactAttachments(email.attachments, roster);
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
      });
    },
  });

  async function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("Shutting down BYOS services...");
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
}

main().catch((error) => {
  console.error("BYOS boot failed", error);
  process.exit(1);
});
