import crypto from "crypto";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import type { Request, Response, NextFunction } from "express";

import { config } from "./config";

const COOKIE_NAME = "byos_session";

function hmac(value: string): string {
  return crypto.createHmac("sha256", config.adminPassword).update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function issueSessionCookie(response: Response): void {
  const expiresAt = Math.floor(Date.now() / 1000) + config.sessionMaxAgeSeconds;
  const value = `${expiresAt}.${hmac(String(expiresAt))}`;
  response.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: config.sessionMaxAgeSeconds,
    }),
  );
}

export function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    serializeCookie(COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    }),
  );
}

export function hasValidSession(request: Request): boolean {
  const rawCookie = request.headers.cookie;
  if (!rawCookie) return false;
  const cookies = parseCookie(rawCookie);
  const session = cookies[COOKIE_NAME];
  if (!session) return false;
  const [expiresAtRaw, signature] = session.split(".");
  if (!expiresAtRaw || !signature) return false;
  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return false;
  }
  return secureEqual(signature, hmac(expiresAtRaw));
}

export function requireSession(request: Request, response: Response, next: NextFunction): void {
  if (!hasValidSession(request)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function verifyPassword(password: string): boolean {
  return secureEqual(password, config.adminPassword);
}
