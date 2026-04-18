/**
 * Fetches the supplier or buyer roster from Sabai and decrypts the AES-256-GCM
 * ciphertext locally. Both rosters travel over HTTPS with X-BYOS-API-Key auth
 * and are opaque to Sabai's DB — Sabai never sees the plaintext names.
 */
import { config } from "./config";
import { decryptContactName } from "./relay";

export type ContactKind = "supplier" | "buyer";

export interface ContactRecord {
  id: string;
  canonicalName: string;
  aliases: string[];
  notes?: string;
}

export interface ContactRoster {
  kind: ContactKind;
  updatedAt: string;
  contacts: ContactRecord[];
}

interface SabaiContactRow {
  id: number;
  name: string;
  is_encrypted: boolean;
}

function rosterPath(kind: ContactKind): string {
  return kind === "buyer" ? "/byos/buyers" : "/byos/suppliers";
}

function listKey(kind: ContactKind): "suppliers" | "buyers" {
  return kind === "buyer" ? "buyers" : "suppliers";
}

/** Fetch a roster (supplier or buyer) from Sabai and decrypt the names. */
export async function fetchRoster(kind: ContactKind): Promise<ContactRoster> {
  const url = `${config.sabaiBaseUrl}${rosterPath(kind)}`;
  const response = await fetch(url, {
    headers: { "X-BYOS-API-Key": config.sabaiApiKey },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${kind} roster from Sabai (${response.status}): ${await response.text()}`,
    );
  }
  const data = (await response.json()) as Record<string, SabaiContactRow[]>;
  const rows = data[listKey(kind)] ?? [];
  // Decrypt row-by-row so a single bad ciphertext (e.g. row written under a
  // different SECRET_ENCRYPTION_KEY) doesn't poison the whole batch. Bad rows
  // are dropped from the roster and logged with their id for triage.
  const contacts: ContactRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    let name: string;
    if (row.is_encrypted) {
      try {
        name = decryptContactName(row.name);
      } catch (error) {
        skipped += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[byos:roster] decrypt_failed kind=${kind} id=${row.id}: ${message} `
            + "— check SECRET_ENCRYPTION_KEY matches the key used to encrypt this row",
        );
        continue;
      }
    } else {
      name = row.name;
    }
    contacts.push({ id: String(row.id), canonicalName: name, aliases: [] });
  }
  if (skipped > 0) {
    console.warn(
      `[byos:roster] dropped ${skipped}/${rows.length} ${kind} row(s) due to decrypt errors; `
        + "redaction will fall back to heuristics and may miss matches for those contacts",
    );
  }
  return { kind, updatedAt: new Date().toISOString(), contacts };
}
