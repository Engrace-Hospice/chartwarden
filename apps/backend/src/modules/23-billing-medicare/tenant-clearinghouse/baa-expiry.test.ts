// CW-AC-17 — a tenant-held vendor BAA states its end date. What recording one checks, what a changed or lapsed one does to the
// verification, how the resolver, the claims-billing gate and the notifier act on the day after it, and the warning ahead of it. Every
// clock here is a value the test sets: the service, the resolver, the reader and the notifier all take `now`. The same rules are
// proven against the real table and the real role in m23-tenant-clearinghouse.live.test.ts.
import { randomBytes } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError, type TenantClearinghouseChoice } from "@chartwarden/types";
import {
  InMemoryAttemptStore,
  UNBOUND_BAA_EXPIRED,
  UNBOUND_BAA_REVOKED,
} from "@chartwarden/x12-837-client";
import { createInMemoryHarness } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import { BAA_EXPIRY_WARN_DAYS, baaDaysLeft, baaEnded, normalizeBaaInput } from "./baa";
import {
  ALERT_RETRY_MS,
  BAA_EXPIRED_ALERT,
  BAA_EXPIRING_ALERT,
  createBaaExpiryNotifier,
} from "./baa-expiry-notice";
import { choiceOf, decideClaimsBilling } from "./choice";
import type { ConfigRow } from "./config-store";
import { createInMemoryConfigStore } from "./config-store-memory";
import { createTenantClearinghouseRuntime } from "./resolver";
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
  lane: "tenant",
};
const OPERATOR: ClearinghouseActor = {
  organizationId: ORG,
  userId: "55555555-5555-4555-8555-555555555555",
  membershipId: "66666666-6666-4666-8666-666666666666",
  lane: "platform",
};
const FAKE_KEY = "fake-key-not-a-secret#1";
const EFFECTIVE = "2026-01-15";
const ENDS = "2027-01-15";
const BAA = {
  heldBy: "tenant",
  effectiveDate: EFFECTIVE,
  expiresOn: ENDS,
  documentRef: "Claim.MD BAA, signed 2026-01-15, contract folder 7",
} as const;
/** 2026-11-09 07:00 Eastern: 67 days before the end date. */
const NOW = new Date("2026-11-09T12:00:00Z");

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ChartWardenError) return err.code;
    throw err;
  }
  return "no error";
};

/** A 422 names the field's own code in its details (the envelope code is VALIDATION_FAILED). */
const fieldCodeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ChartWardenError) return err.details?.[0]?.code ?? err.code;
    throw err;
  }
  return "no error";
};

describe("recording an end date", () => {
  const record = (over: Record<string, unknown> = {}) =>
    normalizeBaaInput({ ...BAA, ...over } as never, "2026-11-09");

  it("keeps no end date when none is stated (the agreement is open-ended)", () => {
    expect(record({ expiresOn: undefined }).expiresOn).toBeNull();
    expect(record({ expiresOn: null }).expiresOn).toBeNull();
    expect(record({ expiresOn: "  " }).expiresOn).toBeNull();
  });

  it("accepts a real day after the effective date, today included (the last day in force)", () => {
    expect(record().expiresOn).toBe(ENDS);
    expect(record({ expiresOn: "2026-11-09" }).expiresOn).toBe("2026-11-09");
  });

  it.each([
    ["not a date", "next year"],
    ["an impossible day", "2027-02-30"],
    ["the effective date itself", EFFECTIVE],
    ["before the effective date", "2025-12-31"],
    ["already past: an ended BAA covers nothing", "2026-11-08"],
  ])("refuses an end date that is %s", async (_why, expiresOn) => {
    expect(await fieldCodeOf(Promise.resolve().then(() => record({ expiresOn })))).toBe(
      "CLEARINGHOUSE_BAA_EXPIRY_INVALID",
    );
  });
});

describe("the one rule every gate asks", () => {
  it("ends the day AFTER the last day in force, and never without an end date", () => {
    expect(baaEnded("2026-12-31", "2026-12-31")).toBe(false);
    expect(baaEnded("2026-12-31", "2027-01-01")).toBe(true);
    expect(baaEnded(null, "2099-01-01")).toBe(false);
    expect(baaEnded(undefined, "2099-01-01")).toBe(false);
  });

  it("counts whole days to the last day, negative once it has passed, null with no end date", () => {
    expect(baaDaysLeft("2026-12-31", "2026-12-31")).toBe(0);
    expect(baaDaysLeft("2026-12-31", "2026-12-01")).toBe(30);
    expect(baaDaysLeft("2026-12-31", "2027-01-02")).toBe(-2);
    expect(baaDaysLeft(null, "2026-12-01")).toBeNull();
  });
});

type Store = ReturnType<typeof createInMemoryConfigStore>;

/** A claimmd production config with its connection verified, ready for a BAA; the clock is the test's. */
async function tenantWithConnection() {
  const clock = { at: NOW };
  const store = createInMemoryConfigStore(() => clock.at);
  const service = createTenantClearinghouseService({
    cipher: buildClearinghouseSecretCipher(randomBytes(32)),
    probes: { claimmd: async () => "ok" },
    now: () => clock.at,
    waitingWork: async () => ({ claims: 0, commercialSubmissions: 0 }),
  });
  await service.put(
    store,
    TENANT,
    { vendor: "claimmd", mode: "production", secret: FAKE_KEY },
    undefined,
  );
  await verifyConnection(service, (fn) => fn(store), TENANT, {});
  return { store, service, clock };
}

const pinOf = async (service: TenantClearinghouseService, store: Store) => ({
  recordedAt: (await service.view(store, ORG)).baa?.recordedAt ?? "no BAA recorded",
});

describe("the service and an end date", () => {
  it("records it and shows it, with the days left", async () => {
    const { store, service } = await tenantWithConnection();
    const { view } = await service.recordBaa(store, TENANT, BAA);
    expect(view.baa).toMatchObject({ expiresOn: ENDS, expired: false, expiresInDays: 67 });
    expect(BAA_EXPIRY_WARN_DAYS).toBe(90);
  });

  it("shows no end date, and never expires, when none was stated", async () => {
    const { store, service, clock } = await tenantWithConnection();
    await service.recordBaa(store, TENANT, { ...BAA, expiresOn: undefined });
    clock.at = new Date("2099-01-01T12:00:00Z");
    const baa = (await service.view(store, ORG)).baa;
    expect(baa).toMatchObject({ expiresOn: null, expired: false, expiresInDays: null });
  });

  it("treats a changed end date as a changed record: the verification is voided and a live config waits at verified", async () => {
    const { store, service } = await tenantWithConnection();
    await service.recordBaa(store, TENANT, BAA);
    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));
    await service.activate(store, TENANT);
    expect((await service.view(store, ORG)).status).toBe("active");

    // the very same record again: nothing changes (an idempotent re-record)
    const same = await service.recordBaa(store, TENANT, BAA);
    expect(same.changedFields).toEqual([]);
    expect(same.view.status).toBe("active");

    // the renewal: a new end date on the same document
    const renewed = await service.recordBaa(store, TENANT, { ...BAA, expiresOn: "2028-01-15" });
    expect(renewed.changedFields).toEqual(["baa"]);
    expect(renewed.view.baa).toMatchObject({ expiresOn: "2028-01-15", verified: null });
    expect(renewed.view.status).toBe("verified");
  });

  it("flags the lapse and refuses to verify or activate it: only a renewed record clears it", async () => {
    const { store, service, clock } = await tenantWithConnection();
    await service.recordBaa(store, TENANT, BAA);
    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));

    clock.at = new Date("2027-01-16T17:00:00Z"); // Eastern 2027-01-16: the day after the last day in force
    expect((await service.view(store, ORG)).baa).toMatchObject({
      expired: true,
      expiresInDays: null,
    });
    expect(await codeOf(service.activate(store, TENANT))).toBe("CLEARINGHOUSE_BAA_EXPIRED");
    expect(await codeOf(service.verifyBaa(store, OPERATOR, await pinOf(service, store)))).toBe(
      "CLEARINGHOUSE_BAA_EXPIRED",
    );

    // the tenant records the renewed BAA; the operator verifies it; the tenant activates it
    await service.recordBaa(store, TENANT, {
      ...BAA,
      effectiveDate: "2027-01-10",
      expiresOn: "2028-01-10",
    });
    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));
    const live = await service.activate(store, TENANT);
    expect(live.status).toBe("active");
    expect(live.baa).toMatchObject({ expired: false });
  });

  it("does not carry the operator's verification over to a renewal of the same document: it reads as not verified until the operator verifies again (owner decision)", async () => {
    const { store, service, clock } = await tenantWithConnection();
    await service.recordBaa(store, TENANT, BAA);
    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));
    await service.activate(store, TENANT);

    clock.at = new Date("2027-01-16T17:00:00Z"); // the day after the last day in force; the config still reads `active`
    expect((await service.view(store, ORG)).status).toBe("active");

    // the renewal: the very same document and effective date, a new end date
    const renewed = await service.recordBaa(store, TENANT, { ...BAA, expiresOn: "2028-01-15" });
    expect(renewed.view.baa).toMatchObject({
      documentRef: BAA.documentRef,
      effectiveDate: BAA.effectiveDate,
      expiresOn: "2028-01-15",
      expired: false,
      verified: null,
    });
    expect(renewed.view.status).toBe("verified"); // taken off `active`: nothing sends until it is verified and activated again
    expect(await codeOf(service.activate(store, TENANT))).toBe("CLEARINGHOUSE_BAA_NOT_VERIFIED");

    await service.verifyBaa(store, OPERATOR, await pinOf(service, store));
    expect((await service.activate(store, TENANT)).status).toBe("active");
  });

  it("refuses an end date the tenant records already past, whatever the lane's clock says it is", async () => {
    const { store, service, clock } = await tenantWithConnection();
    clock.at = new Date("2027-01-16T17:00:00Z");
    expect(await fieldCodeOf(service.recordBaa(store, TENANT, BAA))).toBe(
      "CLEARINGHOUSE_BAA_EXPIRY_INVALID",
    );
  });
});

type RuntimeDeps = Parameters<typeof createTenantClearinghouseRuntime>[0];

/** The resolver over a one-row world and a clock the test moves. */
async function resolverWorld(rowOver: Partial<ConfigRow>, extra: Partial<RuntimeDeps> = {}) {
  const cipher = buildClearinghouseSecretCipher(randomBytes(32));
  const sealed = await cipher.encrypt(ORG, FAKE_KEY, { vendor: "claimmd", mode: "production" });
  const clock = { at: NOW };
  const ending: { organizationId: string; expiresOn: string; daysLeft: number }[] = [];
  let row = {
    organizationId: ORG,
    vendor: "claimmd",
    mode: "production",
    status: "active",
    version: 1,
    secretCipher: sealed.cipher,
    baaRevokedAt: null,
    baaExpiresOn: null,
    ...rowOver,
  } as ConfigRow;
  const runtime = createTenantClearinghouseRuntime({
    db: {} as DbClient,
    cipher,
    attempts: new InMemoryAttemptStore(),
    platformBinding: { vendor: "in_memory", transport: createInMemoryHarness().transport },
    fallbackOrgIds: new Set(),
    isOrganizationLive: async () => true,
    readRow: async () => row,
    now: () => clock.at,
    onBaaEnding: (e) => void ending.push(e),
    ...extra,
  });
  return {
    runtime,
    clock,
    ending,
    setRow: (next: Partial<ConfigRow>) => {
      row = { ...row, ...next };
    },
  };
}

describe("the resolver fails closed after the last day in force", () => {
  it("serves the account on the last day, Eastern, and holds it from the first moment of the next", async () => {
    const { runtime, clock } = await resolverWorld({ baaExpiresOn: "2026-12-31" });

    clock.at = new Date("2027-01-01T04:59:00Z"); // Eastern 2026-12-31 23:59
    expect((await runtime.binding.forOrg?.(ORG))?.vendor).toBe("claimmd");
    expect(await runtime.usageFor(ORG)).toBe("production");

    clock.at = new Date("2027-01-01T05:00:00Z"); // Eastern 2027-01-01 00:00
    const held = await runtime.binding.forOrg?.(ORG);
    expect(held).toBe(UNBOUND_BAA_EXPIRED);
    expect(held?.vendor).toBeNull();
    expect(held?.unboundReason).toBe("baa_expired");
    // an expired config is not "live", so the env usage question has no answer from it
    expect(await runtime.usageFor(ORG)).toBeNull();
  });

  it("drops the cached transport at the lapse and serves again once the renewed record lands", async () => {
    const { runtime, clock, setRow } = await resolverWorld({ baaExpiresOn: "2026-12-31" });
    expect((await runtime.binding.forOrg?.(ORG))?.vendor).toBe("claimmd");
    clock.at = new Date("2027-01-02T12:00:00Z");
    expect(await runtime.binding.forOrg?.(ORG)).toBe(UNBOUND_BAA_EXPIRED);
    setRow({ baaExpiresOn: "2028-01-15", version: 2 }); // the renewed, re-verified, re-activated record
    expect((await runtime.binding.forOrg?.(ORG))?.vendor).toBe("claimmd");
  });

  it("never holds a config with no end date, and a revoked one keeps its own reason", async () => {
    const open = await resolverWorld({ baaExpiresOn: null });
    open.clock.at = new Date("2099-06-01T12:00:00Z");
    expect((await open.runtime.binding.forOrg?.(ORG))?.vendor).toBe("claimmd");

    const revoked = await resolverWorld({
      status: "verified",
      baaExpiresOn: "2026-12-31",
      baaRevokedAt: new Date("2026-11-01T00:00:00Z"),
    });
    revoked.clock.at = new Date("2027-02-01T12:00:00Z");
    expect(await revoked.runtime.binding.forOrg?.(ORG)).toBe(UNBOUND_BAA_REVOKED);
  });

  it("says so when the end is within the warning window or past, and never when it is further out or stated none", async () => {
    const w = await resolverWorld({ baaExpiresOn: "2027-02-08" });
    await w.runtime.binding.forOrg?.(ORG); // NOW is 2026-11-09: 91 days out
    expect(w.ending).toEqual([]);

    w.clock.at = new Date("2026-11-10T12:00:00Z"); // 90 days out: inside the window
    await w.runtime.binding.forOrg?.(ORG);
    expect(w.ending).toEqual([{ organizationId: ORG, expiresOn: "2027-02-08", daysLeft: 90 }]);

    w.clock.at = new Date("2027-02-09T17:00:00Z"); // past: negative days
    await w.runtime.binding.forOrg?.(ORG);
    expect(w.ending.at(-1)).toEqual({ organizationId: ORG, expiresOn: "2027-02-08", daysLeft: -1 });

    const none = await resolverWorld({ baaExpiresOn: null });
    await none.runtime.binding.forOrg?.(ORG);
    expect(none.ending).toEqual([]);
  });

  it("never lets a failing notice stop a resolution", async () => {
    const w = await resolverWorld(
      { baaExpiresOn: "2026-12-01" },
      {
        onBaaEnding: () => {
          throw new Error("alert router down");
        },
      },
    );
    expect((await w.runtime.binding.forOrg?.(ORG))?.vendor).toBe("claimmd");
  });
});

describe("the claims-billing gate", () => {
  const row = (over: Partial<ConfigRow>): ConfigRow =>
    ({
      vendor: "claimmd",
      mode: "production",
      status: "active",
      baaRevokedAt: null,
      baaExpiresOn: null,
      ...over,
    }) as ConfigRow;
  const choice = (r: ConfigRow, today: string): TenantClearinghouseChoice =>
    choiceOf(r, null, today);

  it("refuses new work, with its own reason, for an active config whose recorded BAA ended", () => {
    const r = row({ baaExpiresOn: "2026-12-31" });
    expect(decideClaimsBilling(choice(r, "2026-12-31"))).toEqual({ entitled: true });
    expect(decideClaimsBilling(choice(r, "2027-01-01"))).toEqual({
      entitled: false,
      reason: "clearinghouse_baa_expired",
    });
    expect(choice(r, "2027-01-01")).toMatchObject({ baaExpired: true });
  });

  it("is not affected by a config with no end date, and lets a revocation say its own reason first", () => {
    expect(decideClaimsBilling(choice(row({}), "2099-01-01"))).toEqual({ entitled: true });
    const revoked = row({
      status: "verified",
      baaExpiresOn: "2026-12-31",
      baaRevokedAt: new Date("2026-11-01T00:00:00Z"),
    });
    expect(decideClaimsBilling(choice(revoked, "2027-02-01"))).toEqual({
      entitled: false,
      reason: "clearinghouse_baa_revoked",
    });
  });
});

describe("the warning ahead and the notice at the end", () => {
  const setup = (over: { alertFails?: boolean; opsFails?: boolean } = {}) => {
    const clock = { at: new Date("2026-11-09T12:00:00Z") };
    const ops: { kind: string; summary: string; details: unknown; correlationId: string }[] = [];
    const alerts: {
      alertCode: string;
      severity: string;
      organizationId: string;
      payload: unknown;
    }[] = [];
    const logs: { event: string; code: string }[] = [];
    const notify = createBaaExpiryNotifier({
      now: () => clock.at,
      opsNotice: (n) => {
        if (over.opsFails) throw new Error("ops sink down");
        ops.push(n);
      },
      alerts: {
        dispatch: async (a) => {
          if (over.alertFails) throw new Error("router down");
          alerts.push(a);
        },
      },
      log: (e) => void logs.push(e),
    });
    return { notify, clock, ops, alerts, logs };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("warns ahead once a day per organization: a warn alert and a platform-ops notice with ids, a date and a count", async () => {
    const { notify, ops, alerts, clock } = setup();
    notify({ organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 67 });
    notify({ organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 67 }); // the next job, same day
    await flush();
    expect(alerts).toEqual([
      {
        alertCode: BAA_EXPIRING_ALERT,
        severity: "warn",
        organizationId: ORG,
        payload: { expiresOn: "2027-01-15", daysLeft: 67 },
      },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: BAA_EXPIRING_ALERT,
      details: { organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 67 },
      correlationId: `${BAA_EXPIRING_ALERT}:${ORG}:2026-11-09`,
    });
    expect(ops[0]?.summary).toContain("ends 2027-01-15 (67 day(s) left)");

    clock.at = new Date("2026-11-10T12:00:00Z"); // the next day: told again
    notify({ organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 66 });
    await flush();
    expect(alerts).toHaveLength(2);
  });

  it("raises a critical notice once the end has passed, even on the day it warned, and keeps each organization apart", async () => {
    const { notify, ops, alerts } = setup();
    const other = "22222222-2222-4222-8222-222222222222";
    notify({ organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 0 });
    notify({ organizationId: ORG, expiresOn: "2027-01-15", daysLeft: -1 });
    notify({ organizationId: other, expiresOn: "2027-01-15", daysLeft: 5 });
    await flush();
    expect(alerts.map((a) => [a.organizationId, a.alertCode, a.severity])).toEqual([
      [ORG, BAA_EXPIRING_ALERT, "warn"],
      [ORG, BAA_EXPIRED_ALERT, "critical"],
      [other, BAA_EXPIRING_ALERT, "warn"],
    ]);
    expect(ops[1]?.summary).toContain("ended 2027-01-15");
  });

  it("tries a failed tenant alert again after the retry window, and never again once it is delivered", async () => {
    const over = { alertFails: true };
    const { notify, ops, alerts, logs, clock } = setup(over);
    const ending = { organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 3 };
    notify(ending);
    await flush();
    expect(logs.map((l) => l.code)).toEqual(["ALERT_FAILED"]);

    over.alertFails = false;
    notify(ending); // inside the retry window: not tried yet
    await flush();
    expect(alerts).toHaveLength(0);

    clock.at = new Date(clock.at.getTime() + ALERT_RETRY_MS);
    notify(ending);
    await flush();
    expect(alerts).toHaveLength(1);

    clock.at = new Date(clock.at.getTime() + ALERT_RETRY_MS);
    notify(ending); // delivered: not again that day
    await flush();
    expect(alerts).toHaveLength(1);
    expect(ops).toHaveLength(1); // the ops notice is once a day whatever the alert did
  });

  it("never throws into the resolver: a failing alert or ops sink is logged by code only", async () => {
    const down = setup({ alertFails: true, opsFails: true });
    expect(() =>
      down.notify({ organizationId: ORG, expiresOn: "2027-01-15", daysLeft: 3 }),
    ).not.toThrow();
    await flush();
    expect(down.logs.map((l) => l.code).sort()).toEqual(["ALERT_FAILED", "OPS_NOTICE_FAILED"]);
    expect(JSON.stringify(down.logs)).not.toContain("router down");
  });
});
