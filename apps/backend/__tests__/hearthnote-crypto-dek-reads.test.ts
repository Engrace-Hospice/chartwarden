// A sign seals the note's narrative twice and every one of its sections at once. Each seal resolves the tenant DEK, which is a pooled
// transaction on the tenant key ring, so unshared one sign would need N + 2 connections beside the one it already holds (and the encounter
// row lock it holds with it). Seals that overlap share one key-ring read; nothing outlives it. Synthetic org ids and keys only.
import { describe, expect, it, vi } from "vitest";
import {
  type EncounterTenantKeyProvider,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/hearthnote-crypto";

const ORG = "00000000-0000-4000-8000-000000000001";
const KEY = Buffer.alloc(32, 7);

function keyRing(over: Partial<EncounterTenantKeyProvider> = {}) {
  const dekForOrg = vi.fn(async (_org: string) => ({ version: "v1", key: KEY }));
  const dekForOrgVersion = vi.fn(async (_org: string, version: string) => ({
    version,
    key: KEY,
  }));
  return { dekForOrg, dekForOrgVersion, keys: { dekForOrg, dekForOrgVersion, ...over } };
}

describe("sealing several texts at once (the signed note's N + 2 seals)", () => {
  it("reads the tenant key once for all of them, and every envelope opens to its own text", async () => {
    const ring = keyRing();
    const { narrative } = createHearthnoteCiphers(ring.keys);
    const texts = Array.from({ length: 12 }, (_, i) => `section ${i} of a synthetic note`);

    const envelopes = await Promise.all(texts.map((text) => narrative.seal(ORG, text)));

    expect(ring.dekForOrg).toHaveBeenCalledTimes(1);
    expect(new Set(envelopes).size).toBe(texts.length);
    const opened = await Promise.all(envelopes.map((envelope) => narrative.open(ORG, envelope)));
    expect(opened).toEqual(texts);
  });

  it("keeps nothing past the read: a seal made afterwards asks the key ring again, so a rotation is seen at once", async () => {
    const ring = keyRing();
    const { narrative } = createHearthnoteCiphers(ring.keys);
    await narrative.seal(ORG, "first");
    ring.dekForOrg.mockResolvedValueOnce({ version: "v2", key: KEY });

    const envelope = await narrative.seal(ORG, "second");

    expect(ring.dekForOrg).toHaveBeenCalledTimes(2);
    expect(envelope.split(".")[1]).toBe("v2");
  });

  it("does not remember a failed read: every seal that waited on it fails, and the next one asks again", async () => {
    const ring = keyRing();
    ring.dekForOrg.mockRejectedValueOnce(new Error("the key ring is unreachable"));
    const { narrative } = createHearthnoteCiphers(ring.keys);

    const outcomes = await Promise.allSettled([narrative.seal(ORG, "a"), narrative.seal(ORG, "b")]);

    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    expect(ring.dekForOrg).toHaveBeenCalledTimes(1);
    await expect(narrative.seal(ORG, "c")).resolves.toMatch(/^v1\.v1\./);
    expect(ring.dekForOrg).toHaveBeenCalledTimes(2);
  });

  it("shares a read only within one organization", async () => {
    const ring = keyRing();
    const { narrative } = createHearthnoteCiphers(ring.keys);
    const other = "00000000-0000-4000-8000-000000000002";

    await Promise.all([narrative.seal(ORG, "a"), narrative.seal(other, "b")]);

    expect(ring.dekForOrg.mock.calls.map(([org]) => org).sort()).toEqual([ORG, other].sort());
  });
});
