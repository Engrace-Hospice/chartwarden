import { describe, expect, it } from "vitest";
import type { PricedLine } from "../domain/pricing";
import {
  type AuthorizationFact,
  type RuleContext,
  evidenceHash,
  isBlocking,
  runCommercialRules,
} from "../domain/rules";

const line = (over: Partial<PricedLine> = {}): PricedLine => ({
  lineNumber: 1,
  levelOfCare: "routine_home_care",
  revenueCode: "0651",
  hcpcsCode: null,
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
  units: 31,
  unitRateCents: 20_000,
  lineChargeCents: 620_000,
  contractRateId: "r1",
  unpricedReason: null,
  ...over,
});
const auth = (over: Partial<AuthorizationFact> = {}): AuthorizationFact => ({
  id: "a1",
  levelOfCare: null,
  status: "approved",
  obtainedOn: "2026-02-01",
  effectiveFrom: "2026-03-01",
  effectiveTo: null,
  ...over,
});
const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
  plan: {
    id: "p1",
    payerId: "pay1",
    claimFilingIndicator: "CI",
    authorizationRequirement: "not_required",
    authorizationLeadDays: null,
    siteOfServiceHcpcsRequired: false,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  },
  payerState: { status: "active", mergedIntoId: null },
  routes: [
    {
      clearinghouseKey: "stedi",
      clearinghousePayerId: "SYNTH01",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
  ],
  clearinghouseKey: null,
  lines: [line()],
  authorizations: [],
  diagnosisCodes: ["C34.90"],
  attendingNpi: "1245319599",
  secondaryPayerKind: null,
  ...over,
});
const failing = (c: RuleContext) => runCommercialRules(c).filter((r) => r.outcome === "fail");
const byKey = (c: RuleContext, key: string) => runCommercialRules(c).find((r) => r.ruleKey === key);

describe("commercial rules", () => {
  it("passes a clean claim and keeps the error-is-hard / warn-is-overridable invariant on every result", () => {
    expect(failing(ctx())).toEqual([]);
    for (const c of [
      ctx({ plan: { ...ctx().plan, authorizationRequirement: "confirm_with_payer" } }),
      ctx({ plan: { ...ctx().plan, authorizationRequirement: "required_at_admission" } }),
      ctx({
        lines: [line({ unpricedReason: "no_contract_rate" })],
        diagnosisCodes: [],
        attendingNpi: null,
      }),
    ]) {
      for (const r of runCommercialRules(c)) {
        if (r.outcome === "fail") expect(r.overridable).toBe(r.severity === "warn");
        else expect(r.overridable).toBe(false);
      }
    }
  });

  it("hard-blocks a plan that does not cover the window, an inactive payer, and a non-commercial filing indicator", () => {
    expect(
      byKey(ctx({ plan: { ...ctx().plan, effectiveTo: "2026-03-20" } }), "plan_in_effect"),
    ).toMatchObject({ outcome: "fail", overridable: false });
    expect(
      byKey(ctx({ payerState: { status: "merged", mergedIntoId: "pay2" } }), "plan_payer_active")
        ?.message,
    ).toContain("pay2");
    expect(byKey(ctx({ payerState: null }), "plan_payer_active")?.outcome).toBe("fail");
    expect(
      byKey(
        ctx({ plan: { ...ctx().plan, claimFilingIndicator: "MA" } }),
        "claim_filing_indicator_commercial",
      )?.outcome,
    ).toBe("fail");
  });

  it("requires exactly one clearinghouse route in effect on the last service day", () => {
    const route = (key: string, from = "2026-01-01", to: string | null = null) => ({
      clearinghouseKey: key,
      clearinghousePayerId: "P",
      effectiveFrom: from,
      effectiveTo: to,
    });
    expect(byKey(ctx({ routes: [] }), "payer_route_in_effect")?.outcome).toBe("fail");
    expect(
      byKey(ctx({ routes: [route("stedi", "2026-04-01")] }), "payer_route_in_effect")?.outcome,
    ).toBe("fail");
    expect(
      byKey(ctx({ routes: [route("stedi", "2026-01-01", "2026-03-30")] }), "payer_route_in_effect")
        ?.outcome,
    ).toBe("fail");
    expect(
      byKey(ctx({ routes: [route("stedi"), route("claimmd")] }), "payer_route_in_effect")?.message,
    ).toMatch(/more than one clearinghouse/);
    expect(
      byKey(
        ctx({ routes: [route("stedi"), route("claimmd")], clearinghouseKey: "stedi" }),
        "payer_route_in_effect",
      )?.outcome,
    ).toBe("pass");
  });

  it("requires a site-of-service HCPCS only when the plan asks for it", () => {
    const plan = { ...ctx().plan, siteOfServiceHcpcsRequired: true };
    expect(byKey(ctx({ plan }), "site_of_service_hcpcs")?.outcome).toBe("fail");
    expect(
      byKey(ctx({ plan, lines: [line({ hcpcsCode: "Q5001" })] }), "site_of_service_hcpcs")?.outcome,
    ).toBe("pass");
  });

  describe("authorization", () => {
    const required = (
      r: "required_at_admission" | "required_per_level_of_care" | "confirm_with_payer",
      over: Partial<RuleContext> = {},
    ) => ctx({ plan: { ...ctx().plan, authorizationRequirement: r }, ...over });

    it("does nothing when not required", () => {
      expect(byKey(ctx(), "authorization_on_file")?.outcome).toBe("pass");
    });

    it("covers every billed day or names the uncovered range", () => {
      expect(
        byKey(
          required("required_at_admission", { authorizations: [auth()] }),
          "authorization_on_file",
        )?.outcome,
      ).toBe("pass");
      const partial = byKey(
        required("required_at_admission", {
          authorizations: [auth({ effectiveTo: "2026-03-15" })],
        }),
        "authorization_on_file",
      );
      expect(partial).toMatchObject({ outcome: "fail", overridable: false });
      expect(partial?.message).toMatch(/expired before routine_home_care 2026-03-16 to 2026-03-31/);
      const none = byKey(required("required_at_admission"), "authorization_on_file");
      expect(none?.message).toMatch(/none covers routine_home_care 2026-03-01 to 2026-03-31/);
    });

    it("unions authorizations, and ignores denied and voided ones", () => {
      const both = [
        auth({ id: "a", effectiveTo: "2026-03-15" }),
        auth({ id: "b", effectiveFrom: "2026-03-16" }),
      ];
      expect(
        byKey(required("required_at_admission", { authorizations: both }), "authorization_on_file")
          ?.outcome,
      ).toBe("pass");
      const dead = [auth({ status: "denied" }), auth({ id: "b", status: "voided" })];
      expect(
        byKey(required("required_at_admission", { authorizations: dead }), "authorization_on_file")
          ?.outcome,
      ).toBe("fail");
    });

    it("matches the level of care when authorization is per level", () => {
      const gip = [auth({ levelOfCare: "general_inpatient" })];
      expect(
        byKey(
          required("required_per_level_of_care", { authorizations: gip }),
          "authorization_on_file",
        )?.outcome,
      ).toBe("fail");
      const rhcAuth = [auth({ levelOfCare: "routine_home_care" })];
      expect(
        byKey(
          required("required_per_level_of_care", { authorizations: rhcAuth }),
          "authorization_on_file",
        )?.outcome,
      ).toBe("pass");
      // an authorization for every level (null) does NOT satisfy a per-level requirement
      expect(
        byKey(
          required("required_per_level_of_care", { authorizations: [auth()] }),
          "authorization_on_file",
        )?.outcome,
      ).toBe("fail");
    });

    it("treats an unconfirmed requirement as a soft block", () => {
      const r = byKey(required("confirm_with_payer"), "authorization_on_file");
      expect(r).toMatchObject({ outcome: "fail", severity: "warn", overridable: true });
    });

    it("flags a late authorization against the lead time, as a soft block", () => {
      const lead = {
        ...ctx().plan,
        authorizationRequirement: "required_at_admission" as const,
        authorizationLeadDays: 5,
      };
      expect(
        byKey(
          ctx({ plan: lead, authorizations: [auth({ obtainedOn: "2026-02-20" })] }),
          "authorization_lead_time",
        )?.outcome,
      ).toBe("pass");
      const late = byKey(
        ctx({ plan: lead, authorizations: [auth({ obtainedOn: "2026-02-28" })] }),
        "authorization_lead_time",
      );
      expect(late).toMatchObject({ outcome: "fail", overridable: true });
    });
  });

  it("declares COB as information only", () => {
    expect(byKey(ctx({ secondaryPayerKind: "medicare" }), "cob_secondary_declared")).toMatchObject({
      outcome: "info",
      severity: "info",
    });
  });

  it("blocks unless passed, informational or overridden; hashes evidence by value not key order", () => {
    expect(isBlocking({ outcome: "fail", severity: "error" }, false)).toBe(true);
    expect(isBlocking({ outcome: "fail", severity: "warn" }, false)).toBe(true);
    expect(isBlocking({ outcome: "fail", severity: "warn" }, true)).toBe(false);
    expect(isBlocking({ outcome: "pass", severity: "info" }, false)).toBe(false);
    expect(isBlocking({ outcome: "info", severity: "info" }, false)).toBe(false);
    expect(evidenceHash({ a: 1, b: { c: [1, 2], d: null } })).toBe(
      evidenceHash({ b: { d: null, c: [1, 2] }, a: 1 }),
    );
    expect(evidenceHash({ a: 1 })).not.toBe(evidenceHash({ a: 2 }));
  });

  it("requires every day of the window to be billed exactly once", () => {
    expect(byKey(ctx(), "service_days_covered")?.outcome).toBe("pass");
    const hole = ctx({
      lines: [
        line({ serviceTo: "2026-03-10" }),
        line({ lineNumber: 2, serviceFrom: "2026-03-20" }),
      ],
    });
    expect(byKey(hole, "service_days_covered")).toMatchObject({
      outcome: "fail",
      overridable: false,
    });
    expect(byKey(hole, "service_days_covered")?.message).toContain("2026-03-11 to 2026-03-19");
    const twice = ctx({
      lines: [
        line({ serviceTo: "2026-03-20" }),
        line({ lineNumber: 2, serviceFrom: "2026-03-15" }),
      ],
    });
    expect(byKey(twice, "service_days_covered")?.message).toContain(
      "Billed twice: 2026-03-15 to 2026-03-20",
    );
    const outside = ctx({ lines: [line({ serviceFrom: "2026-02-25" })] });
    expect(byKey(outside, "service_days_covered")?.message).toContain("Outside the window");
  });
});
