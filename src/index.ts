import type { Server as HttpServer } from "http";

import { validateConfig, config } from "./config";
import { detectAndRedactEmail, detectAndRedactWhatsApp, redactAttachments } from "./redact";
import { notifySenderBounceEmail } from "./notify";
import { relayEmail, relayWhatsApp } from "./relay";
import { fetchRoster } from "./roster";
import { startSmtpServer } from "./smtp";
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
      const roster = await fetchRoster(email.kind);
      const redacted = await detectAndRedactEmail(roster, email);
      if (!redacted.matched) {
        // Couldn't identify the contact — email the original sender a bounce
        // explanation via Sabai's SendGrid. Applies to both supplier (offers@)
        // and buyer (requests@) misses.
        const senderEmail = extractEmailAddress(email.from);
        console.warn(
          `[byos:smtp] unmatched ${email.kind} from=${email.from} (to=${email.to}): ${redacted.reason}`,
        );
        if (senderEmail) {
          await notifySenderBounceEmail({
            senderEmail,
            kind: email.kind,
            reason: redacted.reason,
            originalSubject: email.subject,
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
