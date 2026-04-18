import type { Readable } from "stream";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";

import { config } from "./config";
import type { RelayedAttachment } from "./relay";
import type { ContactKind } from "./roster";

/** All local-parts we accept. Everything else yields a 550 at RCPT TO. */
const OFFER_LOCAL_PARTS = new Set(["offers", "offers-test"]);
const REQUEST_LOCAL_PARTS = new Set(["requests", "requests-test"]);

function localPartOf(address: string | undefined | null): string {
  if (!address) return "";
  return address.toLowerCase().split("@")[0] ?? "";
}

function kindForLocalPart(localPart: string): ContactKind | null {
  if (REQUEST_LOCAL_PARTS.has(localPart)) return "buyer";
  if (OFFER_LOCAL_PARTS.has(localPart)) return "supplier";
  return null;
}

export interface InboundEmail {
  /**
   * Which contact flow this email should go through, decided by the RCPT TO
   * local-part (requests@ → buyer, offers@ → supplier). Unknown local-parts
   * are rejected at SMTP RCPT time and never reach onEmail.
   */
  kind: ContactKind;
  /** Local-part that was accepted (e.g. "requests", "offers-test"). */
  localPart: string;
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments: RelayedAttachment[];
}

export function startSmtpServer(options: {
  onEmail: (email: InboundEmail) => Promise<void>;
}): Promise<any> {
  const server = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    authOptional: true,
    onRcptTo(address: { address: string }, _session: unknown, callback: (error?: Error | null) => void) {
      const localPart = localPartOf(address.address);
      if (!kindForLocalPart(localPart)) {
        // Standards-compliant permanent failure — upstream MTAs will emit
        // a bounce DSN back to the sender without BYOS doing anything else.
        const err = new Error("550 Unknown mailbox; use offers@ or requests@");
        (err as any).responseCode = 550;
        return callback(err);
      }
      callback();
    },
    onData(stream: Readable, session: any, callback: (error?: Error | null) => void) {
      simpleParser(stream)
        .then(async (parsed: any) => {
          // Pick the first accepted recipient. smtp-server preserves rcptTo on
          // the session envelope, and onRcptTo has already rejected anything
          // outside the accepted local-part set.
          const rcpt = session?.envelope?.rcptTo?.[0]?.address as string | undefined;
          const localPart = localPartOf(rcpt ?? parsed.to?.text);
          const kind = kindForLocalPart(localPart);
          if (!kind) {
            // Defensive: should be unreachable because onRcptTo rejects.
            return callback(new Error(`550 Unknown mailbox ${localPart}`));
          }

          const email: InboundEmail = {
            kind,
            localPart,
            from: parsed.from?.text ?? "unknown@byos.invalid",
            to: parsed.to?.text ?? rcpt ?? undefined,
            subject: parsed.subject ?? undefined,
            text: parsed.text ?? undefined,
            html: typeof parsed.html === "string" ? parsed.html : undefined,
            attachments: (parsed.attachments ?? [])
              .filter((a: any) => a.content)
              .map((a: any) => ({
                contentBase64: a.content.toString("base64"),
                contentType: a.contentType ?? "application/octet-stream",
                sizeBytes: a.size,
              })),
          };

          console.log(
            `[byos:smtp] received from=${email.from} to=${email.to ?? "(none)"} kind=${kind} subject=${email.subject ?? "(none)"} attachments=${email.attachments.length}`,
          );

          await options.onEmail(email);
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
