// M19 EscalationRouter (ADR-0057 item 12), tier 1 only: contract parity with the packages/messaging in-memory fake plus the M19 rules
// (discipline map, patient scoping, dropped users, allowlist binding). In-memory store; the live suite proves the real SQL and RLS.
import type {
  EscalationRouteRequest,
  EscalationRouter,
  OnCallShiftDto,
  OncallModel,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { escalationRouterDenyStub } from "../src/bootstrap/seams/providers";
import {
  ESCALATION_DISCIPLINE_BY_ROLE,
  type EscalationRouterReads,
  createEscalationRouter,
} from "../src/modules/19-oncall/seams/escalation-router";
import {
  createAllowlistedEscalationRouter,
  parseEscalationRouterOrgs,
  registerEscalationRouterForAllowlist,
} from "../src/modules/19-oncall/seams/escalation-router-binding";
import { createInMemoryOncallSeamStore } from "../src/modules/19-oncall/seams/store";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PE_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT_NO_PE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOREIGN_PATIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ZONE = "America/New_York";

function shift(over: Partial<OnCallShiftDto> & { id: string }): OnCallShiftDto {
  return {
    shiftId: over.id,
    providerEntityId: PE,
    discipline: "clinical_rn",
    status: "active",
    shiftStartsAt: "2026-06-01T07:00:00.000Z",
    shiftEndsAt: "2026-06-01T19:00:00.000Z",
    primaryOnCallMembershipId: "m-primary",
    backupMembershipId: null,
    externalActorId: null,
    externalActorLabel: null,
    openedAt: null,
    closedAt: null,
    ...over,
  } as OnCallShiftDto;
}

interface Setup {
  shifts?: OnCallShiftDto[];
  users?: Record<string, string>;
  model?: OncallModel | null;
  zones?: string[];
  orgPes?: string[];
  ambient?: string;
  inactive?: string[];
}

function build(setup: Setup = {}, orgOverride?: string) {
  const { store } = createInMemoryOncallSeamStore({
    shifts: setup.shifts ?? [shift({ id: "s1", backupMembershipId: "m-backup" })],
    membershipUserIds: setup.users ?? { "m-primary": "user-primary", "m-backup": "user-backup" },
    inactiveMembershipIds: setup.inactive,
  });
  const calls: string[] = [];
  const reads: EscalationRouterReads = {
    async patientProviderEntity(orgId, patientId) {
      calls.push(`patient:${patientId}`);
      if (orgId !== ORG) return null;
      if (patientId === PATIENT) return { providerEntityId: PE };
      if (patientId === PATIENT_NO_PE) return { providerEntityId: null };
      return null;
    },
    async providerEntityIdsOfOrg() {
      return setup.orgPes ?? [PE];
    },
    async policyModel() {
      return setup.model === undefined ? "direct" : setup.model;
    },
    async timeZones() {
      return setup.zones ?? [ZONE];
    },
  };
  const router = createEscalationRouter(
    store,
    reads,
    () => (orgOverride ?? setup.ambient ?? ORG) as never,
  );
  return { router, calls };
}

const req = (over: Partial<EscalationRouteRequest> = {}): EscalationRouteRequest => ({
  patientId: PATIENT,
  requiredRole: "rn",
  tier: 1,
  asOf: "2026-06-01T12:00:00Z",
  ...over,
});

describe("M19 EscalationRouter tier 1", () => {
  it("resolves primary then backup user ids, stamped source m19, with the location zone", async () => {
    const { router } = build();
    const answer = await router.resolveTier(ORG, req());
    expect(answer).toMatchObject({
      kind: "resolved",
      userIds: ["user-primary", "user-backup"],
      nextTier: null,
      timeZone: ZONE,
      source: "m19",
      tier: 1,
      asOf: "2026-06-01T12:00:00Z",
    });
  });

  it("gives the same answer for the same instant and for Z vs +hh:mm spellings of it", async () => {
    const { router } = build();
    const a = await router.resolveTier(ORG, req({ asOf: "2026-06-01T12:00:00Z" }));
    const b = await router.resolveTier(ORG, req({ asOf: "2026-06-01T12:00:00Z" }));
    const c = await router.resolveTier(ORG, req({ asOf: "2026-06-01T08:00:00-04:00" }));
    expect(b).toEqual(a);
    expect(c).toMatchObject({ kind: "resolved", userIds: ["user-primary", "user-backup"] });
  });

  it("refuses an offset-less or loose asOf and an out-of-range tier by throwing", async () => {
    const { router } = build();
    await expect(router.resolveTier(ORG, req({ asOf: "2026-06-01T12:00:00" }))).rejects.toThrow();
    await expect(router.resolveTier(ORG, req({ asOf: "June 1 2026" }))).rejects.toThrow();
    await expect(router.resolveTier(ORG, req({ tier: 0 }))).rejects.toThrow();
    await expect(router.resolveTier(ORG, req({ tier: 100 }))).rejects.toThrow();
    await expect(router.resolveTier(ORG, req({ patientId: "" }))).rejects.toThrow();
  });

  it("treats shift start as inclusive and end as exclusive, with back-to-back shifts gapless", async () => {
    const shifts = [
      shift({
        id: "day",
        shiftEndsAt: "2026-06-01T19:00:00.000Z",
        primaryOnCallMembershipId: "m-primary",
      }),
      shift({
        id: "night",
        shiftStartsAt: "2026-06-01T19:00:00.000Z",
        shiftEndsAt: "2026-06-02T07:00:00.000Z",
        primaryOnCallMembershipId: "m-night",
        status: "scheduled",
      }),
    ];
    const { router } = build({ shifts, users: { "m-primary": "u-day", "m-night": "u-night" } });
    const at = (asOf: string) => router.resolveTier(ORG, req({ asOf }));
    expect(await at("2026-06-01T07:00:00Z")).toMatchObject({ userIds: ["u-day"] });
    expect(await at("2026-06-01T06:59:59Z")).toMatchObject({ kind: "coverage_gap" });
    expect(await at("2026-06-01T18:59:59Z")).toMatchObject({ userIds: ["u-day"] });
    expect(await at("2026-06-01T19:00:00Z")).toMatchObject({ userIds: ["u-night"] });
    expect(await at("2026-06-02T07:00:00Z")).toMatchObject({ kind: "coverage_gap" });
  });

  it("ignores completed and cancelled shifts, other disciplines and vendor shifts", async () => {
    const shifts = [
      shift({ id: "a", status: "completed" }),
      shift({ id: "b", status: "cancelled" }),
      shift({ id: "c", discipline: "msw" }),
      shift({ id: "d", externalActorId: "vendor-1" as never, primaryOnCallMembershipId: null }),
    ];
    const { router } = build({ shifts });
    expect(await router.resolveTier(ORG, req())).toMatchObject({
      kind: "coverage_gap",
      timeZone: ZONE,
    });
  });

  it("drops memberships whose user does not resolve and reports coverage_gap when all are dropped", async () => {
    const some = build({ users: { "m-backup": "user-backup" } });
    expect(await some.router.resolveTier(ORG, req())).toMatchObject({
      kind: "resolved",
      userIds: ["user-backup"],
    });
    const none = build({ users: {} });
    expect(await none.router.resolveTier(ORG, req())).toMatchObject({ kind: "coverage_gap" });
  });

  it("drops suspended or revoked memberships: a departed user's future shift yields no recipient", async () => {
    const some = build({ inactive: ["m-primary"] });
    expect(await some.router.resolveTier(ORG, req())).toMatchObject({
      kind: "resolved",
      userIds: ["user-backup"],
    });
    const none = build({ inactive: ["m-primary", "m-backup"] });
    expect(await none.router.resolveTier(ORG, req())).toMatchObject({ kind: "coverage_gap" });
  });

  it("answers tier 2 and above with tier_not_configured, whatever the patient", async () => {
    const { router, calls } = build();
    for (const patientId of [PATIENT, FOREIGN_PATIENT]) {
      expect(await router.resolveTier(ORG, req({ tier: 2, patientId }))).toMatchObject({
        kind: "unavailable",
        reason: "tier_not_configured",
        source: "m19",
      });
    }
    expect(calls).toEqual([]);
  });

  it("answers an unmapped role, and a prototype-key role, with no_route_configured", async () => {
    const { router } = build();
    for (const requiredRole of ["physician", "constructor", "__proto__", ""]) {
      if (requiredRole === "") continue;
      expect(await router.resolveTier(ORG, req({ requiredRole }))).toMatchObject({
        kind: "unavailable",
        reason: "no_route_configured",
      });
    }
    expect(ESCALATION_DISCIPLINE_BY_ROLE).toEqual({ rn: "clinical_rn" });
  });

  it("answers a patient from another org, an unknown patient and a non-uuid identically", async () => {
    const { router } = build();
    for (const patientId of [FOREIGN_PATIENT, "not-a-uuid"]) {
      expect(await router.resolveTier(ORG, req({ patientId }))).toMatchObject({
        kind: "unavailable",
        reason: "no_route_configured",
      });
    }
  });

  it("uses the org's only provider entity for a patient with none, and fails closed with several", async () => {
    const one = build({ orgPes: [PE] });
    expect(await one.router.resolveTier(ORG, req({ patientId: PATIENT_NO_PE }))).toMatchObject({
      kind: "resolved",
    });
    const many = build({ orgPes: [PE, PE_2] });
    expect(await many.router.resolveTier(ORG, req({ patientId: PATIENT_NO_PE }))).toMatchObject({
      kind: "unavailable",
      reason: "no_route_configured",
    });
  });

  it("is no_route_configured, not a gap, without a direct/hybrid policy or without one known zone", async () => {
    for (const setup of [
      { model: null },
      { model: "centralized" as const },
      { zones: [] },
      { zones: [ZONE, "America/Chicago"] },
      { zones: ["Not/AZone"] },
    ]) {
      expect(await build(setup).router.resolveTier(ORG, req())).toMatchObject({
        kind: "unavailable",
        reason: "no_route_configured",
      });
    }
    expect(await build({ model: "hybrid" }).router.resolveTier(ORG, req())).toMatchObject({
      kind: "resolved",
    });
  });

  it("throws when the caller's org differs from the ambient scope or no scope exists", async () => {
    await expect(build({}, OTHER_ORG).router.resolveTier(ORG, req())).rejects.toMatchObject({
      code: "TRIAGE_SEAM_ORG_MISMATCH",
    });
    await expect(build({}, "").router.resolveTier(ORG, req())).rejects.toMatchObject({
      code: "TRIAGE_SEAM_ORG_MISMATCH",
    });
  });

  it("propagates a store failure and a reader failure instead of mapping them", async () => {
    const { store } = createInMemoryOncallSeamStore({});
    const broken = {
      ...store,
      shiftsCoveringForProviderEntity: async () => {
        throw new Error("db down");
      },
    };
    const reads: EscalationRouterReads = {
      patientProviderEntity: async () => ({ providerEntityId: PE }),
      providerEntityIdsOfOrg: async () => [PE],
      policyModel: async () => "direct",
      timeZones: async () => [ZONE],
    };
    const router = createEscalationRouter(broken, reads, () => ORG as never);
    await expect(router.resolveTier(ORG, req())).rejects.toThrow("db down");
    const failingReads = createEscalationRouter(
      store,
      {
        ...reads,
        policyModel: async () => {
          throw new Error("rls");
        },
      },
      () => ORG as never,
    );
    await expect(failingReads.resolveTier(ORG, req())).rejects.toThrow("rls");
  });
});

describe("allowlist binding", () => {
  const denyStub: EscalationRouter = escalationRouterDenyStub;

  it("parses strictly: lower-cases uuids, ignores and counts garbage, empty is empty", () => {
    expect(parseEscalationRouterOrgs(undefined)).toEqual({ orgIds: new Set(), ignoredCount: 0 });
    expect(parseEscalationRouterOrgs("  ")).toEqual({ orgIds: new Set(), ignoredCount: 0 });
    const parsed = parseEscalationRouterOrgs(`${ORG.toUpperCase()}, nope ,*, ${OTHER_ORG},`);
    expect([...parsed.orgIds]).toEqual([ORG, OTHER_ORG]);
    expect(parsed.ignoredCount).toBe(2);
  });

  it("serves allowlisted orgs from the real router and everyone else with the exact deny-stub answer", async () => {
    const { router } = build();
    const bound = createAllowlistedEscalationRouter(router, denyStub, new Set([ORG]));
    expect(await bound.resolveTier(ORG, req())).toMatchObject({ kind: "resolved", source: "m19" });
    const other = await bound.resolveTier(OTHER_ORG, req());
    expect(other).toEqual(await denyStub.resolveTier(OTHER_ORG, req()));
    const empty = createAllowlistedEscalationRouter(router, denyStub, new Set());
    expect(await empty.resolveTier(ORG, req())).toEqual(await denyStub.resolveTier(ORG, req()));
  });

  it("registers nothing and warns only by count when the allowlist is empty or garbage", () => {
    const warnings: string[] = [];
    const { store } = createInMemoryOncallSeamStore({});
    const deps = (allowlistRaw: string | undefined) => ({
      store,
      reads: {} as EscalationRouterReads,
      fallback: denyStub,
      allowlistRaw,
      warn: (m: string) => warnings.push(m),
    });
    expect(registerEscalationRouterForAllowlist(deps(undefined)).size).toBe(0);
    expect(registerEscalationRouterForAllowlist(deps("  ")).size).toBe(0);
    expect(registerEscalationRouterForAllowlist(deps("secret-looking-garbage")).size).toBe(0);
    expect(warnings).toEqual(["ESCALATION_ROUTER_ORGS: 1 entry is not a uuid and ignored"]);
  });
});
