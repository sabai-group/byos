/**
 * Durable WhatsApp runtime flags under WHATSAPP_ARTIFACTS_DIR (outside LocalAuth,
 * so LOGOUT / Force New QR wipes do not clear them).
 *
 * Single JSON file + merge-on-write so callers cannot clobber each other's keys.
 */
import fs from "fs/promises";
import path from "path";

import { config } from "./config";

/** Sentinel: unpaired alert never sent (or cleared after re-pair). Always due. */
export const NEVER_SENT_ALERT_MS = 0;

export interface WhatsAppRuntimeState {
  /** True after at least one successful WhatsApp `ready` on this volume. */
  hadReadySession: boolean;
  /** Epoch ms of last successful unpaired notify; {@link NEVER_SENT_ALERT_MS} if none. */
  lastAlertSentAtMs: number;
}

const STATE_FILENAME = "whatsapp-runtime-state.json";

const DEFAULT_STATE: WhatsAppRuntimeState = {
  hadReadySession: false,
  lastAlertSentAtMs: NEVER_SENT_ALERT_MS,
};

function statePath(): string {
  return path.join(config.whatsappArtifactsDir, STATE_FILENAME);
}

function normalizeState(raw: unknown): WhatsAppRuntimeState {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<WhatsAppRuntimeState>;
  return {
    hadReadySession: parsed.hadReadySession === true,
    lastAlertSentAtMs:
      typeof parsed.lastAlertSentAtMs === "number" && Number.isFinite(parsed.lastAlertSentAtMs)
        ? parsed.lastAlertSentAtMs
        : NEVER_SENT_ALERT_MS,
  };
}

async function writeState(state: WhatsAppRuntimeState): Promise<void> {
  await fs.mkdir(config.whatsappArtifactsDir, { recursive: true });
  await fs.writeFile(statePath(), `${JSON.stringify(state)}\n`, "utf8");
}

export async function loadWhatsAppRuntimeState(): Promise<WhatsAppRuntimeState> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(), "utf8")) as unknown;
    return normalizeState(raw);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Read-merge-write. Only keys present in `patch` are updated.
 */
export async function updateWhatsAppRuntimeState(
  patch: Partial<WhatsAppRuntimeState>,
): Promise<WhatsAppRuntimeState> {
  const current = await loadWhatsAppRuntimeState();
  const next: WhatsAppRuntimeState = {
    hadReadySession:
      patch.hadReadySession !== undefined ? patch.hadReadySession : current.hadReadySession,
    lastAlertSentAtMs:
      patch.lastAlertSentAtMs !== undefined ? patch.lastAlertSentAtMs : current.lastAlertSentAtMs,
  };
  await writeState(next);
  return next;
}
