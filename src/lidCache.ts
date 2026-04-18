/**
 * Disk-backed cache mapping WhatsApp Linked IDs (`*@lid`) to phone JIDs (`*@c.us`).
 *
 * This cache MUST survive `forceQrForWeb` session wipes: the `.wwebjs_auth` tree
 * is cleared on re-link, but an `@lid` never changes for a given user's account,
 * so the cached mapping stays valid across re-links and speeds up resolution.
 * Keep `lid-cache.json` out of anything `wipeWhatsAppAuthRoot` touches.
 *
 * On-disk format: `{ [lid: string]: LidCacheEntry }` persisted as JSON. Writes
 * are atomic (write `lid-cache.json.tmp`, then rename over the target).
 */
import * as fsSync from "fs";
import path from "path";

export interface LidCacheEntry {
  phoneJid: string;
  firstSeenTs: number;
  lastConfirmedTs: number;
  source: string;
}

export interface LidCache {
  get(lid: string): string | undefined;
  set(lid: string, phoneJid: string, source: string): void;
  refreshIfStale(lid: string, maxAgeMs: number): boolean;
  /** Full entry (for stale-check + remap logging). */
  getEntry(lid: string): LidCacheEntry | undefined;
}

const CACHE_FILENAME = "lid-cache.json";

function logWarn(message: string, details?: Record<string, unknown>): void {
  console.warn(`[byos:lidCache] ${message}`, details ?? "");
}

function readInitial(filePath: string): Record<string, LidCacheEntry> {
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logWarn("malformed_cache_ignored", { filePath, reason: "not_object" });
      return {};
    }
    const result: Record<string, LidCacheEntry> = {};
    for (const [lid, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<LidCacheEntry>;
      if (
        typeof entry.phoneJid !== "string" ||
        typeof entry.firstSeenTs !== "number" ||
        typeof entry.lastConfirmedTs !== "number" ||
        typeof entry.source !== "string"
      ) {
        continue;
      }
      result[lid] = {
        phoneJid: entry.phoneJid,
        firstSeenTs: entry.firstSeenTs,
        lastConfirmedTs: entry.lastConfirmedTs,
        source: entry.source,
      };
    }
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    logWarn("failed_to_load_cache", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export function openLidCache(dir: string): LidCache {
  const filePath = path.join(dir, CACHE_FILENAME);
  const tmpPath = `${filePath}.tmp`;

  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logWarn("failed_to_mkdir_cache_dir", {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const entries: Record<string, LidCacheEntry> = readInitial(filePath);

  function flushToDisk(): void {
    const payload = JSON.stringify(entries, null, 2);
    try {
      fsSync.writeFileSync(tmpPath, payload, "utf8");
      fsSync.renameSync(tmpPath, filePath);
    } catch (error) {
      logWarn("failed_to_persist_cache", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function get(lid: string): string | undefined {
    return entries[lid]?.phoneJid;
  }

  function getEntry(lid: string): LidCacheEntry | undefined {
    return entries[lid];
  }

  function set(lid: string, phoneJid: string, source: string): void {
    const now = Date.now();
    const existing = entries[lid];
    entries[lid] = {
      phoneJid,
      firstSeenTs: existing?.firstSeenTs ?? now,
      lastConfirmedTs: now,
      source,
    };
    flushToDisk();
  }

  function refreshIfStale(lid: string, maxAgeMs: number): boolean {
    const entry = entries[lid];
    if (!entry) return true;
    return Date.now() - entry.lastConfirmedTs > maxAgeMs;
  }

  return { get, set, refreshIfStale, getEntry };
}
