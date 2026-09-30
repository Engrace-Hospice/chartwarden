// apps/backend/__tests__/patient-routes.test.ts — M5-T09 route-inventory integration tests
// (§4.2; §4.7 permission handshake; §7.1 admit-no-dup / §7.4 address cascade / §7.7 right-to-amend).
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type PatientView,
  createInMemoryCaseloadStore,
  createInMemoryPatientRouteService,
  registerPatientRoutes,
} from "../src/modules/05-patient/index";
import type { MatchCandidate } from "../src/modules/05-patient/matching/index";
import { registerCaseloadSeam } from "../src/modules/05-patient/seams/index";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const EXISTING = "pat-existing";

// An existing patient with an MBI + SSN — the §7.1 hard-duplicate target (and the §3.3 masking case).
const existing: PatientView & MatchCandidate = {
  id: EXISTING,
  organizationId: ORG,
  mrn: "MRN-E",
  lastName: "LOVELACE",
  firstName: "ADA",
  dob: "1990-01-01",
  status: "active",
  mbi: "1EG4TE5MK73",
  ssn: "123-45-6789",
};

const PERMISSION_SEED = [
  { userId: "admit_1", permissions: ["patient.create", "patient.read"] },
  { userId: "edit_1", permissions: ["patient.edit", "patient.read"] },
  { userId: "amend_1", permissions: ["patient.amend_request_record", "patient.amend_review"] },
  { userId: "noperm_1", permissions: [] },
  // F-092 — holds `patient.read` and is on NO caseload. Before the ABAC guard this actor read every
  // chart in the tenant; the catalog has declared `patient.read` caseload-scoped the whole time.
  { userId: "offcaseload_1", permissions: ["patient.read"] },
  // …and the oversight arm: same absence of a caseload row, org-wide by ROLE.
  { userId: "don_1", permissions: ["patient.read"] },
];

/** Open `patient_assignment` rows, as `caseload_or_scope` resolves them through M5's CaseloadProvider. */
const CASELOAD = new Set([
  `${ORG}:edit_1:${EXISTING}`,
  `${ORG}:admit_1:${EXISTING}`,
  // §7.7 amendment INTAKE is caseload-scoped because the catalog declares
  // `patient.amend_request_record: abac: "caseload_or_scope"`. (Its sibling `patient.amend_review` is
  // `abac: "none"` — deciding an amendment is a records-management act, recording the patient's request
  // is a care-team one.) Honouring the declaration is the whole point of F-092: leaving one unenforced
  // because the workflow is arguable is how all nine came to be unenforced.
  `${ORG}:amend_1:${EXISTING}`,
]);

function makeServer() {
  const { service, events } = createInMemoryPatientRouteService({
    patients: [existing],
    now: () => new Date("2026-06-20T00:00:00Z"),
  });
  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  // F-092 — the §7.5 chart-scope guard is REAL here: M7's own `caseload_or_scope` predicate, over an
  // injected caseload, behind the same registry the composition root installs. A stub would prove the
  // route composes *a* guard; this proves it composes the one the permission catalog names, with a
  // target the predicate can actually resolve.
  registerAbacRegistry();
  const predicates = buildCarePlanAbacPredicates({
    resolver: {
      async loadPlan() {
        return null;
      },
      async loadProblem() {
        return null;
      },
      async loadVersion() {
        return null;
      },
    },
    async isInCaseload({ organizationId, userId, patientId }) {
      return CASELOAD.has(`${organizationId}:${userId}:${patientId}`);
    },
  });
  registerPredicateIdempotent("caseload_or_scope", predicates.caseload_or_scope);
  // F-096 — the CENSUS narrowing reads the same caseload through M5's own `CaseloadProvider` seam
  // (`caseloadPatientIds`, the `patient_id = ANY(:ids)` set) rather than through the predicate, because
  // a preHandler can refuse a collection but cannot filter one. Seeded from the SAME `CASELOAD` set the
  // predicate resolves, so the list half and the chart half cannot disagree in this harness about who
  // is on whose caseload.
  registerCaseloadSeam({
    store: createInMemoryCaseloadStore(
      [...CASELOAD].map((row) => {
        const [organizationId, userId, patientId] = row.split(":") as [string, string, string];
        return { organizationId, userId, patientId };
      }),
    ).store,
  });
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  // F-171 (#248) — the merge write path (`merges-db.ts`) is real Drizzle over `patient`/`patient_merge`
  // and has no in-memory counterpart; this harness's own patient map is private to
  // `createInMemoryPatientRouteService` (unlike `PatientRouteService`, `mergePatients` is not on that
  // interface — see `patient-routes.ts`'s header). No test in this file exercises the merge route; the
  // real mechanism is proven live in `m5-patient-merge.live.test.ts`.
  const mergePatients = async (): Promise<never> => {
    throw new Error("mergePatients: not implemented in the route-test in-memory harness");
  };
  registerPatientRoutes(app, { service, mergePatients });
  return { app, events };
}

const ADMIT = { "x-test-user": "admit_1", "x-test-org": ORG, "x-test-roles": "admissions" };
const EDIT = { "x-test-user": "edit_1", "x-test-org": ORG, "x-test-roles": "rn" };
const AMEND = { "x-test-user": "amend_1", "x-test-org": ORG, "x-test-roles": "compliance" };
const NOPERM = { "x-test-user": "noperm_1", "x-test-org": ORG, "x-test-roles": "intern" };
const OFF_CASELOAD = { "x-test-user": "offcaseload_1", "x-test-org": ORG, "x-test-roles": "rn" };
const DON = { "x-test-user": "don_1", "x-test-org": ORG, "x-test-roles": "director_of_nursing" };

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M5-T09 — patient routes (§4.2, §4.7 gating, §7.1/§7.4/§7.7)", () => {
  it("denies admit without patient.create (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: NOPERM,
      payload: { lastName: "X", firstName: "Y", dob: "2000-01-01", administrativeSex: "U" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("§7.1 a unique admit creates the patient (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: ADMIT,
      payload: {
        lastName: "Newperson",
        firstName: "Fresh",
        dob: "1975-03-03",
        administrativeSex: "M",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe("created");
    expect(res.json().patientId).toBeTruthy();
    await app.close();
  });

  it("§7.1 a hard-duplicate admit (same MBI) is BLOCKED with 409, no row created", async () => {
    const { app, events } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/patients",
      headers: ADMIT,
      payload: {
        lastName: "Different",
        firstName: "Name",
        dob: "1991-02-02",
        administrativeSex: "F",
        mbi: "1EG4-TE5-MK73",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DUPLICATE_OF");
    expect(events).toContain("m5.patient.duplicate_block");
    expect(events).not.toContain("m5.patient.created");
    await app.close();
  });

  it("§7.4 an address change emits the address_changed cascade", async () => {
    const { app, events } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
      payload: { line1: "10 New St", city: "Portland", state: "OR", postalCode: "97201" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().cascadeEmitted).toBe("m5.patient.address_changed");
    expect(events).toContain("m5.patient.address_changed");
    await app.close();
  });

  it("§7.7 an amendment opens with a 60-day SLA; deny without reason 4xx; accept resolves it", async () => {
    const { app } = makeServer();
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/amendments`,
      headers: AMEND,
      payload: { scope: "demographic", rationale: "wrong DOB" },
    });
    expect(submit.statusCode).toBe(201);
    expect(submit.json().status).toBe("pending");
    expect(submit.json().slaDueAt).toBe(new Date("2026-08-19T00:00:00Z").toISOString()); // +60 days
    const amendmentId = submit.json().id;

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/amendments/${amendmentId}/accept`,
      headers: AMEND,
      payload: {},
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().status).toBe("accepted");
    await app.close();
  });

  it("§4.2 lists patients in the actor's org (cursor-paginated)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients?limit=10",
      headers: EDIT,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((p: { id: string }) => p.id === EXISTING)).toBe(true);
    expect(body).toHaveProperty("nextCursor");
    await app.close();
  });

  it("§4.2 census-metrics returns the org's active count + per-status breakdown (denies without read)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients/census-metrics",
      headers: EDIT,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.byStatus.active).toBe(1);
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/patients/census-metrics",
      headers: NOPERM,
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§4.2 list q-filter matches by name/MRN (and denies without patient.read)", async () => {
    const { app } = makeServer();
    const hit = await app.inject({
      method: "GET",
      url: "/api/v1/patients?q=lovelace",
      headers: EDIT,
    });
    expect(hit.json().items.map((p: { id: string }) => p.id)).toContain(EXISTING);
    const miss = await app.inject({
      method: "GET",
      url: "/api/v1/patients?q=zzzznomatch",
      headers: EDIT,
    });
    expect(miss.json().items).toHaveLength(0);
    const denied = await app.inject({ method: "GET", url: "/api/v1/patients", headers: NOPERM });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§7.5 GET a patient the actor's org doesn't have → 404 (no leak)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients/pat-nonexistent",
      headers: EDIT,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("§3.3 demographics tab returns live M5 data (and denies without patient.read)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/demographics`,
      headers: EDIT,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().legalLastName).toBe("LOVELACE");
    expect(res.json().dob).toBe("1990-01-01");
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/demographics`,
      headers: NOPERM,
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§3.3/§2.2 identifiers are MASKED for ssn (last4 only, no plaintext value)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/identifiers`,
      headers: EDIT,
    });
    expect(res.statusCode).toBe(200);
    const ssn = res.json().identifiers.find((i: { kind: string }) => i.kind === "ssn");
    expect(ssn.sensitive).toBe(true);
    expect(ssn.value).toBeNull(); // ciphertext/plaintext NEVER serialized
    expect(ssn.last4).toBe("6789");
    const mrn = res.json().identifiers.find((i: { kind: string }) => i.kind === "mrn");
    expect(mrn.value).toBe("MRN-E"); // non-sensitive kinds are plaintext
    await app.close();
  });

  it("§3.3 addresses tab: add → list shows the current row; geocode pending; denies without patient.read", async () => {
    const { app } = makeServer();
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().addresses).toHaveLength(0);

    const add = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
      payload: {
        line1: "10 New St",
        city: "Portland",
        state: "OR",
        postalCode: "97201",
        isPrimary: true,
      },
    });
    expect(add.statusCode).toBe(201);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
    });
    const rows = listed.json().addresses;
    expect(rows).toHaveLength(1);
    expect(rows[0].current).toBe(true);
    expect(rows[0].isPrimary).toBe(true);
    expect(rows[0].effectiveTo).toBeNull();
    expect(rows[0].geocodeLat).toBeNull(); // filled async by the geocode job

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: NOPERM,
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("§7.4 D5 primary rotation: a new primary closes the prior current primary (append-only)", async () => {
    const { app } = makeServer();
    await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
      payload: {
        line1: "1 First Ave",
        city: "Portland",
        state: "OR",
        postalCode: "97201",
        isPrimary: true,
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
      payload: {
        line1: "2 Second Ave",
        city: "Salem",
        state: "OR",
        postalCode: "97301",
        isPrimary: true,
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: EDIT,
    });
    const rows = listed.json().addresses as Array<{
      line1: string;
      isPrimary: boolean;
      current: boolean;
      effectiveTo: string | null;
    }>;
    expect(rows).toHaveLength(2); // append-only: the prior row is kept
    const currentPrimaries = rows.filter((r) => r.current && r.isPrimary);
    expect(currentPrimaries).toHaveLength(1); // at most one current primary
    expect(currentPrimaries[0]!.line1).toBe("2 Second Ave");
    const closed = rows.find((r) => r.line1 === "1 First Ave");
    expect(closed!.current).toBe(false);
    expect(closed!.effectiveTo).not.toBeNull();
    await app.close();
  });

  it("§7.5 addresses for an unknown patient → 404 (no leak)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/patients/pat-nope/addresses",
      headers: EDIT,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("§7.5 demographics/identifiers for an unknown patient → 404 (no leak)", async () => {
    const { app } = makeServer();
    const a = await app.inject({
      method: "GET",
      url: "/api/v1/patients/pat-nope/demographics",
      headers: EDIT,
    });
    const b = await app.inject({
      method: "GET",
      url: "/api/v1/patients/pat-nope/identifiers",
      headers: EDIT,
    });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    await app.close();
  });

  // ── F-092: the §7.5 chart-scope guard the catalog has always declared ───────────────────────────
  //
  // Before this, M5 composed no ABAC of any kind: `patient.read` declared `caseload_or_scope` in the
  // permission catalog, nothing read that declaration (`requirePermission` never looks at
  // `defaultAbac`), and six route comments claimed a "non-caseload → 404" that the service had no
  // caseload input to perform.

  it("F-092 refuses a chart read to a patient.read holder who is on no caseload — as a 404", async () => {
    const { app } = makeServer();
    const res = await app.inject({ url: `/api/v1/patients/${EXISTING}`, headers: OFF_CASELOAD });
    // 404, not 403: a 403 on a chart id confirms the chart exists, which is the disclosure the guard
    // is here to prevent. This is what `notFoundOnDeny` buys.
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("F-092 the same actor is refused every per-chart TAB, not only the resolve route", async () => {
    const { app } = makeServer();
    for (const tab of [
      "demographics",
      "identifiers",
      "payers",
      "care-team",
      "privacy-flags",
      "addresses",
    ]) {
      const res = await app.inject({
        url: `/api/v1/patients/${EXISTING}/${tab}`,
        headers: OFF_CASELOAD,
      });
      expect([tab, res.statusCode]).toEqual([tab, 404]);
    }
    await app.close();
  });

  it("F-092 an assigned clinician still reads the chart (the guard narrows, it does not close)", async () => {
    const { app } = makeServer();
    const res = await app.inject({ url: `/api/v1/patients/${EXISTING}`, headers: EDIT });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(EXISTING);
    await app.close();
  });

  it("F-092 a Director of Nursing reads any chart with no caseload row at all", async () => {
    // The DON is on NO caseload here. CoP 418.64(a) makes them responsible for all nursing services,
    // and M3's `SYSTEM_LOCKED_FLOORS` locks `patient.read` AND `assignment.manage` onto the role — a
    // permission to put clinicians on caseloads that cannot be exercised against invisible patients.
    // `ORG_WIDE_SCOPE_ROLES` named only three roles and this was not one, so M7/M9/M20/M23 have been
    // refusing the DON every care plan, assessment and safety row outside their own caseload; it is
    // now DERIVED from the floors rather than listed by hand.
    const { app } = makeServer();
    const res = await app.inject({ url: `/api/v1/patients/${EXISTING}`, headers: DON });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("F-092 a per-chart WRITE is scoped too (add address)", async () => {
    const { app } = makeServer();
    const write = await app.inject({
      method: "POST",
      url: `/api/v1/patients/${EXISTING}/addresses`,
      headers: OFF_CASELOAD,
      payload: { line1: "1 Elm", city: "Springfield", state: "IL", postalCode: "62701" },
    });
    expect(write.statusCode).toBe(403); // no patient.edit — RBAC refuses before the scope guard
    await app.close();
  });

  // ── F-096: §7.5's OTHER half — the census list ─────────────────────────────────────────────────
  //
  // The assertion this block replaces read "the census list is not [narrowed]", and said: "asserted so
  // the gap is a KNOWN state rather than a silent one: if someone narrows the list later, this test is
  // where they will say so." This is that. Until now any holder of `patient.read` listed every patient
  // in the tenant, which is the larger of the two disclosures F-092 split: a chart read leaks one
  // patient to someone who guessed an id; a census leaks the identity of every patient the agency
  // serves to everyone who can log in.

  const idsOf = (res: { json: () => { items: { id: string }[] } }) =>
    res.json().items.map((p) => p.id);

  it("F-096 a patient.read holder on NO caseload gets an EMPTY census, not the tenant's", async () => {
    const { app } = makeServer();
    const list = await app.inject({ url: "/api/v1/patients", headers: OFF_CASELOAD });
    expect(list.statusCode).toBe(200);
    // 200 with nothing in it, not 403: the actor may ask for a census, they simply have none. The
    // failure shape this pins is `if (ids.length > 0) narrow(ids)`, which would return the whole tenant
    // here — for precisely the actor who should see least.
    expect(idsOf(list)).toEqual([]);
    await app.close();
  });

  it("F-096 an assigned clinician sees their caseload — narrowing is not closing", async () => {
    const { app } = makeServer();
    const list = await app.inject({ url: "/api/v1/patients", headers: EDIT });
    expect(list.statusCode).toBe(200);
    expect(idsOf(list)).toEqual([EXISTING]);
    await app.close();
  });

  it("F-096 an org-wide oversight role still sees the whole census", async () => {
    // The DON is on no caseload at all. `hasOrgWideScope` answers for the LIST exactly as it answers
    // for the chart guard — one derivation, so the two halves of §7.5 cannot disagree about who is
    // org-wide. Before F-096 this role was absent from three of the five copies of that list.
    const { app } = makeServer();
    const list = await app.inject({ url: "/api/v1/patients", headers: DON });
    expect(list.statusCode).toBe(200);
    expect(idsOf(list)).toContain(EXISTING);
    await app.close();
  });

  it("F-096 the q-filter cannot widen the census past the caseload", async () => {
    // Narrowing has to survive every other filter the route accepts, or a search box becomes the
    // bypass: the caseload predicate is ANDed into the same WHERE as `status` and `q`, never applied
    // after them.
    const { app } = makeServer();
    const list = await app.inject({
      url: `/api/v1/patients?q=${existing.lastName}`,
      headers: OFF_CASELOAD,
    });
    expect(list.statusCode).toBe(200);
    expect(idsOf(list)).toEqual([]);
    await app.close();
  });
});
