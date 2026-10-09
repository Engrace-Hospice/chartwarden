// apps/backend/__tests__/emar-caregiver-barcode.test.ts — M13-T09: the §2.9 D10 caregiver-attested write path
// (five-rights + the mandatory M12 D6 consistency check) and the §2.9 BCMA barcode verification, exercised
// through the FULL M1 middleware chain (Fastify `inject`, no live infra), plus the M31 caregiver-portal
// forward-seam deny-stub. The §4.6 permission keys gate every route; the four §4.7 predicates M13 owns are
// registered into a fresh ABAC registry over the slice's resolver (the M13-T08 emar-routes.test.ts precedent).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { formatWristbandPayload } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildEmarAbacPredicates,
  createInMemoryEmarBackend,
  denyStubCaregiverPortalSessionResolver,
  registerEmarRoutes,
} from "../src/modules/13-emar/index";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  // emar-routes.ts's actorOf() reads the acting MEMBERSHIP id from here (not ctx.userId).
  request.context.attributes.membershipId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ORDER = "00000000-0000-4000-8000-0000000000a1";
const DISCONTINUED_ORDER = "00000000-0000-4000-8000-0000000000a2";
const NOW = "2026-06-22T12:00:00.000Z";
// GAP-020 -- two real printed bands (the slice stands in for M5's `patient_wristband` with the seeded one).
const BAND_A = formatWristbandPayload(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
const BAND_B = formatWristbandPayload(Uint8Array.from({ length: 16 }, (_, i) => 200 - i));

const READ = [
  "administration.read",
  "administration.read_missed",
  "reconciliation.read",
  "comfort_kit.read",
];
const WRITE = ["administration.record", "administration.caregiver_record"];
const PERMISSION_SEED = [{ userId: "md_1", permissions: [...READ, ...WRITE] }];

function makeServer() {
  const backend = createInMemoryEmarBackend({
    now: () => NOW,
    memberships: [
      { userId: "md_1", membershipId: "mem_md", organizationId: ORG, discipline: "md" },
    ],
    caseManagers: { [PATIENT]: "md_1" },
    orders: [
      // The active order authorizes morphine 5 mg PO; the BCMA RxCUI/NDC + the patient wristband identify it.
      {
        medicationOrderId: ORDER,
        organizationId: ORG,
        patientId: PATIENT,
        medClass: "standard",
        route: "PO",
        doseAmount: 5,
        doseUnit: "mg",
        rxnormRxcui: "313782",
        ndc: "00093-0058-01",
      },
      {
        medicationOrderId: DISCONTINUED_ORDER,
        organizationId: ORG,
        patientId: PATIENT,
        medClass: "standard",
        route: "PO",
        doseAmount: 5,
        doseUnit: "mg",
        administerable: false,
        blockedReasons: ["discontinued"],
      },
    ],
    patients: [{ patientId: PATIENT, wristbandPayload: BAND_A }],
  });

  const grantStore = createInMemoryEffectivePermissionStore(
    PERMISSION_SEED.map((s) => ({
      orgId: ORG,
      userId: s.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: s.permissions }],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);
  const reg = createPredicateRegistry();
  // Caseload scope (GAP-004) is not under test here: every actor is on the patient's caseload.
  const isInCaseload = async () => true;
  for (const [name, predicate] of Object.entries(
    buildEmarAbacPredicates({ resolver: backend, isInCaseload }),
  ))
    reg.register(name, predicate);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerEmarRoutes(app, { service: backend });
  return { app, backend };
}

const MD = { "x-test-user": "md_1", "x-test-org": ORG, "x-test-roles": "md" };

const caregiverBody = (over: Record<string, unknown> = {}) => ({
  patientId: PATIENT,
  medicationOrderId: ORDER,
  administeredAt: NOW,
  administeredAmount: 5,
  administeredUnit: "mg",
  route: "PO",
  caregiverAttestationText: "Gave evening morphine for breakthrough pain",
  ...over,
});

const recordBody = (over: Record<string, unknown> = {}) => ({
  medicationOrderId: ORDER,
  medClass: "standard",
  mode: "single_dose",
  administeredAt: NOW,
  data: {},
  ...over,
});

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

describe("M13-T09 — §2.9 D10 caregiver-attested write path", () => {
  it("a caregiver-attested dose matching the order commits as pending_caregiver_review (201) and fires the cosign event", async () => {
    const { app, backend } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/caregiver-attested",
      headers: MD,
      payload: caregiverBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending_caregiver_review");
    expect(res.json().requiresRnReview).toBe(true);
    expect(backend.drainEvents().map((e) => e.eventName)).toContain(
      "m13.administration.recorded_caregiver_attested",
    );
    await app.close();
  });

  it("a caregiver-reported dose with the wrong route fails the §5.11 five-rights check (422 FIVE_RIGHTS_VIOLATION)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/caregiver-attested",
      headers: MD,
      payload: caregiverBody({ route: "IM" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("FIVE_RIGHTS_VIOLATION");
    await app.close();
  });

  it("a caregiver-reported dose larger than the order authorizes fails the dose right (422)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/caregiver-attested",
      headers: MD,
      payload: caregiverBody({ administeredAmount: 50 }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("FIVE_RIGHTS_VIOLATION");
    await app.close();
  });

  it("the mandatory M12 D6 consistency check blocks a caregiver dose against a discontinued order (422 ADMINISTRATION_BLOCKED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/caregiver-attested",
      headers: MD,
      payload: caregiverBody({ medicationOrderId: DISCONTINUED_ORDER }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("ADMINISTRATION_BLOCKED");
    await app.close();
  });
});

describe("M13-T09 — §2.9 BCMA barcode verification", () => {
  it("a clinician dose with a matching barcode commits (201) and carries matchResult=match", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({
        barcodeScan: {
          scannedRxnormRxcui: "313782",
          patientWristbandPayload: BAND_A,
        },
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().barcodeMatchResult).toBe("match");
    await app.close();
  });

  it("a wrong-patient wristband scan is refused (422 BARCODE_VERIFICATION_FAILED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({
        barcodeScan: {
          scannedRxnormRxcui: "313782",
          patientWristbandPayload: BAND_B,
        },
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("BARCODE_VERIFICATION_FAILED");
    expect(res.json().error.details).toEqual([
      expect.objectContaining({
        field: "barcodeScan.patientWristbandPayload",
        code: "WRISTBAND_MISMATCH",
      }),
    ]);
    await app.close();
  });

  it("GAP-020: a drug-only scan (no wristband) is refused while the tenant requires a wristband (the default)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({ barcodeScan: { scannedRxnormRxcui: "313782" } }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("BARCODE_VERIFICATION_FAILED");
    expect(res.json().error.details[0].code).toBe("WRISTBAND_NOT_PRESENTED");
    await app.close();
  });

  it("GAP-020: a legacy free-text 'digest' is malformed and refused, never accepted as a wristband", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({
        barcodeScan: { scannedRxnormRxcui: "313782", patientWristbandPayload: "sha256:patient-a" },
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].code).toBe("WRISTBAND_MALFORMED");
    await app.close();
  });

  it("GAP-020: with the policy off a bandless drug scan passes, but a WRONG band still refuses", async () => {
    const { app, backend } = makeServer();
    await backend.putPolicy(ORG, { bcmaWristbandRequired: false });
    const bandless = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({ barcodeScan: { scannedRxnormRxcui: "313782" } }),
    });
    expect(bandless.statusCode).toBe(201);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({
        barcodeScan: { scannedRxnormRxcui: "313782", patientWristbandPayload: BAND_B },
      }),
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.details[0].code).toBe("WRISTBAND_MISMATCH");
    await app.close();
  });

  it("GAP-020: the caregiver-attested path needs no band, but a scanned wrong band refuses", async () => {
    const { app } = makeServer();
    const bandless = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/caregiver-attested",
      headers: MD,
      payload: caregiverBody({ barcodeScan: { scannedRxnormRxcui: "313782" } }),
    });
    expect(bandless.statusCode).toBe(201);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/administrations/caregiver-attested",
      headers: MD,
      payload: caregiverBody({
        barcodeScan: { scannedRxnormRxcui: "313782", patientWristbandPayload: BAND_B },
      }),
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe("BARCODE_VERIFICATION_FAILED");
    await app.close();
  });

  it("a wrong-drug barcode scan is refused (422 BARCODE_VERIFICATION_FAILED)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/administrations",
      headers: MD,
      payload: recordBody({ barcodeScan: { scannedRxnormRxcui: "000000" } }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("BARCODE_VERIFICATION_FAILED");
    await app.close();
  });
});

describe("M13-T09 — M31 caregiver-portal forward seam (deny-stub)", () => {
  it("the deny-stub fails closed with M31_NOT_BOUND until M31 locks", async () => {
    const r = await denyStubCaregiverPortalSessionResolver.resolve(ORG, "session-1");
    expect(r).toEqual({ bound: false, reason: "M31_NOT_BOUND" });
  });
});
