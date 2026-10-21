// GAP-162 - the M33 platform / compliance admin scope predicates: allow and deny arms.
import { type AbacContext, type AbacTarget, PLATFORM_OPS_ROLE_KEYS } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  M33_ABAC_PREDICATES,
  buildM33AbacPredicates,
  denyStubReportingAbacResolver,
} from "../abac-predicates";

const ctx = (over: Partial<AbacContext> = {}): AbacContext =>
  ({
    userId: "u1",
    organizationId: "11111111-1111-4111-8111-111111111111",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
    ...over,
  }) as AbacContext;

const predicates = buildM33AbacPredicates({ resolver: denyStubReportingAbacResolver });
const none = {} as AbacTarget;

describe("platform_admin_scope", () => {
  it("is registered", () => {
    expect(M33_ABAC_PREDICATES).toContain("platform_admin_scope");
    expect(predicates.platform_admin_scope).toBeTypeOf("function");
  });
  it("admits every platform-ops role", async () => {
    for (const role of PLATFORM_OPS_ROLE_KEYS) {
      expect(await predicates.platform_admin_scope?.(ctx({ roles: [role] }), none)).toBe(true);
    }
  });
  it("denies a tenant role even one holding report.admin permissions (report_admin, org_admin)", async () => {
    for (const role of ["report_admin", "org_admin", "compliance_officer", "rn"]) {
      expect(await predicates.platform_admin_scope?.(ctx({ roles: [role] }), none)).toBe(false);
    }
    expect(await predicates.platform_admin_scope?.(ctx(), none)).toBe(false);
  });
});

describe("compliance_officer_scope", () => {
  it("is registered", () => {
    expect(M33_ABAC_PREDICATES).toContain("compliance_officer_scope");
  });
  it("admits compliance / privacy / security officers in an org", async () => {
    for (const role of ["compliance_officer", "hipaa_privacy_officer", "hipaa_security_officer"]) {
      expect(await predicates.compliance_officer_scope?.(ctx({ roles: [role] }), none)).toBe(true);
    }
  });
  it("denies other tenant roles, platform ops, and an actor with no org context", async () => {
    for (const role of ["org_admin", "report_admin", "rn", ...PLATFORM_OPS_ROLE_KEYS]) {
      expect(await predicates.compliance_officer_scope?.(ctx({ roles: [role] }), none)).toBe(false);
    }
    expect(
      await predicates.compliance_officer_scope?.(
        ctx({ roles: ["compliance_officer"], organizationId: "" }),
        none,
      ),
    ).toBe(false);
  });
});
