import express from "express";
import path from "path";

import { clearSessionCookie, hasValidSession, issueSessionCookie, requireSession, verifyPassword } from "./auth";
import { config } from "./config";
import { encryptContactName } from "./relay";
import { fetchRoster, type ContactKind } from "./roster";
import type { WhatsAppLinkState } from "./whatsapp";
import { listArchive, openArchiveAttachment, readArchiveMeta } from "./archive";

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
    hasError: Boolean(state.lastError),
  };
}

function parseContactKind(raw: unknown): ContactKind {
  return String(raw ?? "supplier").toLowerCase() === "buyer" ? "buyer" : "supplier";
}

/** Express types params as string | string[]; normalize to a single string. */
function routeParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function listKey(kind: ContactKind): "suppliers" | "buyers" {
  return kind === "buyer" ? "buyers" : "suppliers";
}

function rosterPath(kind: ContactKind): string {
  return kind === "buyer" ? "/byos/buyers" : "/byos/suppliers";
}

async function postContactToSabai(
  kind: ContactKind,
  encryptedName: string,
): Promise<unknown> {
  const response = await fetch(`${config.sabaiBaseUrl}${rosterPath(kind)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BYOS-API-Key": config.sabaiApiKey,
    },
    body: JSON.stringify({ name: encryptedName, is_encrypted: true }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sabai returned ${response.status}: ${text}`);
  }
  return response.json();
}

async function deleteContactFromSabai(
  kind: ContactKind,
  id: string,
): Promise<unknown> {
  const response = await fetch(`${config.sabaiBaseUrl}${rosterPath(kind)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-BYOS-API-Key": config.sabaiApiKey },
  });
  if (!response.ok) {
    const text = await response.text();
    // Surface Sabai's JSON `detail` when present so the UI shows the real
    // reason (e.g. FK conflict) instead of a generic status string.
    let message = `Sabai returned ${response.status}: ${text}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.detail === "string") {
        message = parsed.detail;
      }
    } catch {
      /* keep raw text */
    }
    throw new Error(message);
  }
  if (response.status === 204) return { status: "deleted" };
  return response.json();
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

  /**
   * Kind-aware roster fetch. `?kind=supplier|buyer` (defaults to supplier).
   * Returns `{ kind, updatedAt, suppliers | buyers: [...] }`, matching the
   * Sabai-side GET /byos/{suppliers,buyers} shape.
   */
  app.get("/api/roster", requireSession, async (request, response, next) => {
    try {
      const kind = parseContactKind(request.query.kind);
      const roster = await fetchRoster(kind);
      response.json({
        kind,
        updatedAt: roster.updatedAt,
        [listKey(kind)]: roster.contacts,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Unified contact endpoint; body: `{ kind, name }`. BYOS encrypts the name
   * locally before shipping to Sabai so plaintext never touches the DB.
   */
  app.post("/api/contacts", requireSession, async (request, response, next) => {
    try {
      const kind = parseContactKind(request.body?.kind);
      const { name } = request.body ?? {};
      if (!name || typeof name !== "string") {
        response.status(400).json({ error: "name is required" });
        return;
      }
      const encrypted = encryptContactName(name.trim());
      const result = await postContactToSabai(kind, encrypted);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Delete a contact (supplier or buyer) on Sabai. The `:id` is the numeric
   * Sabai row id surfaced by GET /api/roster.
   */
  app.delete("/api/contacts/:id", requireSession, async (request, response, next) => {
    try {
      const kind = parseContactKind(request.query.kind);
      const rawId = request.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) {
        response.status(400).json({ error: "id is required" });
        return;
      }
      const result = await deleteContactFromSabai(kind, id);
      response.json(result);
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

  /**
   * List the most recent archived inbounds (newest first, up to 100 entries).
   */
  app.get("/api/archive", requireSession, async (_request, response, next) => {
    try {
      const items = await listArchive();
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Full metadata for a single archived inbound.
   */
  app.get("/api/archive/:id", requireSession, async (request, response, next) => {
    try {
      const id = Number.parseInt(routeParam(request.params.id) ?? "", 10);
      if (!Number.isFinite(id) || id < 1) {
        response.status(400).json({ error: "Invalid archive id" });
        return;
      }
      const meta = await readArchiveMeta(id);
      if (!meta) {
        response.status(404).json({ error: "Not found" });
        return;
      }
      response.json(meta);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Stream a stored attachment. The `storedAs` parameter is validated against
   * the meta entry so arbitrary paths cannot be requested (path-traversal guard).
   */
  app.get("/api/archive/:id/attachments/:storedAs", requireSession, async (request, response, next) => {
    try {
      const id = Number.parseInt(routeParam(request.params.id) ?? "", 10);
      if (!Number.isFinite(id) || id < 1) {
        response.status(400).json({ error: "Invalid archive id" });
        return;
      }
      const storedAs = routeParam(request.params.storedAs);
      if (!storedAs) {
        response.status(400).json({ error: "Invalid attachment name" });
        return;
      }
      const result = await openArchiveAttachment(id, storedAs);
      if (!result) {
        response.status(404).json({ error: "Attachment not found" });
        return;
      }
      response.setHeader("Content-Type", result.contentType);
      if (result.sizeBytes !== undefined) {
        response.setHeader("Content-Length", result.sizeBytes);
      }
      // Serve inline so the browser can display images / PDFs directly.
      response.setHeader("Content-Disposition", `inline; filename="${storedAs}"`);
      result.stream.pipe(response);
      result.stream.on("error", next);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Serve the archive detail page for clean /archive/:id URLs.
   */
  app.get("/archive/:id", requireSession, (_request, response) => {
    response.sendFile(path.join(publicDir, "archive.html"));
  });

  app.use(express.static(publicDir));

  app.get("*", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[byos:http:error] ${request.method} ${request.path} — ${message}`);
    response.status(400).json({ error: message });
  });

  return app;
}
