/**
 * On-disk archive of every inbound offer list (email and WhatsApp batch) in
 * fully unredacted native form. Retains the last `config.archiveKeep` entries
 * (configurable via the BYOS_ARCHIVE_KEEP env var, default 100).
 *
 * Storage layout:
 *   <archiveDir>/<id>/meta.json           — full payload + attachment index
 *   <archiveDir>/<id>/attachments/<name>  — decoded attachment bytes
 *
 * IDs are monotonically increasing integers derived from the directory listing
 * alone — no separate counter file. The `enqueue` helper serializes all writes
 * so only one archive operation runs at a time, eliminating any race between
 * readdir and mkdir. BYOS is a single Node.js process, so no cross-process
 * locking is needed.
 */
import { createReadStream, type ReadStream } from "fs";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

import { config } from "./config";
import type { ContactKind } from "./roster";
import type { InboundEmail } from "./smtp";
import type { RelayedAttachment } from "./relay";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface ArchiveOutcome {
  senderAccepted: boolean;
  rejectReason?: string;
  contactMatch?: { kind: ContactKind; confidence?: number };
  unmatchedReason?: string;
}

/** The shape passed to onBatch in index.ts (mirrors whatsapp.ts startWhatsAppService signature). */
export interface WhatsAppBatchPayload {
  from: string;
  to?: string;
  text: string;
  messages: Array<Record<string, unknown>>;
  attachments: RelayedAttachment[];
  metadata: Record<string, unknown>;
}

interface ArchivedAttachment {
  /** Original filename as received from the sender. */
  filename: string | undefined;
  contentType: string;
  sizeBytes: number | undefined;
  contentId: string | undefined;
  /** Sanitized, collision-free name used on disk. */
  storedAs: string;
}

interface ArchivedEmailMeta {
  id: number;
  channel: "email";
  receivedAt: string;
  kind: string;
  localPart: string;
  from: string;
  to: string | undefined;
  subject: string | undefined;
  text: string | undefined;
  html: string | undefined;
  attachments: ArchivedAttachment[];
  outcome: ArchiveOutcome;
}

interface ArchivedWhatsAppMeta {
  id: number;
  channel: "whatsapp";
  receivedAt: string;
  from: string;
  to: string | undefined;
  text: string | undefined;
  messages: Array<Record<string, unknown>>;
  attachments: ArchivedAttachment[];
  metadata: Record<string, unknown>;
  outcome: ArchiveOutcome;
}

export type ArchivedMeta = ArchivedEmailMeta | ArchivedWhatsAppMeta;

export interface ArchiveListItem {
  id: number;
  channel: string;
  receivedAt: string;
  from: string;
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function entryDir(id: number): string {
  return path.join(config.archiveDir, String(id));
}

function attachmentsDir(id: number): string {
  return path.join(entryDir(id), "attachments");
}

/** Sanitize a filename to filesystem-safe chars, disambiguating collisions. */
function safeFilename(raw: string | undefined, idx: number, used: Set<string>): string {
  const base = raw ? path.basename(raw) : `attachment-${idx}`;
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_") || `attachment-${idx}`;
  let candidate = safe;
  let suffix = 0;
  while (used.has(candidate)) {
    suffix++;
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length) || `attachment-${idx}`;
    candidate = `${stem}_${suffix}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/** Parse all numeric directory names inside archiveDir. */
async function readIds(): Promise<number[]> {
  await mkdir(config.archiveDir, { recursive: true });
  const entries = await readdir(config.archiveDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => Number.parseInt(e.name, 10));
}

/** Allocate the next ID and create its directory. */
async function nextIdAndMkdir(): Promise<number> {
  const ids = await readIds();
  const next = ids.length === 0 ? 1 : Math.max(...ids) + 1;
  try {
    await mkdir(entryDir(next), { recursive: false });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Defensive: the serialized chain makes this path unreachable in normal
      // operation. If it ever fires, bump once and retry.
      const retry = next + 1;
      await mkdir(entryDir(retry), { recursive: false });
      return retry;
    }
    throw err;
  }
  return next;
}

/** Remove all archive entries beyond the newest `config.archiveKeep`. */
async function pruneOldEntries(): Promise<void> {
  const keep = Math.max(0, config.archiveKeep);
  const ids = await readIds();
  if (ids.length <= keep) return;
  ids.sort((a, b) => b - a); // descending — keep the highest IDs
  const toDelete = ids.slice(keep);
  await Promise.all(toDelete.map((id) => rm(entryDir(id), { recursive: true, force: true })));
}

/** Write decoded attachment bytes to disk; return metadata for meta.json. */
async function writeAttachments(
  id: number,
  attachments: RelayedAttachment[],
): Promise<ArchivedAttachment[]> {
  if (attachments.length === 0) return [];
  await mkdir(attachmentsDir(id), { recursive: true });
  const used = new Set<string>();
  const archived: ArchivedAttachment[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const storedAs = safeFilename(a.filename, i, used);
    await writeFile(path.join(attachmentsDir(id), storedAs), Buffer.from(a.contentBase64, "base64"));
    archived.push({
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      contentId: a.contentId,
      storedAs,
    });
  }
  return archived;
}

/**
 * Serialize all archive writes so the readdir → mkdir step is never concurrent.
 * `chain` is a resolved-only promise — errors are forwarded to callers via `reject`
 * rather than letting the chain reject and silencing future writes.
 */
let chain: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const prev = chain;
    chain = new Promise<void>((chainResolve) => {
      prev.finally(() => {
        fn().then(
          (v) => { resolve(v); chainResolve(); },
          (e) => { reject(e); chainResolve(); },
        );
      });
    });
  });
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export async function archiveEmail(email: InboundEmail, outcome: ArchiveOutcome): Promise<number> {
  return enqueue(async () => {
    const id = await nextIdAndMkdir();
    const attachments = await writeAttachments(id, email.attachments);
    const meta: ArchivedEmailMeta = {
      id,
      channel: "email",
      receivedAt: new Date().toISOString(),
      kind: email.kind,
      localPart: email.localPart,
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments,
      outcome,
    };
    await writeFile(path.join(entryDir(id), "meta.json"), JSON.stringify(meta, null, 2));
    await pruneOldEntries();
    return id;
  });
}

export async function archiveWhatsApp(
  batch: WhatsAppBatchPayload,
  outcome: ArchiveOutcome,
): Promise<number> {
  return enqueue(async () => {
    const id = await nextIdAndMkdir();
    const attachments = await writeAttachments(id, batch.attachments);
    const meta: ArchivedWhatsAppMeta = {
      id,
      channel: "whatsapp",
      receivedAt: new Date().toISOString(),
      from: batch.from,
      to: batch.to,
      text: batch.text,
      messages: batch.messages,
      attachments,
      metadata: batch.metadata,
      outcome,
    };
    await writeFile(path.join(entryDir(id), "meta.json"), JSON.stringify(meta, null, 2));
    await pruneOldEntries();
    return id;
  });
}

export async function readArchiveMeta(id: number): Promise<ArchivedMeta | null> {
  try {
    const raw = await readFile(path.join(entryDir(id), "meta.json"), "utf-8");
    return JSON.parse(raw) as ArchivedMeta;
  } catch {
    return null;
  }
}

export async function listArchive(): Promise<ArchiveListItem[]> {
  const ids = await readIds();
  ids.sort((a, b) => b - a); // newest first
  const items: ArchiveListItem[] = [];
  for (const id of ids) {
    const meta = await readArchiveMeta(id);
    if (meta) {
      items.push({ id: meta.id, channel: meta.channel, receivedAt: meta.receivedAt, from: meta.from });
    }
  }
  return items;
}

export async function openArchiveAttachment(
  id: number,
  storedAs: string,
): Promise<{ stream: ReadStream; contentType: string; sizeBytes: number | undefined } | null> {
  const meta = await readArchiveMeta(id);
  if (!meta) return null;
  // Only known storedAs values are allowed — prevents path traversal.
  const entry = meta.attachments.find((a) => a.storedAs === storedAs);
  if (!entry) return null;
  try {
    const filePath = path.join(attachmentsDir(id), storedAs);
    const stream = createReadStream(filePath);
    return { stream, contentType: entry.contentType, sizeBytes: entry.sizeBytes };
  } catch {
    return null;
  }
}
