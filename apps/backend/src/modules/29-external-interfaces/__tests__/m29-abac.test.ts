// apps/backend/src/modules/29-external-interfaces/__tests__/m29-abac.test.ts — M29-T08 §4.8 predicate tests.
import type { AbacContext, AbacTarget } from "@wardenx/auth";
import { PLATFORM_OPS_ROLE_KEYS, createPredicateRegistry } from "@wardenx/auth";
import { describe, expect, it } from "vitest";

import {
  HL7_OWNER_MODULE_WRITE_PERMISSION,
  type M29AbacResolver,
  M29_ABAC_PREDICATES,
  buildM29AbacPredicates,
  denyStubM29AbacResolver,
} from "../abac-predicates";

const ORG = "org-1";
const ctx = (over: Partial<AbacContext> = {}): AbacContext =>
  ({
    organizationId: ORG,
    userId: "u1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: { membershipId: "m1" },
    ...over,
  }) as AbacContext;

const resolver = (over: Partial<M29AbacResolver>): M29AbacResolver => ({
  ...denyStubM29AbacResolver,
  ...over,
});

const build = (over: Partial<M29AbacResolver>) =>
  buildM29AbacPredicates({ resolver: resolver(over) });

describe("external_feed_organization_scope", () => {
  it("allows a feed in the actor's org and denies a cross-tenant one", async () => {
    const inOrg = build({
      async feedOrgId() {
        return ORG;
      },
    }).external_feed_organization_scope;
    expect(await inOrg(ctx(), { feedId: "f1" } as AbacTarget)).toBe(true);

    const cross = build({
      async feedOrgId() {
        return "other";
      },
    }).external_feed_organization_scope;
    expect(await cross(ctx(), { feedId: "f1" } as AbacTarget)).toBe(false);
  });

  it("fails closed when the feed is unreadable", async () => {
    const p = build({}).external_feed_organization_scope;
    expect(await p(ctx(), { feedId: "f1" } as AbacTarget)).toBe(false);
  });
});

describe("hl7_inbound_proposal_owner_module_match", () => {
  it("allows only a reviewer holding the owner module's native write permission", async () => {
    const ok = build({
      async proposalFacts() {
        return { organizationId: ORG, ownerModule: "m5" };
      },
      async holdsPermission(_o, _m, key) {
        return key === HL7_OWNER_MODULE_WRITE_PERMISSION.m5;
      },
    }).hl7_inbound_proposal_owner_module_match;
    expect(await ok(ctx(), { proposalId: "p1" } as AbacTarget)).toBe(true);

    const denied = build({
      async proposalFacts() {
        return { organizationId: ORG, ownerModule: "m6" };
      },
      async holdsPermission(_o, _m, key) {
        return key === HL7_OWNER_MODULE_WRITE_PERMISSION.m5; // holds m5, not m6
      },
    }).hl7_inbound_proposal_owner_module_match;
    expect(await denied(ctx(), { proposalId: "p1" } as AbacTarget)).toBe(false);
  });

  it("denies a cross-tenant proposal", async () => {
    const p = build({
      async proposalFacts() {
        return { organizationId: "other", ownerModule: "m5" };
      },
      async holdsPermission() {
        return true;
      },
    }).hl7_inbound_proposal_owner_module_match;
    expect(await p(ctx(), { proposalId: "p1" } as AbacTarget)).toBe(false);
  });
});

describe("lab_observation_patient_caseload_or_scope", () => {
  it("allows a wide-scope role via the review-unmatched key", async () => {
    const p = build({
      async observationFacts() {
        return { organizationId: ORG, patientId: "pat-1" };
      },
      async holdsPermission(_o, _m, key) {
        return key === "external_interfaces.lab.review_unmatched";
      },
    }).lab_observation_patient_caseload_or_scope;
    expect(await p(ctx(), { observationId: "o1" } as AbacTarget)).toBe(true);
  });

  it("allows a caseload clinician who is not wide-scope", async () => {
    const p = build({
      async observationFacts() {
        return { organizationId: ORG, patientId: "pat-1" };
      },
      async holdsPermission() {
        return false;
      },
      async isInCaseload(_o, _u, patientId) {
        return patientId === "pat-1";
      },
    }).lab_observation_patient_caseload_or_scope;
    expect(await p(ctx(), { observationId: "o1" } as AbacTarget)).toBe(true);
  });

  it("denies a non-caseload, non-wide-scope actor", async () => {
    const p = build({
      async observationFacts() {
        return { organizationId: ORG, patientId: "pat-1" };
      },
      async holdsPermission() {
        return false;
      },
      async isInCaseload() {
        return false;
      },
    }).lab_observation_patient_caseload_or_scope;
    expect(await p(ctx(), { observationId: "o1" } as AbacTarget)).toBe(false);
  });

  it("denies an unmatched observation to a non-wide-scope actor", async () => {
    const p = build({
      async observationFacts() {
        return { organizationId: ORG, patientId: null };
      },
      async holdsPermission() {
        return false;
      },
    }).lab_observation_patient_caseload_or_scope;
    expect(await p(ctx(), { observationId: "o1" } as AbacTarget)).toBe(false);
  });
});

describe("external_feed_compliance_co_approver_distinct", () => {
  it("reads the first approver from the STORED feed and denies self-approval", async () => {
    const p = build({
      async feedRevokeRequester() {
        return { requestedBy: "m2" };
      },
    }).external_feed_compliance_co_approver_distinct;
    expect(await p(ctx(), { feedId: "f1" } as AbacTarget)).toBe(true);

    const self = build({
      async feedRevokeRequester() {
        return { requestedBy: "m1" };
      },
    }).external_feed_compliance_co_approver_distinct;
    expect(await self(ctx(), { feedId: "f1" } as AbacTarget)).toBe(false);
  });

  it("ignores a body-supplied primaryApproverId (GAP-153)", async () => {
    const p = build({
      async feedRevokeRequester() {
        return { requestedBy: "m1" };
      },
    }).external_feed_compliance_co_approver_distinct;
    expect(await p(ctx(), { feedId: "f1", primaryApproverId: "someone-else" } as AbacTarget)).toBe(
      false,
    );
  });

  it("treats a feed with no pending revoke as the first approval", async () => {
    const p = build({
      async feedRevokeRequester() {
        return { requestedBy: null };
      },
    }).external_feed_compliance_co_approver_distinct;
    expect(await p(ctx(), { feedId: "f1" } as AbacTarget)).toBe(true);
  });

  it("fails closed when the feed is unreadable or no feed id is given", async () => {
    const p = build({}).external_feed_compliance_co_approver_distinct;
    expect(await p(ctx(), { feedId: "f1" } as AbacTarget)).toBe(false);
    expect(await p(ctx(), {} as AbacTarget)).toBe(false);
  });
});

describe("nppes_platform_job_caller", () => {
  // This used to assert the allow arm by putting `isPlatformOperator: true` on the context ITSELF — a
  // fact no producer in the repo ever wrote, so the test proved the predicate reads the attribute and
  // nothing about whether any real caller can satisfy it. Every arm below is now driven by a role the
  // platform catalog actually issues (F-030).
  it("denies a tenant session that carries no platform role", async () => {
    const p = build({}).nppes_platform_job_caller;
    expect(await p(ctx(), {} as AbacTarget)).toBe(false);
    expect(await p(ctx({ roles: ["org_admin", "compliance_officer"] }), {} as AbacTarget)).toBe(
      false,
    );
  });

  it("admits every role in the platform-ops catalog", async () => {
    const p = build({}).nppes_platform_job_caller;
    expect(PLATFORM_OPS_ROLE_KEYS.length).toBeGreaterThan(0);
    for (const role of PLATFORM_OPS_ROLE_KEYS) {
      expect(await p(ctx({ roles: [role] }), {} as AbacTarget)).toBe(true);
    }
  });

  it("admits EXACTLY the platform catalog — the admit-set is derived, not a second copy of the list", async () => {
    // M35's `platform_billing_scope` gates its cross-tenant admin surface off the same
    // `PLATFORM_OPS_ROLE_KEYS`. Asserting membership in both directions here (and there) is what keeps the
    // two platform-only gates from drifting on who counts as an operator, without either module importing
    // the other. A role the catalog drops must stop admitting; one it adds must start.
    const p = build({}).nppes_platform_job_caller;
    const admitted: string[] = [];
    for (const role of [...PLATFORM_OPS_ROLE_KEYS, "org_admin", "medical_director", "rn"]) {
      if (await p(ctx({ roles: [role] }), {} as AbacTarget)) admitted.push(role);
    }
    expect(admitted.sort()).toEqual([...PLATFORM_OPS_ROLE_KEYS].sort());
  });
});

describe("external_feed_baa_satisfied", () => {
  it("mirrors the resolver's BAA verdict and fails closed when unreadable", async () => {
    const ok = build({
      async feedBaaSatisfied() {
        return true;
      },
    }).external_feed_baa_satisfied;
    expect(await ok(ctx(), { feedId: "f1" } as AbacTarget)).toBe(true);

    const no = build({
      async feedBaaSatisfied() {
        return false;
      },
    }).external_feed_baa_satisfied;
    expect(await no(ctx(), { feedId: "f1" } as AbacTarget)).toBe(false);

    const unreadable = build({}).external_feed_baa_satisfied;
    expect(await unreadable(ctx(), { feedId: "f1" } as AbacTarget)).toBe(false);
  });
});

// ── W-XI-15 — Boot Validator Refuses Missing Predicate ──────────────────────────────────────────────
//
// The acceptance gate against predicate-name drift: every §4.8 name M29 DECLARES must have a built
// resolver AND land in M3's registry at boot, and a name that never registered must FAIL CLOSED (deny),
// never fall open. `arch:abac-predicates` is the CI arm of this; these are the unit arm.
describe("W-XI-15 — predicate registration completeness (§4.8 / §8)", () => {
  it("every declared §4.8 name has exactly one built resolver — no drift either direction", () => {
    const built = Object.keys(buildM29AbacPredicates({ resolver: denyStubM29AbacResolver }));
    expect(built.sort()).toEqual([...M29_ABAC_PREDICATES].sort());
  });

  it("registers all six declared predicates into an M3-shaped registry", () => {
    const registry = createPredicateRegistry();
    const predicates = buildM29AbacPredicates({ resolver: denyStubM29AbacResolver });
    for (const name of M29_ABAC_PREDICATES) registry.register(name, predicates[name]);

    for (const name of M29_ABAC_PREDICATES) expect(registry.has(name)).toBe(true);
    // Single-owner: re-registering the same name is refused (mirrors the shared registry's guard).
    expect(() =>
      registry.register(M29_ABAC_PREDICATES[0], predicates[M29_ABAC_PREDICATES[0]]),
    ).toThrow(/already registered/);
  });

  it("a missing predicate fails CLOSED — evaluate() denies an unregistered name, never falls open", () => {
    const registry = createPredicateRegistry();
    const predicates = buildM29AbacPredicates({ resolver: denyStubM29AbacResolver });
    // Simulate the W-XI-15 regression: the dual-approval predicate is dropped from the registry.
    const dropped = "external_feed_compliance_co_approver_distinct" as const;
    for (const name of M29_ABAC_PREDICATES) {
      if (name === dropped) continue;
      registry.register(name, predicates[name]);
    }

    expect(registry.has(dropped)).toBe(false);
    // The evaluator returns false (deny) for the unregistered name — the guarantee W-XI-15 protects.
    const verdict = registry.evaluate(dropped, ctx() as AbacContext, {} as AbacTarget);
    expect(verdict).toBe(false);
  });
});
