// Slice 4 — the rules of a tenant's DoseSpot clinic registration, on the in-memory store, a fake key ring and a fake probe.
// draft -> registered -> verified -> active; any change to the credential or its target sends the row back to `registered`
// (or `draft` while incomplete) and clears what the old credential earned; production needs the platform flag; the tenant lane
// may rotate a Subscription-Key but never introduce one.
import { randomBytes } from "node:crypto";
import type { ConnectionProbeOutcome, DoseSpotTenantConfig } from "@chartwarden/dosespot";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryConfigStore } from "./config-store-memory";
import { buildClinicSecretCipher } from "./secret-cipher";
import { type ClinicActor, createDoseSpotClinicService } from "./service";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const OPERATOR = "44444444-4444-4444-8444-444444444444";
const TENANT: ClinicActor = { organizationId: ORG, userId: "u-t", membershipId: MEMBER };
const OPS: ClinicActor = {
  organizationId: ORG,
  userId: "u-o",
  membershipId: OPERATOR,
  lane: "platform",
};

const SUBSCRIPTION_KEY_ONLY = { DOSESPOT_SUBSCRIPTION_KEY_SANDBOX: "platform-sandbox-sub-key" };
/** The platform has enabled sandbox registrations to go live (DOSESPOT_SANDBOX_ENABLED, exactly `true`). */
const withPlatformKey = { ...SUBSCRIPTION_KEY_ONLY, DOSESPOT_SANDBOX_ENABLED: "true" };
const CLINIC_KEY = "clinic-key-plaintext-aaaa1111";
const SUB_KEY = "sub-key-plaintext-bbbb2222";
const BASE = { environment: "sandbox", clinicId: "clinic-1", serviceClinicianId: "900" } as const;

function build(
  opts: {
    outcome?: () => ConnectionProbeOutcome | "throw";
    env?: Record<string, string | undefined>;
    envFallbackOrgs?: string[];
    cipher?: boolean;
  } = {},
) {
  const store = createInMemoryConfigStore(() => new Date("2026-11-06T12:00:00.000Z"));
  const key = randomBytes(32);
  const probed: DoseSpotTenantConfig[] = [];
  const service = createDoseSpotClinicService({
    ...(opts.cipher === false
      ? {}
      : { cipher: buildClinicSecretCipher({ dekForOrg: async () => ({ version: "v1", key }) }) }),
    probe: {
      probe: async (config) => {
        probed.push(config);
        const out = opts.outcome?.() ?? "ok";
        if (out === "throw") throw new Error("boom");
        return out;
      },
    },
    env: opts.env ?? {},
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    envFallbackFor: (org) => (opts.envFallbackOrgs ?? []).includes(org),
  });
  return { store, service, probed };
}

/** A 422 whose first detail carries `code` (a ValidationError's own code is VALIDATION_FAILED). */
const invalidWith = (code: string) =>
  expect.objectContaining({ statusCode: 422, details: [expect.objectContaining({ code })] });

const verifyFully = async (h: ReturnType<typeof build>, actor = TENANT) => {
  const plan = await h.service.prepareVerify(h.store, actor);
  const outcome = await h.service.runProbe(plan);
  return h.service.completeVerify(h.store, actor, plan, outcome);
};
const putFull = (
  h: ReturnType<typeof build>,
  extra: Record<string, unknown> = {},
  actor = TENANT,
) =>
  h.service.put(h.store, actor, { ...BASE, clinicKey: CLINIC_KEY, ...extra } as never, undefined);

describe("view", () => {
  it("is empty for an org with no row and no env fallback", async () => {
    const { store, service } = build();
    const v = await service.view(store, ORG);
    expect(v).toMatchObject({ source: "none", status: null, hasSecret: false, version: null });
  });

  it("says an org served only by the env fallback is on the platform binding", async () => {
    const { store, service } = build({ envFallbackOrgs: [ORG] });
    expect(await service.view(store, ORG)).toMatchObject({
      source: "platform_env",
      status: "active",
    });
  });
});

describe("put: the first save", () => {
  it("the first save for an org the env fallback was serving takes it out of service (a row is authoritative): leftActive", async () => {
    const h = build({ envFallbackOrgs: [ORG] });
    expect((await putFull(h)).leftActive).toBe(true);
    const g = build();
    expect((await putFull(g)).leftActive).toBe(false); // an org that was never live
  });

  it("a complete first save is `registered` and returns no secret", async () => {
    const h = build();
    const out = await putFull(h);
    expect(out.created).toBe(true);
    expect(out.view).toMatchObject({
      source: "tenant",
      status: "registered",
      environment: "sandbox",
      clinicId: "clinic-1",
      serviceClinicianId: "900",
      hasSecret: true,
      version: 1,
    });
    expect(out.changedFields).toEqual([
      "environment",
      "clinicId",
      "serviceClinicianId",
      "clinicKey",
    ]);
    const json = JSON.stringify(out.view);
    expect(json).not.toContain(CLINIC_KEY);
    expect(h.store.rows()[0]?.secretCipher).not.toContain(CLINIC_KEY);
    expect(h.store.rows()[0]?.secretDekRef).toBe("v1");
  });

  it("an incomplete save stays `draft` so the wizard can resume", async () => {
    const h = build();
    const out = await h.service.put(
      h.store,
      TENANT,
      { environment: "sandbox", clinicId: "clinic-1" },
      undefined,
    );
    expect(out.view).toMatchObject({
      status: "draft",
      hasSecret: false,
      clinicId: "clinic-1",
      serviceClinicianId: null,
    });
    expect(h.store.rows()[0]?.registeredAt).toBeNull();
  });

  it("a draft completed later becomes `registered`, stamped with who did it", async () => {
    const h = build();
    await h.service.put(
      h.store,
      TENANT,
      { environment: "sandbox", clinicId: "clinic-1" },
      undefined,
    );
    const out = await h.service.put(
      h.store,
      OPS,
      { environment: "sandbox", serviceClinicianId: "900", clinicKey: CLINIC_KEY },
      1,
    );
    expect(out.view.status).toBe("registered");
    expect(h.store.rows()[0]).toMatchObject({
      registeredByMembershipId: OPERATOR,
      setByMembershipId: OPERATOR,
    });
  });

  it("refuses an If-Match on the first save (412) and an id or key of the wrong shape (422)", async () => {
    const g = build();
    await expect(g.service.put(g.store, TENANT, { ...BASE } as never, 3)).rejects.toMatchObject({
      statusCode: 412,
    });
    for (const bad of [
      { clinicId: "has space" },
      { clinicId: "x".repeat(65) },
      { serviceClinicianId: "bad/slash" },
      { clinicKey: "short" },
      { clinicKey: "has a space in it" },
      { subscriptionKey: "tiny" },
    ]) {
      const k = build();
      await expect(
        k.service.put(k.store, OPS, { ...BASE, clinicKey: CLINIC_KEY, ...bad } as never, undefined),
      ).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  it("refuses to store a key when no cipher is bound (503), and writes nothing", async () => {
    const h = build({ cipher: false });
    await expect(putFull(h)).rejects.toMatchObject({
      statusCode: 503,
      code: "DOSESPOT_CIPHER_UNBOUND",
    });
    expect(h.store.rows()).toHaveLength(0);
  });

  it("a key needs a clinic id to be sealed against (422), never stored loose", async () => {
    const h = build();
    await expect(
      h.service.put(h.store, TENANT, { environment: "sandbox", clinicKey: CLINIC_KEY }, undefined),
    ).rejects.toEqual(invalidWith("DOSESPOT_CLINIC_ID_REQUIRED"));
  });
});

describe("put: changing an existing registration", () => {
  it("needs If-Match (428) and refuses a stale one (412)", async () => {
    const h = build();
    await putFull(h);
    await expect(
      h.service.put(h.store, TENANT, { ...BASE, clinicKey: CLINIC_KEY }, undefined),
    ).rejects.toMatchObject({
      statusCode: 428,
    });
    await expect(
      h.service.put(h.store, TENANT, { ...BASE, clinicKey: CLINIC_KEY }, 9),
    ).rejects.toMatchObject({
      statusCode: 412,
    });
  });

  it("saving the same values with no secret changes nothing and leaves the earned state alone", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    const out = await h.service.put(h.store, TENANT, { ...BASE }, 2);
    expect(out.changedFields).toEqual([]);
    expect(out.view.status).toBe("verified");
    expect(out.view.version).toBe(2);
  });

  it("a rotated clinic key lands on `registered` and clears the test, verification and activation", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    await h.service.activate(h.store, TENANT);
    const out = await h.service.put(
      h.store,
      TENANT,
      { ...BASE, clinicKey: "a-new-clinic-key-cccc3333" },
      3,
    );
    expect(out.leftActive).toBe(true);
    expect(out.changedFields).toEqual(["clinicKey"]);
    expect(out.view).toMatchObject({
      status: "registered",
      lastTest: null,
      verifiedAt: null,
      activatedAt: null,
    });
    expect(h.store.rows()[0]).toMatchObject({
      verifiedAt: null,
      activatedAt: null,
      lastTestOutcome: null,
    });
    // the rotated key is what verification now unseals
    const plan = await h.service.prepareVerify(h.store, TENANT);
    expect(plan.config.clinicKey).toBe("a-new-clinic-key-cccc3333");
  });

  it("a changed clinician id also needs a fresh test, but keeps the sealed key as it was", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    const before = h.store.rows()[0]?.secretCipher;
    const out = await h.service.put(h.store, TENANT, { ...BASE, serviceClinicianId: "901" }, 2);
    expect(out.changedFields).toEqual(["serviceClinicianId"]);
    expect(out.view.status).toBe("registered");
    expect(h.store.rows()[0]?.secretCipher).toBe(before);
  });

  it("changing the environment or clinic drops the old key (it is bound to the old target)", async () => {
    const h = build();
    await putFull(h);
    const out = await h.service.put(h.store, TENANT, { ...BASE, environment: "production" }, 1);
    expect(out.view).toMatchObject({
      status: "draft",
      hasSecret: false,
      environment: "production",
    });
    expect(out.changedFields).toEqual(["environment", "clinicKey"]);
    expect(h.store.rows()[0]?.secretCipher).toBeNull();
    const g = build();
    await putFull(g);
    const moved = await g.service.put(
      g.store,
      TENANT,
      { ...BASE, clinicId: "clinic-2", clinicKey: CLINIC_KEY },
      1,
    );
    expect(moved.view.status).toBe("registered");
    expect(moved.changedFields).toEqual(["clinicId", "clinicKey"]);
  });

  it("a new key for the same target keeps a stored Subscription-Key (the bundle is merged, not replaced)", async () => {
    const h = build();
    await putFull(h, { subscriptionKey: SUB_KEY }, OPS);
    await h.service.put(h.store, OPS, { ...BASE, clinicKey: "a-new-clinic-key-cccc3333" }, 1);
    const plan = await h.service.prepareVerify(h.store, OPS);
    expect(plan.config).toMatchObject({
      clinicKey: "a-new-clinic-key-cccc3333",
      subscriptionKey: SUB_KEY,
    });
  });

  it("a stale concurrent write is a 412, not a silent overwrite", async () => {
    const h = build();
    await putFull(h);
    await h.service.put(h.store, TENANT, { ...BASE, serviceClinicianId: "901" }, 1);
    await expect(
      h.service.put(h.store, TENANT, { ...BASE, serviceClinicianId: "902" }, 1),
    ).rejects.toMatchObject({ statusCode: 412 });
  });
});

describe("an unopenable stored envelope refuses a PARTIAL rotation (it would silently drop the ops-set Subscription-Key)", () => {
  async function withBrokenEnvelope() {
    const h = build({ env: withPlatformKey });
    await putFull(h, { subscriptionKey: SUB_KEY }, OPS); // ops set the clinic's own Subscription-Key
    await h.store.update(ORG, h.store.rows()[0]?.version ?? 1, {
      secretCipher: "v1.AAAA.AAAA.AAAA",
    });
    return h;
  }

  it("a new clinic key alone is refused with a typed 503 and the row is left as it was", async () => {
    for (const actor of [OPS, TENANT]) {
      const h = await withBrokenEnvelope();
      const before = h.store.rows()[0];
      await expect(
        h.service.put(
          h.store,
          actor,
          { ...BASE, clinicKey: "a-new-clinic-key-cccc3333" },
          before?.version,
        ),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "DOSESPOT_CREDENTIAL_UNREADABLE",
        // the message names the way out: platform support, the platform route, both keys together
        message: expect.stringMatching(
          /platform support.*platform route.*AND the Subscription-Key/s,
        ),
      });
      expect(h.store.rows()[0]).toEqual(before);
    }
  });

  describe("platform repair of a clinic that has no Subscription-Key of its own", () => {
    async function brokenWithoutOwnKey() {
      const h = build({ env: withPlatformKey });
      await putFull(h); // no per-clinic Subscription-Key: the platform's is used
      await h.store.update(ORG, h.store.rows()[0]?.version ?? 1, {
        secretCipher: "v1.AAAA.AAAA.AAAA",
      });
      return h;
    }
    const NEW_KEY = "a-new-clinic-key-eeee5555";

    it("the platform lane re-seals the clinic key ALONE when it attests the clinic uses the platform's Subscription-Key", async () => {
      const h = await brokenWithoutOwnKey();
      const out = await h.service.put(
        h.store,
        OPS,
        { ...BASE, clinicKey: NEW_KEY, usePlatformSubscriptionKey: true },
        h.store.rows()[0]?.version,
      );
      expect(out.view.status).toBe("registered"); // what the old key earned is gone: it must be re-tested
      expect(out.changedFields).toEqual(["clinicKey", "subscriptionKey"]); // names only: the attestation is on the audit row
      const plan = await h.service.prepareVerify(h.store, OPS);
      expect(plan.config).toMatchObject({
        clinicKey: NEW_KEY,
        subscriptionKey: "platform-sandbox-sub-key", // the platform's own, not an invented one
      });
    });

    it("over a READABLE envelope the attestation drops the clinic's own Subscription-Key: the platform's is served from then on", async () => {
      const h = build({ env: withPlatformKey });
      await putFull(h, { subscriptionKey: SUB_KEY }, OPS); // the clinic had its own
      await h.service.put(
        h.store,
        OPS,
        { ...BASE, clinicKey: NEW_KEY, usePlatformSubscriptionKey: true },
        h.store.rows()[0]?.version,
      );
      const plan = await h.service.prepareVerify(h.store, OPS);
      expect(plan.config).toMatchObject({
        clinicKey: NEW_KEY,
        subscriptionKey: "platform-sandbox-sub-key",
      });
      expect(plan.config.subscriptionKey).not.toBe(SUB_KEY);
    });

    it("the tenant lane cannot make that attestation (422), and the row is untouched", async () => {
      const h = await brokenWithoutOwnKey();
      const before = h.store.rows()[0];
      await expect(
        h.service.put(
          h.store,
          TENANT,
          { ...BASE, clinicKey: NEW_KEY, usePlatformSubscriptionKey: true },
          before?.version,
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
      expect(h.store.rows()[0]).toEqual(before);
    });

    it("the attestation contradicts a Subscription-Key sent in the same call (422), and needs a clinic key to apply to (422)", async () => {
      const h = await brokenWithoutOwnKey();
      const version = h.store.rows()[0]?.version;
      await expect(
        h.service.put(
          h.store,
          OPS,
          {
            ...BASE,
            clinicKey: NEW_KEY,
            subscriptionKey: "a-new-sub-key-ffff6666",
            usePlatformSubscriptionKey: true,
          },
          version,
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
      await expect(
        h.service.put(h.store, OPS, { ...BASE, usePlatformSubscriptionKey: true }, version),
      ).rejects.toMatchObject({ statusCode: 422 });
    });
  });

  it("platform support re-entering BOTH keys is a full replace and is accepted", async () => {
    const h = await withBrokenEnvelope();
    const out = await h.service.put(
      h.store,
      OPS,
      {
        ...BASE,
        clinicKey: "a-new-clinic-key-cccc3333",
        subscriptionKey: "a-new-sub-key-dddd4444",
      },
      h.store.rows()[0]?.version,
    );
    expect(out.view.status).toBe("registered");
    const plan = await h.service.prepareVerify(h.store, OPS);
    expect(plan.config).toMatchObject({
      clinicKey: "a-new-clinic-key-cccc3333",
      subscriptionKey: "a-new-sub-key-dddd4444",
    });
  });

  it("a draft with no sealed key at all is not 'unopenable': saving the key for the first time works", async () => {
    const h = build({ env: withPlatformKey });
    await h.service.put(
      h.store,
      TENANT,
      { environment: "sandbox", clinicId: "clinic-1" },
      undefined,
    );
    const out = await h.service.put(h.store, TENANT, { ...BASE, clinicKey: CLINIC_KEY }, 1);
    expect(out.view.status).toBe("registered");
  });
});

describe("the Subscription-Key: ops may set it, the tenant lane may only rotate it", () => {
  it("the tenant lane cannot introduce one", async () => {
    const h = build();
    await expect(putFull(h, { subscriptionKey: SUB_KEY }, TENANT)).rejects.toEqual(
      invalidWith("DOSESPOT_SUBSCRIPTION_KEY_PLATFORM_ONLY"),
    );
    expect(h.store.rows()).toHaveLength(0);
    const g = build();
    await putFull(g);
    await expect(
      g.service.put(g.store, TENANT, { ...BASE, subscriptionKey: SUB_KEY }, 1),
    ).rejects.toEqual(invalidWith("DOSESPOT_SUBSCRIPTION_KEY_PLATFORM_ONLY"));
  });

  it("ops sets one, and then the tenant lane may rotate it", async () => {
    const h = build();
    await putFull(h, { subscriptionKey: SUB_KEY }, OPS);
    const out = await h.service.put(
      h.store,
      TENANT,
      { ...BASE, subscriptionKey: "rotated-sub-key-dddd4444" },
      1,
    );
    expect(out.changedFields).toEqual(["subscriptionKey"]);
    const plan = await h.service.prepareVerify(h.store, TENANT);
    expect(plan.config).toMatchObject({
      clinicKey: CLINIC_KEY,
      subscriptionKey: "rotated-sub-key-dddd4444",
    });
  });

  it("falls back to the platform key for the environment when the row carries none", async () => {
    const h = build({ env: { DOSESPOT_SUBSCRIPTION_KEY_SANDBOX: "platform-sandbox-sub-key" } });
    await putFull(h);
    const plan = await h.service.prepareVerify(h.store, TENANT);
    expect(plan.config.subscriptionKey).toBe("platform-sandbox-sub-key");
  });

  it("refuses to verify when neither the row nor the platform has a Subscription-Key", async () => {
    const h = build();
    await putFull(h);
    await expect(h.service.prepareVerify(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_SUBSCRIPTION_KEY_MISSING",
    });
  });
});

describe("verify (the connection test)", () => {
  it("passes: registered becomes verified and the outcome is recorded", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    const out = await verifyFully(h);
    expect(out.test).toEqual({ outcome: "ok" });
    expect(out.view).toMatchObject({ status: "verified", lastTest: { outcome: "ok" } });
    expect(h.probed).toHaveLength(1);
    expect(h.probed[0]).toMatchObject({
      baseUrl: "https://my.staging.dosespot.com/webapi/v2",
      clinicId: "clinic-1",
      serviceClinicianId: "900",
      clinicKey: CLINIC_KEY,
      version: 1,
    });
    expect(h.store.rows()[0]).toMatchObject({ verifiedByMembershipId: MEMBER });
  });

  it.each(["credential_rejected", "unreachable"] as const)(
    "%s is recorded and the status stays registered",
    async (outcome) => {
      const h = build({ env: withPlatformKey, outcome: () => outcome });
      await putFull(h);
      const out = await verifyFully(h);
      expect(out.test).toEqual({ outcome });
      expect(out.view).toMatchObject({
        status: "registered",
        lastTest: { outcome },
        verifiedAt: null,
      });
    },
  );

  it("a probe that throws is `unreachable`, never an error to the caller", async () => {
    const h = build({ env: withPlatformKey, outcome: () => "throw" });
    await putFull(h);
    expect((await verifyFully(h)).test).toEqual({ outcome: "unreachable" });
  });

  it("is refused for a draft, and when the config moved during the probe (409)", async () => {
    const h = build({ env: withPlatformKey });
    await h.service.put(
      h.store,
      TENANT,
      { environment: "sandbox", clinicId: "clinic-1" },
      undefined,
    );
    await expect(h.service.prepareVerify(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_NOT_REGISTERED",
    });
    const g = build({ env: withPlatformKey });
    await putFull(g);
    const plan = await g.service.prepareVerify(g.store, TENANT);
    await g.service.put(g.store, TENANT, { ...BASE, serviceClinicianId: "901" }, 1);
    await expect(g.service.completeVerify(g.store, TENANT, plan, "ok")).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_CHANGED_DURING_VERIFY",
    });
  });

  it("a re-test of a live registration records the outcome and does NOT deactivate it", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    await h.service.activate(h.store, TENANT);
    const bad = build({ env: withPlatformKey, outcome: () => "credential_rejected" });
    const plan = await h.service.prepareVerify(h.store, TENANT);
    const out = await h.service.completeVerify(h.store, TENANT, plan, "credential_rejected");
    expect(out.view.status).toBe("active");
    expect(out.view.lastTest?.outcome).toBe("credential_rejected");
    expect(bad.probed).toHaveLength(0);
  });

  it("production cannot be tested until the platform enables it (409), and sandbox never needs a flag", async () => {
    const h = build({ env: { DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION: "platform-prod-sub-key" } });
    await putFull(h, { environment: "production" });
    await expect(h.service.prepareVerify(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_PRODUCTION_NOT_ENABLED",
    });
    const g = build({
      env: {
        DOSESPOT_PRODUCTION_ENABLED: "true",
        DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION: "platform-prod-sub-key",
      },
    });
    await putFull(g, { environment: "production" });
    await expect(g.service.prepareVerify(g.store, TENANT)).rejects.toMatchObject({
      code: "DOSESPOT_PRODUCTION_URL_UNSET",
    });
  });

  it("an unopenable sealed key is a typed 409, not a 500", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    const row = h.store.rows()[0];
    await h.store.update(ORG, row?.version ?? 1, { secretCipher: "v1.AAAA.AAAA.AAAA" });
    await expect(h.service.prepareVerify(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_SECRET_UNREADABLE",
    });
  });
});

describe("activate and deactivate", () => {
  it("only a verified registration activates (409 otherwise); activating twice is a no-op", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await expect(h.service.activate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_NOT_VERIFIED",
    });
    await verifyFully(h);
    const first = await h.service.activate(h.store, TENANT);
    expect(first.changed).toBe(true);
    expect(first.view).toMatchObject({ status: "active", activatedAt: "2026-11-06T12:00:00.000Z" });
    expect(h.store.rows()[0]).toMatchObject({ activatedByMembershipId: MEMBER });
    const again = await h.service.activate(h.store, TENANT);
    expect(again.changed).toBe(false);
  });

  it("a verified registration whose LATEST test failed cannot be activated until a test passes again", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    const plan = await h.service.prepareVerify(h.store, TENANT);
    await h.service.completeVerify(h.store, TENANT, plan, "credential_rejected"); // a re-test fails: status stays verified
    expect((await h.service.view(h.store, ORG)).status).toBe("verified");
    await expect(h.service.activate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_NOT_VERIFIED",
    });
    await verifyFully(h);
    expect((await h.service.activate(h.store, TENANT)).view.status).toBe("active");
  });

  it("production activation is refused unless DOSESPOT_PRODUCTION_ENABLED is exactly 'true'", async () => {
    const env = {
      DOSESPOT_PRODUCTION_ENABLED: "true",
      DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com/webapi/v2",
      DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION: "platform-prod-sub-key",
    };
    const h = build({ env });
    await putFull(h, { environment: "production" });
    await verifyFully(h);
    // the platform turns production off after the test (a flag flip is a deploy): activation re-checks it
    const off = createDoseSpotClinicService({
      cipher: buildClinicSecretCipher({
        dekForOrg: async () => ({ version: "v1", key: randomBytes(32) }),
      }),
      probe: { probe: async () => "ok" },
      env: { ...env, DOSESPOT_PRODUCTION_ENABLED: "TRUE" },
    });
    await expect(off.activate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_PRODUCTION_NOT_ENABLED",
    });
    expect((await h.service.activate(h.store, TENANT)).view.status).toBe("active");
  });

  it("a platform operator may not activate: 403 DOSESPOT_ACTIVATION_TENANT_ONLY, even for a verified registration and even over an active one; the tenant's own administrator still can", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h, {}, OPS);
    await verifyFully(h, OPS);
    // everything an activation needs is in place (verified, latest test passed, sandbox enabled): only the lane is wrong
    const refused = await h.service.activate(h.store, OPS).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ChartWardenError);
    expect(refused).toMatchObject({ code: "DOSESPOT_ACTIVATION_TENANT_ONLY", statusCode: 403 });
    expect((await h.service.view(h.store, ORG)).status).toBe("verified");
    expect(h.store.rows()[0]).toMatchObject({ activatedAt: null, activatedByMembershipId: null });
    expect(await h.service.activate(h.store, TENANT)).toMatchObject({
      changed: true,
      view: { status: "active" },
    });
    expect(h.store.rows()[0]).toMatchObject({ activatedByMembershipId: MEMBER });
    // an operator cannot re-run it over an active registration either: a refusal, not an idempotent success
    await expect(h.service.activate(h.store, OPS)).rejects.toMatchObject({
      code: "DOSESPOT_ACTIVATION_TENANT_ONLY",
      statusCode: 403,
    });
    // and the refusal comes before the not-configured check: an operator learns nothing from it about a tenant with no registration
    const empty = build();
    await expect(empty.service.activate(empty.store, OPS)).rejects.toMatchObject({
      code: "DOSESPOT_ACTIVATION_TENANT_ONLY",
    });
  });

  it("deactivation returns to `verified` (no new test owed); deactivating a verified one is a no-op; a registered one is a 409", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await expect(h.service.deactivate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_NOT_ACTIVE",
    });
    await verifyFully(h);
    expect((await h.service.deactivate(h.store, TENANT)).changed).toBe(false);
    await h.service.activate(h.store, TENANT);
    const out = await h.service.deactivate(h.store, OPS);
    expect(out.changed).toBe(true);
    expect(out.view).toMatchObject({ status: "verified", activatedAt: null });
    expect(out.view.verifiedAt).not.toBeNull();
    // and it can be re-activated straight away
    expect((await h.service.activate(h.store, TENANT)).view.status).toBe("active");
  });

  it("activate and deactivate on an org with no row are a 409, not a crash", async () => {
    const h = build();
    await expect(h.service.activate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_NOT_CONFIGURED",
    });
    await expect(h.service.deactivate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_NOT_CONFIGURED",
    });
  });
});

describe("sandbox activation is gated by DOSESPOT_SANDBOX_ENABLED", () => {
  it("a sandbox registration verifies without the flag but activate is refused with its own code (409)", async () => {
    const h = build({ env: SUBSCRIPTION_KEY_ONLY });
    await putFull(h);
    const out = await verifyFully(h); // verify is open anywhere
    expect(out.view.status).toBe("verified");
    await expect(h.service.activate(h.store, TENANT)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_SANDBOX_NOT_ENABLED",
    });
    expect((await h.service.view(h.store, ORG)).status).toBe("verified");
  });

  it("only an exact 'true' enables it", async () => {
    for (const flag of ["TRUE", "1", "yes", ""]) {
      const h = build({ env: { ...SUBSCRIPTION_KEY_ONLY, DOSESPOT_SANDBOX_ENABLED: flag } });
      await putFull(h);
      await verifyFully(h);
      await expect(h.service.activate(h.store, TENANT)).rejects.toMatchObject({
        code: "DOSESPOT_SANDBOX_NOT_ENABLED",
      });
    }
    const on = build({ env: withPlatformKey });
    await putFull(on);
    await verifyFully(on);
    expect((await on.service.activate(on.store, TENANT)).view.status).toBe("active");
  });

  it("a deactivation and a re-test never need the flag (a live row can always be taken out of service)", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    await h.service.activate(h.store, TENANT);
    const off = createDoseSpotClinicService({
      cipher: buildClinicSecretCipher({
        dekForOrg: async () => ({ version: "v1", key: randomBytes(32) }),
      }),
      probe: { probe: async () => "ok" },
      env: SUBSCRIPTION_KEY_ONLY,
    });
    expect((await off.deactivate(h.store, TENANT)).view.status).toBe("verified");
  });
});

describe("the view says whether the registration is LIVE on this deployment, not just what status it was left in", () => {
  it("an active sandbox row on a deployment that does not enable sandbox is NOT live, with a reason code", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    await verifyFully(h);
    await h.service.activate(h.store, TENANT);
    expect(await h.service.view(h.store, ORG)).toMatchObject({
      status: "active",
      live: true,
      notLiveReason: null,
    });
    // the flag is later unset: the stored status is still `active`, but nothing is served
    const off = createDoseSpotClinicService({
      cipher: buildClinicSecretCipher({
        dekForOrg: async () => ({ version: "v1", key: randomBytes(32) }),
      }),
      probe: { probe: async () => "ok" },
      env: SUBSCRIPTION_KEY_ONLY,
    });
    expect(await off.view(h.store, ORG)).toMatchObject({
      status: "active",
      live: false,
      notLiveReason: "sandbox_not_enabled",
    });
  });

  // Review of slice 4, L-a: the reason was keyed on the ROW's environment, so a sandbox row whose host was unusable was told "sandbox_not_enabled"
  // (an operator who then set the flag found nothing changed). The reason now follows the environment resolver: no usable host or flag is
  // `environment_unavailable`; a usable sandbox that is merely not enabled is `sandbox_not_enabled`.
  const notLiveReasonUnder = async (
    environment: "sandbox" | "production",
    activeEnv: Record<string, string>,
    laterEnv: Record<string, string>,
  ) => {
    const h = build({ env: activeEnv });
    await putFull(h, { environment });
    await verifyFully(h);
    await h.service.activate(h.store, TENANT);
    const later = createDoseSpotClinicService({
      cipher: buildClinicSecretCipher({
        dekForOrg: async () => ({ version: "v1", key: randomBytes(32) }),
      }),
      probe: { probe: async () => "ok" },
      env: laterEnv,
    });
    return later.view(h.store, ORG);
  };
  const PROD = {
    DOSESPOT_PRODUCTION_ENABLED: "true",
    DOSESPOT_SUBSCRIPTION_KEY_PRODUCTION: "platform-prod-sub-key",
    DOSESPOT_BASE_URL_PRODUCTION: "https://my.dosespot.com",
  };

  it("a sandbox row on a deployment that enables sandbox but names an unacceptable host is environment_unavailable, not sandbox_not_enabled", async () => {
    const view = await notLiveReasonUnder("sandbox", withPlatformKey, {
      ...withPlatformKey,
      DOSESPOT_BASE_URL_SANDBOX: "https://attacker.example.com",
    });
    expect(view).toMatchObject({
      status: "active",
      live: false,
      notLiveReason: "environment_unavailable",
    });
  });

  it("a production row whose flag has been turned off, or whose host has been unset, is environment_unavailable", async () => {
    expect(await notLiveReasonUnder("production", PROD, SUBSCRIPTION_KEY_ONLY)).toMatchObject({
      live: false,
      notLiveReason: "environment_unavailable",
    });
    const { DOSESPOT_BASE_URL_PRODUCTION: _unset, ...noHost } = PROD;
    expect(await notLiveReasonUnder("production", PROD, noHost)).toMatchObject({
      live: false,
      notLiveReason: "environment_unavailable",
    });
  });

  it("a usable sandbox that is only not enabled stays sandbox_not_enabled, and a live production row has no reason", async () => {
    expect(
      await notLiveReasonUnder("sandbox", withPlatformKey, SUBSCRIPTION_KEY_ONLY),
    ).toMatchObject({
      live: false,
      notLiveReason: "sandbox_not_enabled",
    });
    expect(await notLiveReasonUnder("production", PROD, PROD)).toMatchObject({
      live: true,
      notLiveReason: null,
    });
  });

  it("a row that was never activated is not live, and an env-served org is", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    expect(await h.service.view(h.store, ORG)).toMatchObject({ live: false, notLiveReason: null });
    const served = build({ envFallbackOrgs: [ORG] });
    expect(await served.service.view(served.store, ORG)).toMatchObject({
      source: "platform_env",
      live: true,
    });
    const none = build();
    expect(await none.service.view(none.store, ORG)).toMatchObject({ live: false });
  });
});

describe("the view's facts", () => {
  it("shows how many prescribers are enrolled and how many orders are waiting, and gates nothing on them", async () => {
    const h = build({ env: withPlatformKey });
    await putFull(h);
    h.store.setPrescribers(ORG, 2);
    h.store.setQueued(ORG, 5);
    const v = await h.service.view(h.store, ORG);
    expect(v).toMatchObject({ prescribersEnrolled: 2, queuedTransmissions: 5 });
    await verifyFully(h);
    expect((await h.service.activate(h.store, TENANT)).view.status).toBe("active");
  });
});
