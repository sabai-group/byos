import type { Server as HttpServer } from "http";

import { validateConfig, config } from "./config";
import { sendQrCodeEmail } from "./mailer";
import { detectAndRedactEmail, detectAndRedactWhatsApp, redactAttachments } from "./redact";
import { relayEmail, relayWhatsApp } from "./relay";
import { startSmtpServer } from "./smtp";
import { fetchRosterFromSabai } from "./suppliers";
import { createWebApp } from "./web";
import { startWhatsAppService } from "./whatsapp";

async function main() {
  validateConfig();
  let shuttingDown = false;

  const whatsappService = await startWhatsAppService({
    onQrReady: sendQrCodeEmail,
    onBatch: async (batch) => {
      const roster = await fetchRosterFromSabai();
      const redacted = await detectAndRedactWhatsApp(roster, {
        from: batch.from,
        text: batch.text,
        messages: batch.messages,
      });
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
        supplierMatch: redacted.supplierMatch,
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
    onLinkRequest: async () => {
      await whatsappService.requestQrEmail();
    },
    onEmail: async (email) => {
      const roster = await fetchRosterFromSabai();
      const redacted = await detectAndRedactEmail(roster, email);
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
        supplierMatch: redacted.supplierMatch,
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
