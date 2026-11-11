// Slice 2 (tenant pricing) — the shipped platform audit mapping cannot be overwritten by its own detail, and a plan write that returns no row
// is a typed 500 (PERSIST_FAILED), never a bare Error the error envelope would not recognise.
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { buildContractService } from "../pricing/contract-service";
import { buildPricingPlanService } from "../pricing/plan-service";
import { type PlatformAuditRow, buildPlatformAuditPort } from "../pricing/ports";
import type { PlatformAuditEntry } from "../pricing/ports";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";

describe("buildPlatformAuditPort: the context keeps the operator, the tenant and the reason a detail field would like to rewrite", () => {
  const record = async (detail: Record<string, string | number | boolean | null>) => {
    let written: PlatformAuditRow | undefined;
    const port = buildPlatformAuditPort(async (_tx, row) => {
      written = row;
    });
    await port.record({} as WriteTx, {
      eventType: "m35.test",
      resourceKind: "subscription",
      resourceId: "res-1",
      organizationId: "org-real",
      operator: { userId: "operator-real", membershipId: "membership-real" },
      reason: "the real reason",
      detail,
    });
    if (!written) throw new Error("nothing was written");
    return written;
  };

  it("a detail that names reason, operatorUserId, operatorMembershipId or organizationId does NOT replace the real ones", async () => {
    const row = await record({
      reason: "forged reason",
      operatorUserId: "forged-operator",
      operatorMembershipId: "forged-membership",
      organizationId: "forged-org",
      planSlug: "demo-v1",
    });
    expect(row.context).toMatchObject({
      reason: "the real reason",
      operatorUserId: "operator-real",
      operatorMembershipId: "membership-real",
      organizationId: "org-real",
      planSlug: "demo-v1", // a detail still adds its own facts
    });
  });

  it("is platform-scoped severity warn / outcome success, with the event and resource it was given", async () => {
    const row = await record({});
    expect(row).toMatchObject({
      eventType: "m35.test",
      resourceKind: "subscription",
      resourceId: "res-1",
      outcome: "success",
      severity: "warn",
    });
    expect(row.correlationId).toContain("m35-pricing:m35.test:res-1:");
  });
});

/** A transaction double: each select() consumes the next rows; every insert / update / delete returns no row. */
function txReturning(selects: unknown[][]): WriteTx {
  const queue = [...selects];
  const chain = (rows: unknown[]): unknown => {
    const handler: ProxyHandler<() => unknown> = {
      get: (_t, prop) =>
        prop === "then" ? (resolve: (v: unknown) => void) => resolve(rows) : () => proxy,
      apply: () => proxy,
    };
    const proxy: unknown = new Proxy(() => undefined, handler);
    return proxy;
  };
  return {
    select: () => chain(queue.shift() ?? []),
    insert: () => chain([]),
    update: () => chain([]),
    delete: () => chain([]),
  } as unknown as WriteTx;
}

describe("plan writes that return no row are a typed PERSIST_FAILED 500", () => {
  const actor = {
    organizationId: "o",
    userId: "u",
    roles: [],
    membershipId: "m",
    stepUpRecent: true,
  };
  const audit = { record: async () => undefined };
  const service = (selects: unknown[][]) => {
    const runner: PlatformRunner = (fn) => fn(txReturning(selects));
    return buildPricingPlanService({ platformRunner: runner, audit });
  };
  const draft = {
    id: "p1",
    tier: "census_banded",
    slug: "fam-v1",
    familySlug: "fam",
    version: 1,
    name: "Plan",
    description: null,
    currencyCode: "USD",
    basePriceCents: 100,
    publishedAt: null,
    deprecatedAt: null,
    perUserPriceCents: 1000,
    billingSoftwareBps: 100,
    managedBillingBps: 400,
    contractTermMonths: 12,
    implementationFeeCents: 0,
    minimumMonthlyCents: null,
  };
  const published = { ...draft, publishedAt: new Date("2026-11-01T00:00:00Z") };
  const input = {
    name: "Plan",
    perUserPriceCents: 1000,
    bands: [{ minAdc: 0, monthlyFeeCents: 100 }],
    billingSoftwareBps: 100,
    managedBillingBps: 400,
    contractTermMonths: 12,
    implementationFeeCents: 0,
    minimumMonthlyCents: null,
  };
  const reason = "a reason long enough";

  const expectPersistFailed = async (call: () => Promise<unknown>) => {
    const error = await call().catch((e) => e);
    expect(error).toBeInstanceOf(ChartWardenError);
    expect(error).toMatchObject({ code: "PERSIST_FAILED", statusCode: 500 });
  };

  it("create (the insert)", () =>
    expectPersistFailed(() =>
      service([[]]).create(actor, { familySlug: "fam", ...input }, reason),
    ));
  it("replaceDraft (the update)", () =>
    expectPersistFailed(() => service([[draft]]).replaceDraft(actor, "p1", input, reason)));
  it("publish (the update)", () =>
    expectPersistFailed(() =>
      service([[draft], [{ minAdc: 0, monthlyFeeCents: 100 }]]).publish(actor, "p1", reason),
    ));
  it("newVersion (the insert)", () =>
    expectPersistFailed(() =>
      service([
        [published],
        [{ id: "p1", version: 1, publishedAt: published.publishedAt }],
        [],
      ]).newVersion(actor, "p1", reason),
    ));
  it("archive (the update)", () =>
    expectPersistFailed(() => service([[published]]).archive(actor, "p1", reason)));
});

/** A Postgres unique violation as Drizzle surfaces it: the pg error, wrapped, with the constraint on it. */
const uniqueViolation = (constraint: string): Error =>
  new Error("Failed query: insert ...", {
    cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint,
    }),
  });

describe("a select-then-insert race surfaces as a 409, not a raw unique violation (a 500)", () => {
  const actor = {
    organizationId: "o",
    userId: "u",
    roles: [],
    membershipId: "m",
    stepUpRecent: true,
  };
  const reason = "a reason long enough";
  const raceOn =
    (constraint: string): PlatformRunner =>
    async () => {
      throw uniqueViolation(constraint);
    };
  const plans = (constraint: string) =>
    buildPricingPlanService({
      platformRunner: raceOn(constraint),
      audit: { record: async () => undefined },
    });
  const input = {
    familySlug: "fam",
    name: "Plan",
    perUserPriceCents: 1000,
    bands: [{ minAdc: 0, monthlyFeeCents: 100 }],
    billingSoftwareBps: 100,
    managedBillingBps: 400,
    contractTermMonths: 12,
    implementationFeeCents: 0,
    minimumMonthlyCents: null,
  };

  it("create: two operators creating the same family collide on plan_slug_uq -> ConflictError 409", async () => {
    const error = await plans("plan_slug_uq")
      .create(actor, input, reason)
      .catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409 });
    expect(error.message).toMatch(/created at the same time/);
  });

  it("newVersion: two operators versioning the same family collide on plan_slug_uq -> ConflictError 409", async () => {
    const error = await plans("plan_slug_uq")
      .newVersion(actor, "p1", reason)
      .catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409 });
    expect(error.message).toMatch(/another version/);
  });

  it("any other failure is left exactly as it was", async () => {
    const other = uniqueViolation("some_other_uq");
    const runner: PlatformRunner = async () => {
      throw other;
    };
    const service = buildPricingPlanService({
      platformRunner: runner,
      audit: { record: async () => undefined },
    });
    await expect(service.create(actor, input, reason)).rejects.toBe(other);
  });

  it("createForTenant: a subscription written by another path first -> SUBSCRIPTION_EXISTS 409", async () => {
    const contracts = buildContractService({
      db: {} as DbClient,
      platformRunner: raceOn("subscription_org_active_uq"),
      audit: { record: async () => undefined },
      outbox: { publish: async () => undefined } as never,
      onboarding: {
        enter: async () => null,
        planContractStep: async () => ({ taskId: null, status: "pending", lockedBy: null }),
        attestPlanContract: async () => undefined,
      },
    });
    const error = await contracts
      .createForTenant(actor, "acme", {
        planSlug: "fam-v1",
        billingServiceMode: "billing_software",
        reason,
        orderFormRef: null,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ChartWardenError);
    expect(error).toMatchObject({ code: "SUBSCRIPTION_EXISTS", statusCode: 409 });
  });
});

describe("a price change is auditable: the structured audit row names the operator AND the figures", () => {
  const actor = {
    organizationId: "o",
    userId: "user-1",
    roles: [],
    membershipId: "membership-1",
    stepUpRecent: true,
  };
  const reason = "a reason long enough";
  const row = (perUserPriceCents: number) => ({
    id: "p1",
    tier: "census_banded",
    slug: "fam-v1",
    familySlug: "fam",
    version: 1,
    name: "Plan",
    description: null,
    currencyCode: "USD",
    basePriceCents: 100,
    isActive: false,
    publishedAt: null,
    deprecatedAt: null,
    supersedesPlanId: null,
    perUserPriceCents,
    billingSoftwareBps: 100,
    managedBillingBps: 400,
    contractTermMonths: 12,
    implementationFeeCents: 5000,
    minimumMonthlyCents: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
  });
  const bands = [
    { minAdc: 0, monthlyFeeCents: 100_000 },
    { minAdc: 10, monthlyFeeCents: 200_000 },
  ];

  /** replaceDraft / publish over a transaction whose update returns `after`; the audit rows are captured. */
  function run(action: "draft_updated" | "published", before: object, after: object) {
    const audited: PlatformAuditEntry[] = [];
    const queue: unknown[][] = action === "published" ? [[before], bands] : [[before]];
    const chain = (rows: unknown[]): unknown => {
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_t, prop) =>
          prop === "then" ? (resolve: (v: unknown) => void) => resolve(rows) : () => proxy,
        apply: () => proxy,
      });
      return proxy;
    };
    const tx = {
      select: () => chain(queue.shift() ?? []),
      insert: () => chain([]),
      update: () => chain([after]),
      delete: () => chain([]),
    } as unknown as WriteTx;
    const service = buildPricingPlanService({
      platformRunner: (fn) => fn(tx),
      audit: { record: async (_tx, entry) => void audited.push(entry) },
    });
    const done =
      action === "published"
        ? service.publish(actor, "p1", reason)
        : service.replaceDraft(
            actor,
            "p1",
            {
              name: "Plan",
              perUserPriceCents: (after as { perUserPriceCents: number }).perUserPriceCents,
              bands,
              billingSoftwareBps: 100,
              managedBillingBps: 400,
              contractTermMonths: 12,
              implementationFeeCents: 5000,
              minimumMonthlyCents: null,
            },
            reason,
          );
    return done.then(() => audited);
  }

  it("m35.plan.draft_updated carries the new figures, the band table and a digest of them", async () => {
    const [entry] = await run("draft_updated", row(1000), row(1250));
    expect(entry).toMatchObject({
      eventType: "m35.plan.draft_updated",
      operator: { userId: "user-1", membershipId: "membership-1" },
    });
    expect(entry?.detail).toMatchObject({
      planSlug: "fam-v1",
      version: 1,
      currencyCode: "USD",
      perUserPriceCents: 1250,
      billingSoftwareBps: 100,
      managedBillingBps: 400,
      contractTermMonths: 12,
      implementationFeeCents: 5000,
      minimumMonthlyCents: null,
      bands: "0:100000,10:200000",
    });
    expect(entry?.detail?.figuresSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("m35.plan.published carries them too, and the digest moves with any figure", async () => {
    const [draftUpdated] = await run("draft_updated", row(1000), row(1250));
    const [published] = await run("published", row(1250), {
      ...row(1250),
      publishedAt: new Date("2026-11-02T00:00:00Z"),
      isActive: true,
    });
    const [other] = await run("published", row(1300), {
      ...row(1300),
      publishedAt: new Date("2026-11-02T00:00:00Z"),
      isActive: true,
    });
    expect(published?.eventType).toBe("m35.plan.published");
    expect(published?.detail).toMatchObject({
      perUserPriceCents: 1250,
      bands: "0:100000,10:200000",
    });
    // the same figures hash the same wherever they are recorded; a different price is a different digest
    expect(published?.detail?.figuresSha256).toBe(draftUpdated?.detail?.figuresSha256);
    expect(other?.detail?.figuresSha256).not.toBe(published?.detail?.figuresSha256);
  });
});
