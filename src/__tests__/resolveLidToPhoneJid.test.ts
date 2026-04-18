import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "whatsapp-web.js";

import { openLidCache, type LidCache, type LidCacheEntry } from "../lidCache";
import { LID_CACHE_STALE_MS, resolveLidToPhoneJid } from "../whatsapp";

/**
 * Builds a test Client stub. All four resolution surfaces default to misses; opt-in to the
 * ones you care about per test.
 */
function makeClientStub(overrides: {
  getContactLidAndPhone?: (userIds: string[]) => Promise<Array<{ lid: string; pn: string }>>;
  getContactById?: (contactId: string) => Promise<unknown>;
  pupPage?: { evaluate: (fn: unknown, ...args: unknown[]) => Promise<unknown> } | undefined;
} = {}): Client {
  const stub = {
    getContactLidAndPhone:
      overrides.getContactLidAndPhone ?? vi.fn().mockResolvedValue([]),
    getContactById:
      overrides.getContactById ?? vi.fn().mockResolvedValue(null),
    pupPage: overrides.pupPage,
  };
  return stub as unknown as Client;
}

let tmpDir: string;
let cache: LidCache;

const LID = "111111111111111@lid";
const PHONE = "972501234567@c.us";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "byos-lidcache-"));
  cache = openLidCache(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveLidToPhoneJid", () => {
  it("passes through non-@lid JIDs unchanged", async () => {
    const client = makeClientStub();
    const result = await resolveLidToPhoneJid(client, cache, "972501234567@c.us");
    expect(result).toEqual({
      phoneJid: "972501234567@c.us",
      unresolved: false,
      source: "passthrough",
    });
  });

  it("tier A: returns cached phone JID without calling client", async () => {
    cache.set(LID, PHONE, "tierB");
    const getContactLidAndPhone = vi.fn().mockResolvedValue([{ lid: LID, pn: PHONE }]);
    const getContactById = vi.fn();
    const evaluate = vi.fn();
    const client = makeClientStub({
      getContactLidAndPhone,
      getContactById,
      pupPage: { evaluate },
    });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result).toEqual({ phoneJid: PHONE, unresolved: false, source: "tierA" });
    expect(getContactLidAndPhone).not.toHaveBeenCalled();
    expect(getContactById).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("tier B: uses client.getContactLidAndPhone(pn) and caches as tierB", async () => {
    const getContactLidAndPhone = vi.fn().mockResolvedValue([{ lid: LID, pn: PHONE }]);
    const client = makeClientStub({ getContactLidAndPhone });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result).toEqual({ phoneJid: PHONE, unresolved: false, source: "tierB" });
    expect(getContactLidAndPhone).toHaveBeenCalledTimes(1);
    expect(getContactLidAndPhone).toHaveBeenCalledWith([LID]);
    expect(cache.get(LID)).toBe(PHONE);
    expect(cache.getEntry(LID)?.source).toBe("tierB");
  });

  it("tier B: ignores non-@c.us pn values and falls through", async () => {
    const getContactLidAndPhone = vi.fn().mockResolvedValue([{ lid: LID, pn: "" }]);
    const getContactById = vi.fn().mockResolvedValue({ id: { _serialized: PHONE } });
    const client = makeClientStub({ getContactLidAndPhone, getContactById });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result.source).toBe("tierC");
    expect(result.phoneJid).toBe(PHONE);
  });

  it("tier C: falls through to getContactById using contact.id._serialized", async () => {
    const getContactLidAndPhone = vi.fn().mockResolvedValue([]);
    const getContactById = vi.fn().mockResolvedValue({
      id: { _serialized: PHONE },
      number: "972501234567",
    });
    const client = makeClientStub({ getContactLidAndPhone, getContactById });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result).toEqual({ phoneJid: PHONE, unresolved: false, source: "tierC" });
    expect(getContactById).toHaveBeenCalledWith(LID);
    expect(cache.get(LID)).toBe(PHONE);
  });

  it("tier C: synthesizes @c.us from contact.number when _serialized is absent", async () => {
    const getContactById = vi.fn().mockResolvedValue({
      id: { _serialized: "foo@lid" },
      number: "972501234567",
    });
    const client = makeClientStub({ getContactById });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result).toEqual({
      phoneJid: "972501234567@c.us",
      unresolved: false,
      source: "tierC",
    });
  });

  it("tier C: rejects malformed contact.number", async () => {
    const getContactById = vi.fn().mockResolvedValue({
      id: { _serialized: "foo@lid" },
      number: "not-a-phone",
    });
    const evaluate = vi.fn().mockResolvedValue(null);
    const client = makeClientStub({ getContactById, pupPage: { evaluate } });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result.source).toBe("unresolved");
    expect(result.phoneJid).toBe(LID);
    expect(result.unresolved).toBe(true);
  });

  it("tier D: falls through to pupPage.evaluate(Store.LidUtils...)", async () => {
    const evaluate = vi.fn().mockResolvedValue(PHONE);
    const client = makeClientStub({ pupPage: { evaluate } });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result).toEqual({ phoneJid: PHONE, unresolved: false, source: "tierD" });
    expect(evaluate).toHaveBeenCalledTimes(1);
    // first arg is the function, second is the LID
    expect(evaluate.mock.calls[0][1]).toBe(LID);
    expect(cache.getEntry(LID)?.source).toBe("tierD");
  });

  it("returns LID + unresolvedSender when all four tiers miss", async () => {
    const client = makeClientStub({
      getContactLidAndPhone: vi.fn().mockResolvedValue([]),
      getContactById: vi.fn().mockResolvedValue(null),
      pupPage: { evaluate: vi.fn().mockResolvedValue(null) },
    });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result).toEqual({ phoneJid: LID, unresolved: true, source: "unresolved" });
    expect(cache.get(LID)).toBeUndefined();
  });

  it("swallows tier errors and keeps walking the chain", async () => {
    const client = makeClientStub({
      getContactLidAndPhone: vi.fn().mockRejectedValue(new Error("boom B")),
      getContactById: vi.fn().mockRejectedValue(new Error("boom C")),
      pupPage: { evaluate: vi.fn().mockResolvedValue(PHONE) },
    });

    const result = await resolveLidToPhoneJid(client, cache, LID);

    expect(result.source).toBe("tierD");
    expect(result.phoneJid).toBe(PHONE);
  });

  it("re-resolves on a stale tier A entry (>30 days) via tier B", async () => {
    // Seed a stale entry by writing directly to disk with an old lastConfirmedTs.
    const stalePath = path.join(tmpDir, "lid-cache.json");
    const staleEntry: LidCacheEntry = {
      phoneJid: "999999999@c.us",
      firstSeenTs: Date.now() - LID_CACHE_STALE_MS - 60_000,
      lastConfirmedTs: Date.now() - LID_CACHE_STALE_MS - 60_000,
      source: "tierB",
    };
    await fs.writeFile(stalePath, JSON.stringify({ [LID]: staleEntry }), "utf8");
    const freshCache = openLidCache(tmpDir);
    expect(freshCache.get(LID)).toBe("999999999@c.us");
    expect(freshCache.refreshIfStale(LID, LID_CACHE_STALE_MS)).toBe(true);

    const getContactLidAndPhone = vi.fn().mockResolvedValue([{ lid: LID, pn: PHONE }]);
    const client = makeClientStub({ getContactLidAndPhone });

    const result = await resolveLidToPhoneJid(client, freshCache, LID);

    // Stale entry was ignored and re-resolved via Tier B.
    expect(result).toEqual({ phoneJid: PHONE, unresolved: false, source: "tierB" });
    expect(getContactLidAndPhone).toHaveBeenCalledTimes(1);
    expect(freshCache.get(LID)).toBe(PHONE);
  });

  it("overwrites the cache on LID remap and logs lid_remapped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cache.set(LID, "111@c.us", "tierB");
    const client = makeClientStub({
      getContactLidAndPhone: vi.fn().mockResolvedValue([{ lid: LID, pn: "222@c.us" }]),
    });

    // Force Tier A to be stale so re-resolution runs.
    // We'll mutate the cache's internal entry's lastConfirmedTs through the file + reopen path.
    const entry = cache.getEntry(LID)!;
    const oldEntry: LidCacheEntry = {
      ...entry,
      lastConfirmedTs: Date.now() - LID_CACHE_STALE_MS - 1,
      firstSeenTs: entry.firstSeenTs,
    };
    await fs.writeFile(
      path.join(tmpDir, "lid-cache.json"),
      JSON.stringify({ [LID]: oldEntry }),
      "utf8",
    );
    const freshCache = openLidCache(tmpDir);

    const result = await resolveLidToPhoneJid(client, freshCache, LID);

    expect(result).toEqual({ phoneJid: "222@c.us", unresolved: false, source: "tierB" });
    expect(freshCache.get(LID)).toBe("222@c.us");
    expect(warn).toHaveBeenCalled();
    const remapLog = warn.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("lid_remapped"),
    );
    expect(remapLog).toBeDefined();
  });
});

describe("openLidCache persistence", () => {
  it("write-through persists entries across reopens", async () => {
    cache.set(LID, PHONE, "tierC");
    const reopened = openLidCache(tmpDir);
    expect(reopened.get(LID)).toBe(PHONE);
    expect(reopened.getEntry(LID)?.source).toBe("tierC");
  });

  it("gracefully handles malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "lid-cache.json"), "{not json", "utf8");
    const reopened = openLidCache(tmpDir);
    expect(reopened.get(LID)).toBeUndefined();
  });
});
