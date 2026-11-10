// The operator's revoke of a tenant's vendor BAA (ADR-0053 amendment, owner decision "build it"): what it voids and holds, who may do
// it, what clears it, and the one exception it makes to the vendor / mode lock. The service runs over the in-memory store; the same
// rules are proven against the real table, the real roles and the real attempt query in m23-tenant-clearinghouse.live.test.ts.
import { randomBytes } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryConfigStore } from "./config-store-memory";
import { buildClearinghouseSecretCipher } from "./secret-cipher";
import {
  type ClearinghouseActor,
  type TenantClearinghouseService,
  createTenantClearinghouseService,
  verifyConnection,
} from "./service";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT: ClearinghouseActor = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  membershipId: "44444444-4444-4444-8444-444444444444",
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
const REASON = "Vendor ended the BAA on 2026-11-08, ticket SEC-42";
const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-09T12:00:00Z");

type Store = ReturnType<typeof createInMemoryConfigStore>;

/** A claimmd production config taken all the way to active: connection verified, BAA recorded and verified, activated. */
async function liveTenant(over: { waitingClaims?: number } = {}) {
  const store = createInMemoryConfigStore(() => NOW);
  const waitingClaims = { calls: 0 };
  /** The service's clock: a test moves it to tell two records apart (a record's `recordedAt` is its pin). */
  const clock = { at: NOW };
  const service = createTenantClearinghouseService({
    cipher: buildClearinghouseSecretCipher(randomBytes(32)),
    probes: { claimmd: async () => "ok" },
    now: () => clock.at,
    waitingWork: async () => {
      waitingClaims.calls += 1;
      return { claims: over.waitingClaims ?? 0, commercialSubmissions: 0 };
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
  return { store, service, waitingClaims, clock };
}

const pinOf = async (service: TenantClearinghouseService, store: Store) => ({
  recordedAt: (await service.view(store, ORG)).baa?.recordedAt ?? "no BAA recorded",
});
const revoke = async (
  service: TenantClearinghouseService,
  store: Store,
  actor: ClearinghouseActor = OPERATOR,
  reason: string = REASON,
) => service.revokeBaa(store, actor, await pinOf(service, store), reason);
const versionOf = async (service: TenantClearinghouseService, store: Store): Promise<number> =>
  (await service.view(store, ORG)).version ?? 0;

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
  it("voids the verification, takes a live config out of service and records who and why", async () => {
    const { store, service } = await liveTenant();

    const { view, wasActive } = await revoke(service, store);

    expect(wasActive).toBe(true);
    expect(view.status).toBe("verified"); // the state a re-recorded BAA leaves a live config in
    expect(view.activatedAt).toBeNull();
    expect(view.baaRequired).toBe(true);
    expect(view.baa).toMatchObject({ verified: null, revoked: true });
    expect(view.baa?.revokedAt).toBe(NOW.toISOString());
    const [row] = store.rows();
    expect(row).toMatchObject({
      baaRevokedAt: NOW,
      baaRevokedByMembershipId: OPERATOR.membershipId,
      baaRevokedReason: REASON,
      baaVerifiedAt: null,
      baaVerifiedByMembershipId: null,
      status: "verified",
      activatedAt: null,
    });
    // the record itself stays: the operator and the tenant can still see which agreement ended
    expect(row?.baaDocumentRef).toBe(BAA.documentRef);
  });

  it("stores the reason with its whitespace collapsed, and leaves a config that was not live where it was", async () => {
    const { store, service } = await liveTenant();
    // a rotation drops the live config to draft first: nothing is live when the BAA is revoked
    await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: `${FAKE_KEY}-rotated` },
      await versionOf(service, store),
    );

    const { view, wasActive } = await revoke(
      service,
      store,
      OPERATOR,
      "  Vendor   ended\nthe BAA,\tticket SEC-43  ",
    );

    expect(wasActive).toBe(false);
    expect(view.status).toBe("draft");
    expect(store.rows()[0]?.baaRevokedReason).toBe("Vendor ended the BAA, ticket SEC-43");
  });

  it("shows the tenant the timestamp and a flag but never the operator's reason; the operator's own view carries it", async () => {
    const { store, service } = await liveTenant();
    const { view: operatorView } = await revoke(service, store);

    const tenantView = await service.view(store, ORG);

    expect(tenantView.baa).toMatchObject({ revoked: true, revokedAt: NOW.toISOString() });
    expect(JSON.stringify(tenantView)).not.toContain(REASON);
    expect(tenantView.baa).not.toHaveProperty("revokedReason");
    expect(operatorView.baa?.revokedReason).toBe(REASON);
    expect((await service.view(store, ORG, { operator: true })).baa?.revokedReason).toBe(REASON);
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

    const err = await revoke(service, store, OPERATOR, "A second operator, ticket SEC-44").catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: "CLEARINGHOUSE_BAA_REVOKED", statusCode: 409 });
    expect(await versionOf(service, store)).toBe(before);
    expect(store.rows()[0]?.baaRevokedReason).toBe(REASON);
  });

  it("refuses a BAA nobody recorded, a config that was never chosen, and `outside`", async () => {
    const store = createInMemoryConfigStore(() => NOW);
    const service = createTenantClearinghouseService({
      cipher: buildClearinghouseSecretCipher(randomBytes(32)),
      probes: {},
      now: () => NOW,
    });
    const pin = { recordedAt: NOW.toISOString() };
    expect(await codeOf(service.revokeBaa(store, OPERATOR, pin, REASON))).toBe(
      "CLEARINGHOUSE_NOT_CONFIGURED",
    );

    await service.put(
      store,
      TENANT,
      { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
      undefined,
    );
    expect(await codeOf(service.revokeBaa(store, OPERATOR, pin, REASON))).toBe(
      "CLEARINGHOUSE_BAA_NOT_RECORDED",
    );

    await service.put(store, TENANT, { vendor: "outside" }, await versionOf(service, store));
    expect(await codeOf(service.revokeBaa(store, OPERATOR, pin, REASON))).toBe(
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

    const err = await service.revokeBaa(store, OPERATOR, seen, REASON).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "CLEARINGHOUSE_BAA_CHANGED", statusCode: 409 });
    expect((await service.view(store, ORG)).baa?.verified).not.toBeNull();
    expect((await service.view(store, ORG)).baa?.revoked).toBe(false);
  });

  it("screens the reason like the BAA document reference: 3-500 characters, no SSN- or MBI-shaped identifier", async () => {
    const { store, service } = await liveTenant();
    const bad = [
      "ab",
      "   ab   ",
      "x".repeat(501),
      "vendor ended the BAA for 900-12-3456",
      "vendor ended the BAA for 900123456",
      "vendor ended the BAA for 1EG4-TE5-MK73",
    ];
    for (const reason of bad) {
      expect(await codeOf(revoke(service, store, OPERATOR, reason)), reason).toBe(
        "VALIDATION_FAILED",
      );
    }
    expect((await service.view(store, ORG)).baa?.revoked).toBe(false);
    expect(await codeOf(revoke(service, store, OPERATOR, "abc"))).toBe("no error");
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

  it("is cleared only by the tenant recording a new BAA, which starts again at unverified", async () => {
    const { store, service } = await liveTenant();
    await revoke(service, store);

    const recorded = await service.recordBaa(store, TENANT, {
      ...BAA,
      documentRef: "Claim.MD BAA, renewed 2026-11-09, contract folder 7",
    });

    expect(recorded.changedFields).toEqual(["baa", "baaRevocation"]);
    expect(recorded.view.baa).toMatchObject({ revoked: false, revokedAt: null, verified: null });
    expect(store.rows()[0]).toMatchObject({
      baaRevokedAt: null,
      baaRevokedByMembershipId: null,
      baaRevokedReason: null,
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

    const result = await trySwitch(service, store, "outside");

    expect(result.view.vendor).toBe("outside");
    expect(waitingClaims.calls).toBe(0);
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
    expect(mode.store.rows()[0]).toMatchObject({ baaVendor: "claimmd" });
    expect((await mode.service.view(mode.store, ORG)).baa?.revoked).toBe(true);

    const vendor = await liveTenant();
    await revoke(vendor.service, vendor.store);
    await trySwitch(vendor.service, vendor.store, "vendor");
    expect(vendor.store.rows()[0]).toMatchObject({
      baaVendor: null,
      baaRecordedAt: null,
      baaRevokedAt: null,
      baaRevokedByMembershipId: null,
      baaRevokedReason: null,
    });
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
      baaRevokedReason: null,
    });
  });
});
