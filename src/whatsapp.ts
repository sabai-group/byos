import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import QRCode from "qrcode";
import { Client, LocalAuth, type Message } from "whatsapp-web.js";

import { config } from "./config";
import type { RelayedAttachment } from "./relay";

const execFileAsync = promisify(execFile);

/**
 * When `true`, inbound senders using Linked IDs (`*@lid`) are mapped to phone JIDs (`*@c.us`)
 * where WhatsApp Web exposes the mapping. When `false`, wire IDs are kept as-is.
 *
 * Re-enable: set to `true` (or swap which line is commented below).
 */
// const RESOLVE_WHATSAPP_LID_TO_PHONE_JID = true;
const RESOLVE_WHATSAPP_LID_TO_PHONE_JID = false;

async function resolveLidToPhoneJid(client: Client, jid: string): Promise<string> {
  if (!jid.endsWith("@lid")) {
    return jid;
  }
  try {
    const rows = await client.getContactLidAndPhone([jid]);
    const pn = rows[0]?.pn;
    if (pn && typeof pn === "string") {
      return pn;
    }
  } catch (error) {
    console.warn("[byos:whatsapp] Failed to resolve @lid to phone JID", jid, error);
  }
  return jid;
}

type InboundWhatsAppSenderResolution = {
  senderJid: string;
  batchKey: string;
  batchFrom: string;
  /** Original wire JID when it differed after LID→phone resolution (logging only). */
  fromWire?: string;
};

/**
 * Derives batch key, relay `from`, and per-message sender id from a `message` event.
 * LID→phone resolution is applied only when {@link RESOLVE_WHATSAPP_LID_TO_PHONE_JID} is on.
 */
async function resolveInboundWhatsAppSender(client: Client, message: Message): Promise<InboundWhatsAppSenderResolution> {
  const isGroup = message.from.endsWith("@g.us");
  const senderWire = isGroup ? (message.author || message.from) : message.from;

  let senderJid = senderWire;
  if (RESOLVE_WHATSAPP_LID_TO_PHONE_JID) {
    senderJid = await resolveLidToPhoneJid(client, senderWire);
  }

  const batchKey = isGroup ? message.from : senderJid;
  const batchFrom = isGroup ? message.from : senderJid;
  const fromWire =
    RESOLVE_WHATSAPP_LID_TO_PHONE_JID && senderWire !== senderJid ? senderWire : undefined;

  return { senderJid, batchKey, batchFrom, fromWire };
}

interface WhatsAppBatch {
  from: string;
  to?: string;
  messages: Array<Record<string, unknown>>;
  attachments: RelayedAttachment[];
  timer?: NodeJS.Timeout;
}

export interface WhatsAppService {
  requestQrEmail: () => Promise<void>;
  forceQrForWeb: () => Promise<WhatsAppLinkState>;
  getLinkState: () => WhatsAppLinkState;
  shutdown: () => Promise<void>;
}

export interface WhatsAppLinkState {
  ready: boolean;
  /** Phone accepted the QR (authenticated) but WhatsApp client has not emitted `ready` yet. */
  pairing: boolean;
  /** True while “Force New QR” is tearing down the client and wiping disk session data. */
  resetting: boolean;
  qrAvailable: boolean;
  qrDataUrl: string | null;
  waitingForQr: boolean;
  status: string;
  lastEvent: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  browserVersion: string | null;
  userAgent: string | null;
  authPath: string;
  headless: boolean;
  locale: string;
  timezone: string;
  artifactsDir: string;
  lastScreenshotPath: string | null;
  lastHtmlPath: string | null;
}

export async function startWhatsAppService(options: {
  onBatch: (batch: { from: string; to?: string; text: string; messages: Array<Record<string, unknown>>; attachments: RelayedAttachment[]; metadata: Record<string, unknown> }) => Promise<void>;
  onQrReady: (qrDataUrl: string) => Promise<void>;
}): Promise<WhatsAppService> {
  const batches = new Map<string, WhatsAppBatch>();
  const pendingQrWaiters = new Set<(state: WhatsAppLinkState) => void>();
  const pendingStartupStateChecks = new Set<() => void>();

  let client: Client | null = null;
  let latestQrDataUrl: string | null = null;
  let emailQrRequested = false;
  let isReady = false;
  /** True after `authenticated` until `ready` (or reset by qr / failure / disconnect). */
  let pairingInProgress = false;
  let forceResetInProgress = false;
  let status = "initializing";
  let lastEvent: string | null = null;
  let lastEventAt: string | null = null;
  let lastError: string | null = null;
  let browserVersion: string | null = null;
  let userAgent: string | null = null;
  let lastScreenshotPath: string | null = null;
  let lastHtmlPath: string | null = null;

  interface AuthStoreSnapshot {
    exists: boolean;
    rootEntries: string[];
    sessionEntries: string[];
  }

  async function ensureArtifactsDir(): Promise<void> {
    await fs.mkdir(config.whatsappArtifactsDir, { recursive: true });
  }

  async function removeIfExists(targetPath: string): Promise<boolean> {
    try {
      await fs.rm(targetPath, { force: true, recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove every entry inside `dirPath` but not `dirPath` itself.
   * Docker named volumes mount at `WHATSAPP_AUTH_PATH`; deleting that path hits EBUSY — only children are safe to remove.
   */
  async function emptyDirectoryContents(dirPath: string): Promise<void> {
    let entries: Array<{ name: string }>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await fs.mkdir(dirPath, { recursive: true });
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      await fs.rm(path.join(dirPath, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });
    }
  }

  /**
   * Wipe persisted Chromium / LocalAuth data. Only clears *contents* of the auth root (volume mount safe).
   */
  async function wipeWhatsAppAuthRoot(rootPath: string): Promise<{ ok: boolean; error?: string }> {
    let lastError: string | undefined;
    const delaysMs = [0, 500, 1500];
    for (const delay of delaysMs) {
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        await emptyDirectoryContents(rootPath);
        return { ok: true };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      await execFileAsync("find", [rootPath, "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+"], {
        timeout: 120_000,
      });
      return { ok: true };
    } catch (error) {
      const fallbackMsg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `${lastError ?? "emptyDirectoryContents failed"} | find+rm: ${fallbackMsg}` };
    }
  }

  /** Matches `LocalAuth` + `clientId: "default"` → `session-default` as Puppeteer userDataDir. */
  const LOCAL_AUTH_SESSION_DIR = "session-default";

  /**
   * Remove Chromium singleton lock files only at the profile root (userDataDir).
   * Recursive deletion elsewhere is unnecessary and can interact badly with deep profile trees on volumes.
   */
  async function cleanupStaleChromiumLocksAtProfileRoot(sessionRoot: string): Promise<string[]> {
    const removed: string[] = [];
    const lockFileNames = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]);
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = (await fs.readdir(sessionRoot, { withFileTypes: true })) as Array<{
        name: string;
        isDirectory: () => boolean;
      }>;
    } catch {
      return removed;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!lockFileNames.has(entry.name)) continue;
      const fullPath = path.join(sessionRoot, entry.name);
      const removedThis = await removeIfExists(fullPath);
      if (removedThis) removed.push(fullPath);
    }
    return removed;
  }

  async function inspectAuthStore(rootPath: string): Promise<AuthStoreSnapshot> {
    const snapshot: AuthStoreSnapshot = {
      exists: false,
      rootEntries: [],
      sessionEntries: [],
    };
    try {
      const rootEntries = await fs.readdir(rootPath, { withFileTypes: true });
      snapshot.exists = true;
      snapshot.rootEntries = rootEntries.map((entry) => entry.name).sort();
      const sessionPath = path.join(rootPath, LOCAL_AUTH_SESSION_DIR);
      const sessionEntries = await fs.readdir(sessionPath, { withFileTypes: true }).catch(() => []);
      snapshot.sessionEntries = sessionEntries.map((entry) => entry.name).sort();
    } catch {
      return snapshot;
    }
    return snapshot;
  }

  async function appendDebugLog(event: string, details?: Record<string, unknown>): Promise<void> {
    if (!config.whatsappDebug) return;
    await ensureArtifactsDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), event, details: details ?? {} });
    await fs.appendFile(path.join(config.whatsappArtifactsDir, "events.log"), `${line}\n`, "utf8");
  }

  function getLinkState(): WhatsAppLinkState {
    return {
      ready: isReady,
      pairing: pairingInProgress && !isReady,
      resetting: forceResetInProgress,
      qrAvailable: Boolean(latestQrDataUrl),
      qrDataUrl: latestQrDataUrl,
      waitingForQr: !isReady && !latestQrDataUrl && emailQrRequested,
      status,
      lastEvent,
      lastEventAt,
      lastError,
      browserVersion,
      userAgent,
      authPath: config.whatsappAuthPath,
      headless: config.whatsappHeadless,
      locale: config.whatsappLocale,
      timezone: config.whatsappTimezone,
      artifactsDir: config.whatsappArtifactsDir,
      lastScreenshotPath,
      lastHtmlPath,
    };
  }

  function resolvePendingQrWaiters(): void {
    const state = getLinkState();
    for (const resolve of pendingQrWaiters) {
      resolve(state);
    }
    pendingQrWaiters.clear();
  }

  function markEvent(event: string, details?: Record<string, unknown>): void {
    lastEvent = event;
    lastEventAt = new Date().toISOString();
    console.log(`[byos:whatsapp] ${event}`, details ?? "");
    void appendDebugLog(event, details).catch((error) =>
      console.error("Failed to persist WhatsApp debug log", error),
    );
    resolvePendingQrWaiters();
    for (const wake of pendingStartupStateChecks) {
      wake();
    }
  }

  async function captureBrowserArtifacts(reason: string): Promise<void> {
    try {
      await ensureArtifactsDir();
      if (!client) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const anyClient = client as unknown as {
        pupPage?: {
          screenshot: (options: { path: string; fullPage: boolean }) => Promise<void>;
          content: () => Promise<string>;
          url: () => string;
          title: () => Promise<string>;
        };
      };
      const page = anyClient.pupPage;
      if (!page) return;
      const screenshotPath = path.join(config.whatsappArtifactsDir, `${timestamp}-${reason}.png`);
      const htmlPath = path.join(config.whatsappArtifactsDir, `${timestamp}-${reason}.html`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await fs.writeFile(htmlPath, await page.content(), "utf8");
      lastScreenshotPath = screenshotPath;
      lastHtmlPath = htmlPath;
      markEvent("artifacts_saved", {
        reason,
        screenshotPath,
        htmlPath,
        pageUrl: page.url(),
        pageTitle: await page.title(),
      });
    } catch (error) {
      console.error("Failed to capture WhatsApp browser artifacts", error);
    }
  }

  async function flushBatch(batchKey: string): Promise<void> {
    const batch = batches.get(batchKey);
    if (!batch) return;
    batches.delete(batchKey);
    const text = batch.messages
      .map((message) => (typeof message.text === "string" ? message.text : ""))
      .filter(Boolean)
      .join("\n\n");
    await options.onBatch({
      from: batch.from,
      to: batch.to,
      text,
      messages: batch.messages,
      attachments: batch.attachments,
      metadata: {
        waid: batch.from.replace(/\D/g, "") || "redacted",
      },
    });
  }

  function buildClient(): Client {
    const puppeteerArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      `--lang=${config.whatsappLocale}`,
    ];
    if (config.whatsappUserAgent) {
      puppeteerArgs.push(`--user-agent=${config.whatsappUserAgent}`);
    }

    return new Client({
      userAgent: config.whatsappUserAgent,
      authStrategy: new LocalAuth({
        dataPath: config.whatsappAuthPath,
        clientId: "default",
      }),
      puppeteer: {
        headless: config.whatsappHeadless,
        executablePath: config.puppeteerExecutablePath,
        defaultViewport: {
          width: config.whatsappViewportWidth,
          height: config.whatsappViewportHeight,
        },
        args: puppeteerArgs,
        dumpio: config.whatsappDebug,
        // Puppeteer defaults to closing the browser on SIGINT/SIGTERM. That races with our
        // graceful shutdown and often corrupts the Chromium userDataDir on Docker volumes.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
    });
  }

  function attachClientListeners(activeClient: Client): void {
    activeClient.on("qr", async (qr: string) => {
      isReady = false;
      pairingInProgress = false;
      status = "qr_ready";
      latestQrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M" });
      lastError = null;
      markEvent("qr", { qrLength: qr.length });
      if (emailQrRequested) {
        emailQrRequested = false;
        await options.onQrReady(latestQrDataUrl);
      }
    });

    activeClient.on("authenticated", () => {
      status = "authenticated";
      lastError = null;
      pairingInProgress = true;
      // Phone accepted the link — hide QR in the UI immediately; avoid a stale/broken image while Store syncs.
      latestQrDataUrl = null;
      markEvent("authenticated");
    });

    activeClient.on("ready", () => {
      isReady = true;
      pairingInProgress = false;
      status = "ready";
      latestQrDataUrl = null;
      emailQrRequested = false;
      lastError = null;
      markEvent("ready");
    });

    activeClient.on("change_state", (state: string) => {
      status = `state:${state}`;
      markEvent("change_state", { state });
    });

    activeClient.on("loading_screen", (percent: number, message: string) => {
      status = `loading:${percent}`;
      markEvent("loading_screen", { percent, message });
    });

    activeClient.on("disconnected", (reason: string) => {
      isReady = false;
      pairingInProgress = false;
      status = "disconnected";
      latestQrDataUrl = null;
      lastError = reason || "Disconnected";
      markEvent("disconnected", { reason });
      void captureBrowserArtifacts("disconnected");
    });

    activeClient.on("auth_failure", (message: string) => {
      isReady = false;
      pairingInProgress = false;
      status = "auth_failure";
      latestQrDataUrl = null;
      lastError = message || "Authentication failed";
      markEvent("auth_failure", { message });
      void captureBrowserArtifacts("auth_failure");
    });

    activeClient.on("message", async (message: Message) => {
      if (message.fromMe || message.from === "status@broadcast") {
        return;
      }

      const { senderJid, batchKey, batchFrom, fromWire } = await resolveInboundWhatsAppSender(activeClient, message);

      const inboundTimestamp = new Date((message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      console.log(
        "[byos:whatsapp:inbound]",
        JSON.stringify({
          from: senderJid,
          ...(fromWire ? { fromWire } : {}),
          to: message.to,
          timestamp: inboundTimestamp,
          type: message.type,
          hasMedia: message.hasMedia,
          body: message.body ?? "",
        }),
      );
      markEvent("inbound_message", {
        from: senderJid,
        ...(fromWire ? { fromWire } : {}),
        to: message.to,
        timestamp: inboundTimestamp,
        type: message.type,
        hasMedia: message.hasMedia,
        body: message.body ?? "",
      });

      const existing = batches.get(batchKey);
      if (existing?.timer) {
        clearTimeout(existing.timer);
      }

      const attachments = existing?.attachments ?? [];
      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          if (media?.data) {
            attachments.push({
              contentBase64: media.data,
              contentType: media.mimetype ?? "application/octet-stream",
            });
          }
        } catch (error) {
          console.error("[byos:whatsapp] Failed to download media, skipping attachment", error);
        }
      }

      const batch: WhatsAppBatch = {
        from: batchFrom,
        to: (message.to as string | undefined) ?? undefined,
        messages: [
          ...(existing?.messages ?? []),
          {
            from: senderJid,
            to: message.to,
            text: message.body ?? "",
            timestamp: inboundTimestamp,
            type: message.type,
            hasMedia: message.hasMedia,
          },
        ],
        attachments,
      };

      batch.timer = setTimeout(() => {
        void flushBatch(batchKey).catch((error) => console.error("Failed to flush WhatsApp batch", error));
      }, config.whatsappDebounceMs);
      batches.set(batchKey, batch);
    });
  }

  async function postInitialize(activeClient: Client): Promise<void> {
    const anyClient = activeClient as unknown as {
      pupBrowser?: { version: () => Promise<string> };
      pupPage?: {
        setUserAgent: (value: string) => Promise<void>;
        setViewport: (value: { width: number; height: number }) => Promise<void>;
        setExtraHTTPHeaders: (value: Record<string, string>) => Promise<void>;
        emulateTimezone: (value: string) => Promise<void>;
        evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
        on: (event: string, handler: (...args: any[]) => void) => void;
        url: () => string;
      };
    };
    if (anyClient.pupBrowser) {
      browserVersion = await anyClient.pupBrowser.version();
      markEvent("browser_version", { browserVersion });
    }
    if (anyClient.pupPage) {
      if (config.whatsappUserAgent) {
        await anyClient.pupPage.setUserAgent(config.whatsappUserAgent);
      }
      await anyClient.pupPage.setViewport({
        width: config.whatsappViewportWidth,
        height: config.whatsappViewportHeight,
      });
      await anyClient.pupPage.setExtraHTTPHeaders({
        "Accept-Language": `${config.whatsappLocale},en;q=0.9`,
      });
      try {
        await anyClient.pupPage.emulateTimezone(config.whatsappTimezone);
      } catch (error) {
        markEvent("timezone_emulation_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      userAgent = await anyClient.pupPage.evaluate(() => navigator.userAgent);
      markEvent("page_identity", {
        userAgent,
        pageUrl: anyClient.pupPage.url(),
      });
      anyClient.pupPage.on("console", (...args: any[]) => {
        const first = args[0];
        console.log("[byos:whatsapp:console]", first?.text?.() ?? "");
      });
      anyClient.pupPage.on("pageerror", (error: Error) => {
        lastError = error.message;
        markEvent("page_error", { error: error.message });
      });
      anyClient.pupPage.on(
        "requestfailed",
        (request: { url: () => string; failure: () => { errorText?: string } | null }) => {
          markEvent("request_failed", {
            url: request.url(),
            error: request.failure()?.errorText ?? "unknown",
          });
        },
      );
    }
  }

  async function initializeClient(): Promise<void> {
    await ensureArtifactsDir();
    const sessionRoot = path.join(config.whatsappAuthPath, LOCAL_AUTH_SESSION_DIR);
    const removedLocks = await cleanupStaleChromiumLocksAtProfileRoot(sessionRoot);
    if (removedLocks.length > 0) {
      markEvent("stale_profile_locks_removed", { removedLocks });
    }
    markEvent("launch_config", {
      headless: config.whatsappHeadless,
      executablePath: config.puppeteerExecutablePath ?? "default",
      authPath: config.whatsappAuthPath,
      locale: config.whatsappLocale,
      timezone: config.whatsappTimezone,
      viewport: `${config.whatsappViewportWidth}x${config.whatsappViewportHeight}`,
      userAgent: config.whatsappUserAgent || "default",
      puppeteerHandlesSignals: false,
    });

    client = buildClient();
    attachClientListeners(client);
    try {
      await client.initialize();
      await postInitialize(client);
    } catch (error) {
      status = "launch_failed";
      lastError = error instanceof Error ? error.message : String(error);
      markEvent("initialize_failed", { error: lastError });
      await captureBrowserArtifacts("initialize_failed");
      throw error;
    }
  }

  async function destroyCurrentClient(options?: { logout?: boolean }): Promise<void> {
    if (!client) return;
    try {
      const maybeLogout = client as unknown as { logout?: () => Promise<void> };
      // Do not gate on `isReady`: callers (e.g. force-reset) clear that flag for the UI before destroy,
      // but we still need server-side logout + LocalAuth cleanup when there was an active session.
      if (options?.logout && maybeLogout.logout) {
        await maybeLogout.logout().catch(() => undefined);
      }
    } catch {
      // ignore logout failures; destroy still follows
    }
    await client.destroy().catch(() => undefined);
    client = null;
    // Give the volume/filesystem time to flush Chromium profile writes (notably IndexedDB).
    await new Promise((r) => setTimeout(r, 1000));
  }

  async function waitForQrState(timeoutMs = 15000): Promise<WhatsAppLinkState> {
    const immediate = getLinkState();
    if (immediate.ready || immediate.pairing || immediate.qrAvailable || immediate.lastError) {
      return immediate;
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingQrWaiters.delete(onResolve);
        resolve(getLinkState());
      }, timeoutMs);
      const onResolve = (state: WhatsAppLinkState) => {
        clearTimeout(timeout);
        pendingQrWaiters.delete(onResolve);
        resolve(state);
      };
      pendingQrWaiters.add(onResolve);
    });
  }

  function getStartupRestoreOutcome(): "restored" | "relink_required" | "failed" | null {
    if (isReady) {
      return "restored";
    }
    if (latestQrDataUrl || lastEvent === "qr") {
      return "relink_required";
    }
    if (status === "auth_failure" || status === "disconnected" || status === "launch_failed") {
      return "failed";
    }
    if (lastEvent === "auth_failure" || lastEvent === "disconnected" || lastEvent === "initialize_failed") {
      return "failed";
    }
    return null;
  }

  async function waitForStartupRestoreOutcome(timeoutMs = 20000): Promise<"restored" | "relink_required" | "failed" | "timeout"> {
    const immediate = getStartupRestoreOutcome();
    if (immediate) {
      return immediate;
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingStartupStateChecks.delete(onWake);
        resolve("timeout");
      }, timeoutMs);
      const onWake = () => {
        const outcome = getStartupRestoreOutcome();
        if (!outcome) {
          return;
        }
        clearTimeout(timeout);
        pendingStartupStateChecks.delete(onWake);
        resolve(outcome);
      };
      pendingStartupStateChecks.add(onWake);
    });
  }

  async function confirmStartupRestore(authStoreBeforeLaunch: AuthStoreSnapshot): Promise<void> {
    markEvent("auth_store_snapshot", { ...authStoreBeforeLaunch });

    const hadPersistedProfile =
      authStoreBeforeLaunch.exists && authStoreBeforeLaunch.sessionEntries.length > 0;
    // Cold start shows a QR quickly; an existing profile may sit on loading/sync longer than 20s.
    const startupWaitMs = hadPersistedProfile ? 120_000 : 25_000;
    const outcome = await waitForStartupRestoreOutcome(startupWaitMs);
    if (outcome === "restored") {
      markEvent("startup_restore_confirmed", {
        hadPersistedSession: authStoreBeforeLaunch.sessionEntries.length > 0,
      });
      return;
    }
    if (outcome === "relink_required") {
      markEvent("startup_restore_failed_relink_required", {
        hadPersistedSession: authStoreBeforeLaunch.sessionEntries.length > 0,
        authStore: authStoreBeforeLaunch,
      });
      return;
    }
    if (outcome === "failed") {
      markEvent("startup_restore_failed", {
        hadPersistedSession: authStoreBeforeLaunch.sessionEntries.length > 0,
        authStore: authStoreBeforeLaunch,
        status,
        lastError,
      });
      return;
    }
    markEvent("startup_restore_timed_out", {
      hadPersistedSession: authStoreBeforeLaunch.sessionEntries.length > 0,
      authStore: authStoreBeforeLaunch,
      status,
      lastEvent,
    });
  }

  const authStoreBeforeLaunch = await inspectAuthStore(config.whatsappAuthPath);
  await initializeClient();
  await confirmStartupRestore(authStoreBeforeLaunch);

  return {
    async requestQrEmail() {
      if (latestQrDataUrl) {
        await options.onQrReady(latestQrDataUrl);
        return;
      }
      emailQrRequested = true;
      status = "waiting_for_qr";
      markEvent("request_qr_email");
    },
    async forceQrForWeb() {
      const hadActiveSession = isReady;
      forceResetInProgress = true;
      status = "resetting_for_new_qr";
      lastError = null;
      latestQrDataUrl = null;
      browserVersion = null;
      userAgent = null;
      isReady = false;
      pairingInProgress = false;
      emailQrRequested = false;
      markEvent("force_new_qr_requested", { hadActiveSession });
      try {
        await destroyCurrentClient({ logout: hadActiveSession });
        const wipe = await wipeWhatsAppAuthRoot(config.whatsappAuthPath);
        markEvent("session_auth_path_cleared", { authPath: config.whatsappAuthPath, wipeOk: wipe.ok });
        if (!wipe.ok) {
          lastError = wipe.error ?? "Failed to wipe WhatsApp session directory (check volume permissions).";
          status = "session_wipe_failed";
          markEvent("session_auth_wipe_failed", { authPath: config.whatsappAuthPath, error: wipe.error });
        }
        await initializeClient();
      } finally {
        forceResetInProgress = false;
      }
      return waitForQrState();
    },
    getLinkState,
    async shutdown() {
      for (const batch of batches.values()) {
        if (batch.timer) {
          clearTimeout(batch.timer);
        }
      }
      batches.clear();
      pendingQrWaiters.clear();
      await destroyCurrentClient();
    },
  };
}
