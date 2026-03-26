import nodemailer from "nodemailer";

import { config } from "./config";

function getTransport() {
  if (!config.smtpRelayHost) {
    return null;
  }
  return nodemailer.createTransport({
    host: config.smtpRelayHost,
    port: config.smtpRelayPort,
    secure: config.smtpRelaySecure,
    auth: config.smtpRelayUser
      ? {
          user: config.smtpRelayUser,
          pass: config.smtpRelayPass,
        }
      : undefined,
  });
}

export async function sendQrCodeEmail(qrDataUrl: string): Promise<void> {
  const transport = getTransport();
  if (!transport || !config.adminEmailTo || !config.adminEmailFrom) {
    console.warn("QR email requested, but outbound SMTP relay settings are incomplete.");
    return;
  }

  const pngBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  await transport.sendMail({
    from: config.adminEmailFrom,
    to: config.adminEmailTo,
    subject: "BYOS WhatsApp linking QR",
    text: "Scan the attached QR code in WhatsApp to link this BYOS deployment.",
    html: '<p>Scan the attached QR code in WhatsApp to link this BYOS deployment.</p><p><img src="cid:qr-code" alt="WhatsApp QR code" /></p>',
    attachments: [
      {
        filename: "whatsapp-link-qr.png",
        content: pngBase64,
        encoding: "base64",
        cid: "qr-code",
      },
    ],
  });
}
