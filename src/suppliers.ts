import { config } from "./config";
import { decryptSupplierName } from "./relay";

export interface SupplierRecord {
  id: string;
  canonicalName: string;
  aliases: string[];
  notes?: string;
}

export interface SupplierRoster {
  updatedAt: string;
  suppliers: SupplierRecord[];
}

interface SabaiSupplierRow {
  id: number;
  name: string;
  is_encrypted: boolean;
}

/** Fetch the supplier roster from Sabai's DB via the /byos/suppliers endpoint. */
export async function fetchRosterFromSabai(): Promise<SupplierRoster> {
  const url = `${config.sabaiBaseUrl}/byos/suppliers`;
  const response = await fetch(url, {
    headers: { "X-BYOS-API-Key": config.sabaiApiKey },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch suppliers from Sabai (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { suppliers: SabaiSupplierRow[] };
  const suppliers: SupplierRecord[] = data.suppliers.map((row) => {
    const name = row.is_encrypted ? decryptSupplierName(row.name) : row.name;
    return {
      id: String(row.id),
      canonicalName: name,
      aliases: [],
    };
  });
  return { updatedAt: new Date().toISOString(), suppliers };
}
