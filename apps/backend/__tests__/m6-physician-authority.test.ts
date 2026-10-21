// apps/backend/__tests__/m6-physician-authority.test.ts — 42 CFR 418.26(b) (FY 2027, effective 2026-10-01)
// discharge order and 42 CFR 418.25(a) (FY 2026, effective 2025-10-01) admission recommendation.
//
// Three layers: (1) the PURE signer matrix (medical director, physician designee, the physician member of THIS
// patient's IDG are signers; another team's IDG physician, the attending, an NP are not; the pre-effective-date
// legacy sets); (2) the in-memory slice (order required for a live discharge, persisted cosigner, the
// recommendation + the activation checklist item); (3) the route layer (the `discharge.is_order_signer`
// predicate and the new recommendation / signer-picker routes through the full M1 chain).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  ADMISSION_RECOMMENDATION_BLOCKS_ACTIVATION,
  admissionRecommendationCapacities,
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  dischargeOrderCapacities,
  dischargeOrderRequiredAtFiling,
  dischargeOrderTimingValid,
  heldSignerCapacities,
  registerAdmissionRoutes,
  resolvePhysicianSigner,
} from "../src/modules/06-admission/index";

const ORG = "org_a";
const ADMISSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMISSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT = "pat_1";
const OTHER_PATIENT = "pat_2";

// Users (uuid-shaped so they pass the TypeBox Uuid() on route bodies).
const MED_DIRECTOR = "10000000-0000-4000-8000-000000000001";
const DESIGNEE = "10000000-0000-4000-8000-000000000002";
const IDG_MD = "10000000-0000-4000-8000-000000000003"; // `md` + open `md` assignment on PATIENT
const OTHER_TEAM_MD = "10000000-0000-4000-8000-000000000004"; // `md` + `md` assignment on OTHER_PATIENT
const ATTENDING = "10000000-0000-4000-8000-000000000005"; // `md`, attending — no IDG seat
const NP = "10000000-0000-4000-8000-000000000006"; // `np` (even if assigned, never an IDG physician)
const RN = "10000000-0000-4000-8000-000000000007";

const ROLE_KEYS: Record<string, readonly string[]> = {
  [MED_DIRECTOR]: ["medical_director"],
  [DESIGNEE]: ["hospice_physician"],
  [IDG_MD]: ["md"],
  [OTHER_TEAM_MD]: ["md"],
  [ATTENDING]: ["md"],
  [NP]: ["np"],
  [RN]: ["rn_case_manager"],
};
const IDG_ASSIGNMENTS: Record<string, readonly string[]> = {
  [PATIENT]: [IDG_MD, NP],
  [OTHER_PATIENT]: [OTHER_TEAM_MD],
};

const factsFor = (userId: string, patientId = PATIENT) => ({
  roleKeys: ROLE_KEYS[userId] ?? null,
  idgPhysicianOfPatient: (IDG_ASSIGNMENTS[patientId] ?? []).includes(userId),
});

// ── (1) the pure signer matrix ──────────────────────────────────────────────────────────────────────

describe("418.26(b) discharge-order signer matrix (on/after 2026-10-01)", () => {
  const allowed = dischargeOrderCapacities("2026-10-15");
  const verdict = (userId: string) => resolvePhysicianSigner({ facts: factsFor(userId), allowed });

  it("admits the medical director", () => {
    expect(verdict(MED_DIRECTOR)).toEqual({ ok: true, capacity: "medical_director" });
  });
  it("admits the physician designee", () => {
    expect(verdict(DESIGNEE)).toEqual({ ok: true, capacity: "physician_designee" });
  });
  it("admits the physician member of THIS patient's IDG", () => {
    expect(verdict(IDG_MD)).toEqual({ ok: true, capacity: "idg_physician_member" });
  });
  it("rejects the IDG physician of ANOTHER patient's team", () => {
    expect(verdict(OTHER_TEAM_MD).ok).toBe(false);
    expect(heldSignerCapacities(factsFor(OTHER_TEAM_MD, OTHER_PATIENT))).toEqual([
      "idg_physician_member",
    ]);
  });
  it("rejects the attending physician", () => {
    expect(verdict(ATTENDING).ok).toBe(false);
  });
  it("rejects an NP even when assigned to the patient (the IDG seat is MD/DO only)", () => {
    expect(verdict(NP).ok).toBe(false);
  });
  it("rejects a user with no membership", () => {
    expect(verdict("nobody").ok).toBe(false);
  });
  it("refuses a claimed capacity the signer does not hold", () => {
    expect(
      resolvePhysicianSigner({ facts: factsFor(DESIGNEE), allowed, claimed: "medical_director" })
        .ok,
    ).toBe(false);
  });
});

describe("pre-effective-date legacy rules", () => {
  it("418.26(b) before 2026-10-01 named only the medical director", () => {
    const allowed = dischargeOrderCapacities("2026-09-30");
    expect(allowed).toEqual(["medical_director"]);
    expect(resolvePhysicianSigner({ facts: factsFor(MED_DIRECTOR), allowed }).ok).toBe(true);
    expect(resolvePhysicianSigner({ facts: factsFor(DESIGNEE), allowed }).ok).toBe(false);
    expect(resolvePhysicianSigner({ facts: factsFor(IDG_MD), allowed }).ok).toBe(false);
  });
  it("no order is required for a live discharge before 2026-10-01, nor ever for death / for-cause filing", () => {
    expect(dischargeOrderRequiredAtFiling("moved_out_of_service_area", "2026-09-30")).toBe(false);
    expect(dischargeOrderRequiredAtFiling("moved_out_of_service_area", "2026-10-01")).toBe(true);
    expect(dischargeOrderRequiredAtFiling("no_longer_terminal", "2026-11-01")).toBe(true);
    expect(dischargeOrderRequiredAtFiling("other", "2026-11-01")).toBe(true);
    expect(dischargeOrderRequiredAtFiling("death", "2026-11-01")).toBe(false);
    expect(dischargeOrderRequiredAtFiling("for_cause", "2026-11-01")).toBe(false);
  });
  it("418.25(a): the IDG physician member may recommend only from 2025-10-01", () => {
    expect(admissionRecommendationCapacities("2025-09-30T12:00:00Z")).toEqual([
      "medical_director",
      "physician_designee",
    ]);
    expect(admissionRecommendationCapacities("2025-10-01T00:00:00Z")).toContain(
      "idg_physician_member",
    );
  });
  it("an order may not be signed after the discharge date (+1 day slack) or in the future", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    expect(dischargeOrderTimingValid("2026-10-10T15:00:00Z", "2026-10-10", now)).toBe(true);
    expect(dischargeOrderTimingValid("2026-10-11T20:00:00Z", "2026-10-10", now)).toBe(true);
    expect(dischargeOrderTimingValid("2026-10-12T01:00:00Z", "2026-10-10", now)).toBe(false);
    expect(dischargeOrderTimingValid("2026-10-21T00:00:00Z", "2026-10-25", now)).toBe(false);
  });
});

// ── (2) the in-memory slice ─────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-20T12:00:00Z");
function backend() {
  return createInMemoryAdmissionBackend({
    now: () => NOW,
    clinicianRoleKeys: ROLE_KEYS,
    idgPhysicianAssignments: IDG_ASSIGNMENTS,
    userNames: { [MED_DIRECTOR]: "Dr. Director", [IDG_MD]: "Dr. Team" },
    records: [
      {
        id: ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "active",
        patientId: PATIENT,
      },
      {
        id: OTHER_ADMISSION,
        organizationId: ORG,
        kind: "admission",
        state: "pending",
        patientId: PATIENT,
        attendingPhysicianId: "att-1",
      },
    ],
  });
}
const moved = (dischargeDate: string, signer?: string) => ({
  reason: "moved_out_of_service_area" as const,
  dischargeDate,
  narrative: "relocated out of the service area",
  ...(signer
    ? { dischargeOrder: { signedByUserId: signer, signedAt: "2026-10-18T10:00:00Z" } }
    : {}),
});

describe("slice — 418.26(b) on the discharge write", () => {
  it("refuses a live discharge on/after 2026-10-01 without an order (DISCHARGE_ORDER_REQUIRED)", async () => {
    await expect(
      backend().service.discharge(ORG, ADMISSION, moved("2026-10-18"), RN),
    ).rejects.toMatchObject({ code: "DISCHARGE_ORDER_REQUIRED", statusCode: 422 });
  });
  it("accepts the order from the patient's IDG physician", async () => {
    const res = await backend().service.discharge(ORG, ADMISSION, moved("2026-10-18", IDG_MD), RN);
    expect(res.state).toBe("completed");
  });
  it.each([
    ["the attending", ATTENDING],
    ["another team's IDG physician", OTHER_TEAM_MD],
    ["an NP", NP],
  ])("rejects an order signed by %s (PHYSICIAN_SIGNER_INVALID)", async (_label, signer) => {
    await expect(
      backend().service.discharge(ORG, ADMISSION, moved("2026-10-18", signer), RN),
    ).rejects.toMatchObject({ code: "PHYSICIAN_SIGNER_INVALID" });
  });
  it("keeps the legacy rule for a pre-2026-10-01 discharge (no order needed)", async () => {
    const res = await backend().service.discharge(ORG, ADMISSION, moved("2026-09-30"), RN);
    expect(res.state).toBe("completed");
  });
  it("rejects a death discharge that carries an order", async () => {
    await expect(
      backend().service.discharge(
        ORG,
        ADMISSION,
        {
          reason: "death",
          dischargeDate: "2026-10-18",
          narrative: "patient died peacefully at home",
          deathCertifierId: MED_DIRECTOR,
          dischargeOrder: { signedByUserId: MED_DIRECTOR, signedAt: "2026-10-18T10:00:00Z" },
        },
        RN,
      ),
    ).rejects.toMatchObject({ code: "PHYSICIAN_SIGNER_INVALID" });
  });
  it("the for-cause cosign is the order: an IDG physician of this patient may cosign, an attending may not", async () => {
    const forCause = {
      reason: "for_cause" as const,
      dischargeDate: "2026-10-18",
      narrative: "documented safety threat to staff",
      forCauseReason: "repeated credible threats of violence to visiting nurses",
    };
    const ok = backend();
    const filed = await ok.service.discharge(ORG, ADMISSION, forCause, RN);
    const cosigned = await ok.service.cosignDischarge(
      ORG,
      filed.id,
      { cosignerName: "Dr. Team", cosignerNpi: "1234567893", actorRoleKeys: ["md"] },
      filed.version,
      IDG_MD,
    );
    expect(cosigned.state).toBe("completed");

    const bad = backend();
    const filed2 = await bad.service.discharge(ORG, ADMISSION, forCause, RN);
    await expect(
      bad.service.cosignDischarge(
        ORG,
        filed2.id,
        { cosignerName: "Dr. Att", cosignerNpi: "1234567893", actorRoleKeys: ["md"] },
        filed2.version,
        ATTENDING,
      ),
    ).rejects.toMatchObject({ code: "PHYSICIAN_SIGNER_INVALID" });
  });
});

describe("slice — 418.25(a) admission recommendation", () => {
  const rec = (by: string, extra: Record<string, unknown> = {}) => ({
    recommendedByUserId: by,
    recommendedAt: "2026-10-19T09:00:00Z",
    attendingConsulted: true,
    ...extra,
  });

  it("records the IDG physician's recommendation and completes the checklist item", async () => {
    const b = backend();
    const before = await b.service.getAdmission(ORG, OTHER_ADMISSION);
    const item = before?.readiness?.requirements.find((r) => r.code === "admission_recommendation");
    expect(item).toMatchObject({
      status: "action_required",
      blocking: ADMISSION_RECOMMENDATION_BLOCKS_ACTIVATION,
      action: "RECORD_ADMISSION_RECOMMENDATION",
    });
    const res = await b.service.recordAdmissionRecommendation(
      ORG,
      OTHER_ADMISSION,
      rec(IDG_MD),
      before?.version ?? 0,
      RN,
    );
    const after = await b.service.getAdmission(ORG, OTHER_ADMISSION);
    expect(res.version).toBe((before?.version ?? 0) + 1);
    expect(after?.admissionRecommendation).toMatchObject({
      recommendedByUserId: IDG_MD,
      capacity: "idg_physician_member",
      attendingConsulted: true,
    });
    expect(
      after?.readiness?.requirements.find((r) => r.code === "admission_recommendation")?.status,
    ).toBe("complete");
  });
  it("rejects the attending and an NP as recommenders", async () => {
    const b = backend();
    for (const by of [ATTENDING, NP]) {
      await expect(
        b.service.recordAdmissionRecommendation(ORG, OTHER_ADMISSION, rec(by), 1, RN),
      ).rejects.toMatchObject({ code: "PHYSICIAN_SIGNER_INVALID" });
    }
  });
  it("requires a note when the admission's attending physician was not consulted", async () => {
    await expect(
      backend().service.recordAdmissionRecommendation(
        ORG,
        OTHER_ADMISSION,
        rec(MED_DIRECTOR, { attendingConsulted: false }),
        1,
        RN,
      ),
    ).rejects.toMatchObject({ code: "ATTENDING_CONSULT_NOTE_REQUIRED" });
  });
  it("refuses a future-dated recommendation", async () => {
    await expect(
      backend().service.recordAdmissionRecommendation(
        ORG,
        OTHER_ADMISSION,
        rec(MED_DIRECTOR, { recommendedAt: "2026-12-01T00:00:00Z" }),
        1,
        RN,
      ),
    ).rejects.toMatchObject({ code: "ADMISSION_RECOMMENDATION_INVALID" });
  });
  it("lists only eligible signers for the patient, with capacities", async () => {
    const list = await backend().service.listPhysicianSigners(ORG, ADMISSION);
    const ids = list?.items.map((c) => c.userId).sort();
    expect(ids).toEqual([MED_DIRECTOR, DESIGNEE, IDG_MD].sort());
    expect(list?.items.find((c) => c.userId === IDG_MD)?.capacities).toEqual([
      "idg_physician_member",
    ]);
  });
});

// ── (3) the route layer ──────────────────────────────────────────────────────────────────────────────

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const KEYS = [
  "discharge.for_cause",
  "discharge.moved",
  "discharge.cosign_for_cause",
  "admission.read",
  "admission.record_recommendation",
];

function makeServer() {
  const b = backend();
  const grantStore = createInMemoryEffectivePermissionStore(
    [MED_DIRECTOR, DESIGNEE, IDG_MD, ATTENDING, RN].map((userId) => ({
      orgId: ORG,
      userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  const registry = createPredicateRegistry();
  const predicates = buildAdmissionAbacPredicates({
    resolver: b.resolver,
    isInCaseload: async () => true,
    physicianAuthority: b.physicianAuthority,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, { service: b.service });
  return { app, b };
}
const as = (user: string, roles: string) => ({ "x-test-user": user, "x-test-roles": roles });

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("routes — discharge.is_order_signer + the 418.25(a) recommendation", () => {
  async function fileForCause(app: ReturnType<typeof makeServer>["app"]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/discharge`,
      headers: as(RN, "rn_case_manager"),
      payload: {
        reason: "for_cause",
        dischargeDate: "2026-10-18",
        narrative: "documented safety threat to staff",
        forCauseReason: "repeated credible threats of violence to visiting nurses",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; version: number };
  }

  it.each([
    ["the physician designee", DESIGNEE, "hospice_physician", 200],
    ["the patient's IDG physician", IDG_MD, "md", 200],
    ["the attending", ATTENDING, "md", 403],
  ])("route-40 cosign by %s → %s", async (_label, user, roles, status) => {
    const { app } = makeServer();
    const filed = await fileForCause(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/discharges/${filed.id}/cosign-for-cause`,
      headers: as(user, roles),
      payload: { cosignerName: "Dr. Signer", cosignerNpi: "1234567893", ifVersion: filed.version },
    });
    expect(res.statusCode).toBe(status);
    await app.close();
  });

  it("route 39 refuses a live discharge without an order with 422 DISCHARGE_ORDER_REQUIRED", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${ADMISSION}/discharge`,
      headers: as(RN, "rn_case_manager"),
      payload: moved("2026-10-18"),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("DISCHARGE_ORDER_REQUIRED");
    await app.close();
  });

  it("POST /admission-recommendation records it; GET /physician-signers lists the picker", async () => {
    const { app } = makeServer();
    const signers = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${OTHER_ADMISSION}/physician-signers`,
      headers: as(RN, "rn_case_manager"),
    });
    expect(signers.statusCode).toBe(200);
    expect(signers.json().items.length).toBe(3);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${OTHER_ADMISSION}/admission-recommendation`,
      headers: as(RN, "rn_case_manager"),
      payload: {
        recommendedByUserId: MED_DIRECTOR,
        recommendedAt: "2026-10-19T09:00:00Z",
        attendingConsulted: true,
        ifVersion: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
    await app.close();
  });
});
