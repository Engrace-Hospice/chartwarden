// Slice 2 (tenant pricing) — the shipped platform audit mapping cannot be overwritten by its own detail, and a plan write that returns no row
// is a typed 500 (PERSIST_FAILED), never a bare Error the error envelope would not recognise.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { buildPricingPlanService } from "../pricing/plan-service";
import { type PlatformAuditRow, buildPlatformAuditPort } from "../pricing/ports";
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
