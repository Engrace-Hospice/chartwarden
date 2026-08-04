// apps/backend/__tests__/bereavement-authz.test.ts — M16-T06 (§4.7 permission keys · §4.8 ABAC
// predicates · §7.13 + D10 disclosure · §2.6 the effect runner · §8.5 the eraser).
//
// The properties this file exists to hold — each one is a way the surface could quietly become fail-OPEN,
// or a way a documented obligation could silently stop happening:
//
//   • every §4.7 key is single-owner in the platform mirror, and the two portal-self keys are the ONLY
//     ones a bereaved family member's own session may hold;
//   • `bereavement_window` admits the plan's counselor, its volunteer and org-scoped oversight — and
//     DENIES on `eligible` / `initiating` / every closed status, which is precisely why the three
//     pre-active routes bind oversight instead (the dead-gate bug this predicate would otherwise cause);
//   • `discipline_can_provide_bereavement` denies an unresolvable discipline, denies a VOLUNTEER whose
//     418.78 gates are unread (fail-CLOSED, never "no answer means compliant"), and resolves the ACTOR's
//     own discipline from the session roles without a DB round-trip;
//   • `portal_self_service` denies a staff session, denies a portal session with no account, and denies a
//     portal account that does not own the target contact;
//   • `ABAC_ANY` allows on the FIRST passing branch, re-raises the last denial when every branch denies,
//     and PROPAGATES a non-authorization error rather than laundering it into "try the other one";
//   • the §2.6 effect runner THROWS on a declared event with no payload (a silently-dropped lifecycle
//     event is the failure mode the declarative effect list exists to prevent), and an alert failure never
//     fails the mutation;
//   • the §7.13 gate REDACTS on an M39 outage and never discloses, and a bereavement volunteer never sees
//     clinical risk content (D10);
//   • the §8.5 eraser shreds BEFORE it deletes, and a second erase reports zero.
import { M16_CONTRIBUTED_PERMISSIONS, allPermissionMirrorRows } from "@wardenx/auth";
import type { AbacContext } from "@wardenx/auth";
import { ForbiddenError, NotFoundError } from "@wardenx/types";
import type { IsoInstant } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/events-by-m16";
import {
  type BereavementAbacResolver,
  M16_ABAC_PREDICATES,
  M16_PERMISSION_KEY_LIST,
  M16_PORTAL_SELF_PERMISSION_KEYS,
  buildBereavementAbacPredicates,
  createInMemoryBereavementEraseStore,
  decideBereavementWindow,
  denyStubBereavementAbacResolver,
  disciplineForRoleKeys,
  eraseBereavementRecord,
} from "../src/modules/16-bereavement/index";
import type { M16ReadActor } from "../src/modules/16-bereavement/routes/actor";
import type { PreHandler } from "../src/modules/16-bereavement/routes/actor";
import {
  M16_PAGE_SIZES,
  clampLimit,
  decodeCursor,
  encodeCursor,
  toCursorPage,
} from "../src/modules/16-bereavement/routes/concurrency";
import {
  type BereavementDisclosurePort,
  isBereavementVolunteer,
  resolveBereavementDisclosure,
} from "../src/modules/16-bereavement/routes/disclosure";
import {
  MissingOutboxPayloadError,
  runEffects,
} from "../src/modules/16-bereavement/routes/effects-runner";
import { ABAC_ANY } from "../src/modules/16-bereavement/routes/guards";

const ORG = "11111111-1111-4111-8111-111111111111";
const PLAN = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const COUNSELOR = "44444444-4444-4444-8444-444444444444";
const VOLUNTEER = "55555555-5555-4555-8555-555555555555";
const OUTSIDER = "66666666-6666-4666-8666-666666666666";
const PORTAL_ACCOUNT = "77777777-7777-4777-8777-777777777777";
const PATIENT = "88888888-8888-4888-8888-888888888888";

function ctx(overrides: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
    ...overrides,
  };
}

const planFacts = (status: string) => ({
  organizationId: ORG,
  planId: PLAN,
  status: status as never,
  assignedCounselorUserId: COUNSELOR as never,
  assignedVolunteerUserId: VOLUNTEER as never,
});

const resolverFor = (
  overrides: Partial<BereavementAbacResolver> = {},
): BereavementAbacResolver => ({
  async loadPlan() {
    return planFacts("active");
  },
  async loadPlanForContact() {
    return planFacts("active");
  },
  async loadPlanForOutreach() {
    return planFacts("active");
  },
  async loadContact() {
    return {
      organizationId: ORG,
      contactId: CONTACT,
      planId: PLAN,
      portalAccountId: PORTAL_ACCOUNT,
    };
  },
  async disciplineOf() {
    return "bereavement_counselor";
  },
  ...overrides,
});

// ── §4.7 permission keys ────────────────────────────────────────────────────────────────────────────

describe("M16-T06 §4.7 — the permission keys registered into M3", () => {
  it("registers exactly the §4.7 catalog, single-owner across the platform mirror", () => {
    expect(M16_PERMISSION_KEY_LIST).toHaveLength(29);
    const mirror = allPermissionMirrorRows().map((r) => r.key);
    for (const key of M16_PERMISSION_KEY_LIST) {
      expect(mirror.filter((k) => k === key)).toHaveLength(1);
    }
  });

  it("every key is namespaced `bereavement.` — nothing leaks into another module's namespace", () => {
    for (const key of M16_PERMISSION_KEY_LIST) expect(key.startsWith("bereavement.")).toBe(true);
  });

  it("the two portal-self keys are the ONLY §4.1 rows a bereaved family session may hold", () => {
    expect([...M16_PORTAL_SELF_PERMISSION_KEYS].sort()).toEqual([
      "bereavement.contact.opt_out",
      "bereavement.contact.rescind_opt_out",
    ]);
    for (const key of M16_PORTAL_SELF_PERMISSION_KEYS) {
      expect(M16_CONTRIBUTED_PERMISSIONS[key].abac).toBe("portal_self_service");
    }
  });
});

// ── §4.4 outbox catalog ─────────────────────────────────────────────────────────────────────────────

describe("M16-T06 §4.4 — the outbox catalog", () => {
  it("declares all 22 §4.4 events, every one owned by m16 and `mN.<resource>.<verb>` shaped", () => {
    expect(M16_OUTBOX_EVENTS).toHaveLength(22);
    for (const event of M16_OUTBOX_EVENTS) {
      expect(event.moduleOwner).toBe("m16");
      expect(event.eventName).toMatch(/^m16\.[a-z_]+\.[a-z0-9_]+$/);
      expect(event.declaredConsumers.length).toBeGreaterThan(0);
    }
  });

  it("never declares itself as its own consumer (a module does not subscribe to its own emit)", () => {
    for (const event of M16_OUTBOX_EVENTS) expect(event.declaredConsumers).not.toContain("m16");
  });
});

// ── §4.8 `bereavement_window` ───────────────────────────────────────────────────────────────────────

describe("M16-T06 §4.8 — bereavement_window", () => {
  const actor = { organizationId: ORG, membershipId: COUNSELOR, hasOversight: false };

  it("admits the plan's assigned counselor and its assigned volunteer while active or paused", () => {
    for (const status of ["active", "paused"]) {
      expect(decideBereavementWindow(planFacts(status), actor)).toBe(true);
      expect(
        decideBereavementWindow(planFacts(status), { ...actor, membershipId: VOLUNTEER }),
      ).toBe(true);
    }
  });

  it("admits org-scoped oversight without any assignment at all", () => {
    expect(
      decideBereavementWindow(planFacts("active"), {
        organizationId: ORG,
        membershipId: null,
        hasOversight: true,
      }),
    ).toBe(true);
  });

  it("denies a membership that holds neither assignment", () => {
    expect(decideBereavementWindow(planFacts("active"), { ...actor, membershipId: OUTSIDER })).toBe(
      false,
    );
  });

  it("DENIES on `eligible` and `initiating` — which is why routes 3/4/5 bind oversight instead", () => {
    // This is the assertion that documents the dead-gate bug: at assignment/activation time the plan is
    // pre-active by definition, so binding the window predicate on those routes would 403 forever.
    expect(decideBereavementWindow(planFacts("eligible"), actor)).toBe(false);
    expect(decideBereavementWindow(planFacts("initiating"), actor)).toBe(false);
  });

  it("denies on every closed status, including the M4 legal-hold extension", () => {
    for (const status of [
      "closed_completed",
      "closed_declined",
      "closed_early",
      "closed_legal_hold_extended",
    ]) {
      expect(decideBereavementWindow(planFacts(status), actor)).toBe(false);
    }
  });

  it("denies a cross-tenant plan even if the assignment matches (defense in depth behind RLS)", () => {
    expect(
      decideBereavementWindow({ ...planFacts("active"), organizationId: "other-org" }, actor),
    ).toBe(false);
  });

  it("denies when no subject is named and when the plan cannot be read (fail-CLOSED)", async () => {
    const predicates = buildBereavementAbacPredicates({
      resolver: denyStubBereavementAbacResolver,
    });
    expect(await predicates.bereavement_window!(ctx(), {})).toBe(false);
    expect(await predicates.bereavement_window!(ctx(), { planId: PLAN })).toBe(false);
  });

  it("resolves the plan through a :contactId and an :outreachId target too", async () => {
    const predicates = buildBereavementAbacPredicates({ resolver: resolverFor() });
    const actorCtx = ctx({ attributes: { membershipId: COUNSELOR } });
    expect(await predicates.bereavement_window!(actorCtx, { contactId: CONTACT })).toBe(true);
    expect(await predicates.bereavement_window!(actorCtx, { outreachId: "o-1" })).toBe(true);
  });
});

// ── §4.8 `discipline_can_provide_bereavement` ───────────────────────────────────────────────────────

describe("M16-T06 §4.8 — discipline_can_provide_bereavement", () => {
  it("derives the ACTOR's own discipline from the session roles, with no resolver round-trip", async () => {
    let resolverCalls = 0;
    const predicates = buildBereavementAbacPredicates({
      resolver: resolverFor({
        async disciplineOf() {
          resolverCalls += 1;
          return null;
        },
      }),
    });
    const allowed = await predicates.discipline_can_provide_bereavement!(
      ctx({ roles: ["chaplain"], attributes: { membershipId: COUNSELOR } }),
      {},
    );
    expect(allowed).toBe(true);
    expect(resolverCalls).toBe(0);
  });

  it("prefers the STRONGEST discipline when a membership holds several", () => {
    // An MSW who also volunteers must not be downgraded to the volunteer path and then denied for want
    // of a 418.78 TB screening they were never required to hold.
    expect(disciplineForRoleKeys(["volunteer", "msw"])).toBe("medical_social_worker");
    expect(disciplineForRoleKeys(["volunteer"])).toBe("bereavement_volunteer");
    expect(disciplineForRoleKeys(["billing_specialist"])).toBe(null);
  });

  it("denies when the discipline cannot be resolved — never 'no discipline means anyone'", async () => {
    const predicates = buildBereavementAbacPredicates({
      resolver: resolverFor({
        async disciplineOf() {
          return null;
        },
      }),
    });
    expect(
      await predicates.discipline_can_provide_bereavement!(ctx(), { counselorUserId: OUTSIDER }),
    ).toBe(false);
  });

  it("denies a discipline outside the §4.8 set", async () => {
    const predicates = buildBereavementAbacPredicates({
      resolver: resolverFor({
        async disciplineOf() {
          return "home_health_aide";
        },
      }),
    });
    expect(
      await predicates.discipline_can_provide_bereavement!(ctx(), { counselorUserId: OUTSIDER }),
    ).toBe(false);
  });

  it("denies a VOLUNTEER when the 418.78 gate probe is unbound (fail-CLOSED)", async () => {
    const predicates = buildBereavementAbacPredicates({
      resolver: resolverFor({
        async disciplineOf() {
          return "bereavement_volunteer";
        },
      }),
    });
    expect(
      await predicates.discipline_can_provide_bereavement!(ctx(), { volunteerUserId: VOLUNTEER }),
    ).toBe(false);
  });

  it("denies a VOLUNTEER when the 418.78 gate probe THROWS (an M15 outage never assumes compliance)", async () => {
    const predicates = buildBereavementAbacPredicates({
      resolver: resolverFor({
        async disciplineOf() {
          return "bereavement_volunteer";
        },
      }),
      volunteerGatesSatisfied: async () => {
        throw new Error("m15 unavailable");
      },
    });
    expect(
      await predicates.discipline_can_provide_bereavement!(ctx(), { volunteerUserId: VOLUNTEER }),
    ).toBe(false);
  });

  it("admits a VOLUNTEER whose gates are satisfied", async () => {
    const predicates = buildBereavementAbacPredicates({
      resolver: resolverFor({
        async disciplineOf() {
          return "bereavement_volunteer";
        },
      }),
      volunteerGatesSatisfied: async () => true,
    });
    expect(
      await predicates.discipline_can_provide_bereavement!(ctx(), { volunteerUserId: VOLUNTEER }),
    ).toBe(true);
  });
});

// ── §4.8 `org_scope_bereavement_oversight` + `portal_self_service` ──────────────────────────────────

describe("M16-T06 §4.8 — oversight and portal-self", () => {
  const predicates = buildBereavementAbacPredicates({ resolver: resolverFor() });

  it("registers exactly the four names M16 owns", () => {
    expect([...M16_ABAC_PREDICATES].sort()).toEqual([
      "bereavement_window",
      "discipline_can_provide_bereavement",
      "org_scope_bereavement_oversight",
      "portal_self_service",
    ]);
  });

  it("oversight admits a clinical supervisor and denies a caseload clinician", async () => {
    expect(
      await predicates.org_scope_bereavement_oversight!(
        ctx({ roles: ["clinical_supervisor"] }),
        {},
      ),
    ).toBe(true);
    expect(
      await predicates.org_scope_bereavement_oversight!(ctx({ roles: ["chaplain"] }), {}),
    ).toBe(false);
  });

  it("portal-self admits the bereaved person's own session", async () => {
    const portal = ctx({
      attributes: { sessionClass: "caregiver_portal", portalAccountId: PORTAL_ACCOUNT },
    });
    expect(await predicates.portal_self_service!(portal, { contactId: CONTACT })).toBe(true);
  });

  it("portal-self denies a STAFF session however privileged", async () => {
    const staff = ctx({
      roles: ["clinical_supervisor", "director_of_nursing"],
      attributes: { sessionClass: "staff", portalAccountId: PORTAL_ACCOUNT },
    });
    expect(await predicates.portal_self_service!(staff, { contactId: CONTACT })).toBe(false);
  });

  it("portal-self denies a portal session with no account, and one that owns a DIFFERENT contact", async () => {
    expect(
      await predicates.portal_self_service!(
        ctx({ attributes: { sessionClass: "caregiver_portal" } }),
        { contactId: CONTACT },
      ),
    ).toBe(false);
    expect(
      await predicates.portal_self_service!(
        ctx({ attributes: { sessionClass: "caregiver_portal", portalAccountId: "someone-else" } }),
        { contactId: CONTACT },
      ),
    ).toBe(false);
  });
});

// ── the §4.1 `∨` composition ────────────────────────────────────────────────────────────────────────

describe("M16-T06 §4.1 — ABAC_ANY (the `∨` rows)", () => {
  const req = {} as never;
  const rep = {} as never;
  const pass: PreHandler = async () => {};
  const denyForbidden: PreHandler = async () => {
    throw new ForbiddenError("nope");
  };
  const denyNotFound: PreHandler = async () => {
    throw new NotFoundError("resource");
  };

  it("allows on the first passing branch and never evaluates the rest", async () => {
    let second = 0;
    const guard = ABAC_ANY(pass, async () => {
      second += 1;
    });
    await expect(guard(req, rep)).resolves.toBeUndefined();
    expect(second).toBe(0);
  });

  it("falls through a denial to the next branch", async () => {
    await expect(ABAC_ANY(denyForbidden, pass)(req, rep)).resolves.toBeUndefined();
    await expect(ABAC_ANY(denyNotFound, pass)(req, rep)).resolves.toBeUndefined();
  });

  it("re-raises the LAST denial when every branch denies", async () => {
    await expect(ABAC_ANY(denyNotFound, denyForbidden)(req, rep)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("PROPAGATES a non-authorization error instead of trying the next branch", async () => {
    // A predicate that blew up must not be laundered into "well, try the other one" — that is how a
    // broken gate silently becomes an open one.
    let second = 0;
    const guard = ABAC_ANY(
      async () => {
        throw new TypeError("predicate bug");
      },
      async () => {
        second += 1;
      },
    );
    await expect(guard(req, rep)).rejects.toBeInstanceOf(TypeError);
    expect(second).toBe(0);
  });
});

// ── §2.6 the effect runner ──────────────────────────────────────────────────────────────────────────

describe("M16-T06 §2.6 — the effect runner", () => {
  const baseCtx = (payloads: Record<string, Record<string, unknown>> = {}) => ({
    organizationId: ORG,
    at: new Date("2026-07-31T00:00:00.000Z"),
    outbox: { async publish() {} },
    aggregateKind: "bereavement_plan",
    aggregateId: PLAN,
    payloads: payloads as never,
  });

  it("THROWS when a machine declares an event the service built no payload for", async () => {
    await expect(
      runEffects(null, [{ kind: "outbox", event: "m16.bereavement.plan_paused" }], baseCtx()),
    ).rejects.toBeInstanceOf(MissingOutboxPayloadError);
  });

  it("publishes the declared event with the aggregate identity on the caller's tx", async () => {
    const published: unknown[] = [];
    await runEffects("tx-handle", [{ kind: "outbox", event: "m16.bereavement.plan_resumed" }], {
      ...baseCtx({ "m16.bereavement.plan_resumed": { planId: PLAN } }),
      outbox: {
        async publish(tx, emission) {
          published.push({ tx, emission });
        },
      },
    });
    expect(published).toEqual([
      {
        tx: "tx-handle",
        emission: {
          eventName: "m16.bereavement.plan_resumed",
          payload: { planId: PLAN },
          aggregateKind: "bereavement_plan",
          aggregateId: PLAN,
        },
      },
    ]);
  });

  it("accumulates set_timestamp / set_assignment into one patch", async () => {
    const patch = await runEffects(
      null,
      [
        { kind: "set_timestamp", field: "opened_at", at: "2026-01-02T03:04:05.000Z" as IsoInstant },
        {
          kind: "set_assignment",
          role: "counselor",
          membershipId: COUNSELOR,
          at: "2026-01-02T03:04:05.000Z" as IsoInstant,
        },
      ],
      baseCtx(),
    );
    expect(patch.openedAt?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(patch.assignedCounselorUserId).toBe(COUNSELOR);
  });

  it("never fails the mutation when the M36 alert port throws (delivery is M36's problem)", async () => {
    await expect(
      runEffects(null, [{ kind: "alert", alert: "outreach_missed" }], {
        ...baseCtx(),
        alerts: {
          async emit() {
            throw new Error("m36 down");
          },
        },
        alertPayloads: { outreach_missed: { planId: PLAN } },
      }),
    ).resolves.toBeDefined();
  });

  it("is a no-op on `audit` — the M4 trigger owns that row, and two accounts would diverge", async () => {
    await expect(runEffects(null, [{ kind: "audit" }], baseCtx())).resolves.toEqual({});
  });
});

// ── §7.13 / D10 disclosure ──────────────────────────────────────────────────────────────────────────

describe("M16-T06 §7.13 / D10 — the disclosure gate", () => {
  const actor = (overrides: Partial<M16ReadActor> = {}): M16ReadActor => ({
    organizationId: ORG,
    userId: "user-1",
    membershipId: COUNSELOR,
    roles: ["bereavement_counselor"],
    sessionClass: "staff",
    locationIds: [],
    portalAccountId: null,
    ...overrides,
  });

  const port = (allowed: boolean): BereavementDisclosurePort => ({
    async part2ReleaseActive() {
      return allowed;
    },
  });

  it("discloses SUD content when M39 says the Part 2 release is satisfied", async () => {
    const verdict = await resolveBereavementDisclosure(actor(), PATIENT, port(true));
    expect(verdict.sudAllowed).toBe(true);
    expect(verdict.redactedCategories).toEqual([]);
  });

  it("REDACTS when M39 denies, and names the category in the envelope", async () => {
    const verdict = await resolveBereavementDisclosure(actor(), PATIENT, port(false));
    expect(verdict.sudAllowed).toBe(false);
    expect(verdict.redactedCategories).toContain("sud");
  });

  it("REDACTS when the M39 port THROWS — an outage narrows what is seen, never widens it", async () => {
    const verdict = await resolveBereavementDisclosure(actor(), PATIENT, {
      async part2ReleaseActive() {
        throw new Error("m39 down");
      },
    });
    expect(verdict.sudAllowed).toBe(false);
  });

  it("gives the RN Case Manager the Part 2 fast path with no consent round-trip", async () => {
    let calls = 0;
    const verdict = await resolveBereavementDisclosure(
      actor({ roles: ["rn_case_manager"] }),
      PATIENT,
      {
        async part2ReleaseActive() {
          calls += 1;
          return false;
        },
      },
    );
    expect(verdict.sudAllowed).toBe(true);
    expect(calls).toBe(0);
  });

  it("D10 — a bereavement VOLUNTEER never receives clinical risk content", async () => {
    const volunteerActor = actor({ roles: ["bereavement_volunteer"] });
    expect(isBereavementVolunteer(volunteerActor)).toBe(true);
    const verdict = await resolveBereavementDisclosure(volunteerActor, PATIENT, port(true));
    expect(verdict.clinicalRiskAllowed).toBe(false);
    expect(verdict.redactedCategories).toContain("clinical_risk");
  });

  it("a portal session receives neither category, whatever its roles", async () => {
    const verdict = await resolveBereavementDisclosure(
      actor({ sessionClass: "caregiver_portal", roles: ["rn_case_manager"] }),
      PATIENT,
      port(true),
    );
    expect(verdict.sudAllowed).toBe(false);
    expect(verdict.clinicalRiskAllowed).toBe(false);
  });
});

// ── pagination envelope ─────────────────────────────────────────────────────────────────────────────

describe("M16-T06 — the cursor envelope", () => {
  it("round-trips an opaque cursor and treats a malformed one as 'from the beginning'", () => {
    const cursor = encodeCursor({ a: "2026-01-01T00:00:00.000Z", id: PLAN });
    expect(decodeCursor(cursor)).toEqual({ a: "2026-01-01T00:00:00.000Z", id: PLAN });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("emits `{data, next_cursor, has_more}` and clamps `limit` into the route's policy", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `id-${n}`, at: `2026-01-0${n}T00:00:00.000Z` }));
    const page = toCursorPage(
      rows,
      2,
      (r) => ({ a: r.at, id: r.id }),
      (r) => r.id,
    );
    expect(page.data).toEqual(["id-1", "id-2"]);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBeNull();

    expect(clampLimit("9999", M16_PAGE_SIZES.plans)).toBe(M16_PAGE_SIZES.plans.maxSize);
    expect(clampLimit("0", M16_PAGE_SIZES.plans)).toBe(1);
    expect(clampLimit(undefined, M16_PAGE_SIZES.outreach)).toBe(
      M16_PAGE_SIZES.outreach.defaultSize,
    );
  });
});

// ── §8.5 the eraser ─────────────────────────────────────────────────────────────────────────────────

describe("M16-T06 §8.5 — the bereavement_record eraser", () => {
  it("locks, SHREDS before it deletes, and reports the subtree tally", async () => {
    const { store, locked } = createInMemoryBereavementEraseStore({
      shredded: 7,
      counts: {
        contactLogs: 4,
        riskScores: 3,
        optOuts: 1,
        outreach: 9,
        anniversaryReminders: 2,
        contacts: 2,
        plansTombstoned: 1,
        closuresShredded: 1,
      },
    });
    const result = await eraseBereavementRecord(ORG, PATIENT, store);
    expect(locked).toEqual([PATIENT]);
    expect(result.shredded).toBe(7);
    // The tombstoned plan root and the surviving closure row are bookkeeping, NOT deletions.
    expect(result.erased).toBe(4 + 3 + 1 + 9 + 2 + 2);
    expect(result.counts.plansTombstoned).toBe(1);
    expect(result.counts.closuresShredded).toBe(1);
  });

  it("is idempotent — a second destruction certificate finds nothing and reports zero", async () => {
    const { store } = createInMemoryBereavementEraseStore({
      shredded: 3,
      counts: { contacts: 2 },
    });
    await eraseBereavementRecord(ORG, PATIENT, store);
    const second = await eraseBereavementRecord(ORG, PATIENT, store);
    expect(second.erased).toBe(0);
    expect(second.shredded).toBe(0);
  });
});
