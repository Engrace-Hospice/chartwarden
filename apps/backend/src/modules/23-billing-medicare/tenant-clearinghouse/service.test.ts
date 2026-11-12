import { randomBytes } from "node:crypto";
import { CLEARINGHOUSE_RELEASE_QUIET_DAYS, ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryConfigStore } from "./config-store-memory";
import { MAX_HELD_CREDENTIALS } from "./credential-reservation";
import { fingerprintKeysIncomplete } from "./fingerprint-key-check";
import { buildClearinghouseSecretCipher, deriveFingerprintSubkey } from "./secret-cipher";
import {
  type ClearinghouseActor,
  type ClearinghouseProbes,
  type TenantClearinghouseService,
  createTenantClearinghouseService,
  verifyConnection,
} from "./service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACTOR: ClearinghouseActor = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  membershipId: "44444444-4444-4444-8444-444444444444",
  lane: "tenant",
};
const FAKE_KEY = "fake-key-not-a-secret#1";
const OPERATOR: ClearinghouseActor = {
  organizationId: ORG,
  userId: "55555555-5555-4555-8555-555555555555",
  membershipId: "66666666-6666-4666-8666-666666666666",
  lane: "platform",
};
const BAA = {
  heldBy: "tenant",
  effectiveDate: "2026-01-15",
  documentRef: "Claim.MD BAA, signed 2026-01-15, contract folder 7",
} as const;

/** The route's own orchestration: read + decrypt, probe with NO transaction open, then compare-and-set. */
const verify = (
  service: TenantClearinghouseService,
  store: ReturnType<typeof createInMemoryConfigStore>,
  actor: ClearinghouseActor,
  input: { evidenceNote?: string; confirmNoPatientInformation?: boolean } = {},
) => verifyConnection(service, (fn) => fn(store), actor, input);
/** The BAA record the operator was looking at: its own `recordedAt`, read off the masked view (the route's If-Match). */
const pinOf = async (
  service: TenantClearinghouseService,
  store: ReturnType<typeof createInMemoryConfigStore>,
): Promise<{ recordedAt: string }> => ({
  recordedAt: (await service.view(store, ORG)).baa?.recordedAt ?? "no BAA recorded",
});
/** The operator verifies the record as it stands now (what a fresh read shows). */
const verifyBaaSeen = async (
  service: TenantClearinghouseService,
  store: ReturnType<typeof createInMemoryConfigStore>,
) => service.verifyBaa(store, OPERATOR, await pinOf(service, store));

const ATTEST = {
  evidenceNote: "Sandbox claim accepted by Stedi test mode, ticket OPS-123",
  confirmNoPatientInformation: true,
} as const;

/** A claimmd config taken all the way to active (connection verified, BAA recorded and verified). */
async function makeActive(
  service: TenantClearinghouseService,
  store: ReturnType<typeof createInMemoryConfigStore>,
) {
  await service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined);
  await verify(service, store, ACTOR);
  await service.recordBaa(store, ACTOR, BAA);
  await verifyBaaSeen(service, store);
  return service.activate(store, ACTOR);
}

function setup(probes: ClearinghouseProbes = {}) {
  const store = createInMemoryConfigStore();
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  let probed: { secret: string; mode: string } | undefined;
  const probe =
    (outcome: "ok" | "credential_rejected" | "unreachable") =>
    async (secret: string, mode: string) => {
      probed = { secret, mode };
      return outcome;
    };
  const service = createTenantClearinghouseService({
    cipher,
    probes: Object.keys(probes).length > 0 ? probes : { claimmd: probe("ok") },
  });
  return { store, service, cipher, probe, probed: () => probed };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ChartWardenError) return err.code;
    throw err;
  }
  return "no error";
};

describe("tenant clearinghouse service: choosing", () => {
  it("reports nothing chosen for a new tenant", async () => {
    const { store, service } = setup();
    const view = await service.view(store, ORG);
    expect(view).toMatchObject({ vendor: null, status: null, source: "none", hasSecret: false });
  });

  it("starts a transmitting vendor at draft with a sealed secret and never returns the secret", async () => {
    const { store, service } = setup();
    const { created, view } = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    expect(created).toBe(true);
    expect(view).toMatchObject({
      vendor: "claimmd",
      mode: "test",
      status: "draft",
      hasSecret: true,
      verifiableBy: "connection_test",
    });
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
    const [row] = store.rows();
    expect(row?.secretCipher).toBeTruthy();
    expect(row?.secretCipher).not.toContain(FAKE_KEY);
  });

  it("stores `outside` as active with no mode and no secret", async () => {
    const { store, service } = setup();
    const { view } = await service.put(store, ACTOR, { vendor: "outside" }, undefined);
    expect(view).toMatchObject({
      vendor: "outside",
      status: "active",
      mode: null,
      hasSecret: false,
    });
  });

  it("refuses an incomplete or contradictory choice before touching the store", async () => {
    const { store, service } = setup();
    expect(
      await codeOf(service.put(store, ACTOR, { vendor: "stedi", secret: FAKE_KEY }, undefined)),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(service.put(store, ACTOR, { vendor: "stedi", mode: "test" }, undefined)),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(service.put(store, ACTOR, { vendor: "outside", mode: "test" }, undefined)),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(
        service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: "short" }, undefined),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(store.rows()).toHaveLength(0);
  });

  it("answers 503 when no encryption key is bound (a secret is never stored in the clear)", async () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({ probes: {} });
    expect(
      await codeOf(
        service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined),
      ),
    ).toBe("CLEARINGHOUSE_CIPHER_UNBOUND");
    expect(store.rows()).toHaveLength(0);
  });

  describe("checkPut: every refusal put would make, without writing", () => {
    it("refuses the platform's own key before anything is written (security review LOW-3)", async () => {
      const store = createInMemoryConfigStore();
      const cipher = buildClearinghouseSecretCipher(randomBytes(32));
      const service = createTenantClearinghouseService({
        cipher,
        probes: {},
        platformCredentialFingerprints: new Set([cipher.fingerprint("claimmd", FAKE_KEY)]),
      });
      expect(
        await codeOf(
          service.checkPut(
            store,
            OPERATOR,
            { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
            undefined,
          ),
        ),
      ).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");
      expect(store.rows()).toEqual([]);
    });

    it("answers 503 for a credential when no encryption key is bound, BEFORE the caller writes anything else (the operator's switch sets the billing mode first)", async () => {
      const store = createInMemoryConfigStore();
      const service = createTenantClearinghouseService({ probes: {} });
      expect(
        await codeOf(
          service.checkPut(
            store,
            OPERATOR,
            { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
            undefined,
          ),
        ),
      ).toBe("CLEARINGHOUSE_CIPHER_UNBOUND");
      expect(store.rows()).toHaveLength(0);
    });

    it("asks nothing of the cipher for `outside` or for a write without a credential, and writes nothing either way", async () => {
      const store = createInMemoryConfigStore();
      const service = createTenantClearinghouseService({ probes: {} });
      await expect(
        service.checkPut(store, OPERATOR, { vendor: "outside" }, undefined),
      ).resolves.toBeUndefined();
      expect(store.rows()).toHaveLength(0);
    });

    it("refuses what put would refuse (a missing credential on a first choice, a stale or missing pin) and changes nothing", async () => {
      const { store, service } = setup();
      expect(
        await codeOf(
          service.checkPut(store, OPERATOR, { vendor: "claimmd", mode: "production" }, undefined),
        ),
      ).toBe("VALIDATION_FAILED"); // the field error on `secret` (CLEARINGHOUSE_SECRET_REQUIRED) under the 422 envelope
      const chosen = await service.put(store, ACTOR, { vendor: "outside" }, undefined);
      const version = chosen.view.version as number;
      const toVendor = { vendor: "claimmd", mode: "production", secret: FAKE_KEY } as const;
      expect(await codeOf(service.checkPut(store, OPERATOR, toVendor, undefined))).toBe(
        "IF_MATCH_REQUIRED",
      );
      expect(await codeOf(service.checkPut(store, OPERATOR, toVendor, version + 3))).toBeTruthy();
      await expect(service.checkPut(store, OPERATOR, toVendor, version)).resolves.toBeUndefined();
      expect((await service.view(store, ORG)).vendor).toBe("outside");
    });
  });

  it("needs If-Match to change an existing config, and refuses a stale version", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const input = { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}2` } as const;
    expect(await codeOf(service.put(store, ACTOR, input, undefined))).toBe("IF_MATCH_REQUIRED");
    expect(await codeOf(service.put(store, ACTOR, input, 7))).toBe("VERSION_CONFLICT");
    expect(await codeOf(service.put(store, ACTOR, input, 1))).toBe("no error");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside" }, undefined))).toBe(
      "IF_MATCH_REQUIRED",
    );
  });

  it("refuses If-Match on a first choice", async () => {
    const { store, service } = setup();
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside" }, 1))).toBe(
      "VERSION_CONFLICT",
    );
  });

  it("changes nothing for an identical put with no new secret", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const { view } = await service.put(store, ACTOR, { vendor: "claimmd", mode: "test" }, 1);
    expect(view.version).toBe(1);
  });

  it("puts a vendor or mode change back to draft and demands the new credential", async () => {
    const { store, service } = setup();
    const live = await makeActive(service, store);
    expect(
      await codeOf(
        service.put(
          store,
          ACTOR,
          { vendor: "claimmd", mode: "production" },
          live.version as number,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
    const { view } = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-prod` },
      live.version as number,
    );
    expect(view).toMatchObject({
      status: "draft",
      mode: "production",
      verification: null,
      activatedAt: null,
    });
  });

  // D6 (owner, 2026-11-06): rotating the credential of a verified or live config means the NEW key has not been tried.
  it("drops a verified or active config back to draft on a credential rotation, and clears what the old key earned", async () => {
    for (const stopAt of ["verified", "active"] as const) {
      const { store, service } = setup();
      const before =
        stopAt === "active"
          ? await makeActive(service, store)
          : await (async () => {
              await service.put(
                store,
                ACTOR,
                { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
                undefined,
              );
              return (await verify(service, store, ACTOR)).view;
            })();
      expect(before.status).toBe(stopAt);
      const { view, changedFields } = await service.put(
        store,
        ACTOR,
        { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}-rotated` },
        before.version as number,
      );
      expect(view).toMatchObject({
        status: "draft",
        lastTest: null,
        verification: null,
        activatedAt: null,
      });
      expect(changedFields).toEqual(["secret"]);
      // the connection to the new key must be re-verified, and the config re-activated
      expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_VERIFIED");
    }
  });

  it("keeps the vendor BAA across a same-vendor rotation or mode change, and voids it when the vendor changes", async () => {
    const { store, service } = setup();
    const live = await makeActive(service, store);
    // the record names the vendor it was made for (the table's CHECK keeps an active config on that vendor's BAA)
    expect(store.rows()[0]?.baaVendor).toBe("claimmd");
    const rotated = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}-rotated` },
      live.version as number,
    );
    expect(rotated.view.baa?.verified).not.toBeNull();
    // chosen (L1): a key change inside the same vendor keeps the BAA; the BAA is with the vendor, not with a key or an account id
    // ChartWarden can see, and the tenant re-records it when its agreement changes
    expect(store.rows()[0]?.baaVendor).toBe("claimmd");
    const remoded = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-prod` },
      rotated.view.version as number,
    );
    expect(remoded.view.baa?.verified).not.toBeNull();
    const switched = await service.put(
      store,
      ACTOR,
      { vendor: "stedi", mode: "production", secret: `${FAKE_KEY}-stedi` },
      remoded.view.version as number,
    );
    expect(switched.view.baa).toBeNull();
    expect(store.rows()[0]?.baaVendor).toBeNull();
    expect(switched.view.status).toBe("draft");
  });

  it("a BAA recorded after a switch names the NEW vendor, and a switch to outside leaves no BAA vendor behind", async () => {
    const { store, service } = setup();
    const live = await makeActive(service, store);
    const switched = await service.put(
      store,
      ACTOR,
      { vendor: "stedi", mode: "production", secret: `${FAKE_KEY}-stedi` },
      live.version as number,
    );
    await service.recordBaa(store, ACTOR, { ...BAA, documentRef: "Stedi BAA, contract folder 8" });
    expect(store.rows()[0]?.baaVendor).toBe("stedi");
    const outside = await service.put(
      store,
      ACTOR,
      { vendor: "outside" },
      (await service.view(store, ORG)).version as number,
    );
    expect(outside.view.baa).toBeNull();
    expect(store.rows()[0]?.baaVendor).toBeNull();
    expect(switched.view.baa).toBeNull();
  });

  it("reports which fields a put changed (names only), for the field-level audit row", async () => {
    const { store, service } = setup();
    const first = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    expect(first.changedFields).toEqual(["vendor", "mode", "secret"]);
    const switched = await service.put(
      store,
      ACTOR,
      { vendor: "stedi", mode: "test", secret: FAKE_KEY },
      first.view.version as number,
    );
    expect(switched.changedFields).toEqual(["vendor", "secret"]);
    const same = await service.put(
      store,
      ACTOR,
      { vendor: "stedi", mode: "test" },
      switched.view.version as number,
    );
    expect(same.changedFields).toEqual([]);
  });

  it("refuses to switch away from a vendor (or to outside) while the org has queued claims or submissions", async () => {
    const store = createInMemoryConfigStore();
    const cipher = buildClearinghouseSecretCipher(randomBytes(32));
    const waiting = { claims: 2, commercialSubmissions: 1 };
    const service = createTenantClearinghouseService({
      cipher,
      probes: {},
      waitingWork: async () => waiting,
    });
    // an ACTIVE config: only a vendor that is live can drain what is queued on it (re-review M3: see the draft test below)
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    await verify(service, store, ACTOR, ATTEST);
    await service.recordBaa(store, ACTOR, BAA);
    await verifyBaaSeen(service, store);
    const first = { view: await service.activate(store, ACTOR) };
    const version = first.view.version as number;
    for (const input of [
      { vendor: "outside" },
      { vendor: "stedi", mode: "test", secret: FAKE_KEY },
      { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
    ] as const) {
      const err = await service.put(store, ACTOR, input, version).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChartWardenError);
      expect(err).toMatchObject({ code: "CLEARINGHOUSE_WORK_WAITING", statusCode: 409 });
      // the 409 names the counts so the tenant knows what to wait for
      expect(JSON.stringify((err as ChartWardenError).details)).toContain("claims");
      expect(JSON.stringify((err as ChartWardenError).details)).toContain("2");
    }
    // a same-vendor, same-mode credential rotation is not a switch: nothing is re-routed
    expect(
      await codeOf(
        service.put(
          store,
          ACTOR,
          { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}-rotated` },
          version,
        ),
      ),
    ).toBe("no error");
    // and once the queue is empty the switch is allowed
    waiting.claims = 0;
    waiting.commercialSubmissions = 0;
    const next = await service.view(store, ORG);
    expect(
      await codeOf(service.put(store, ACTOR, { vendor: "outside" }, next.version as number)),
    ).toBe("no error");
  });

  // Owner decision (slice 5): a tenant that bills outside ChartWarden is on billing mode none. Switching to a vendor means choosing the
  // billing mode the vendor billing calls for, which only a platform operator may do (the tenant's own lane cannot set it).
  describe("leaving `outside` while the org has a pricing contract", () => {
    async function outsideOrg(hasContract: (org: string) => Promise<boolean>) {
      const store = createInMemoryConfigStore();
      const service = createTenantClearinghouseService({
        cipher: buildClearinghouseSecretCipher(randomBytes(32)),
        probes: {},
        hasPricingContract: (org) => hasContract(org),
      });
      const chosen = await service.put(store, ACTOR, { vendor: "outside" }, undefined);
      return { store, service, version: chosen.view.version as number };
    }
    const toVendor = { vendor: "claimmd", mode: "production", secret: FAKE_KEY } as const;

    it("refuses the tenant's own switch with a typed 409, and changes nothing", async () => {
      const { store, service, version } = await outsideOrg(async () => true);
      const err = await service.put(store, ACTOR, toVendor, version).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChartWardenError);
      expect(err).toMatchObject({
        code: "CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR",
        statusCode: 409,
      });
      expect((await service.view(store, ORG)).vendor).toBe("outside");
    });

    it("lets a platform operator make the switch (the operator's flow sets the billing mode with it)", async () => {
      const { store, service, version } = await outsideOrg(async () => true);
      expect(await codeOf(service.put(store, OPERATOR, toVendor, version))).toBe("no error");
      expect((await service.view(store, ORG)).vendor).toBe("claimmd");
    });

    it("lets a tenant with NO contract switch (there is no billing mode to set)", async () => {
      const { store, service, version } = await outsideOrg(async () => false);
      expect(await codeOf(service.put(store, ACTOR, toVendor, version))).toBe("no error");
    });

    it("does not stand in the way of a tenant that stays outside, or of a first choice", async () => {
      const store = createInMemoryConfigStore();
      const service = createTenantClearinghouseService({
        cipher: buildClearinghouseSecretCipher(randomBytes(32)),
        probes: {},
        hasPricingContract: async () => true,
      });
      expect(await codeOf(service.put(store, ACTOR, toVendor, undefined))).toBe("no error");
    });

    it("answers 503, not a guess, when the contract cannot be read (a switch that cannot be judged is not allowed)", async () => {
      const { store, service, version } = await outsideOrg(async () => {
        throw new Error("pricing read failed");
      });
      const err = await service.put(store, ACTOR, toVendor, version).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CLEARINGHOUSE_CONTRACT_UNAVAILABLE", statusCode: 503 });
      expect((await service.view(store, ORG)).vendor).toBe("outside");
    });

    it("asks nothing where pricing is not bound (a deployment without it has no contracts)", async () => {
      const store = createInMemoryConfigStore();
      const service = createTenantClearinghouseService({
        cipher: buildClearinghouseSecretCipher(randomBytes(32)),
        probes: {},
      });
      const chosen = await service.put(store, ACTOR, { vendor: "outside" }, undefined);
      expect(await codeOf(service.put(store, ACTOR, toVendor, chosen.view.version as number))).toBe(
        "no error",
      );
    });
  });

  it("counts waiting work only for an ACTIVE config: a draft or verified one cannot drain it, so refusing the switch would strand the tenant (re-review M3)", async () => {
    const waiting = { claims: 3, commercialSubmissions: 2 };
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {},
      waitingWork: async () => waiting,
    });
    // draft: chosen, nothing verified; the claims queued meanwhile are held and no vendor is able to send them
    const draftStore = createInMemoryConfigStore();
    const draft = await service.put(
      draftStore,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    // verified: the connection is tested, the BAA is not yet in place, still nothing is sent
    const verifiedStore = createInMemoryConfigStore();
    await service.put(
      verifiedStore,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const verified = await verify(service, verifiedStore, ACTOR, ATTEST);
    expect(verified.view.status).toBe("verified");

    expect(
      await codeOf(
        service.put(
          draftStore,
          ACTOR,
          { vendor: "stedi", mode: "test", secret: FAKE_KEY },
          draft.view.version as number,
        ),
      ),
    ).toBe("no error");
    expect(
      await codeOf(
        service.put(verifiedStore, ACTOR, { vendor: "outside" }, verified.view.version as number),
      ),
    ).toBe("no error");
  });

  it("reads the waiting work on the store's own transaction, never a second pooled connection while the row is locked (re-review L5)", async () => {
    const scope = { name: "the open org-scoped transaction" };
    const store = Object.assign(createInMemoryConfigStore(), { tx: scope });
    const seen: unknown[] = [];
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {},
      waitingWork: async (_organizationId, tx) => {
        seen.push(tx);
        return { claims: 0, commercialSubmissions: 0 };
      },
    });
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    await verify(service, store, ACTOR, ATTEST);
    await service.recordBaa(store, ACTOR, BAA);
    await verifyBaaSeen(service, store);
    const live = await service.activate(store, ACTOR);

    await service.put(store, ACTOR, { vendor: "outside" }, live.version as number);

    expect(seen).toEqual([scope]);
  });

  it("locks vendor and mode once a production submission exists, but still allows a rotation", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
      undefined,
    );
    store.setProductionAttempts(ORG, true);
    expect(
      await codeOf(
        service.put(store, ACTOR, { vendor: "stedi", mode: "production", secret: FAKE_KEY }, 1),
      ),
    ).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    expect(await codeOf(service.put(store, ACTOR, { vendor: "outside" }, 1))).toBe(
      "CLEARINGHOUSE_VENDOR_LOCKED",
    );
    expect(
      await codeOf(
        service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, 1),
      ),
    ).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    expect(
      await codeOf(
        service.put(
          store,
          ACTOR,
          { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-new` },
          1,
        ),
      ),
    ).toBe("no error");
  });

  describe("the vendor lock ends with the credential release's quiet window (CH-1)", () => {
    const DAY = 86_400_000;
    const NOW = new Date("2026-11-09T12:00:00Z");
    /** A production claimmd config whose latest production submission was reserved `daysAgo` days ago. */
    async function lockedAt(daysAgo: number) {
      const store = createInMemoryConfigStore();
      const service = createTenantClearinghouseService({
        cipher: buildClearinghouseSecretCipher(randomBytes(32)),
        probes: {},
        now: () => NOW,
      });
      await service.put(
        store,
        ACTOR,
        { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
        undefined,
      );
      store.setProductionAttempts(ORG, true, new Date(NOW.getTime() - daysAgo * DAY));
      return { store, service };
    }
    const switchToStedi = (
      s: Awaited<ReturnType<typeof lockedAt>>,
    ): ReturnType<TenantClearinghouseService["put"]> =>
      s.service.put(
        s.store,
        ACTOR,
        { vendor: "stedi", mode: "production", secret: `${FAKE_KEY}-stedi` },
        1,
      );

    it("keeps the lock while the latest production submission is inside the window", async () => {
      const s = await lockedAt(CLEARINGHOUSE_RELEASE_QUIET_DAYS - 1);
      expect(await codeOf(switchToStedi(s))).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
    });

    it("lets the tenant switch once the window has passed, so a one-time production claim never locks it forever", async () => {
      const s = await lockedAt(CLEARINGHOUSE_RELEASE_QUIET_DAYS + 1);
      expect(await codeOf(switchToStedi(s))).toBe("no error");
    });
  });

  it("reports a platform-env fallback for an org that has no row", async () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({
      probes: {},
      platformFallback: (org) => (org === ORG ? { vendor: "stedi", mode: "test" } : null),
    });
    expect(await service.view(store, ORG)).toMatchObject({
      vendor: "stedi",
      status: "active",
      source: "platform_env",
    });
    expect(await service.view(store, OTHER_ORG)).toMatchObject({ vendor: null, source: "none" });
  });
});

describe("tenant clearinghouse service: verifying and activating", () => {
  it("verifies Claim.MD with a connection test using the unsealed key in the chosen mode", async () => {
    const { store, service, probed } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const { view, test } = await verify(service, store, ACTOR, {});
    expect(test).toEqual({ outcome: "ok" });
    expect(view).toMatchObject({
      status: "verified",
      verification: { kind: "connection_test" },
      lastTest: { outcome: "ok" },
    });
    expect(probed()).toEqual({ secret: FAKE_KEY, mode: "test" });
  });

  it("stays at draft and records the outcome when the connection test fails", async () => {
    const { store, service, probe } = setup();
    const failing = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: { claimmd: probe("credential_rejected") },
    });
    await failing.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const { view, test } = await verify(failing, store, ACTOR, {});
    expect(test).toEqual({ outcome: "credential_rejected" });
    expect(view).toMatchObject({
      status: "draft",
      verification: null,
      lastTest: { outcome: "credential_rejected" },
    });
    expect(await codeOf(failing.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_VERIFIED");
  });

  it("verifies Stedi (no safe probe) only by attestation with an evidence note", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined);
    expect((await service.view(store, ORG)).verifiableBy).toBe("attestation");
    expect(await codeOf(verify(service, store, ACTOR, {}))).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(
        verify(service, store, ACTOR, { evidenceNote: "short", confirmNoPatientInformation: true }),
      ),
    ).toBe("VALIDATION_FAILED");
    const { view, test } = await verify(service, store, ACTOR, ATTEST);
    expect(test).toBeNull();
    expect(view).toMatchObject({
      status: "verified",
      verification: {
        kind: "attested",
        evidence: "Sandbox claim accepted by Stedi test mode, ticket OPS-123",
      },
    });
  });

  it("refuses an evidence note that looks like a patient identifier", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined);
    expect(
      await codeOf(
        verify(service, store, ACTOR, {
          evidenceNote: "tested with beneficiary 900-12-3456 today",
          confirmNoPatientInformation: true,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(
        verify(service, store, ACTOR, {
          evidenceNote: "tested with beneficiary ９００-１２-３４５６ today",
          confirmNoPatientInformation: true,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("refuses to verify with nothing chosen, with `outside`, or before the credential is entered", async () => {
    const { store, service } = setup();
    expect(await codeOf(verify(service, store, ACTOR, {}))).toBe("CLEARINGHOUSE_NOT_CONFIGURED");
    expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_CONFIGURED");
    await service.put(store, ACTOR, { vendor: "outside" }, undefined);
    expect(await codeOf(verify(service, store, ACTOR, {}))).toBe(
      "CLEARINGHOUSE_OUTSIDE_NOT_VERIFIABLE",
    );
  });

  it("activates only a verified config, and activation is idempotent", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_NOT_VERIFIED");
    await verify(service, store, ACTOR);
    await service.recordBaa(store, ACTOR, BAA);
    await verifyBaaSeen(service, store);
    const first = await service.activate(store, ACTOR);
    expect(first).toMatchObject({ status: "active" });
    expect(first.activatedAt).not.toBeNull();
    const again = await service.activate(store, ACTOR);
    expect(again.version).toBe(first.version);
  });

  it("a platform operator may not activate: 403 CLEARINGHOUSE_ACTIVATION_TENANT_ONLY, even for a verified config; the tenant's own admin still can", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    await verify(service, store, ACTOR);
    await service.recordBaa(store, ACTOR, BAA);
    await verifyBaaSeen(service, store);
    // everything an activation needs is in place: only the lane is wrong
    const refused = await service.activate(store, OPERATOR).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ChartWardenError);
    expect(refused).toMatchObject({
      code: "CLEARINGHOUSE_ACTIVATION_TENANT_ONLY",
      statusCode: 403,
    });
    expect((await service.view(store, ORG)).status).toBe("verified");
    expect(await service.activate(store, ACTOR)).toMatchObject({ status: "active" });
    // and an operator cannot re-run it over an active config either (a refusal, not an idempotent success)
    expect(await codeOf(service.activate(store, OPERATOR))).toBe(
      "CLEARINGHOUSE_ACTIVATION_TENANT_ONLY",
    );
  });

  it("re-verifying an active config keeps it active", async () => {
    const { store, service } = setup();
    await makeActive(service, store);
    const { view } = await verify(service, store, ACTOR);
    expect(view.status).toBe("active");
  });
});

describe("tenant clearinghouse service: the tenant-held vendor BAA (owner decision D2)", () => {
  async function verifiedClaimMd() {
    const ctx = setup();
    await ctx.service.put(
      ctx.store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    await verify(ctx.service, ctx.store, ACTOR);
    return ctx;
  }

  it("refuses activation until a platform operator has verified the recorded BAA (409 CLEARINGHOUSE_BAA_NOT_VERIFIED)", async () => {
    const { store, service } = await verifiedClaimMd();
    // nothing recorded yet
    expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    // recorded by the tenant, not yet verified by an operator
    await service.recordBaa(store, ACTOR, BAA);
    const err = await service.activate(store, ACTOR).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CLEARINGHOUSE_BAA_NOT_VERIFIED", statusCode: 409 });
    expect((await service.view(store, ORG)).status).toBe("verified");
    // verified by the operator: now it may go live
    await verifyBaaSeen(service, store);
    expect((await service.activate(store, ACTOR)).status).toBe("active");
  });

  it("shows the BAA status in the view: who holds it, when, the document reference, and whether it is verified", async () => {
    const { store, service } = await verifiedClaimMd();
    expect((await service.view(store, ORG)).baa).toBeNull();
    const recorded = await service.recordBaa(store, ACTOR, BAA);
    expect(recorded.view.baa).toMatchObject({
      heldBy: "tenant",
      effectiveDate: "2026-01-15",
      documentRef: BAA.documentRef,
      verified: null,
    });
    const verified = await verifyBaaSeen(service, store);
    expect(verified.baa?.verified?.at).toEqual(expect.any(String));
  });

  it("validates the record: held by the tenant, a real past date, a reference with no patient identifier", async () => {
    const { store, service } = await verifiedClaimMd();
    const cases: unknown[] = [
      { ...BAA, heldBy: "chartwarden" },
      { ...BAA, effectiveDate: "2999-01-01" },
      { ...BAA, effectiveDate: "not-a-date" },
      { ...BAA, effectiveDate: "2026-02-30" },
      { ...BAA, documentRef: "ab" },
      { ...BAA, documentRef: "x".repeat(201) },
      { ...BAA, documentRef: "scan for beneficiary 900-12-3456" },
      { ...BAA, documentRef: "scan for beneficiary ９００-１２-３４５６" },
      { ...BAA, documentRef: "scan for beneficiary １EG４TE５MK７３" },
    ];
    for (const bad of cases) {
      expect(await codeOf(service.recordBaa(store, ACTOR, bad as typeof BAA))).toBe(
        "VALIDATION_FAILED",
      );
    }
    expect((await service.view(store, ORG)).baa).toBeNull();
  });

  // "Not in the future" is judged on the Eastern (CMS) calendar day, like every other date M23 decides on: 02:00 UTC on 11-07 is
  // still 21:00 Eastern on 11-06, so a BAA dated 11-07 is a day ahead of the tenant's own calendar.
  it("judges 'not in the future' on the EASTERN day, not UTC", async () => {
    const store = createInMemoryConfigStore();
    const eveningEastern = new Date("2026-11-07T02:00:00.000Z");
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: { claimmd: async () => "ok" },
      now: () => eveningEastern,
    });
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    expect(
      await codeOf(service.recordBaa(store, ACTOR, { ...BAA, effectiveDate: "2026-11-07" })),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(service.recordBaa(store, ACTOR, { ...BAA, effectiveDate: "2026-11-06" })),
    ).toBe("no error");
  });

  it("refuses to record a BAA for `outside` (there is no vendor account) or with nothing chosen", async () => {
    const { store, service } = setup();
    expect(await codeOf(service.recordBaa(store, ACTOR, BAA))).toBe("CLEARINGHOUSE_NOT_CONFIGURED");
    await service.put(store, ACTOR, { vendor: "outside" }, undefined);
    expect(await codeOf(service.recordBaa(store, ACTOR, BAA))).toBe(
      "CLEARINGHOUSE_BAA_NOT_APPLICABLE",
    );
    expect(await codeOf(verifyBaaSeen(service, store))).toBe("CLEARINGHOUSE_BAA_NOT_APPLICABLE");
  });

  it("will not verify a BAA nobody recorded, and verifying twice changes nothing", async () => {
    const { store, service } = await verifiedClaimMd();
    expect(await codeOf(verifyBaaSeen(service, store))).toBe("CLEARINGHOUSE_BAA_NOT_RECORDED");
    await service.recordBaa(store, ACTOR, BAA);
    const first = await verifyBaaSeen(service, store);
    const again = await verifyBaaSeen(service, store);
    expect(again.version).toBe(first.version);
  });

  it("pins a tenant BAA write to the clearinghouse version read by the administrator", async () => {
    const { store, service } = await verifiedClaimMd();
    const current = await service.view(store, ORG);
    const stale = await service
      .recordBaa(store, ACTOR, BAA, (current.version as number) + 1)
      .catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: "STALE_VERSION", statusCode: 409 });
    expect((await service.view(store, ORG)).baa).toBeNull();
    await expect(
      service.recordBaa(store, ACTOR, BAA, current.version as number),
    ).resolves.toMatchObject({ view: { baa: { effectiveDate: BAA.effectiveDate } } });
  });

  it("pins the verification to the record the operator saw: a record changed after the read is a 409 and stays unverified (re-review M1)", async () => {
    const { store, service } = await verifiedClaimMd();
    await service.recordBaa(store, ACTOR, BAA);
    const seen = await pinOf(service, store); // the operator reads the record ...
    // ... and the tenant swaps it for another document before the operator's click lands
    await new Promise((r) => setTimeout(r, 5));
    await service.recordBaa(store, ACTOR, {
      ...BAA,
      documentRef: "Claim.MD BAA, a different agreement, contract folder 9",
    });

    const err = await service.verifyBaa(store, OPERATOR, seen).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CLEARINGHOUSE_BAA_CHANGED", statusCode: 409 });
    expect((await service.view(store, ORG)).baa?.verified).toBeNull();

    // verifying what the record now says works, and an operator still holding the old pin is refused even when verified
    const verified = await verifyBaaSeen(service, store);
    expect(verified.baa?.verified?.at).toEqual(expect.any(String));
    expect(await codeOf(service.verifyBaa(store, OPERATOR, seen))).toBe(
      "CLEARINGHOUSE_BAA_CHANGED",
    );
  });

  it("an idempotent re-verify needs the right pin too", async () => {
    const { store, service } = await verifiedClaimMd();
    await service.recordBaa(store, ACTOR, BAA);
    const pin = await pinOf(service, store);
    const first = await service.verifyBaa(store, OPERATOR, pin);
    expect((await service.verifyBaa(store, OPERATOR, pin)).version).toBe(first.version);
    expect(
      await codeOf(service.verifyBaa(store, OPERATOR, { recordedAt: "2000-01-01T00:00:00.000Z" })),
    ).toBe("CLEARINGHOUSE_BAA_CHANGED");
  });

  it("asserts the lane in the service (F7): a platform operator cannot record the tenant's BAA, and the tenant lane cannot verify it", async () => {
    const { store, service } = await verifiedClaimMd();
    expect(await codeOf(service.recordBaa(store, OPERATOR, BAA))).toBe(
      "CLEARINGHOUSE_BAA_TENANT_ONLY",
    );
    expect((await service.view(store, ORG)).baa).toBeNull();

    await service.recordBaa(store, ACTOR, BAA);
    const pin = await pinOf(service, store);
    expect(await codeOf(service.verifyBaa(store, ACTOR, pin))).toBe("FORBIDDEN");
    expect((await service.view(store, ORG)).baa?.verified).toBeNull();
    expect(await codeOf(service.verifyBaa(store, OPERATOR, pin))).toBe("no error");
  });

  it("re-recording the same BAA is a no-op; a changed record voids the verification and takes a live config out of service", async () => {
    const { store, service } = setup();
    const live = await makeActive(service, store);
    const same = await service.recordBaa(store, ACTOR, BAA);
    expect(same.view.version).toBe(live.version);
    expect(same.view.status).toBe("active");

    const changed = await service.recordBaa(store, ACTOR, {
      ...BAA,
      documentRef: "Claim.MD BAA amendment 2, contract folder 7",
    });
    expect(changed.view.baa?.verified).toBeNull();
    // a live config cannot rest on an unverified BAA: it waits at `verified` until the operator re-verifies
    expect(changed.view.status).toBe("verified");
    expect(changed.view.activatedAt).toBeNull();
    expect(await codeOf(service.activate(store, ACTOR))).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    await verifyBaaSeen(service, store);
    expect((await service.activate(store, ACTOR)).status).toBe("active");
  });
});

describe("tenant clearinghouse service: mode `test` in production (security M4)", () => {
  const productionService = () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {},
      isProduction: true,
    });
    return { store, service };
  };
  const TEST_MODE = { vendor: "stedi", mode: "test", secret: FAKE_KEY } as const;

  it("refuses the tenant lane a test-mode config in production with a 422, and stores nothing", async () => {
    const { store, service } = productionService();
    const err = await service.put(store, ACTOR, TEST_MODE, undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(JSON.stringify((err as ChartWardenError).details)).toContain(
      "CLEARINGHOUSE_TEST_MODE_NOT_ALLOWED",
    );
    expect(store.rows()).toHaveLength(0);
    expect(
      await codeOf(service.put(store, ACTOR, { ...TEST_MODE, mode: "production" }, undefined)),
    ).toBe("no error");
  });

  it("lets the platform-ops lane set test mode in production (it records a reason)", async () => {
    const { store, service } = productionService();
    expect(await codeOf(service.put(store, OPERATOR, TEST_MODE, undefined))).toBe("no error");
  });

  it("allows test mode outside production for either lane", async () => {
    const { store, service } = setup();
    expect(await codeOf(service.put(store, ACTOR, TEST_MODE, undefined))).toBe("no error");
  });
});

describe("tenant clearinghouse service: the vendor probe never runs inside a transaction", () => {
  /** A store that logs every call, so the order of reads, locks and the probe is visible. */
  function tracedSetup(probeOutcome: "ok" | "unreachable" = "ok") {
    const store = createInMemoryConfigStore();
    const calls: string[] = [];
    const traced = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || typeof prop !== "string") return value;
        return (...args: unknown[]) => {
          calls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {
        claimmd: async () => {
          calls.push("PROBE");
          return probeOutcome;
        },
      },
    });
    return { store, traced, service, calls };
  }

  it("reads and decrypts first (no lock), probes with no store call in flight, then locks only to compare-and-set", async () => {
    const { store, traced, service, calls } = tracedSetup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    calls.length = 0;
    await verifyConnection(
      service,
      async (fn) => {
        calls.push("TX_OPEN");
        try {
          return await fn(traced);
        } finally {
          calls.push("TX_CLOSE");
        }
      },
      ACTOR,
      {},
    );
    const probeAt = calls.indexOf("PROBE");
    expect(probeAt).toBeGreaterThan(-1);
    // no transaction is open at the moment of the probe
    const openBefore = calls.slice(0, probeAt).filter((c) => c === "TX_OPEN").length;
    const closedBefore = calls.slice(0, probeAt).filter((c) => c === "TX_CLOSE").length;
    expect(openBefore).toBe(closedBefore);
    // the first transaction takes NO row lock; only the second (the write) does
    const firstClose = calls.indexOf("TX_CLOSE");
    expect(calls.slice(0, firstClose)).not.toContain("findForUpdate");
    expect(calls.slice(probeAt)).toContain("findForUpdate");
  });

  it("answers 409 when the config moved while the probe was away, and writes nothing from the stale probe", async () => {
    const { store, service } = tracedSetup();
    const first = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const plan = await service.prepareVerify(store, ACTOR, {});
    // another writer rotates the key while the probe runs
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: `${FAKE_KEY}-new` },
      first.view.version as number,
    );
    const err = await service.completeVerify(store, ACTOR, plan, "ok").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CLEARINGHOUSE_CHANGED_DURING_VERIFY", statusCode: 409 });
    expect((await service.view(store, ORG)).status).toBe("draft");
  });

  it("refuses a verification request pinned to an already stale clearinghouse version before probing", async () => {
    const { store, service, calls } = tracedSetup();
    const first = await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const err = await service
      .prepareVerify(store, ACTOR, {}, (first.view.version as number) + 1)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "STALE_VERSION", statusCode: 409 });
    expect(calls).not.toContain("PROBE");
    expect((await service.view(store, ORG)).status).toBe("draft");
  });

  it("treats a probe that throws as unreachable instead of failing the request", async () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {
        claimmd: async () => {
          throw new Error("socket hang up");
        },
      },
    });
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const { test, view } = await verify(service, store, ACTOR);
    expect(test).toEqual({ outcome: "unreachable" });
    expect(view.lastTest?.outcome).toBe("unreachable");
  });
});

describe("tenant clearinghouse service: attesting a vendor with no safe probe", () => {
  it("requires the confirmation that the evidence note names no patient information", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined);
    const err = await verify(service, store, ACTOR, {
      evidenceNote: ATTEST.evidenceNote,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(JSON.stringify((err as ChartWardenError).details)).toContain(
      "CLEARINGHOUSE_NO_PHI_CONFIRMATION_REQUIRED",
    );
    expect((await verify(service, store, ACTOR, ATTEST)).view.status).toBe("verified");
  });
});

// Owner decisions 2026-11-08 (migrations 1434/1435): one credential belongs to ONE organization, and never to the platform's own
// binding; it stays reserved through a rotation or a switch to outside until a platform operator releases it.
describe("tenant clearinghouse service: one credential per organization", () => {
  const OTHER: ClearinghouseActor = { ...ACTOR, organizationId: OTHER_ORG };

  it("refuses a second organization saving the same account key (409, holder never named); the holder may re-save it", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    let refusal: unknown;
    try {
      await service.put(
        store,
        OTHER,
        { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
        undefined,
      );
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(ChartWardenError);
    expect(refusal).toMatchObject({ code: "CLEARINGHOUSE_ACCOUNT_IN_USE", statusCode: 409 });
    expect(JSON.stringify(refusal)).not.toContain(ORG);
    expect((refusal as Error).message).not.toContain(ORG);
    // the same key under another vendor is another account
    await expect(
      service.put(store, OTHER, { vendor: "stedi", mode: "test", secret: FAKE_KEY }, undefined),
    ).resolves.toMatchObject({ created: true });
    // the holder re-saving its own key (a rotation to the same value) is fine
    const own = await service.view(store, ORG);
    await expect(
      service.put(
        store,
        ACTOR,
        { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
        own.version ?? 0,
      ),
    ).resolves.toMatchObject({ created: false });
  });

  it("keeps the old credential reserved through a rotation and a switch to outside; only a platform release frees it", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    let v = (await service.view(store, ORG)).version ?? 0;
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: "another-fake-key#2" },
      v,
    );
    const otherPut = () =>
      codeOf(
        service.put(store, OTHER, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined),
      );
    // the rotated-away key is still held by ORG
    expect(await otherPut()).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");

    v = (await service.view(store, ORG)).version ?? 0;
    await service.put(store, ACTOR, { vendor: "outside" }, v);
    expect(store.rows().find((r) => r.organizationId === ORG)?.credentialFingerprint).toBeNull();
    expect(store.heldFingerprints(ORG)).toHaveLength(2); // outside clears the current one, not the reservations
    expect(await otherPut()).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");

    // the tenant's own lane may not release
    expect(
      await codeOf(service.releaseCredentials(store, ACTOR, "account moved to the new org")),
    ).toBe("FORBIDDEN");
    const { released } = await service.releaseCredentials(
      store,
      OPERATOR,
      "account moved to the new org",
    );
    expect(released).toBe(2);
    expect(store.heldFingerprints(ORG)).toEqual([]);
    await expect(
      service.put(store, OTHER, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined),
    ).resolves.toMatchObject({ created: true });
  });

  it("never releases the current credential, and refuses while vendor responses may still arrive", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const v = (await service.view(store, ORG)).version ?? 0;
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: "another-fake-key#2" },
      v,
    );

    store.setProductionAttempts(ORG, true);
    expect(
      await codeOf(service.releaseCredentials(store, OPERATOR, "retire the rotated key")),
    ).toBe("CLEARINGHOUSE_RESPONSES_PENDING");
    expect(store.heldFingerprints(ORG)).toHaveLength(2);

    store.setProductionAttempts(ORG, false);
    const { released } = await service.releaseCredentials(
      store,
      OPERATOR,
      "retire the rotated key",
    );
    expect(released).toBe(1); // the rotated-away key only
    expect(store.heldFingerprints(ORG)).toEqual([
      store.rows().find((r) => r.organizationId === ORG)?.credentialFingerprint,
    ]);
    expect(
      await codeOf(
        service.put(
          store,
          OTHER,
          { vendor: "claimmd", mode: "test", secret: "another-fake-key#2" },
          undefined,
        ),
      ),
    ).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");
  });

  it("backfills a pre-1434 row's fingerprint (and its reservation) on its next write", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const sealed = store.rows()[0];
    // simulate a row sealed before migration 1434: a credential with no fingerprint and no reservation
    const legacy = createInMemoryConfigStore();
    await legacy.insert({ ...sealed, credentialFingerprint: null } as never);
    expect(legacy.heldFingerprints(ORG)).toEqual([]);
    await service.recordBaa(legacy, ACTOR, BAA);
    expect(legacy.rows()[0]?.credentialFingerprint).toBe(sealed?.credentialFingerprint);
    expect(legacy.heldFingerprints(ORG)).toEqual([sealed?.credentialFingerprint]);
  });

  it("refuses the platform's own account key, with the same refusal", async () => {
    const store = createInMemoryConfigStore();
    const cipher = buildClearinghouseSecretCipher(randomBytes(32));
    const service = createTenantClearinghouseService({
      cipher,
      probes: { claimmd: async () => "ok" },
      platformCredentialFingerprints: new Set([cipher.fingerprint("claimmd", FAKE_KEY)]),
    });
    expect(
      await codeOf(
        service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: FAKE_KEY }, undefined),
      ),
    ).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");
    expect(store.rows()).toEqual([]); // nothing was written
  });

  // Migration 1436 (security review MEDIUM-1): after a KEK change with the old KEK kept as retired, a reservation recorded under the
  // old key still blocks; the holder's re-entry records it under the new key too; dropping the old KEK ends only what it computed.
  it("keeps a reservation recorded under a retired KEK blocking while that KEK is configured", async () => {
    const store = createInMemoryConfigStore();
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const make = (cipher: ReturnType<typeof buildClearinghouseSecretCipher>) =>
      createTenantClearinghouseService({ cipher, probes: { claimmd: async () => "ok" } });
    await make(buildClearinghouseSecretCipher(oldKek)).put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    await make(buildClearinghouseSecretCipher(oldKek)).put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: "another-fake-key#2" },
      (await make(buildClearinghouseSecretCipher(oldKek)).view(store, ORG)).version ?? 0,
    ); // FAKE_KEY is now a retired credential: only its old-key fingerprint exists
    const rotated = make(buildClearinghouseSecretCipher(newKek, [deriveFingerprintSubkey(oldKek)]));
    const otherPut = (service: ReturnType<typeof make>) =>
      codeOf(
        service.put(
          store,
          { ...ACTOR, organizationId: OTHER_ORG },
          { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
          undefined,
        ),
      );
    expect(await otherPut(rotated)).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");
    expect(store.rows().filter((r) => r.organizationId === OTHER_ORG)).toEqual([]);
    // without the retired KEK the old reservation no longer matches: the documented lapse (ops runbook §8.3)
    expect(await otherPut(make(buildClearinghouseSecretCipher(newKek)))).toBe("no error");
  });

  it("re-reserves a current fingerprint that has no held reservation on the row's next write (review LOW-1)", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const row = store.rows()[0];
    const bare = createInMemoryConfigStore();
    await bare.insert({ ...row } as never); // a row written without its reservation (a pre-1435 build)
    expect(bare.heldFingerprints(ORG)).toEqual([]);
    await service.recordBaa(bare, ACTOR, BAA);
    expect(bare.heldFingerprints(ORG)).toEqual([row?.credentialFingerprint]);
  });

  it("re-reserves under the key the fingerprint was really computed with, not a stale label (review LOW-5)", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const row = store.rows()[0];
    const bare = createInMemoryConfigStore();
    // a pre-1436 build rewrote the fingerprint and left an earlier credential's key id behind
    await bare.insert({ ...row, credentialFingerprintKeyId: "0123456789abcdef" } as never);
    await service.recordBaa(bare, ACTOR, BAA);
    expect(bare.rows()[0]?.credentialFingerprintKeyId).toBe(row?.credentialFingerprintKeyId);
    expect(bare.heldFingerprints(ORG)).toEqual([row?.credentialFingerprint]);
  });

  it("caps the credentials one organization holds unreleased (review LOW-4)", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: "fake-key-00#" },
      undefined,
    );
    for (let i = 1; i < MAX_HELD_CREDENTIALS; i++) {
      const v = (await service.view(store, ORG)).version ?? 0;
      await service.put(
        store,
        ACTOR,
        { vendor: "claimmd", mode: "test", secret: `fake-key-${i}#` },
        v,
      );
    }
    expect(store.heldFingerprints(ORG)).toHaveLength(MAX_HELD_CREDENTIALS);
    const v = (await service.view(store, ORG)).version ?? 0;
    expect(
      await codeOf(
        service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: "fake-key-new#" }, v),
      ),
    ).toBe("CLEARINGHOUSE_CREDENTIAL_LIMIT");
    // re-saving a key it already holds is not a new credential
    await expect(
      service.put(store, ACTOR, { vendor: "claimmd", mode: "test", secret: "fake-key-3#" }, v),
    ).resolves.toMatchObject({ created: false });
  });

  it("answers a concurrent save of the org's own credential with a version conflict, not a refusal (review LOW-5)", async () => {
    const { store, service } = setup();
    let first = true;
    const racing = {
      ...store,
      // the competing save commits between this save's check and its insert
      async holdsCredential(org: string, fp: string) {
        if (first) {
          first = false;
          await store.reserveCredential(org, "claimmd", { keyId: null, fingerprint: fp });
          return false;
        }
        return store.holdsCredential(org, fp);
      },
    };
    expect(
      await codeOf(
        service.put(
          racing,
          ACTOR,
          { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
          undefined,
        ),
      ),
    ).toBe("VERSION_CONFLICT");
  });

  it("never releases any key's fingerprint of the current credential", async () => {
    const oldKek = randomBytes(32);
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32), [oldKek]),
      probes: { claimmd: async () => "ok" },
    });
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    expect(store.heldFingerprints(ORG)).toHaveLength(2); // current key + retired key
    const { released } = await service.releaseCredentials(
      store,
      OPERATOR,
      "ticket OPS-1234 cleanup",
    );
    expect(released).toBe(0);
    expect(store.heldFingerprints(ORG)).toHaveLength(2);
  });

  it("stores only the keyed fingerprint, never the key", async () => {
    const { store, service } = setup();
    await service.put(
      store,
      ACTOR,
      { vendor: "claimmd", mode: "test", secret: FAKE_KEY },
      undefined,
    );
    const row = store.rows()[0];
    expect(row?.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
  });
});

// Security review of cfd943e82: M2 (saves refused while unknown fingerprint keys are held; the current credential re-reserved under
// every configured key) and L3 (no cipher needed when nothing must be re-reserved; the org's own current credential is never capped).
describe("tenant clearinghouse service: fingerprint keys and the current credential", () => {
  const PUT = { vendor: "claimmd", mode: "test", secret: FAKE_KEY } as const;
  // a changed record, so the write is not a no-op on a row copied after the first BAA was recorded
  const BAA_2 = { ...BAA, documentRef: "Claim.MD BAA, signed 2026-01-15, contract folder 8" };

  it("refuses a credential save with a typed 503 while the fingerprint key check is not complete, on either lane; outside still saves", async () => {
    const store = createInMemoryConfigStore();
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {},
      assertFingerprintKeysComplete: async () => {
        throw fingerprintKeysIncomplete();
      },
    });
    for (const actor of [ACTOR, OPERATOR]) {
      const err = await service.put(store, actor, PUT, undefined).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "CLEARINGHOUSE_FINGERPRINT_KEYS_INCOMPLETE",
        statusCode: 503,
      });
    }
    expect(store.rows()).toEqual([]);
    await expect(
      service.put(store, ACTOR, { vendor: "outside" }, undefined),
    ).resolves.toMatchObject({ created: true });
  });

  it("on the next write, re-reserves the current credential under every configured key, and surfaces another org's hold as 409", async () => {
    const kek = randomBytes(32);
    const retired = randomBytes(32);
    const store = createInMemoryConfigStore();
    // saved while only the current KEK was configured: one reservation
    await createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(kek),
      probes: {},
    }).put(store, ACTOR, PUT, undefined);
    expect(store.heldFingerprints(ORG)).toHaveLength(1);
    const twoKeys = buildClearinghouseSecretCipher(kek, [deriveFingerprintSubkey(retired)]);
    const service = createTenantClearinghouseService({ cipher: twoKeys, probes: {} });
    await service.recordBaa(store, ACTOR, BAA);
    expect(store.heldFingerprints(ORG)).toEqual(
      twoKeys.fingerprints("claimmd", FAKE_KEY).map((f) => f.fingerprint),
    ); // the missing retired-key row is repaired

    // another org already holds the credential under the retired key: the holder's next write says so
    const contested = createInMemoryConfigStore();
    await contested.insert({ ...store.rows()[0] } as never);
    const retiredFp = twoKeys.fingerprints("claimmd", FAKE_KEY)[1]?.fingerprint ?? "";
    await contested.reserveCredential(OTHER_ORG, "claimmd", {
      keyId: null,
      fingerprint: retiredFp,
    });
    expect(await codeOf(service.recordBaa(contested, ACTOR, BAA_2))).toBe(
      "CLEARINGHOUSE_ACCOUNT_IN_USE",
    );
  });

  it("needs no cipher for a write that has nothing to re-reserve, and reserves an unopenable fingerprint under no key id", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, PUT, undefined);
    const noCipher = createTenantClearinghouseService({ probes: {} });
    await expect(noCipher.recordBaa(store, ACTOR, BAA)).resolves.toMatchObject({
      changedFields: ["baa"],
    });
    // a row with no held reservation: the stored fingerprint is reserved without the cipher, its key id unverifiable (NULL)
    const bare = createInMemoryConfigStore();
    const row = store.rows()[0];
    await bare.insert({ ...row } as never);
    await noCipher.recordBaa(bare, ACTOR, BAA_2);
    expect(bare.heldFingerprints(ORG)).toEqual([row?.credentialFingerprint]);
    expect(bare.rows()[0]?.credentialFingerprintKeyId).toBeNull();
  });

  it("re-reserves the org's own current credential even at the cap", async () => {
    const { store, service } = setup();
    await service.put(store, ACTOR, PUT, undefined);
    const bare = createInMemoryConfigStore();
    await bare.insert({ ...store.rows()[0] } as never); // its current credential has no reservation
    for (let i = 0; i < MAX_HELD_CREDENTIALS; i++)
      await bare.reserveCredential(ORG, "claimmd", {
        keyId: null,
        fingerprint: `${i}`.padStart(64, "0"),
      });
    await expect(service.recordBaa(bare, ACTOR, BAA)).resolves.toMatchObject({
      changedFields: ["baa"],
    });
    expect(bare.heldFingerprints(ORG)).toHaveLength(MAX_HELD_CREDENTIALS + 1);
  });
});
