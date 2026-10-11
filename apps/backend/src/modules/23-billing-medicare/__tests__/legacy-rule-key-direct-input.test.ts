// Migration 1069 renamed `hipps_coding_correct` -> `per_diem_class_coding_correct`. A DIRECT rule-key input (bulk override,
// rule-config CREATE body) must be canonicalized before it reaches the ABAC registry lookup, and a custom rule-config can
// never be created under a legacy spelling.
import { describe, expect, it } from "vitest";
import { type ReadingM23AbacResolver, buildM23AbacPredicates } from "../abac-predicates";
import { targetRuleKeyFromBody } from "../routes/guards";
import { buildDrizzleM23WriteService } from "../routes/write-service-drizzle";

const LEGACY = "hipps_coding_correct";
const CURRENT = "per_diem_class_coding_correct";
const NO_RESOLVER = {} as ReadingM23AbacResolver;
const ctx = {
  organizationId: "o",
  userId: "u",
  roles: ["billing_manager", "compliance_officer"],
  attributes: {},
} as never;

describe("legacy rule key on direct-key input paths", () => {
  const predicates = buildM23AbacPredicates({ resolver: NO_RESOLVER });

  it("regulatory_required_rule_protected treats the legacy key like the current regulatory rule (denied)", async () => {
    const guard = predicates.regulatory_required_rule_protected as (
      c: unknown,
      t: unknown,
    ) => Promise<boolean>;
    expect(await guard(ctx, { ruleKey: CURRENT })).toBe(false);
    expect(await guard(ctx, { ruleKey: LEGACY })).toBe(false);
  });

  it("a tenant-custom key stays editable", async () => {
    const guard = predicates.regulatory_required_rule_protected as (
      c: unknown,
      t: unknown,
    ) => Promise<boolean>;
    expect(await guard(ctx, { ruleKey: "custom_rule_new" })).toBe(true);
  });

  it("targetRuleKeyFromBody canonicalizes a legacy key and leaves a canonical one alone", () => {
    expect(targetRuleKeyFromBody({ body: { ruleKey: LEGACY } } as never)).toEqual({
      ruleKey: CURRENT,
    });
    expect(targetRuleKeyFromBody({ body: { ruleKey: CURRENT } } as never)).toEqual({
      ruleKey: CURRENT,
    });
    expect(targetRuleKeyFromBody({ body: {} } as never)).toEqual({ ruleKey: "" });
  });

  it("createRuleConfig rejects a legacy spelling with a typed 400 before touching the database", async () => {
    const svc = buildDrizzleM23WriteService({} as never);
    const actor = {
      organizationId: "o",
      userId: "u",
      roles: [],
      membershipId: "m",
      stepUpRecent: true,
    } as never;
    await expect(
      svc.createRuleConfig(actor, {
        ruleKey: LEGACY,
        severity: "warn",
        setReason: "x".repeat(40),
      } as never),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", statusCode: 400 });
  });
});
