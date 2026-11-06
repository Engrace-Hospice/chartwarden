// Slice 4 — the database-backed config source behind the layered resolver: a row decides, only `active` operates, the sealed
// credential is opened once per row version, and anything unusable fails closed. Pure: a fake row reader and a fake key ring.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ConfigRow } from "./config-store";
import { buildClinicSecretCipher } from "./secret-cipher";
import { createDrizzleTenantConfigSource } from "./source";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = randomBytes(32);
const ring = { dekForOrg: async () => ({ version: "v1", key: KEY }) };
const cipher = buildClinicSecretCipher(ring);
const PLATFORM_KEY = { DOSESPOT_SUBSCRIPTION_KEY_SANDBOX: "platform-sandbox-sub-key" };

async function rowWith(
  over: Partial<ConfigRow> = {},
  bundle = { clinicKey: "clinic-key-plaintext-1" } as {
    clinicKey: string;
    subscriptionKey?: string;
  },
) {
  const sealed = await cipher.encrypt(ORG, bundle, {
    environment: "sandbox",
    clinicId: "clinic-1",
  });
  const at = new Date("2026-11-06T12:00:00.000Z");
  return {
    id: "r1",
    organizationId: ORG,
    environment: "sandbox",
    status: "active",
    clinicId: "clinic-1",
    serviceClinicianId: "900",
    secretCipher: sealed.cipher,
    secretDekRef: sealed.dekRef,
    registeredAt: at,
    registeredByMembershipId: "m",
    verifiedAt: at,
    verifiedByMembershipId: "m",
    lastTestAt: at,
    lastTestOutcome: "ok",
    activatedAt: at,
    activatedByMembershipId: "m",
    setByMembershipId: "m",
    version: 3,
    createdAt: at,
    updatedAt: at,
    ...over,
  } as ConfigRow;
}

function sourceOver(row: ConfigRow | null, env: Record<string, string | undefined> = PLATFORM_KEY) {
  let current = row;
  let reads = 0;
  const source = createDrizzleTenantConfigSource({
    readRow: async () => {
      reads += 1;
      return current;
    },
    cipher,
    platformEnv: env,
  });
  return {
    source,
    swap: (r: ConfigRow | null) => {
      current = r;
    },
    reads: () => reads,
  };
}

describe("DoseSpot tenant config source", () => {
  it("says absent when the org has no row (the env fallback may then serve it)", async () => {
    expect(await sourceOver(null).source.lookup(ORG, "operate")).toEqual({ kind: "absent" });
  });

  it.each(["draft", "registered", "verified"] as const)(
    "a %s row is present but does not operate",
    async (status) => {
      const found = await sourceOver(await rowWith({ status })).source.lookup(ORG, "operate");
      expect(found).toMatchObject({ kind: "present", usable: false });
    },
  );

  it("a verified row may be used for setup (prescriber enrolment); a registered one may not", async () => {
    expect(
      await sourceOver(await rowWith({ status: "verified" })).source.lookup(ORG, "setup"),
    ).toMatchObject({ usable: true });
    expect(
      await sourceOver(await rowWith({ status: "registered" })).source.lookup(ORG, "setup"),
    ).toMatchObject({ usable: false });
  });

  it("an active row operates and loads the full config with the platform Subscription-Key fallback", async () => {
    const found = await sourceOver(await rowWith()).source.lookup(ORG, "operate");
    expect(found).toMatchObject({ kind: "present", usable: true });
    if (found.kind !== "present") throw new Error("unreachable");
    expect(await found.load()).toEqual({
      baseUrl: "https://my.staging.dosespot.com/webapi/v2",
      subscriptionKey: "platform-sandbox-sub-key",
      clinicId: "clinic-1",
      clinicKey: "clinic-key-plaintext-1",
      serviceClinicianId: "900",
      epcsCertified: false,
      version: 3,
    });
  });

  it("the row's own Subscription-Key wins over the platform's", async () => {
    const row = await rowWith(
      {},
      { clinicKey: "clinic-key-plaintext-1", subscriptionKey: "tenant-own-sub-key-1" },
    );
    const found = await sourceOver(row).source.lookup(ORG, "operate");
    if (found.kind !== "present") throw new Error("unreachable");
    expect((await found.load()).subscriptionKey).toBe("tenant-own-sub-key-1");
  });

  it("opens the sealed credential once per row version, and again after a rotation", async () => {
    let opens = 0;
    const counting = {
      ...cipher,
      decrypt: async (...args: Parameters<typeof cipher.decrypt>) => {
        opens += 1;
        return cipher.decrypt(...args);
      },
    };
    let row = await rowWith();
    const source = createDrizzleTenantConfigSource({
      readRow: async () => row,
      cipher: counting,
      platformEnv: PLATFORM_KEY,
    });
    const load = async () => {
      const f = await source.lookup(ORG, "operate");
      if (f.kind !== "present") throw new Error("unreachable");
      return f.load();
    };
    await load();
    await load();
    expect(opens).toBe(1);
    row = await rowWith({ version: 4 });
    await load();
    expect(opens).toBe(2);
  });

  it("an unopenable credential is a typed 503 with no secret in it, never 'not configured'", async () => {
    const row = await rowWith({ secretCipher: "v1.AAAA.AAAA.AAAA" });
    const found = await sourceOver(row).source.lookup(ORG, "operate");
    if (found.kind !== "present") throw new Error("unreachable");
    const err = await found.load().catch((e) => e);
    expect(err).toMatchObject({ statusCode: 503, code: "DOSESPOT_CREDENTIAL_UNREADABLE" });
    expect(String(err.message)).not.toContain("clinic-key");
  });

  it("no cipher bound is the same typed 503", async () => {
    const source = createDrizzleTenantConfigSource({
      readRow: async () => rowWith(),
      platformEnv: PLATFORM_KEY,
    });
    const found = await source.lookup(ORG, "operate");
    if (found.kind !== "present") throw new Error("unreachable");
    await expect(found.load()).rejects.toMatchObject({
      statusCode: 503,
      code: "DOSESPOT_CREDENTIAL_UNREADABLE",
    });
  });

  it("an active production row is NOT usable once the platform flag is off (fail closed)", async () => {
    const sealed = await cipher.encrypt(
      ORG,
      { clinicKey: "clinic-key-plaintext-1" },
      { environment: "production", clinicId: "clinic-1" },
    );
    const row = await rowWith({ environment: "production", secretCipher: sealed.cipher });
    const off = await sourceOver(row, {
      DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com/webapi/v2",
    }).source.lookup(ORG, "operate");
    expect(off).toMatchObject({ kind: "present", usable: false });
    const on = await sourceOver(row, {
      DOSESPOT_PRODUCTION_ENABLED: "true",
      DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com/webapi/v2",
      DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION: "platform-prod-sub-key",
    }).source.lookup(ORG, "operate");
    expect(on).toMatchObject({ usable: true });
  });

  it("no Subscription-Key anywhere is a typed 503 at load, not a request without one", async () => {
    const found = await sourceOver(await rowWith(), {}).source.lookup(ORG, "operate");
    if (found.kind !== "present") throw new Error("unreachable");
    await expect(found.load()).rejects.toMatchObject({
      statusCode: 503,
      code: "DOSESPOT_CREDENTIAL_UNREADABLE",
    });
  });

  it("reads the row on every lookup, so a deactivation is seen at once", async () => {
    const h = sourceOver(await rowWith());
    await h.source.lookup(ORG, "operate");
    h.swap(await rowWith({ status: "verified", version: 4 }));
    expect(await h.source.lookup(ORG, "operate")).toMatchObject({ usable: false });
    expect(h.reads()).toBe(2);
  });
});
