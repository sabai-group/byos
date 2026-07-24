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

function parseCsvEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  webPort: parseIntEnv("BYOS_PORT", 8787),
  smtpPort: parseIntEnv("BYOS_SMTP_PORT", 2525),
  adminPassword: process.env.BYOS_ADMIN_PASSWORD ?? "365",
  /** Customer-specific API key from Sabai `customer` table; sent as X-BYOS-API-Key over HTTPS. */
  sabaiApiKey: process.env.SABAI_API_KEY ?? "",
  /**
   * AES-256-GCM key material for encrypting contact (supplier/buyer) names stored in Sabai's DB.
   * Must not be configured on Sabai — only BYOS (and optional downstream decryptors) should have it.
   */
  contactEncryptionKey: process.env.SECRET_ENCRYPTION_KEY ?? "",
  sabaiBaseUrl: process.env.SABAI_BASE_URL ?? "https://sabai365-16c4b4eee4fe.herokuapp.com",
  aiApiKey: process.env.OPENAI_API_KEY ?? "",
  aiBaseUrl: process.env.OPENAI_BASE_URL ?? undefined,
  /**
   * AI model used for contact detection / redaction. Managed by SABAI via the
   * shipped default so customers stay on a current model without editing config.
   * `BYOS_AI_MODEL` is deprecated (old deployments pinned it to a mini model);
   * it is intentionally ignored so those deployments pick up the new default.
   * `AI_MODEL` remains as an undocumented escape hatch for manual overrides.
   */
  aiModel: process.env.AI_MODEL ?? "gpt-5.4",
  /**
   * Email domains that should bypass the regex-based defense-in-depth redaction
   * post-pass. Typically the BYOS customer's own corporate domain(s) plus the
   * Sabai relay domain — email addresses on those domains belong to the
   * relaying employee (or the relay endpoint) rather than the supplier/buyer
   * whose identity we are trying to scrub, so we want them to pass through
   * unchanged even when they show up inside a message body. Comma-separated;
   * matching is suffix-based against the address's domain (`endsWith("@" + d)`
   * or `endsWith("." + d)`, lowercased).
   */
  internalEmailDomains: parseCsvEnv("BYOS_INTERNAL_EMAIL_DOMAINS"),
  whatsappHeadless: parseBoolEnv("WHATSAPP_HEADLESS", true),
  whatsappDebug: parseBoolEnv("WHATSAPP_DEBUG", false),
  whatsappDebounceMs: parseIntEnv("WHATSAPP_DEBOUNCE_MS", 60_000),
  whatsappAuthPath: process.env.WHATSAPP_AUTH_PATH ?? path.resolve(process.cwd(), "data", ".wwebjs_auth"),
  whatsappArtifactsDir:
    process.env.WHATSAPP_ARTIFACTS_DIR ?? path.resolve(process.cwd(), "data", "runtime", "whatsapp"),
  /** Directory where unredacted inbound archives are stored on disk. */
  archiveDir:
    process.env.BYOS_ARCHIVE_DIR ?? path.resolve(process.cwd(), "data", "runtime", "archive"),
  /**
   * Maximum number of archived inbound offer lists to retain on disk. Older
   * entries are pruned after each write. Default 100.
   */
  archiveKeep: parseIntEnv("BYOS_ARCHIVE_KEEP", 100),
  whatsappLocale: process.env.WHATSAPP_LOCALE ?? "en-US",
  whatsappTimezone: process.env.WHATSAPP_TIMEZONE ?? "UTC",
  /**
   * Which contact roster WhatsApp inbound batches should be matched against.
   * "supplier" (default) — offers from sellers; "buyer" — request lists from customers.
   * WhatsApp uses a single channel per deployment, so this is configured at deploy time
   * rather than inferred per message.
   */
  whatsappContactKind: ((process.env.BYOS_WHATSAPP_KIND ?? "supplier").toLowerCase() === "buyer"
    ? "buyer"
    : "supplier") as "supplier" | "buyer",
  whatsappUserAgent:
    process.env.WHATSAPP_USER_AGENT ??
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  whatsappViewportWidth: parseIntEnv("WHATSAPP_VIEWPORT_WIDTH", 1366),
  whatsappViewportHeight: parseIntEnv("WHATSAPP_VIEWPORT_HEIGHT", 768),
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/byos-browser",
  sessionMaxAgeSeconds: parseIntEnv("BYOS_SESSION_MAX_AGE_SECONDS", 60 * 60 * 24 * 7),
};

export function validateConfig(): void {
  if (!config.sabaiApiKey) {
    throw new Error("SABAI_API_KEY is required (must match a Sabai-accepted relay key)");
  }
  if (!config.contactEncryptionKey) {
    throw new Error("SECRET_ENCRYPTION_KEY is required to encrypt contact identity for Sabai ingest");
  }
  if (!config.aiApiKey) {
    console.warn("OPENAI_API_KEY is not set; contact detection will fall back to heuristic matching only.");
  }
  if (process.env.BYOS_AI_MODEL) {
    console.warn(
      `BYOS_AI_MODEL is deprecated and ignored; the AI model now defaults to ${config.aiModel}. ` +
        "Remove it from your .env (or set AI_MODEL only if you must override).",
    );
  }
}
