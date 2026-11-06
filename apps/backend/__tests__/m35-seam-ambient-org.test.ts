// Slice 2 (tenant pricing) — the two org-explicit seams (M25 NetCollectionsReader, M35 BillingServiceModeReader) refuse a call made inside
// ANOTHER organisation's request. A worker (no ambient context) and the same organisation's own request pass. The database handle here is
// a trap: if a guarded call ever reached it, the test would fail on the trap, not on the assertion, so "refused" means "refused BEFORE any read".
import type { DbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { OrgId } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { refuseForeignAmbientOrg } from "../src/bootstrap/ambient-org-guard";
import { buildNetCollectionsReader } from "../src/modules/25-remittance/net-collections-reader";
import { readBillingServiceMode } from "../src/modules/35-subscription/pricing/contract-service";

const ORG_A = "a1000000-0000-4000-8000-0000000000a1";
const ORG_B = "b2000000-0000-4000-8000-0000000000b2";
const REACHED_THE_DATABASE = "the guard let the call reach the database";
const trap = new Proxy(
  {},
  {
    get() {
      throw new Error(REACHED_THE_DATABASE);
    },
  },
) as unknown as DbClient;
const period = {
  periodStart: new Date("2026-11-01T00:00:00Z"),
  periodEnd: new Date("2026-12-01T00:00:00Z"),
};
const inRequestOf = <T>(organizationId: string, fn: () => T): T =>
  runWithRequestContext({ organizationId, userId: "someone" }, fn);

describe("refuseForeignAmbientOrg", () => {
  it("refuses an ambient request of a different organisation with a 403 that names the seam", () => {
    const error = (() => {
      try {
        inRequestOf(ORG_B, () => refuseForeignAmbientOrg(ORG_A, "BillingServiceModeReader"));
      } catch (e) {
        return e as { code: string; statusCode: number; message: string };
      }
      return null;
    })();
    expect(error).toMatchObject({ code: "SEAM_FOREIGN_ORGANIZATION", statusCode: 403 });
    expect(error?.message).toContain("BillingServiceModeReader");
  });

  it("passes with no ambient context (a worker) and with the same organisation's own request", () => {
    expect(() => refuseForeignAmbientOrg(ORG_A, "x")).not.toThrow();
    expect(() => inRequestOf(ORG_A, () => refuseForeignAmbientOrg(ORG_A, "x"))).not.toThrow();
  });

  it("refuses an ambient request that has no organisation at all (an unauthenticated context is not this organisation's)", () => {
    expect(() => inRequestOf("", () => refuseForeignAmbientOrg(ORG_A, "x"))).toThrow(
      /another organisation/,
    );
  });
});

describe("the seam bodies refuse before they read", () => {
  it("BillingServiceModeReader: tenant B's request cannot ask tenant A's mode", async () => {
    await expect(
      inRequestOf(ORG_B, () => readBillingServiceMode(trap, ORG_A)),
    ).rejects.toMatchObject({
      code: "SEAM_FOREIGN_ORGANIZATION",
    });
  });

  it("NetCollectionsReader: tenant B's request cannot read tenant A's collections, by period or by month", async () => {
    const reader = buildNetCollectionsReader(trap);
    await expect(
      inRequestOf(ORG_B, () => reader.netCollectionsForPeriod(ORG_A as OrgId, period)),
    ).rejects.toMatchObject({
      code: "SEAM_FOREIGN_ORGANIZATION",
    });
    await expect(
      inRequestOf(ORG_B, () => reader.netCollectionsByMonth(ORG_A as OrgId, period)),
    ).rejects.toMatchObject({
      code: "SEAM_FOREIGN_ORGANIZATION",
    });
  });

  it("with no ambient context or the same organisation the guard steps aside (the call then reaches the database, which here is the trap)", async () => {
    await expect(readBillingServiceMode(trap, ORG_A)).rejects.toThrow(REACHED_THE_DATABASE);
    await expect(
      inRequestOf(ORG_A, () =>
        buildNetCollectionsReader(trap).netCollectionsByMonth(ORG_A as OrgId, period),
      ),
    ).rejects.toThrow(REACHED_THE_DATABASE);
  });
});
