// apps/backend/__tests__/admission-intake.test.ts — M6-T07 referral & intake (§7.1) + admission
// wizard (§7.2) workflow tests, driven through the FULL M1 middleware chain via Fastify `inject`.
//
// §7.1 (W-RF-01..04 + edges): receive → triage → accept drives the `admission.draft_from_referral`
// job (draft admission + period-1 + NOR window); externalReferralId is idempotent (409); accept is
// blocked until triaged (409); concurrent triage trips optimistic lock (409 VERSION_MISMATCH).
// §7.2 (W-AD-01..05 + edges): the wizard composes the per-step draft routes into a period-1 bundle;
// the R-AC-01 activation gate is server-truth — route 14 returns 412 PRECONDITION_FAILED with the
// missing codes, and route 10 reads back the SAME gate (no UI/server divergence).
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildAdmissionAbacPredicates,
  createInMemoryAdmissionBackend,
  registerAdmissionRoutes,
} from "../src/modules/06-admission/index";

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
const UUID = "11111111-1111-1111-1111-111111111111";
const PROVIDER = "22222222-2222-2222-2222-222222222222";
const MD_ID = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "44444444-4444-4444-4444-444444444444";

// One intake supervisor drives referral/admission/election/NOR (all admission-scoped, and sup_1 is
// in every caseload per the `isInCaseload` stub below); the CTI sign steps are identity-checked
// (GAP-011 `cti.is_hospice_md`/`cti.is_attending`) and need the matching physician's own grant.
const WIZARD_KEYS = [
  "referral.create",
  "referral.read",
  "referral.triage",
  "referral.accept",
  "admission.create",
  "admission.read",
  "admission.activate",
  "election.draft",
  "election.read",
  "election.sign",
  "cti.draft",
  "cti.read",
  "cti.sign_hospice_md",
  "cti.sign_attending",
  "nor.acknowledge",
];

function makeServer() {
  const backend = createInMemoryAdmissionBackend();
  const grantStore = createInMemoryEffectivePermissionStore([
    {
      orgId: ORG,
      userId: "sup_1",
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: WIZARD_KEYS }],
    },
    // GAP-011 — `cti.is_hospice_md`/`cti.is_attending` now gate the sign routes on the SIGNER's
    // identity matching the CTI's `hospiceMedicalDirectorId`/`attendingPhysicianId` (drafted as
    // MD_ID/ATTENDING below) — sup_1 driving the whole wizard can no longer sign as either
    // physician, matching real production identity-verified signing.
    {
      orgId: ORG,
      userId: MD_ID,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: ["cti.sign_hospice_md"],
        },
      ],
    },
    {
      orgId: ORG,
      userId: ATTENDING,
      grants: [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["cti.sign_attending"] },
      ],
    },
  ]);
  registerEffectivePermissionResolver(grantStore.store);
  // A FRESH registry per server, not the shared module-level `abacRegistry` — see
  // admission-routes.test.ts's `makeServer()` for why (registerIdempotent's same-source reboot
  // check would otherwise keep an EARLIER test's backend bound forever).
  const registry = createPredicateRegistry();
  const predicates = buildAdmissionAbacPredicates({
    resolver: backend.resolver,
    isInCaseload: async () => true,
  });
  for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
  registerAbacRegistry(registry);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerAdmissionRoutes(app, { service: backend.service });
  return { app, backend };
}

const SUP = { "x-test-user": "sup_1", "x-test-org": ORG, "x-test-roles": "intake_supervisor" };
const HOSPICE_MD = { "x-test-user": MD_ID, "x-test-org": ORG, "x-test-roles": "hospice_physician" };
const ATTENDING_MD = {
  "x-test-user": ATTENDING,
  "x-test-org": ORG,
  "x-test-roles": "attending_physician",
};

async function createReferral(
  app: ReturnType<typeof makeServer>["app"],
  externalReferralId?: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/referrals",
    headers: SUP,
    payload: {
      source: "phone",
      receivedAt: "2026-06-20T10:00:00Z",
      receivingUserId: UUID,
      patientNameAtReceipt: "Jane Roe",
      ...(externalReferralId ? { externalReferralId } : {}),
    },
  });
}

/** Drive a referral through receive → triage → accept; returns the created draft admission id. */
async function acceptedAdmission(app: ReturnType<typeof makeServer>["app"]): Promise<string> {
  const created = await createReferral(app);
  const referralId = created.json().id as string;
  const triaged = await app.inject({
    method: "POST",
    url: `/api/v1/referrals/${referralId}/triage`,
    headers: SUP,
    payload: { outcome: "eligible", ifVersion: created.json().version },
  });
  const accepted = await app.inject({
    method: "POST",
    url: `/api/v1/referrals/${referralId}/accept`,
    headers: SUP,
    payload: { primaryDiagnosisIcd10: "C50.9", ifVersion: triaged.json().version },
  });
  return accepted.json().admissionId as string;
}

/** Complete election + CTI + NOR for an admission so its activation gate is green. */
async function completeBundle(
  app: ReturnType<typeof makeServer>["app"],
  admissionId: string,
): Promise<void> {
  const periods = await app.inject({
    method: "GET",
    url: `/api/v1/admissions/${admissionId}/election-periods`,
    headers: SUP,
  });
  const periodId = periods.json().items[0].id as string;

  const stmt = await app.inject({
    method: "POST",
    url: `/api/v1/admissions/${admissionId}/election-statements`,
    headers: SUP,
    payload: {
      electionPeriodId: periodId,
      effectiveDate: "2026-06-20",
      primaryDiagnosisIcd10: "C50.9",
      electedProviderEntityId: PROVIDER,
      waiverAcknowledged: true,
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/election-statements/${stmt.json().id}/sign`,
    headers: SUP,
    payload: {
      signingPatientName: "Jane Roe",
      signingRole: "patient",
      ifVersion: stmt.json().version,
    },
  });

  const cti = await app.inject({
    method: "POST",
    url: `/api/v1/election-periods/${periodId}/cti`,
    headers: SUP,
    payload: {
      hospiceMedicalDirectorId: MD_ID,
      attendingPhysicianId: ATTENDING,
      prognosisStatement: "Terminal prognosis ≤6 months.",
      narrative: "Clinical course supports hospice eligibility.",
      clinicalFindings: {},
      isRecert: false,
    },
  });
  const mdSigned = await app.inject({
    method: "POST",
    url: `/api/v1/cti/${cti.json().id}/sign-hospice-md`,
    headers: HOSPICE_MD,
    payload: {
      signingPhysicianName: "Dr. Director",
      signingPhysicianNpi: "1234567893",
      ifVersion: cti.json().version,
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/cti/${cti.json().id}/sign-attending`,
    headers: ATTENDING_MD,
    payload: {
      signingPhysicianName: "Dr. Attending",
      signingPhysicianNpi: "1234567893",
      ifVersion: mdSigned.json().version,
    },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/admissions/${admissionId}/nor`,
    headers: SUP,
    payload: {
      formVersionId: UUID,
      deliveryMethod: "electronic_witnessed",
      acknowledgedAt: "2026-06-20T11:00:00Z",
      acknowledgedByName: "Jane Roe",
      acknowledgedByRole: "patient",
    },
  });
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M6-T07 — §7.1 receive & triage referral", () => {
  it("W-RF-01: create lands a referral in `received` and emits m6.referral.received", async () => {
    const { app, backend } = makeServer();
    const res = await createReferral(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe("received");
    expect(backend.events).toContain("m6.referral.received");
    await app.close();
  });

  it("W-RF-02: re-ingesting a known externalReferralId returns 409 with no duplicate row", async () => {
    const { app, backend } = makeServer();
    const first = await createReferral(app, "EXT-123");
    expect(first.statusCode).toBe(201);
    const dup = await createReferral(app, "EXT-123");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EXTERNAL_REFERRAL_ALREADY_INGESTED");
    const list = await app.inject({ method: "GET", url: "/api/v1/referrals", headers: SUP });
    expect(list.json().items).toHaveLength(1);
    await app.close();
  });

  it("W-RF-03: triage `eligible` moves to `triaged` and emits m6.referral.triaged", async () => {
    const { app, backend } = makeServer();
    const created = await createReferral(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${created.json().id}/triage`,
      headers: SUP,
      payload: { outcome: "eligible", ifVersion: created.json().version },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("triaged");
    expect(backend.events).toContain("m6.referral.triaged");
    await app.close();
  });

  it("W-RF-04: accept transitions to `accepted` and drafts an admission via admission.draft_from_referral", async () => {
    const { app, backend } = makeServer();
    const created = await createReferral(app);
    const triaged = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${created.json().id}/triage`,
      headers: SUP,
      payload: { outcome: "eligible", ifVersion: created.json().version },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${created.json().id}/accept`,
      headers: SUP,
      payload: { primaryDiagnosisIcd10: "C50.9", ifVersion: triaged.json().version },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().state).toBe("accepted");
    const admissionId = accepted.json().admissionId as string;
    expect(admissionId).toBeTruthy();
    expect(backend.events).toContain("m6.admission.draft_created");

    // The job created a pending draft admission with a draft period-1.
    const adm = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${admissionId}`,
      headers: SUP,
    });
    expect(adm.json().state).toBe("pending");
    const periods = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${admissionId}/election-periods`,
      headers: SUP,
    });
    expect(periods.json().items).toHaveLength(1);
    await app.close();
  });

  it("edge: accepting a referral that was never triaged returns 409 INELIGIBLE_NOT_TRIAGED", async () => {
    const { app } = makeServer();
    const created = await createReferral(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${created.json().id}/accept`,
      headers: SUP,
      payload: { primaryDiagnosisIcd10: "C50.9", ifVersion: created.json().version },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INELIGIBLE_NOT_TRIAGED");
    await app.close();
  });

  it("edge: concurrent triage of the same referral trips the optimistic lock (409 VERSION_MISMATCH)", async () => {
    const { app } = makeServer();
    const created = await createReferral(app);
    const v = created.json().version;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${created.json().id}/triage`,
      headers: SUP,
      payload: { outcome: "eligible", ifVersion: v },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/referrals/${created.json().id}/triage`,
      headers: SUP,
      payload: { outcome: "eligible", ifVersion: v }, // stale
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("VERSION_MISMATCH");
    await app.close();
  });
});

describe("M6-T07 — §7.2 admission wizard + R-AC-01 activation gate", () => {
  it("W-AD-01: a fresh draft admission's activation gate lists all preconditions missing", async () => {
    const { app } = makeServer();
    const admissionId = await acceptedAdmission(app);
    const adm = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${admissionId}`,
      headers: SUP,
    });
    expect(adm.json().activationGate.ready).toBe(false);
    expect(adm.json().activationGate.missing).toEqual([
      "election_signed",
      "nor_acknowledged",
      "cti_signed",
      "attending_signed",
    ]);
    await app.close();
  });

  it("W-AD-02/03/04/05: completing the bundle flips the gate green and activate succeeds", async () => {
    const { app, backend } = makeServer();
    const admissionId = await acceptedAdmission(app);
    await completeBundle(app, admissionId);

    // Route 10 reads server-truth: the gate is now ready (W-AD-05 checklist == server preconditions).
    const gated = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${admissionId}`,
      headers: SUP,
    });
    expect(gated.json().activationGate).toEqual({ ready: true, missing: [] });
    expect(backend.events).toContain("m6.election.signed");
    expect(backend.events).toContain("m6.cti.signed");
    expect(backend.events).toContain("m6.nor.acknowledged");

    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${admissionId}/activate`,
      headers: SUP,
      payload: { ifVersion: gated.json().version },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().state).toBe("active");
    expect(backend.events).toContain("m6.admission.activated");
    await app.close();
  });

  it("edge: activating with NOR missing returns 412 PRECONDITION_FAILED { missing: ['nor_acknowledged'] }", async () => {
    const { app } = makeServer();
    const admissionId = await acceptedAdmission(app);
    await completeBundle(app, admissionId);

    // Re-run the whole bundle EXCEPT NOR by using a fresh admission and skipping the NOR step.
    const adm2 = await acceptedAdmission(app);
    const periods = await app.inject({
      method: "GET",
      url: `/api/v1/admissions/${adm2}/election-periods`,
      headers: SUP,
    });
    const periodId = periods.json().items[0].id as string;
    const stmt = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${adm2}/election-statements`,
      headers: SUP,
      payload: {
        electionPeriodId: periodId,
        effectiveDate: "2026-06-20",
        primaryDiagnosisIcd10: "C50.9",
        electedProviderEntityId: PROVIDER,
        waiverAcknowledged: true,
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/election-statements/${stmt.json().id}/sign`,
      headers: SUP,
      payload: {
        signingPatientName: "Jane Roe",
        signingRole: "patient",
        ifVersion: stmt.json().version,
      },
    });
    const cti = await app.inject({
      method: "POST",
      url: `/api/v1/election-periods/${periodId}/cti`,
      headers: SUP,
      payload: {
        hospiceMedicalDirectorId: MD_ID,
        attendingPhysicianId: ATTENDING,
        prognosisStatement: "p",
        narrative: "n",
        clinicalFindings: {},
        isRecert: false,
      },
    });
    const mdSigned = await app.inject({
      method: "POST",
      url: `/api/v1/cti/${cti.json().id}/sign-hospice-md`,
      headers: HOSPICE_MD,
      payload: {
        signingPhysicianName: "Dr. D",
        signingPhysicianNpi: "1234567893",
        ifVersion: cti.json().version,
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/cti/${cti.json().id}/sign-attending`,
      headers: ATTENDING_MD,
      payload: {
        signingPhysicianName: "Dr. A",
        signingPhysicianNpi: "1234567893",
        ifVersion: mdSigned.json().version,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admissions/${adm2}/activate`,
      headers: SUP,
      payload: { ifVersion: 1 },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("PRECONDITION_FAILED");
    expect(res.json().error.details.map((d: { field: string }) => d.field)).toEqual([
      "nor_acknowledged",
    ]);
    await app.close();
  });
});
