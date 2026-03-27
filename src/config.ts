import path from "path";

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  webPort: parseIntEnv("BYOS_PORT", 8787),
  smtpPort: parseIntEnv("BYOS_SMTP_PORT", 2525),
  adminPassword: process.env.BYOS_ADMIN_PASSWORD ?? "365",
  /** Customer-specific API key from Sabai `customer` table; sent as X-BYOS-API-Key over HTTPS. */
  sabaiApiKey: process.env.SABAI_API_KEY ?? "",
  /**
   * AES-256-GCM key material for encrypting supplier names stored in Sabai's DB.
   * Must not be configured on Sabai — only BYOS (and optional downstream decryptors) should have it.
   */
  supplierEncryptionKey: process.env.SECRET_ENCRYPTION_KEY ?? "",
  sabaiBaseUrl: process.env.SABAI_BASE_URL ?? "https://sabai365-16c4b4eee4fe.herokuapp.com",
  aiApiKey: process.env.OPENAI_API_KEY ?? "",
  aiBaseUrl: process.env.OPENAI_BASE_URL ?? undefined,
  aiModel: process.env.BYOS_AI_MODEL ?? "gpt-4.1-mini",
  adminEmailTo: process.env.BYOS_ADMIN_EMAIL_TO ?? "",
  adminEmailFrom: process.env.BYOS_ADMIN_EMAIL_FROM ?? "",
  smtpRelayHost: process.env.BYOS_SMTP_RELAY_HOST ?? "",
  smtpRelayPort: parseIntEnv("BYOS_SMTP_RELAY_PORT", 587),
  smtpRelaySecure: parseBoolEnv("BYOS_SMTP_RELAY_SECURE", false),
  smtpRelayUser: process.env.BYOS_SMTP_RELAY_USER ?? "",
  smtpRelayPass: process.env.BYOS_SMTP_RELAY_PASS ?? "",
  whatsappHeadless: parseBoolEnv("WHATSAPP_HEADLESS", true),
  whatsappDebug: parseBoolEnv("WHATSAPP_DEBUG", false),
  whatsappDebounceMs: parseIntEnv("WHATSAPP_DEBOUNCE_MS", 60_000),
  whatsappAuthPath: process.env.WHATSAPP_AUTH_PATH ?? path.resolve(process.cwd(), "data", ".wwebjs_auth"),
  whatsappArtifactsDir:
    process.env.WHATSAPP_ARTIFACTS_DIR ?? path.resolve(process.cwd(), "data", "runtime", "whatsapp"),
  whatsappLocale: process.env.WHATSAPP_LOCALE ?? "en-US",
  whatsappTimezone: process.env.WHATSAPP_TIMEZONE ?? "UTC",
  whatsappUserAgent:
    process.env.WHATSAPP_USER_AGENT ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  whatsappViewportWidth: parseIntEnv("WHATSAPP_VIEWPORT_WIDTH", 1366),
  whatsappViewportHeight: parseIntEnv("WHATSAPP_VIEWPORT_HEIGHT", 768),
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/byos-browser",
  sessionMaxAgeSeconds: parseIntEnv("BYOS_SESSION_MAX_AGE_SECONDS", 60 * 60 * 12),
};

export function validateConfig(): void {
  if (!config.sabaiApiKey) {
    throw new Error("SABAI_API_KEY is required (must match a Sabai-accepted relay key)");
  }
  if (!config.supplierEncryptionKey) {
    throw new Error("SECRET_ENCRYPTION_KEY is required to encrypt supplier identity for Sabai ingest");
  }
  if (!config.aiApiKey) {
    console.warn("OPENAI_API_KEY is not set; supplier detection will fall back to heuristic matching only.");
  }
}
