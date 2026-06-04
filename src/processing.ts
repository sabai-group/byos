/**
 * In-memory registry of offer lists currently being processed by BYOS.
 *
 * An entry is added the moment an inbound email or WhatsApp batch enters the
 * handler in `index.ts` and removed once that handler returns — including the
 * archive write. The portal polls `/api/processing` to render spinners next
 * to each in-flight item.
 *
 * State is intentionally process-local: BYOS is a single Node.js process so
 * there is no need for cross-process coordination, and a restart legitimately
 * loses in-flight work (the sender's MTA / WhatsApp client will retry).
 */

export interface ProcessingItem {
  token: number;
  channel: "email" | "whatsapp";
  /** Display label: email subject or WhatsApp text preview. */
  subject: string;
  from: string;
  startedAt: string;
}

let nextToken = 0;
const items = new Map<number, ProcessingItem>();

export function startProcessing(
  entry: Omit<ProcessingItem, "token" | "startedAt">,
): number {
  const token = ++nextToken;
  items.set(token, { ...entry, token, startedAt: new Date().toISOString() });
  return token;
}

export function endProcessing(token: number): void {
  items.delete(token);
}

export function listProcessing(): ProcessingItem[] {
  return Array.from(items.values()).sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
}
