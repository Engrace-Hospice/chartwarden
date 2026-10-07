// GAP-144 — the M23 platform-admin commands. The database is a Proxy that throws on any use, which proves the
// validation / refusal paths reject BEFORE touching the platform table.
import type { repositories } from "@wardenx/billing";
import { describe, expect, it } from "vitest";
import type { M23WriteActor } from "./actor";
import { buildDrizzlePlatformAdminService } from "./platform-admin-service";

const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error("a refused platform-admin command must not touch the database");
    },
  },
) as repositories.BillingDb;

const ACTOR: M23WriteActor = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "u1",
  roles: ["platform_admin"],
  membershipId: "22222222-2222-4222-8222-222222222222",
  stepUpRecent: true,
  actorKind: "user",
};
const service = buildDrizzlePlatformAdminService(untouchedDb, {
  now: () => new Date("2026-10-06T00:00:00Z"),
});

describe("loadWageIndexes validation (loads nothing on any bad row)", () => {
  const base = { fiscalYearStarting: 2026, sourceReference: "https://cms.example/wage-index.csv" };

  it("rejects a factor outside the plausible band", async () => {
    await expect(
      service.loadWageIndexes(ACTOR, {
        ...base,
        rows: [{ ccn: "381234", factorDecimal: "9.0000" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a CCN that appears twice in one file", async () => {
    await expect(
      service.loadWageIndexes(ACTOR, {
        ...base,
        rows: [
          { ccn: "381234", factorDecimal: "0.9500" },
          { ccn: "381234", factorDecimal: "0.9600" },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a fiscal year beyond next year (a typo)", async () => {
    await expect(
      service.loadWageIndexes(ACTOR, {
        fiscalYearStarting: 2099,
        sourceReference: "x",
        rows: [{ ccn: "381234", factorDecimal: "0.9500" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("registerPlatformRule", () => {
  const body = {
    title: "T",
    description: "D",
    severity: "error" as const,
    regulatoryRequired: true,
  };

  it("409s a key that already exists in the code-defined registry", async () => {
    await expect(
      service.registerPlatformRule(ACTOR, { ...body, ruleKey: "noe_timeliness_5d" }),
    ).rejects.toMatchObject({ code: "PLATFORM_RULE_EXISTS", statusCode: 409 });
  });

  it("answers an honest 501 for a new key (no dynamic platform-rule store exists)", async () => {
    await expect(
      service.registerPlatformRule(ACTOR, { ...body, ruleKey: "brand_new_rule" }),
    ).rejects.toMatchObject({ code: "PLATFORM_RULES_ARE_CODE_DEFINED", statusCode: 501 });
  });
});
