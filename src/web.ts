import express from "express";
import path from "path";

import { clearSessionCookie, hasValidSession, issueSessionCookie, requireSession, verifyPassword } from "./auth";
import { config } from "./config";
import { encryptSupplierName } from "./relay";
import { fetchRosterFromSabai } from "./suppliers";
import type { WhatsAppLinkState } from "./whatsapp";

function isLikelyQrDataUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") return false;
  return /^data:image\/(png|jpeg|gif|webp);base64,[\s\S]+/.test(value);
}

function toPublicWhatsAppState(state: WhatsAppLinkState) {
  const showQr =
    !state.ready &&
    !state.pairing &&
    !state.resetting &&
    isLikelyQrDataUrl(state.qrDataUrl);
  return {
    ready: state.ready,
    pairing: state.pairing,
    resetting: state.resetting,
    qrAvailable: showQr,
    qrDataUrl: showQr ? state.qrDataUrl : null,
    waitingForQr: state.waitingForQr,
    hasError: Boolean(state.lastError),
  };
}

export function createWebApp(options: {
  getWhatsAppLinkState: () => WhatsAppLinkState;
  forceWhatsAppLink: () => Promise<WhatsAppLinkState>;
}) {
  const app = express();
  const publicDir = path.resolve(process.cwd(), "src", "public");

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/session", (request, response) => {
    response.json({ authenticated: hasValidSession(request) });
  });

  app.post("/api/login", (request, response) => {
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!verifyPassword(password)) {
      response.status(401).json({ error: "Invalid password" });
      return;
    }
    issueSessionCookie(response);
    response.json({ ok: true });
  });

  app.post("/api/logout", (_request, response) => {
    clearSessionCookie(response);
    response.json({ ok: true });
  });

  app.get("/api/roster", requireSession, async (_request, response, next) => {
    try {
      response.json(await fetchRosterFromSabai());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/suppliers", requireSession, async (request, response, next) => {
    try {
      const { name } = request.body ?? {};
      if (!name || typeof name !== "string") {
        response.status(400).json({ error: "name is required" });
        return;
      }
      const encrypted = encryptSupplierName(name.trim());
      const sabaiResponse = await fetch(`${config.sabaiBaseUrl}/byos/suppliers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BYOS-API-Key": config.sabaiApiKey,
        },
        body: JSON.stringify({ name: encrypted, is_encrypted: true }),
      });
      if (!sabaiResponse.ok) {
        const text = await sabaiResponse.text();
        throw new Error(`Sabai returned ${sabaiResponse.status}: ${text}`);
      }
      response.json(await sabaiResponse.json());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/whatsapp/status", requireSession, (_request, response) => {
    response.json(toPublicWhatsAppState(options.getWhatsAppLinkState()));
  });

  app.post("/api/whatsapp/force-link", requireSession, async (_request, response, next) => {
    try {
      response.json(toPublicWhatsAppState(await options.forceWhatsAppLink()));
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(publicDir));

  app.get("*", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    response.status(400).json({ error: message });
  });

  return app;
}
