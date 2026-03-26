import type { Readable } from "stream";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

import { config } from "./config";
import type { AttachmentManifest } from "./relay";

export interface InboundEmail {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachmentManifests: AttachmentManifest[];
}

function isLinkRequest(email: InboundEmail): boolean {
  const subject = (email.subject ?? "").toLowerCase();
  const text = (email.text ?? "").toLowerCase();
  return subject.includes("link whatsapp") || text.includes("link whatsapp");
}

export function startSmtpServer(options: {
  onEmail: (email: InboundEmail) => Promise<void>;
  onLinkRequest: (email: InboundEmail) => Promise<void>;
}): Promise<any> {
  const server = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    authOptional: true,
    onData(stream: Readable, _session: unknown, callback: (error?: Error | null) => void) {
      simpleParser(stream)
        .then(async (parsed: any) => {
          const email: InboundEmail = {
            from: parsed.from?.text ?? "unknown@byos.invalid",
            to: parsed.to?.text ?? undefined,
            subject: parsed.subject ?? undefined,
            text: parsed.text ?? undefined,
            html: typeof parsed.html === "string" ? parsed.html : undefined,
            attachmentManifests: (parsed.attachments ?? []).map((attachment: any) => ({
              filename: attachment.filename ?? "attachment.bin",
              contentType: attachment.contentType,
              sizeBytes: attachment.size,
            })),
          };

          if (isLinkRequest(email)) {
            await options.onLinkRequest(email);
          } else {
            await options.onEmail(email);
          }
          callback();
        })
        .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
    },
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.smtpPort, () => {
      console.log(`BYOS SMTP server listening on port ${config.smtpPort}`);
      resolve(server);
    });
  });
}
