// The operator's revoke of a tenant's vendor BAA (ADR-0053 amendment, owner decision "build it"): what it voids and holds, who may do
// it, what clears it, the closed reason and ticket it records, the history that survives a re-record, the exception it makes to the
// vendor / mode lock and how long that exception lasts. The service runs over the in-memory store; the same rules are proven against
// the real table, the real roles and the real attempt query in m23-tenant-clearinghouse.live.test.ts.
import { randomBytes } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryConfigStore } from "./config-store-memory";
import { buildClearinghouseSecretCipher } from "./secret-cipher";
import {
  type ClearinghouseActor,
  type RevokeBaaInput,
  type TenantClearinghouseService,
  createTenantClearinghouseService,
  verifyConnection,
} from "./service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TENANT: ClearinghouseActor = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  membershipId: "44444444-4444-4444-8444-444444444444",
  lane: "tenant",
};
const OPERATOR: ClearinghouseActor = {
  organizationId: ORG,
  userId: "55555555-5555-4555-8555-555555555555",
  membershipId: "66666666-6666-4666-8666-666666666666",
  lane: "platform",
};
const FAKE_KEY = "fake-key-not-a-secret#1";
const BAA = {
  heldBy: "tenant",
  effectiveDate: "2026-01-15",
  documentRef: "Claim.MD BAA, signed 2026-01-15, contract folder 7",
} as const;
const REVOKE: RevokeBaaInput = { reasonCode: "vendor_terminated", ticketRef: "SEC-42" };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = new Date("2026-11-09T12:00:00Z");

type Store = ReturnType<typeof createInMemoryConfigStore>;

/** A claimmd production config taken all the way to active: connection verified, BAA recorded and verified, activated. */
async function liveTenant(over: { waitingClaims?: number } = {}) {
  const store = createInMemoryConfigStore(() => NOW);
  const waitingClaims = { calls: 0 };
  /** The service's clock: a test moves it to tell two records, or a departure and its traffic, apart. */
  const clock = { at: NOW };
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  const service = createTenantClearinghouseService({
    cipher,
    probes: { claimmd: async () => "ok" },
    now: () => clock.at,
    waitingWork: async () => {
      waitingClaims.calls += 1;
      return {
        claims: over.waitingClaims ?? 0,
        commercialSubmissions: over.waitingClaims ? 2 : 0,
      };
    },
  });
  await service.put(
    store,
    TENANT,
    { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
    undefined,
  );
  await verifyConnection(service, (fn) => fn(store), TENANT, {});
  await service.recordBaa(store, TENANT, BAA);
  await service.verifyBaa(store, OPERATOR, await pinOf(service, store));
  await service.activate(store, TENANT);
  return { store, service, waitingClaims, clock, cipher };
}

const pinOf = async (service: TenantClearinghouseService, store: Store) => ({
  recordedAt: (await service.view(store, ORG)).baa?.recordedAt ?? "no BAA recorded",
});
const revoke = async (
  service: TenantClearinghouseService,
  store: Store,
  actor: ClearinghouseActor = OPERATOR,
  input: RevokeBaaInput = REVOKE,
) => service.revokeBaa(store, actor, await pinOf(service, store), input);
const versionOf = async (service: TenantClearinghouseService, store: Store): Promise<number> =>
  (await service.view(store, ORG)).version ?? 0;
const operatorView = (service: TenantClearinghouseService, store: Store) =>
  service.view(store, ORG, { operator: true });

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ChartWardenError) return err.code;
    throw err;
  }
  return "no error";
};

describe("the operator revokes a tenant's vendor BAA", () => {
  it("voids the verification, takes a live config out of service and records who, the closed reason and the ticket", async () => {
    const { store, service } = await liveTenant();

    const { view, wasActive, reasonCode, vendor, credentialCleared } = await revoke(service, store);

    expect(wasActive).toBe(true);
    expect(reasonCode).toBe("vendor_terminated");
    expect(vendor).toBe("claimmd");
    expect(credentialCleared).toBe(false);
    expect(view.status).toBe("verified"); // the state a re-recorded BAA leaves a live config in
    expect(view.activatedAt).toBeNull();
    expect(view.baaRequired).toBe(true);
    expect(view.baa).toMatchObject({ verified: null, revoked: true });
    expect(view.baa?.revokedAt).toBe(NOW.toISOString());
    const [row] = store.rows();
    expect(row).toMatchObject({
      baaRevokedAt: NOW,
      baaRevokedByMembershipId: OPERATOR.membershipId,
      baaRevokedReasonCode: "vendor_terminated",
      baaRevokedTicketRef: "SEC-42",
      baaVerifiedAt: null,
      baaVerifiedByMembershipId: null,
      status: "verified",
      activatedAt: null,
    });
    // the record stays: the operator and the tenant can still see which agreement ended
    expect(row?.baaDocumentRef).toBe(BAA.documentRef);
  });

  it("stores NO free text: a closed reason code and a ticket reference are all the row can carry", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    const row = store.rows()[0] as Record<string, unknown>;
    expect(Object.keys(row).filter((k) => /reason/i.test(k))).toEqual(["baaRevokedReasonCode"]);
  });

  it("leaves a config that was not live where it was", async () => {
    const { store, service } = await liveTenant();
    // a rotation drops the live config to draft first: nothing is live when the BAA is revoked
    await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-rotated` },
      await versionOf(service, store),
    );

    const { view, wasActive } = await revoke(service, store);

    expect(wasActive).toBe(false);
    expect(view.status).toBe("draft");
  });

  it("shows the tenant the timestamp, a flag and the closed code, never the ticket or the history; the operator's view has both", async () => {
    const { store, service } = await liveTenant();
    const { view: operatorResult } = await revoke(service, store);

    const tenantView = await service.view(store, ORG);

    expect(tenantView.baa).toMatchObject({
      revoked: true,
      revokedAt: NOW.toISOString(),
      revokedReasonCode: "vendor_terminated",
    });
    expect(JSON.stringify(tenantView)).not.toContain("SEC-42");
    expect(tenantView.baa).not.toHaveProperty("revokedTicketRef");
    expect(tenantView.baa).not.toHaveProperty("previousRevocation");
    expect(operatorResult.baa?.revokedTicketRef).toBe("SEC-42");
    expect((await operatorView(service, store)).baa?.revokedTicketRef).toBe("SEC-42");
  });

  it("is the platform lane's alone: the tenant lane is refused 403 and nothing changes", async () => {
    const { store, service } = await liveTenant();
    const before = await versionOf(service, store);

    const err = await revoke(service, store, TENANT).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(await versionOf(service, store)).toBe(before);
    expect((await service.view(store, ORG)).status).toBe("active");
  });

  it("refuses a second revoke with a typed 409 instead of rewriting who and why", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);
    const before = await versionOf(service, store);

    const err = await revoke(service, store, OPERATOR, {
      reasonCode: "other",
      ticketRef: "SEC-44",
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "CLEARINGHOUSE_BAA_REVOKED", statusCode: 409 });
    expect(await versionOf(service, store)).toBe(before);
    expect(store.rows()[0]).toMatchObject({
      baaRevokedReasonCode: "vendor_terminated",
      baaRevokedTicketRef: "SEC-42",
    });
  });

  it("refuses a BAA nobody recorded, a config that was never chosen, and `outside`", async () => {
    const store = createInMemoryConfigStore(() => NOW);
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {},
      now: () => NOW,
    });
    const pin = { recordedAt: NOW.toISOString() };
    expect(await codeOf(service.revokeBaa(store, OPERATOR, pin, REVOKE))).toBe(
      "CLEARINGHOUSE_NOT_CONFIGURED",
    );

    await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
      undefined,
    );
    expect(await codeOf(service.revokeBaa(store, OPERATOR, pin, REVOKE))).toBe(
      "CLEARINGHOUSE_BAA_NOT_RECORDED",
    );

    await service.put(store, TENANT, { vendor: "outside" }, await versionOf(service, store));
    expect(await codeOf(service.revokeBaa(store, OPERATOR, pin, REVOKE))).toBe(
      "CLEARINGHOUSE_BAA_NOT_APPLICABLE",
    );
  });

  it("is pinned to the record the operator read: a record the tenant replaced since is a 409 and stays verified", async () => {
    const { store, service, clock } = await liveTenant();
    const seen = await pinOf(service, store);
    clock.at = new Date(NOW.getTime() + 1000);
    await service.recordBaa(store, TENANT, {
      ...BAA,
      documentRef: "Claim.MD BAA, a different agreement, contract folder 9",
    });
    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));

    const err = await service.revokeBaa(store, OPERATOR, seen, REVOKE).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "CLEARINGHOUSE_BAA_CHANGED", statusCode: 409 });
    expect((await service.view(store, ORG)).baa?.verified).not.toBeNull();
    expect((await service.view(store, ORG)).baa?.revoked).toBe(false);
  });

  it("accepts only a code from the closed set and a ticket reference: anything else, free text included, is a 422 and writes nothing", async () => {
    const { store, service } = await liveTenant();
    const bad: Record<string, unknown>[] = [
      { reasonCode: "Vendor ended the BAA, ticket SEC-42", ticketRef: "SEC-42" },
      { reasonCode: "vendor_terminated ", ticketRef: "SEC-42" },
      { reasonCode: "VENDOR_TERMINATED", ticketRef: "SEC-42" },
      { reasonCode: "", ticketRef: "SEC-42" },
      { reasonCode: undefined, ticketRef: "SEC-42" },
      { reasonCode: "other", ticketRef: "sec-42" },
      { reasonCode: "other", ticketRef: "SEC42" },
      { reasonCode: "other", ticketRef: "S-42" },
      { reasonCode: "other", ticketRef: "SEC-42 John Smith DOB 04/12/1941" },
      { reasonCode: "other", ticketRef: "SEC-42\nphone 555-123-4567" },
      { reasonCode: "other", ticketRef: "ABCDEFGHIJK-1" },
      { reasonCode: "other", ticketRef: "SEC-123456789" },
      { reasonCode: "other", ticketRef: "" },
      { reasonCode: "other", ticketRef: undefined },
    ];
    for (const input of bad) {
      expect(
        await codeOf(revoke(service, store, OPERATOR, input as never)),
        JSON.stringify(input),
      ).toBe("VALIDATION_FAILED");
    }
    expect((await service.view(store, ORG)).baa?.revoked).toBe(false);
    for (const reasonCode of [
      "vendor_terminated",
      "account_closed",
      "baa_expired",
      "other",
    ] as const) {
      const fresh = await liveTenant();
      expect(
        await codeOf(
          revoke(fresh.service, fresh.store, OPERATOR, { reasonCode, ticketRef: "A1-1" }),
        ),
      ).toBe("no error");
    }
  });
});

describe("the revoke is a kill switch that does not depend on the credential", () => {
  it("revokes a row whose credential can no longer be reserved: another organization holds the fingerprint", async () => {
    const { store, service } = await liveTenant();
    const fingerprint = store.rows()[0]?.credentialFingerprint as string;
    // the reservation this org held is gone and another organization took the credential: any ordinary write would now be refused
    await store.releaseCredentials(ORG, [], {
      userId: OPERATOR.userId,
      reason: "ticket SEC-1",
      at: NOW,
    });
    await store.reserveCredential(OTHER_ORG, "claimmd", { keyId: null, fingerprint });
    expect(
      await codeOf(
        service.recordBaa(store, TENANT, { ...BAA, documentRef: "another agreement, folder 3" }),
      ),
    ).toBe("CLEARINGHOUSE_ACCOUNT_IN_USE");

    const { view } = await revoke(service, store);

    expect(view.baa?.revoked).toBe(true);
    expect(view.status).toBe("verified");
  });

  it("revokes with no encryption key bound at all (the credential is never opened)", async () => {
    const { store } = await liveTenant();
    const noCipher = createTenantClearinghouseService({ probes: {}, now: () => NOW });

    const { view } = await noCipher.revokeBaa(
      store,
      OPERATOR,
      await pinOf(noCipher, store),
      REVOKE,
    );

    expect(view.baa?.revoked).toBe(true);
    expect(store.rows()[0]?.secretCipher).not.toBeNull(); // nothing was unsealed, nothing was dropped
  });

  it("revokes a row sealed before migration 1434 (a credential and no fingerprint) by dropping the credential with the BAA", async () => {
    const { store } = await liveTenant();
    const row = store.rows()[0];
    if (!row) throw new Error("no row");
    // the pre-1434 shape: sealed, never fingerprinted
    await store.update(ORG, row.version, {
      credentialFingerprint: null,
      credentialFingerprintKeyId: null,
    });
    const noCipher = createTenantClearinghouseService({ probes: {}, now: () => NOW });

    const result = await noCipher.revokeBaa(store, OPERATOR, await pinOf(noCipher, store), REVOKE);

    expect(result.credentialCleared).toBe(true);
    expect(result.wasActive).toBe(true);
    expect(store.rows()[0]).toMatchObject({
      status: "draft",
      secretCipher: null,
      secretDekVersion: null,
      credentialFingerprint: null,
      baaRevokedReasonCode: "vendor_terminated",
      activatedAt: null,
      verifiedAt: null,
    });
    expect(result.view.hasSecret).toBe(false); // the tenant enters it again
  });
});

describe("what the revoke leaves held or owed", () => {
  it("counts the production attempts still in flight, those sent in the window, and the queued work", async () => {
    const { store, service } = await liveTenant({ waitingClaims: 7 });
    store.setProductionAttempts(ORG, true, NOW, "reserved");

    const reserved = await revoke(service, store);

    expect(reserved.impact).toEqual({
      attemptsInFlight: 1,
      attemptsSentInWindow: 0,
      queuedClaims: 7,
      queuedCommercialSubmissions: 2,
    });

    const sentToo = await liveTenant();
    sentToo.store.setProductionAttempts(ORG, true, new Date(NOW.getTime() - DAY_MS), "sent");
    expect((await revoke(sentToo.service, sentToo.store)).impact).toMatchObject({
      attemptsInFlight: 0,
      attemptsSentInWindow: 1,
    });

    const quiet = await liveTenant();
    expect((await revoke(quiet.service, quiet.store)).impact).toEqual({
      attemptsInFlight: 0,
      attemptsSentInWindow: 0,
      queuedClaims: 0,
      queuedCommercialSubmissions: 0,
    });
  });
});

describe("while the BAA is revoked", () => {
  it("cannot be verified again, and the config cannot go active", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    expect(await codeOf(service.verifyBaa(store, OPERATOR, await pinOf(service, store)))).toBe(
      "CLEARINGHOUSE_BAA_REVOKED",
    );
    expect(await codeOf(service.activate(store, TENANT))).toBe("CLEARINGHOUSE_BAA_REVOKED");
    const view = await service.view(store, ORG);
    expect(view.status).toBe("verified");
    expect(view.baa?.verified).toBeNull();
  });

  it("refuses activation as revoked even from draft, where the revocation is the larger blocker", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);
    await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-rotated` },
      await versionOf(service, store),
    );

    expect((await service.view(store, ORG)).status).toBe("draft");
    expect(await codeOf(service.activate(store, TENANT))).toBe("CLEARINGHOUSE_BAA_REVOKED");
  });

  it("a connection verify on the revoked config succeeds but never makes it active, and keeps the revocation", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    const { view } = await verifyConnection(service, (fn) => fn(store), TENANT, {});

    expect(view.status).toBe("verified"); // `completeVerify` keeps `verified`: only `active` stays active
    expect(view.baa).toMatchObject({ revoked: true, verified: null });
    expect(await codeOf(service.activate(store, TENANT))).toBe("CLEARINGHOUSE_BAA_REVOKED");
  });

  it("a credential rotation is still allowed with recent production traffic (it is not a switch), and keeps the revocation", async () => {
    const { store, service } = await liveTenant();
    store.setProductionAttempts(ORG, true, NOW, "reserved");
    await revoke(service, store);

    const { view } = await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-rotated` },
      await versionOf(service, store),
    );

    expect(view.status).toBe("draft");
    expect(view.baa?.revoked).toBe(true);
    expect(store.rows()[0]?.revokedVendorLeftAt).toBeNull(); // the vendor was not left
  });

  it("is cleared by the tenant recording a new BAA, which starts again at unverified", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    const recorded = await service.recordBaa(store, TENANT, {
      ...BAA,
      documentRef: "Claim.MD BAA, renewed 2026-11-09, contract folder 7",
    });

    expect(recorded.changedFields).toEqual(["baa", "baaRevocation"]);
    expect(recorded.view.baa).toMatchObject({
      revoked: false,
      revokedAt: null,
      revokedReasonCode: null,
      verified: null,
    });
    expect(store.rows()[0]).toMatchObject({
      baaRevokedAt: null,
      baaRevokedByMembershipId: null,
      baaRevokedReasonCode: null,
      baaRevokedTicketRef: null,
    });
    expect(recorded.view.status).toBe("verified"); // still held until an operator verifies the new agreement
    expect(await codeOf(service.activate(store, TENANT))).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");
    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));
    expect((await service.activate(store, TENANT)).status).toBe("active");
  });

  it("is cleared by re-recording the identical document too: the re-record is the tenant's statement, the operator's verification is the gate", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    const recorded = await service.recordBaa(store, TENANT, BAA);

    expect(recorded.changedFields).toEqual(["baa", "baaRevocation"]);
    expect(recorded.view.baa).toMatchObject({ revoked: false, verified: null });
  });

  it("cannot be cleared by the operator recording a BAA on the tenant's behalf", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    expect(await codeOf(service.recordBaa(store, OPERATOR, BAA))).toBe(
      "CLEARINGHOUSE_BAA_TENANT_ONLY",
    );
    expect((await service.view(store, ORG)).baa?.revoked).toBe(true);
  });
});

describe("the history of a revocation survives a re-record", () => {
  it("shows the operator that the re-recorded document was revoked before, and the tenant nothing", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);
    await service.recordBaa(store, TENANT, BAA);

    const operator = await operatorView(service, store);
    const tenant = await service.view(store, ORG);

    expect(operator.baa?.revoked).toBe(false);
    expect(operator.baa?.previousRevocation).toEqual({
      at: NOW.toISOString(),
      sameDocument: true,
    });
    expect(JSON.stringify(tenant)).not.toContain("previousRevocation");
    expect(store.rows()[0]).toMatchObject({
      baaLastRevokedAt: NOW,
      baaLastRevokedDocumentRef: BAA.documentRef,
    });
  });

  it("refuses to verify the document that was revoked unless the operator acknowledges it (409 CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED)", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);
    await service.recordBaa(store, TENANT, BAA);
    const pin = await pinOf(service, store);

    const refused = await service.verifyBaa(store, OPERATOR, pin).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: "CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED",
      statusCode: 409,
    });
    expect(
      await codeOf(
        service.verifyBaa(store, OPERATOR, pin, { acknowledgePreviousRevocation: false }),
      ),
    ).toBe("CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED");
    expect((await service.view(store, ORG)).baa?.verified).toBeNull();

    const verified = await service.verifyBaa(store, OPERATOR, pin, {
      acknowledgePreviousRevocation: true,
    });
    expect(verified.baa?.verified).not.toBeNull();
    expect(verified.baa?.previousRevocation?.sameDocument).toBe(true); // the audit detail reads this
    expect((await service.activate(store, TENANT)).status).toBe("active");
  });

  it("recognises the same ended document re-typed with another case, spacing or punctuation", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);
    await service.recordBaa(store, TENANT, {
      ...BAA,
      documentRef: "  claim.md  BAA signed 2026 01 15 -- contract folder 7!! ",
    });

    expect(await codeOf(service.verifyBaa(store, OPERATOR, await pinOf(service, store)))).toBe(
      "CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED",
    );
  });

  it("does not ask for an acknowledgement for a different document, and says so in the operator's view", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);
    await service.recordBaa(store, TENANT, {
      ...BAA,
      documentRef: "Claim.MD BAA, a new agreement signed 2026-11-09, folder 12",
    });

    expect((await operatorView(service, store)).baa?.previousRevocation).toEqual({
      at: NOW.toISOString(),
      sameDocument: false,
    });
    expect(
      (await service.verifyBaa(store, OPERATOR, await pinOf(service, store))).baa?.verified,
    ).not.toBeNull();
  });

  it("survives a change of vendor too: the history is kept when the record and the revocation are voided", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    await service.put(
      store,
      TENANT,
      { vendor: "stedi", mode: "production", secret: "fake-stedi-key-not-a-secret#2" },
      await versionOf(service, store),
    );

    expect(store.rows()[0]).toMatchObject({
      baaRevokedAt: null,
      baaRecordedAt: null,
      baaLastRevokedAt: NOW,
      baaLastRevokedDocumentRef: BAA.documentRef,
    });
  });
});

describe("the vendor and mode lock, with and without a revoked BAA", () => {
  const switchTo = {
    vendor: { vendor: "stedi", mode: "production", secret: "fake-stedi-key-not-a-secret#2" },
    mode: { vendor: "claimmd", mode: "test", secret: "fake-key-not-a-secret#3" },
    outside: { vendor: "outside" },
  } as const;
  type SwitchKind = keyof typeof switchTo;
  const SWITCHES: readonly SwitchKind[] = ["vendor", "mode", "outside"];
  const trySwitch = async (
    service: TenantClearinghouseService,
    store: Store,
    kind: SwitchKind,
    actor: ClearinghouseActor = TENANT,
  ) => service.put(store, actor, { ...switchTo[kind] }, await versionOf(service, store));

  const inFlight = NOW;
  const sentYesterday = new Date(NOW.getTime() - DAY_MS);

  for (const [label, reservedAt] of [
    ["a production attempt is in flight", inFlight],
    ["one was sent yesterday", sentYesterday],
  ] as const) {
    for (const kind of SWITCHES) {
      it(`lets the tenant switch ${kind === "outside" ? "to outside" : `its ${kind}`} after a revoke although ${label}`, async () => {
        const { store, service } = await liveTenant();
        store.setProductionAttempts(ORG, true, reservedAt);
        await revoke(service, store);

        const result = await trySwitch(service, store, kind);

        expect(result.view.vendor).toBe(switchTo[kind].vendor);
        expect(result.view.status).toBe(kind === "outside" ? "active" : "draft");
        // the tenant's audit row says the lock was set aside because the BAA is revoked
        expect(result.lockExceptionUsed).toBe(true);
      });

      it(`still locks the tenant's ${kind} switch when the BAA is not revoked and ${label}`, async () => {
        const { store, service } = await liveTenant();
        store.setProductionAttempts(ORG, true, reservedAt);

        expect(await codeOf(trySwitch(service, store, kind))).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
      });
    }
  }

  it("locks again as soon as the tenant clears the revocation by recording a new BAA", async () => {
    const { store, service } = await liveTenant();
    store.setProductionAttempts(ORG, true, inFlight);
    await revoke(service, store);
    await service.recordBaa(store, TENANT, BAA);

    expect(await codeOf(trySwitch(service, store, "vendor"))).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
  });

  it("gives the operator no way to switch a live tenant's vendor: the exception is the tenant lane's only", async () => {
    const { store, service } = await liveTenant();
    store.setProductionAttempts(ORG, true, inFlight);
    await revoke(service, store);

    for (const kind of SWITCHES) {
      expect(await codeOf(trySwitch(service, store, kind, OPERATOR)), kind).toBe(
        "CLEARINGHOUSE_VENDOR_LOCKED",
      );
    }
    expect((await service.view(store, ORG)).vendor).toBe("claimmd");
  });

  it("does not ask for queued work: the revoked config is not active, so nothing waits on it", async () => {
    const { store, service, waitingClaims } = await liveTenant({ waitingClaims: 7 });
    await revoke(service, store);
    const callsAtRevoke = waitingClaims.calls; // the revoke itself counts what it holds, once

    const result = await trySwitch(service, store, "outside");

    expect(result.view.vendor).toBe("outside");
    expect(waitingClaims.calls).toBe(callsAtRevoke);
    expect(result.lockExceptionUsed).toBeUndefined(); // no recent production traffic: there was no lock to set aside
  });

  it("keeps the old behaviour for an active, unrevoked config with queued claims", async () => {
    const { store, service } = await liveTenant({ waitingClaims: 7 });

    expect(await codeOf(trySwitch(service, store, "outside"))).toBe("CLEARINGHOUSE_WORK_WAITING");
  });

  it("voids the revoked BAA with the vendor change, and keeps it across a same-vendor mode change", async () => {
    const mode = await liveTenant();
    await revoke(mode.service, mode.store);
    await trySwitch(mode.service, mode.store, "mode");
    expect(mode.store.rows()[0]).toMatchObject({
      baaVendor: "claimmd",
      revokedVendorLeftAt: null,
    });
    expect((await mode.service.view(mode.store, ORG)).baa?.revoked).toBe(true);

    const vendor = await liveTenant();
    await revoke(vendor.service, vendor.store);
    await trySwitch(vendor.service, vendor.store, "vendor");
    expect(vendor.store.rows()[0]).toMatchObject({
      baaVendor: null,
      baaRecordedAt: null,
      baaRevokedAt: null,
      baaRevokedByMembershipId: null,
      baaRevokedReasonCode: null,
      baaRevokedTicketRef: null,
    });
    expect(vendor.store.rows()[0]?.revokedVendorLeftAt).toEqual(NOW);
    expect((await vendor.service.view(vendor.store, ORG)).baa).toBeNull();
  });

  it("a switch to outside after a revoke leaves no BAA, revoked or otherwise, behind", async () => {
    const { store, service } = await liveTenant();
    store.setProductionAttempts(ORG, true, inFlight);
    await revoke(service, store);

    await trySwitch(service, store, "outside");

    expect(store.rows()[0]).toMatchObject({
      vendor: "outside",
      status: "active",
      baaRecordedAt: null,
      baaRevokedAt: null,
      baaRevokedReasonCode: null,
    });
  });
});

describe("the exception is not one-shot: the vendor the tenant left no longer locks the next one", () => {
  /** Leave revoked claimmd (a production attempt in flight on it) for Stedi, an hour later. */
  async function leftForStedi() {
    const t = await liveTenant();
    t.store.setProductionAttempts(ORG, true, NOW, "reserved");
    await revoke(t.service, t.store);
    t.clock.at = new Date(NOW.getTime() + HOUR_MS);
    await t.service.put(
      t.store,
      TENANT,
      { vendor: "stedi", mode: "production", secret: "fake-stedi-key-not-a-secret#2" },
      await versionOf(t.service, t.store),
    );
    t.clock.at = new Date(NOW.getTime() + 2 * HOUR_MS);
    return t;
  }

  it("A -> B -> C: a tenant that picked the wrong next vendor can still move on, though A's attempt is in the window", async () => {
    const { store, service } = await leftForStedi();
    expect((await service.view(store, ORG)).vendor).toBe("stedi");

    const moved = await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: "fake-key-not-a-secret#3" },
      await versionOf(service, store),
    );

    expect(moved.view).toMatchObject({ vendor: "claimmd", status: "draft" });
  });

  it("A -> B -> outside: and it can bill outside ChartWarden instead", async () => {
    const { store, service } = await leftForStedi();

    const moved = await service.put(
      store,
      TENANT,
      { vendor: "outside" },
      await versionOf(service, store),
    );

    expect(moved.view).toMatchObject({ vendor: "outside", status: "active" });
  });

  it("the new vendor's OWN production traffic locks it as ever: only attempts reserved before the departure are set aside", async () => {
    const { store, service, clock } = await leftForStedi();
    // B went live and sent a production claim after the departure
    store.setProductionAttempts(ORG, true, new Date(clock.at.getTime() + HOUR_MS), "reserved");
    clock.at = new Date(clock.at.getTime() + 2 * HOUR_MS);

    expect(
      await codeOf(
        service.put(store, TENANT, { vendor: "outside" }, await versionOf(service, store)),
      ),
    ).toBe("CLEARINGHOUSE_VENDOR_LOCKED");
  });

  it("the credential release is untouched by the departure: A's traffic still holds the old credential for the window", async () => {
    const { store, service } = await leftForStedi();

    expect(
      await codeOf(service.releaseCredentials(store, OPERATOR, "ticket SEC-9, account moved")),
    ).toBe("CLEARINGHOUSE_RESPONSES_PENDING");
  });
});
