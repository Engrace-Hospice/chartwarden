// apps/backend/src/modules/06-admission/routes/admission-routes.ts — M6-T06 the §4.1 route inventory
// (46 routes; the §4.5 permission handshake; §4.6 ABAC; §6.3 reason-derived discharge permission).
//
// Every route is gated by the REAL Authorization Contract (`requirePermission` from @wardenx/auth,
// M3) on the §4.5 keys M6 registers into M3's catalog (M6_CONTRIBUTED_PERMISSIONS). Org binding is
// server-side (`request.context`, never the body). Handlers compose over the injected
// `AdmissionRouteService` (in-memory slice; Drizzle in prod under withOrgContext so RLS backstops).
//
// §6.3: route 39 (discharge) derives its permission key from `reason` server-side — a client cannot
// bypass the per-reason policy by changing the path. §4.6: the four role-gated signer/override
// predicates M6 owns are wired via `requireAbac` (routes 31/32/40/46); the scope + signer-identity
// predicates resolve through M6's registered resolvers (see abac-predicates.ts).
import {
  INTAKE_ROLE_KEYS,
  hasAdmittingClinicianRole,
  hasOrgWideScope,
  requireAbac,
  requireAnyAbac,
  requirePermission,
  resolveActorPermissions,
} from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { type AdmissionScopeResourceKind, M6_ROLE_PREDICATE_NAMES } from "../abac-predicates";
import {
  type DischargeDetailBodyIssue,
  checkPlaceOfDeathBody,
  checkTransferOutCareSettingBody,
  deriveDischargePermissionKey,
} from "../discharge";
import { AdmissionStateError } from "../state-machines/errors";
import { assertGipAttestations } from "../state-machines/level-of-care";
import {
  AdmissionActivateSchema,
  AdmissionCreateSchema,
  AdmissionHoldSchema,
  AdmissionListQuerySchema,
  AdmissionReadinessResponseSchema,
  AdmissionRecommendationSchema,
  AdmissionResumeSchema,
  AdmissionUpdateSchema,
  ComplianceCloseSchema,
  ComplianceListQuerySchema,
  ComplianceOverrideSchema,
  CtiDraftSchema,
  CtiMarkLateSchema,
  CtiSignSchema,
  CtiVoidSchema,
  DischargeCosignSchema,
  DischargeDeclineSchema,
  DischargeCreateSchema,
  ElectionPeriodCreateSchema,
  ElectionPeriodPatchSchema,
  ElectionSignSchema,
  ElectionStatementDraftSchema,
  ElectionVoidSchema,
  F2fAttestSchema,
  F2fCompleteSchema,
  F2fOverrideWindowSchema,
  F2fScheduleSchema,
  IdParamsSchema,
  LocChangeSchema,
  LocConfirmBedSchema,
  LocPatchSchema,
  NorAcknowledgeSchema,
  PatientIdParamsSchema,
  ReferralAcceptSchema,
  ReferralAssignSchema,
  ReferralConvertSchema,
  ReferralCreateSchema,
  ReferralDeclineSchema,
  ReferralListQuerySchema,
  ReferralNoteCreateSchema,
  ReferralPatientConfirmSchema,
  ReferralPatientCreateSchema,
  ReferralPatientMatchSchema,
  ReferralPendingInformationSchema,
  ReferralPrioritySchema,
  ReferralQualifySchema,
  ReferralReviewSchema,
  ReferralTerminalSchema,
  ReferralTriageSchema,
  ReferralUpdateSchema,
  RevocationCreateSchema,
  TransferInSchema,
  TransferOutSchema,
  UploadedCtiEvidenceSchema,
  UploadedElectionEvidenceSchema,
  UploadedNoticeOfRightsSchema,
  parse,
} from "./admission-typebox";
import { registerDischargeDetailsRoutes } from "./discharge-details-routes";
import type { DischargeDetailsService } from "./discharge-details-service";
import { registerDischargeWorklistRoutes } from "./discharge-worklist-routes";
import type { DischargeWorklistService } from "./discharge-worklist-service";
import { registerReadmissionRoutes } from "./readmission-routes";
import type { ReadmissionService } from "./readmission-service";
import {
  type AdmissionReadScope,
  type AdmissionRouteService,
  ResourceNotFoundError,
} from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AdmissionRouteDeps {
  service: AdmissionRouteService;
  /**
   * The after-the-fact discharge-details service (place of death / receiving care setting). Absent in slices
   * that do not need it — its routes then answer 503 DEGRADED rather than disappearing.
   */
  dischargeDetails?: DischargeDetailsService;
  /**
   * The end-of-episode worklist (the web "Discharge / transfer" hub). Absent in slices that do not need it — its
   * route then answers 503 DEGRADED.
   */
  dischargeWorklist?: DischargeWorklistService;
  /**
   * The readmission / new-admission benefit-period plan. Absent in slices that do not need it — its routes then
   * answer 503 DEGRADED.
   */
  readmission?: ReadmissionService;
  /**
   * The patients on a clinician's caseload (GAP-020) — defaults to M5's published `CaseloadProvider` seam.
   * `userId` is the M2 USER id (what `patient_assignment.clinician_user_id` keys on).
   */
  caseloadPatientIds?: (q: {
    organizationId: string;
    userId: string;
  }) => Promise<readonly string[]>;
}

type CaseloadLookup = NonNullable<AdmissionRouteDeps["caseloadPatientIds"]>;

const defaultCaseloadPatientIds: CaseloadLookup = (q) =>
  getSeam("CaseloadProvider").caseloadPatientIds(q);

/**
 * GAP-020 — the caseload narrowing the org-wide admission list applies. Org-wide scope roles are
 * unrestricted; everyone else sees their caseload plus the one patient a pinned session names.
 * Fail-CLOSED: a caseload that cannot be resolved narrows to the session patient (or nothing).
 */
async function readScopeOf(
  request: FastifyRequest,
  caseloadPatientIds: CaseloadLookup,
): Promise<AdmissionReadScope> {
  const ctx = request.context;
  if (hasOrgWideScope(ctx.roles)) return { patientIds: null };
  const pinned = ctx.attributes?.sessionPatientId;
  const sessionIds = typeof pinned === "string" && pinned.length > 0 ? [pinned] : [];
  if (!ctx.userId) return { patientIds: sessionIds };
  try {
    const caseload = await caseloadPatientIds({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
    return { patientIds: [...new Set([...caseload, ...sessionIds])] };
  } catch {
    return { patientIds: sessionIds };
  }
}

/**
 * The Readmit list's scope (discharge worklist `bucket=recently_discharged` ONLY). A readmission candidate's caseload
 * assignment has usually ended, so the census narrowing alone shows a nurse nothing to readmit. An `admission.create`
 * holder therefore also sees the bucket's rows that the readmission routes would let them open:
 *   • an intake role → org-wide (`admission_intake_scope`: every row of the bucket is a patient with no ongoing stay);
 *   • an admitting clinician (rn / lpn / md / np / pa …) → their own site (`admission_clinical_site_scope`).
 * Anyone else — and anyone without `admission.create` — keeps {@link readScopeOf}.
 */
async function readmissionScopeOf(
  request: FastifyRequest,
  caseloadPatientIds: CaseloadLookup,
): Promise<AdmissionReadScope> {
  const base = await readScopeOf(request, caseloadPatientIds);
  if (base.patientIds === null) return base;
  const ctx = request.context;
  const intake = INTAKE_ROLE_KEYS.some((role) => ctx.roles.includes(role));
  const clinician = hasAdmittingClinicianRole(ctx.roles);
  if (!intake && !clinician) return base;
  const granted = await resolveActorPermissions(ctx);
  if (!granted.has("admission.create")) return base;
  if (intake) return { patientIds: null };
  return {
    ...base,
    sites: { providerEntityIds: [...ctx.providerEntityIds], locationIds: [...ctx.locationIds] },
  };
}

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const idOf = (request: FastifyRequest): string => parse(IdParamsSchema, request.params).id;

// Static permission guards (§4.5). The discharge route derives its key dynamically (§6.3).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const REFERRAL_CREATE = P("referral.create");
const REFERRAL_READ = P("referral.read");
const REFERRAL_UPDATE = P("referral.update");
const REFERRAL_TRIAGE = P("referral.triage");
const REFERRAL_ACCEPT = P("referral.accept");
const REFERRAL_DECLINE = P("referral.decline");
const ADMISSION_CREATE = P("admission.create");
const ADMISSION_READ = P("admission.read");
const ADMISSION_UPDATE = P("admission.update");
const ADMISSION_HOLD = P("admission.hold");
const ADMISSION_ACTIVATE = P("admission.activate");
const ADMISSION_RECORD_RECOMMENDATION = P("admission.record_recommendation");
const ELECTION_DRAFT = P("election.draft");
const ELECTION_READ = P("election.read");
const ELECTION_SIGN = P("election.sign");
const ELECTION_VOID = P("election.void");
const CTI_DRAFT = P("cti.draft");
const CTI_READ = P("cti.read");
const CTI_SIGN_HOSPICE_MD = P("cti.sign_hospice_md");
const CTI_SIGN_ATTENDING = P("cti.sign_attending");
const CTI_VOID = P("cti.void");
const CTI_MARK_LATE = P("cti.mark_late");
const F2F_SCHEDULE = P("f2f.schedule");
const F2F_READ = P("f2f.read");
const F2F_COMPLETE = P("f2f.complete");
const F2F_ATTEST = P("f2f.attest");
const F2F_WINDOW_OVERRIDE = P("f2f.window_override");
const LOC_READ = P("loc.read");
const LOC_CHANGE = P("loc.change");
const REVOCATION_CREATE = P("revocation.create");
const TRANSFER_OUT = P("transfer.out");
const TRANSFER_IN = P("transfer.in");
const DISCHARGE_COSIGN = P("discharge.cosign_for_cause");
const NOR_ACKNOWLEDGE = P("nor.acknowledge");
const NOR_READ = P("nor.read");
const COMPLIANCE_READ = P("compliance.read");
const COMPLIANCE_CLOSE = P("compliance.close");
const COMPLIANCE_OVERRIDE = P("compliance.override");

// §4.6 role-gated ABAC guards (pure over context.roles).
const ABAC_F2F_ATTEST = requireAbac("f2f.attest", M6_ROLE_PREDICATE_NAMES.f2fAttest) as PreHandler;
const ABAC_F2F_OVERRIDE = requireAbac(
  "f2f.window_override",
  M6_ROLE_PREDICATE_NAMES.f2fWindowOverride,
) as PreHandler;
// 42 CFR 418.26(b) — the cosigner must be in the discharge-order signer set for THIS discharge's date/chart.
const ABAC_DISCHARGE_ORDER_SIGNER = requireAbac(
  "discharge.cosign_for_cause",
  M6_ROLE_PREDICATE_NAMES.dischargeOrderSigner,
) as PreHandler;
const ABAC_COMPLIANCE_OVERRIDE = requireAbac(
  "compliance.override",
  M6_ROLE_PREDICATE_NAMES.complianceWindowOverride,
) as PreHandler;

// GAP-011 — the six §4.6 resource-bound predicates (referral.scope, admission.scope, cti.is_hospice_md,
// cti.is_attending, f2f.is_hospice_clinician, compliance.scope — the "orphaned" ones abac-predicates.ts
// registers but no route wired) now wired on every detail/mutate route the §4.1 table maps them to.
// LIST routes (2, 9, 44) are deliberately NOT gated this way: `requireAbac`'s target is a single
// resource id (defaultTarget = request.params), so there is no `:id` for a list route to scope
// against — narrowing a LIST's rows to the caller's caseload is a query-level filtering concern, not a
// boolean allow/deny gate. GAP-020 does that for GET /admissions (`readScopeOf`); the referral lists
// are not patient-keyed and stay RBAC + RLS only.

// `notFoundOnDeny: true` on every resource-scope guard below (§2.2 existence non-leak): the resolvers
// return the SAME "no facts" signal whether a target id is absent, cross-tenant (RLS-backstopped), or
// simply outside the caller's caseload — collapsing all three into 404 keeps that pre-existing §6.6
// non-leak property (a plain 403 here would newly let an actor distinguish "exists, not yours" from
// "doesn't exist", which the org-scoped GET routes never leaked before this fix wired a gate in front
// of them).

/** `referral.scope` — every referral route's `:id` is already a referral id (native target). */
const referralScope = (action: string): PreHandler =>
  requireAbac(action, "referral.scope", { notFoundOnDeny: true }) as PreHandler;

/**
 * `admission.scope` — most routes' `:id` IS an admission id (the default); a route keyed by a CHILD
 * resource (election period/statement, CTI, F2F, LOC period, compliance window) passes `resourceKind`
 * so the predicate resolves scope through the resource's OWNING admission (abac-predicates.ts).
 */
const admissionScope = (
  action: string,
  resourceKind: AdmissionScopeResourceKind = "admission",
): PreHandler =>
  requireAbac(action, "admission.scope", {
    notFoundOnDeny: true,
    ...(resourceKind === "admission"
      ? {}
      : {
          getTarget: (request) => ({
            ...(typeof request.params === "object" && request.params ? request.params : {}),
            resourceKind,
          }),
        }),
  }) as PreHandler;

/**
 * GAP-020 — §7.5 per-chart scope for the PATIENT-keyed routes (`:patientId` path param, or `patientId`
 * in the POST /admissions body). `caseload_or_scope` is M7's predicate, bound BY NAME (no import edge,
 * the M5 `chartScope` pattern): it allows an org-wide oversight role, a session pinned to this patient,
 * or an open caseload assignment; a miss is a 404 (`notFoundOnDeny`) so a refusal never confirms the
 * chart exists. The patient-keyed GETs previously returned `{ items: [] }` for an unknown patient; an
 * out-of-scope caller now gets the same 404 as an absent one, which is the intended non-leak.
 */
const patientScope = (action: string, source: "params" | "body"): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    notFoundOnDeny: true,
    getTarget: (request) => {
      const raw = source === "params" ? request.params : request.body;
      const patientId = (raw as { patientId?: unknown } | null | undefined)?.patientId;
      return { patientId };
    },
  }) as PreHandler;

/** The patient id a patient-keyed guard targets (`:patientId` path param, or the POST /admissions body). */
const patientIdOf = (raw: unknown): unknown =>
  (raw as { patientId?: unknown } | null | undefined)?.patientId;

/**
 * The new-admission / readmission routes ONLY: `caseload_or_scope` OR `admission_intake_scope` OR
 * `admission_clinical_site_scope`. An intake user (intake_coordinator / intake_supervisor) works on patients who are
 * not on anyone's caseload yet, so the caseload predicate alone 404'd the readmission plan and the create for them.
 * `admission_intake_scope` (abac-predicates.ts) opens the route only for an intake role, a patient of the caller's
 * org, and a patient with no active / on-hold admission. `admission_clinical_site_scope` opens it for a nurse /
 * physician / NP / PA at the patient's own site (a former patient's caseload assignment has ended by the time they
 * are readmitted). Same `notFoundOnDeny` non-leak as `patientScope`. Every other patient-keyed route keeps
 * `patientScope` alone.
 */
/** The earlier stay a POST /admissions body names as its readmission source (`readmittedFromAdmissionId`). */
const priorAdmissionIdOf = (raw: unknown): unknown =>
  (raw as { readmittedFromAdmissionId?: unknown } | null | undefined)?.readmittedFromAdmissionId;

const patientOrIntakeScope = (action: string, source: "params" | "body"): PreHandler =>
  requireAnyAbac(
    action,
    ["caseload_or_scope", "admission_intake_scope", "admission_clinical_site_scope"],
    {
      notFoundOnDeny: true,
      getTarget: (request) => {
        if (source === "params") return { patientId: patientIdOf(request.params) };
        // The body's readmission source travels as `priorAdmissionId` — only the clinical site predicate reads it
        // (and requires it to be the SAME patient's stay); the other two keep keying off `patientId` alone.
        const prior = priorAdmissionIdOf(request.body);
        return {
          patientId: patientIdOf(request.body),
          ...(prior !== undefined ? { priorAdmissionId: prior } : {}),
        };
      },
    },
  ) as PreHandler;

/**
 * `GET /admissions/:id/readmission-context` ONLY: `admission.scope` OR `admission_intake_scope` OR
 * `admission_clinical_site_scope` over the earlier stay `:id` (the last two resolve it to its patient).
 */
const admissionOrIntakeScope = (action: string): PreHandler =>
  requireAnyAbac(
    action,
    ["admission.scope", "admission_intake_scope", "admission_clinical_site_scope"],
    {
      notFoundOnDeny: true,
      getTarget: (request) => {
        const params = (
          typeof request.params === "object" && request.params ? request.params : {}
        ) as Record<string, unknown>;
        return { ...params, admissionId: params.id };
      },
    },
  ) as PreHandler;

// The three signer-identity predicates (target = the CTI/F2F id itself, the native `loadCti`/`loadF2f`
// shape — no `resourceKind` involved).
const ABAC_CTI_HOSPICE_MD = requireAbac("cti.sign_hospice_md", "cti.is_hospice_md") as PreHandler;
const ABAC_CTI_ATTENDING = requireAbac("cti.sign_attending", "cti.is_attending") as PreHandler;
const ABAC_F2F_CLINICIAN = requireAbac("f2f.complete", "f2f.is_hospice_clinician") as PreHandler;

/**
 * §6.3 — derive route 39's permission from the body `reason` server-side (the `discharge/` submodule is
 * the single source of truth for the reason→key map). A client cannot bypass the per-reason policy by
 * changing the path; an absent/unrecognised reason falls back to the broadest `discharge.create` gate.
 */
function dischargeReasonGuard(): PreHandler {
  return async (request, reply) => {
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    const key = deriveDischargePermissionKey(reason);
    await (requirePermission(key) as PreHandler)(request, reply);
  };
}

/** The claim-relevant field prechecks (transfer-out care setting, place of death) as a field-scoped 422. */
function throwBodyIssue(issue: DischargeDetailBodyIssue | null): void {
  if (!issue) return;
  throw new AdmissionStateError(issue.code, issue.message, [
    { field: issue.field, code: issue.code, message: issue.message },
  ]);
}

const notFound = (id: string): never => {
  throw new ResourceNotFoundError(id);
};

export function registerAdmissionRoutes(app: FastifyInstance, deps: AdmissionRouteDeps): void {
  const { service } = deps;
  const caseloadPatientIds = deps.caseloadPatientIds ?? defaultCaseloadPatientIds;
  // After-the-fact claim details (place of death / receiving care setting) — own registrar + service.
  registerDischargeDetailsRoutes(app, { service: deps.dischargeDetails });
  // The end-of-episode worklist — same caseload narrowing as the census.
  registerDischargeWorklistRoutes(app, {
    service: deps.dischargeWorklist,
    readScope: (request) => readScopeOf(request, caseloadPatientIds),
    readmissionScope: (request) => readmissionScopeOf(request, caseloadPatientIds),
  });
  // The benefit-period plan behind the readmission screen and the New admission benefit-period field.
  registerReadmissionRoutes(app, {
    service: deps.readmission,
    admissionGuards: [ADMISSION_READ, admissionOrIntakeScope("admission.read")],
    patientGuards: [ADMISSION_READ, patientOrIntakeScope("admission.read", "params")],
  });

  // ── Referral (routes 1–7) ──────────────────────────────────────────────────────────────────
  app.post("/api/v1/referrals", { preHandler: [REFERRAL_CREATE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(ReferralCreateSchema, request.body);
    const res = await service.createReferral(organizationId, body, userId);
    return reply.code(201).send(res);
  });

  app.get(
    "/api/v1/referrals",
    {
      preHandler: [REFERRAL_READ],
      config: { auditRead: { resourceKind: "referral", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const q = parse(ReferralListQuerySchema, request.query);
      return service.listReferrals(organizationId, q, userId);
    },
  );

  app.get(
    "/api/v1/referrals/:id",
    {
      preHandler: [REFERRAL_READ, referralScope("referral.read")],
      config: {
        auditRead: { resourceKind: "referral", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getReferral(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.patch(
    "/api/v1/referrals/:id",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ReferralUpdateSchema, request.body);
      return service.updateReferral(organizationId, idOf(request), body, body.ifVersion);
    },
  );

  app.post(
    "/api/v1/referrals/:id/review",
    { preHandler: [REFERRAL_TRIAGE, referralScope("referral.triage")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralReviewSchema, request.body);
      return service.startReferralReview(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/referrals/:id/patient-matches",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralPatientMatchSchema, request.body);
      return service.runReferralPatientMatching(
        organizationId,
        idOf(request),
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/confirm-patient",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralPatientConfirmSchema, request.body);
      return service.confirmReferralPatient(
        organizationId,
        idOf(request),
        body.patientId,
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/create-patient",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralPatientCreateSchema, request.body);
      return service.createReferralPatient(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/referrals/:id/qualify",
    { preHandler: [REFERRAL_ACCEPT, referralScope("referral.accept")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralQualifySchema, request.body);
      return service.qualifyReferral(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/referrals/:id/triage",
    { preHandler: [REFERRAL_TRIAGE, referralScope("referral.triage")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ReferralTriageSchema, request.body);
      return service.triageReferral(organizationId, idOf(request), body.outcome, body.ifVersion);
    },
  );

  app.post(
    "/api/v1/referrals/:id/accept",
    { preHandler: [REFERRAL_ACCEPT, referralScope("referral.accept")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralAcceptSchema, request.body);
      return service.acceptReferral(
        organizationId,
        idOf(request),
        {
          patientId: body.patientId,
          primaryDiagnosisIcd10: body.primaryDiagnosisIcd10,
          attendingPhysicianId: body.attendingPhysicianId,
          benefitPeriod: body.benefitPeriod,
          f2fException: body.f2fException,
          admissionDate: body.admissionDate,
        },
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/convert",
    { preHandler: [REFERRAL_ACCEPT, referralScope("referral.accept")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralConvertSchema, request.body);
      return service.convertReferral(
        organizationId,
        idOf(request),
        {
          patientId: body.patientId,
          primaryDiagnosisIcd10: body.primaryDiagnosisIcd10,
          attendingPhysicianId: body.attendingPhysicianId,
          benefitPeriod: body.benefitPeriod,
          f2fException: body.f2fException,
          admissionDate: body.admissionDate,
        },
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/decline",
    { preHandler: [REFERRAL_DECLINE, referralScope("referral.decline")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ReferralDeclineSchema, request.body);
      return service.declineReferral(organizationId, idOf(request), body.reason, body.ifVersion);
    },
  );

  app.post(
    "/api/v1/referrals/:id/notes",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralNoteCreateSchema, request.body);
      const res = await service.addReferralNote(organizationId, idOf(request), body, userId);
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/referrals/:id/notes",
    {
      preHandler: [REFERRAL_READ, referralScope("referral.read")],
      config: {
        auditRead: { resourceKind: "referral_note", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return {
        items: await service.listReferralNotes(organizationId, idOf(request)),
      };
    },
  );

  app.get(
    "/api/v1/referrals/:id/activity",
    {
      preHandler: [REFERRAL_READ, referralScope("referral.read")],
      config: {
        auditRead: { resourceKind: "referral_activity", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return {
        items: await service.listReferralActivity(organizationId, idOf(request)),
      };
    },
  );

  app.post(
    "/api/v1/referrals/:id/priority",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralPrioritySchema, request.body);
      return service.updateReferralPriority(
        organizationId,
        idOf(request),
        body.priority,
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/assign",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralAssignSchema, request.body);
      return service.assignReferral(
        organizationId,
        idOf(request),
        body.assignedToUserId,
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/pending-information",
    { preHandler: [REFERRAL_UPDATE, referralScope("referral.update")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralPendingInformationSchema, request.body);
      return service.markReferralPendingInformation(
        organizationId,
        idOf(request),
        body.reason,
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/duplicate",
    { preHandler: [REFERRAL_DECLINE, referralScope("referral.decline")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralTerminalSchema, request.body);
      return service.markReferralDuplicate(
        organizationId,
        idOf(request),
        body.reason,
        body.ifVersion,
        userId,
      );
    },
  );

  app.post(
    "/api/v1/referrals/:id/withdraw",
    { preHandler: [REFERRAL_DECLINE, referralScope("referral.decline")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReferralTerminalSchema, request.body);
      return service.withdrawReferral(
        organizationId,
        idOf(request),
        body.reason,
        body.ifVersion,
        userId,
      );
    },
  );

  // ── Admission (routes 8–14) ────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admissions",
    { preHandler: [ADMISSION_CREATE, patientOrIntakeScope("admission.create", "body")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(AdmissionCreateSchema, request.body);
      const res = await service.createAdmission(organizationId, body, userId);
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/admissions",
    {
      preHandler: [ADMISSION_READ],
      config: { auditRead: { resourceKind: "admission", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AdmissionListQuerySchema, request.query);
      return service.listAdmissions(
        organizationId,
        q,
        await readScopeOf(request, caseloadPatientIds),
      );
    },
  );

  app.get(
    "/api/v1/admissions/:id",
    {
      preHandler: [ADMISSION_READ, admissionScope("admission.read")],
      config: {
        auditRead: { resourceKind: "admission", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getAdmission(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.get(
    "/api/v1/admissions/:id/readiness",
    {
      preHandler: [ADMISSION_READ, admissionScope("admission.read")],
      schema: { response: { 200: AdmissionReadinessResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "admission_readiness",
          resourceIdParam: "id",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getAdmissionReadiness(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  // F-065 — the patient's admissions, newest first. Every clinical CREATE in this platform is keyed by
  // `admissionId` (a medication order, an encounter, a care-plan version), and nothing could resolve one
  // for a patient: `GET /api/v1/admissions` is an org-wide census that takes no patient filter and whose
  // items carry `{ id, state, version }` with no `patientId`, and `GET /api/v1/patients/:id` carries no
  // admission. So the id had to come from a row that already had one — fine for acting on an existing
  // record, impossible for creating the first one. The two workarounds in the tree name it: M07's
  // `screens.ts` declines to offer plan creation ("a 'create care plan' button would need an admissionId
  // this screen does not read"), and M24's claim-assembly wizard renders a raw text input for it.
  //
  // Gated by `admission.read`; a patient with no admissions returns an empty list, never a 404 — an
  // empty list is the truthful answer and a 404 would leak whether the patient exists.
  app.get(
    "/api/v1/patients/:patientId/admissions",
    {
      preHandler: [ADMISSION_READ, patientScope("admission.read", "params")],
      config: {
        auditRead: { resourceKind: "admission", patientIdParam: "patientId", list: true },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return { items: await service.listPatientAdmissions(organizationId, patientId) };
    },
  );

  // Patient-scoped Election & Certification aggregate — the patient-chart "Election & Certification"
  // tab. Gated by `election.read`; a patient with no admission returns a truthful empty (admission null),
  // never a 404. RLS scopes every underlying read to the caller's org.
  app.get(
    "/api/v1/patients/:patientId/election-certification",
    {
      preHandler: [ELECTION_READ, patientScope("election.read", "params")],
      config: {
        auditRead: {
          resourceKind: "election_certification",
          patientIdParam: "patientId",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return service.getPatientElectionCertification(organizationId, patientId);
    },
  );

  app.patch(
    "/api/v1/admissions/:id",
    { preHandler: [ADMISSION_UPDATE, admissionScope("admission.update")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(AdmissionUpdateSchema, request.body);
      return service.updateAdmission(
        organizationId,
        idOf(request),
        {
          admissionAt: body.admissionAt,
          hospicePhysicianId: body.hospicePhysicianId,
          attendingPhysicianId: body.attendingPhysicianId,
          providerEntityId: body.providerEntityId,
          locationId: body.locationId,
        },
        body.ifVersion,
      );
    },
  );

  app.post(
    "/api/v1/admissions/:id/hold",
    { preHandler: [ADMISSION_HOLD, admissionScope("admission.hold")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(AdmissionHoldSchema, request.body);
      return service.holdAdmission(organizationId, idOf(request), body.reason, body.ifVersion);
    },
  );

  app.post(
    "/api/v1/admissions/:id/resume",
    { preHandler: [ADMISSION_HOLD, admissionScope("admission.hold")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(AdmissionResumeSchema, request.body);
      return service.resumeAdmission(organizationId, idOf(request), body.ifVersion);
    },
  );

  app.post(
    "/api/v1/admissions/:id/activate",
    { preHandler: [ADMISSION_ACTIVATE, admissionScope("admission.activate")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(AdmissionActivateSchema, request.body);
      return service.activateAdmission(organizationId, idOf(request), body.ifVersion, {
        locationId: body.locationId,
      });
    },
  );

  // ── 42 CFR 418.25(a) physician admission recommendation + the 418.25/418.26 signer picker ──────────
  app.post(
    "/api/v1/admissions/:id/admission-recommendation",
    {
      preHandler: [
        ADMISSION_RECORD_RECOMMENDATION,
        admissionScope("admission.record_recommendation"),
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(AdmissionRecommendationSchema, request.body);
      return service.recordAdmissionRecommendation(
        organizationId,
        idOf(request),
        {
          recommendedByUserId: body.recommendedByUserId,
          recommendedAt: body.recommendedAt,
          capacity: body.capacity,
          attendingConsulted: body.attendingConsulted,
          attendingConsultNote: body.attendingConsultNote,
        },
        body.ifVersion,
        userId,
      );
    },
  );

  app.get(
    "/api/v1/admissions/:id/discharge-order",
    {
      preHandler: [ADMISSION_READ, admissionScope("admission.read")],
      config: { auditRead: { resourceKind: "discharge", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const id = idOf(request);
      return (await service.getDischargeOrder(organizationId, id)) ?? notFound(id);
    },
  );

  app.get(
    "/api/v1/admissions/:id/physician-signers",
    {
      preHandler: [ADMISSION_READ, admissionScope("admission.read")],
      config: {
        auditRead: {
          none: "staff directory (physician user ids, names, signer capacities) — no patient data is returned",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const id = idOf(request);
      return (await service.listPhysicianSigners(organizationId, id)) ?? notFound(id);
    },
  );

  // ── Election statement & period (routes 15–21) ───────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/election-statements",
    { preHandler: [ELECTION_DRAFT, admissionScope("election.draft")] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(ElectionStatementDraftSchema, request.body);
      const res = await service.draftElectionStatement(
        organizationId,
        idOf(request),
        body.electionPeriodId,
        {
          electedProviderEntityId: body.electedProviderEntityId,
          ...(body.electedAttendingPhysicianId
            ? { electedAttendingPhysicianId: body.electedAttendingPhysicianId }
            : {}),
          waiverAcknowledged: body.waiverAcknowledged,
          ...(body.stateAddendum === undefined ? {} : { stateAddendum: body.stateAddendum }),
        },
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/election-statements/:id",
    {
      preHandler: [ELECTION_READ, admissionScope("election.read", "electionStatement")],
      config: {
        auditRead: {
          resourceKind: "election_statement",
          resourceIdParam: "id",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getElectionStatement(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.post(
    "/api/v1/election-statements/:id/sign",
    {
      preHandler: [ELECTION_SIGN, admissionScope("election.sign", "electionStatement")],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ElectionSignSchema, request.body);
      return service.signElection(organizationId, idOf(request), body.ifVersion, userId, {
        signingPatientName: body.signingPatientName,
        signingRole: body.signingRole,
      });
    },
  );

  app.post(
    "/api/v1/election-statements/:id/void",
    {
      preHandler: [ELECTION_VOID, admissionScope("election.void", "electionStatement")],
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ElectionVoidSchema, request.body);
      return service.voidElection(organizationId, idOf(request), body.reason, body.ifVersion);
    },
  );

  app.post(
    "/api/v1/election-periods/:id/election-statement/uploaded-evidence",
    {
      preHandler: [ELECTION_DRAFT, admissionScope("election.draft", "electionPeriod")],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(UploadedElectionEvidenceSchema, request.body);
      const res = await service.attachUploadedElectionStatement(
        organizationId,
        idOf(request),
        body,
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/election-statements/:id/sign/uploaded-evidence",
    {
      preHandler: [ELECTION_SIGN, admissionScope("election.sign", "electionStatement")],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(UploadedElectionEvidenceSchema, request.body);
      const res = await service.attachUploadedElectionSignature(
        organizationId,
        idOf(request),
        { ...body, documentState: "signed" },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/admissions/:id/election-periods",
    {
      preHandler: [ELECTION_READ, admissionScope("election.read")],
      config: {
        auditRead: { resourceKind: "election_period", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const rows = await service.listElectionPeriods(organizationId, idOf(request));
      return rows === null ? notFound(idOf(request)) : { items: rows };
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-periods",
    { preHandler: [ELECTION_DRAFT, admissionScope("election.draft")] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      parse(ElectionPeriodCreateSchema, request.body);
      const res = await service.createElectionPeriod(organizationId, idOf(request));
      return reply.code(201).send(res);
    },
  );

  app.patch(
    "/api/v1/election-periods/:id",
    {
      preHandler: [ELECTION_DRAFT, admissionScope("election.draft", "electionPeriod")],
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ElectionPeriodPatchSchema, request.body);
      return service.patchElectionPeriod(organizationId, idOf(request), body.ifVersion);
    },
  );

  // ── CTI (routes 22–27) ───────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/election-periods/:id/cti",
    { preHandler: [CTI_DRAFT, admissionScope("cti.draft", "electionPeriod")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CtiDraftSchema, request.body);
      const res = await service.draftCti(
        organizationId,
        {
          electionPeriodId: idOf(request),
          hospiceMedicalDirectorId: body.hospiceMedicalDirectorId,
          attendingPhysicianId: body.attendingPhysicianId,
          terminalDiagnosisIcd10: body.terminalDiagnosisIcd10,
          secondaryDiagnoses: body.secondaryDiagnoses,
          prognosisStatement: body.prognosisStatement,
          narrative: body.narrative,
          clinicalFindings: body.clinicalFindings,
          isRecert: body.isRecert,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/election-periods/:id/cti/uploaded-evidence",
    { preHandler: [CTI_DRAFT, admissionScope("cti.draft", "electionPeriod")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(UploadedCtiEvidenceSchema, request.body);
      const res = await service.attachUploadedCti(organizationId, idOf(request), body, userId);
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/cti/:id",
    {
      preHandler: [CTI_READ, admissionScope("cti.read", "cti")],
      config: { auditRead: { resourceKind: "cti", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getCti(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.post(
    "/api/v1/cti/:id/sign-hospice-md",
    { preHandler: [CTI_SIGN_HOSPICE_MD, ABAC_CTI_HOSPICE_MD] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CtiSignSchema, request.body);
      return service.signCtiHospiceMd(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/cti/:id/sign-attending",
    { preHandler: [CTI_SIGN_ATTENDING, ABAC_CTI_ATTENDING] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CtiSignSchema, request.body);
      return service.signCtiAttending(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/cti/:id/void",
    { preHandler: [CTI_VOID, admissionScope("cti.void", "cti")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(CtiVoidSchema, request.body);
      return service.voidCti(organizationId, idOf(request), body.reason, body.ifVersion);
    },
  );

  app.post(
    "/api/v1/cti/:id/mark-late",
    { preHandler: [CTI_MARK_LATE, admissionScope("cti.mark_late", "cti")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(CtiMarkLateSchema, request.body);
      return service.markCtiLate(organizationId, idOf(request), body.ifVersion);
    },
  );

  // ── F2F (routes 28–32) ─────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/face-to-face",
    { preHandler: [F2F_SCHEDULE, admissionScope("f2f.schedule")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(F2fScheduleSchema, request.body);
      const res = await service.scheduleF2f(organizationId, {
        // GAP-022 — `clinicianRole` is only a claim; the service derives the real role from the
        // clinician's grants and refuses a claim they do not hold.
        actor: { kind: "user", userId },
        admissionId: idOf(request),
        electionPeriodId: body.electionPeriodId,
        scheduledClinicianId: body.scheduledClinicianId,
        clinicianRole: body.clinicianRole,
        scheduledDate: body.scheduledDate,
      });
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/face-to-face/:id",
    {
      preHandler: [F2F_READ, admissionScope("f2f.read", "f2f")],
      config: {
        auditRead: { resourceKind: "face_to_face", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getF2f(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.post(
    "/api/v1/face-to-face/:id/complete",
    { preHandler: [F2F_COMPLETE, ABAC_F2F_CLINICIAN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(F2fCompleteSchema, request.body);
      return service.completeF2f(
        organizationId,
        idOf(request),
        body.ifVersion,
        body.encounterDate,
        {
          encounterLocation: body.encounterLocation,
          telehealthEligibility: body.telehealthEligibility ?? null,
        },
      );
    },
  );

  app.post(
    "/api/v1/face-to-face/:id/attest",
    { preHandler: [F2F_ATTEST, ABAC_F2F_ATTEST] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(F2fAttestSchema, request.body);
      return service.attestF2f(
        organizationId,
        idOf(request),
        body.ifVersion,
        userId,
        body.attestationNarrative ?? null,
        body.signedNoteEncounterId ?? null,
      );
    },
  );

  app.post(
    "/api/v1/face-to-face/:id/override-window",
    { preHandler: [F2F_WINDOW_OVERRIDE, ABAC_F2F_OVERRIDE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(F2fOverrideWindowSchema, request.body);
      return service.overrideF2fWindow(
        organizationId,
        idOf(request),
        body.reason,
        body.ifVersion,
        userId,
      );
    },
  );

  // ── Level of care (routes 33–35) ─────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/level-of-care",
    { preHandler: [LOC_CHANGE, admissionScope("loc.change")] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(LocChangeSchema, request.body);
      assertGipAttestations(body.newLevel, body.gipAttestations);
      const res = await service.changeLoc(
        organizationId,
        idOf(request),
        body.newLevel,
        body.facilityId ?? null,
        body.effectiveStart,
        body.reason,
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/admissions/:id/level-of-care",
    {
      preHandler: [LOC_READ, admissionScope("loc.read")],
      config: {
        auditRead: { resourceKind: "level_of_care", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const rows = await service.listLoc(organizationId, idOf(request));
      return rows === null ? notFound(idOf(request)) : { items: rows };
    },
  );

  app.patch(
    "/api/v1/level-of-care/:id",
    { preHandler: [LOC_CHANGE, admissionScope("loc.change", "loc")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(LocPatchSchema, request.body);
      return service.patchLoc(organizationId, idOf(request), body.reason, body.ifVersion);
    },
  );

  // The §2.3.5 confirm handshake (M6-T04 fix, 2026-08-05): IRC/GIP periods land in `assigning` until this
  // fires; it verifies a real M37 bed assignment exists (never trusts a caller-supplied bed id) before
  // transitioning to `active`.
  app.post(
    "/api/v1/level-of-care/:id/confirm-bed",
    { preHandler: [LOC_CHANGE, admissionScope("loc.change", "loc")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(LocConfirmBedSchema, request.body);
      return service.confirmLocBedAssignment(organizationId, idOf(request), body.ifVersion);
    },
  );

  // ── Revocation / transfer / discharge (routes 36–40) ─────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/revocation",
    { preHandler: [REVOCATION_CREATE, admissionScope("revocation.create")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(RevocationCreateSchema, request.body);
      const res = await service.createRevocation(
        organizationId,
        idOf(request),
        {
          revocationDate: body.revocationDate,
          narrative: body.narrative,
          signingPatientName: body.signingPatientName,
          signingRole: body.signingRole,
          revocationReason: body.revocationReason,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/admissions/:id/transfer-out",
    { preHandler: [TRANSFER_OUT, admissionScope("transfer.out")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      throwBodyIssue(checkTransferOutCareSettingBody(request.body));
      const body = parse(TransferOutSchema, request.body);
      const res = await service.transferOut(
        organizationId,
        idOf(request),
        {
          effectiveDate: body.effectiveDate,
          otherHospiceName: body.otherHospiceName,
          otherHospiceCcn: body.otherHospiceCcn,
          receivingCareSetting: body.receivingCareSetting,
          narrative: body.narrative,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/admissions/:id/transfer-in",
    { preHandler: [TRANSFER_IN, admissionScope("transfer.in")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(TransferInSchema, request.body);
      const res = await service.transferIn(
        organizationId,
        idOf(request),
        {
          priorBenefitPeriodSequence: body.priorBenefitPeriodSequence,
          priorElectionStartDate: body.priorElectionStartDate,
          hospiceMedicalDirectorId: body.hospiceMedicalDirectorId,
          attendingPhysicianId: body.attendingPhysicianId,
          effectiveDate: body.effectiveDate,
          otherHospiceName: body.otherHospiceName,
          otherHospiceCcn: body.otherHospiceCcn,
          otherHospiceNpi: body.otherHospiceNpi,
          narrative: body.narrative,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  // §6.3: the permission key is derived from `reason` server-side (dischargeReasonGuard).
  app.post(
    "/api/v1/admissions/:id/discharge",
    // GAP-121 — the discharge is a chart-scoped write: the reason-derived permission AND `admission.scope`
    // (a same-org clinician outside the patient's caseload gets the non-leaking 404).
    { preHandler: [dischargeReasonGuard(), admissionScope("discharge.create")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      throwBodyIssue(checkPlaceOfDeathBody(request.body));
      const body = parse(DischargeCreateSchema, request.body);
      const res = await service.discharge(
        organizationId,
        idOf(request),
        {
          reason: body.reason,
          dischargeDate: body.dischargeDate,
          narrative: body.narrative,
          forCauseReason: body.forCauseReason,
          deathCertifierId: body.deathCertifierId,
          dischargeOrder: body.dischargeOrder,
          placeOfDeath: body.placeOfDeath,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/discharges/:id/cosign-for-cause",
    { preHandler: [DISCHARGE_COSIGN, ABAC_DISCHARGE_ORDER_SIGNER] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(DischargeCosignSchema, request.body);
      return service.cosignDischarge(
        organizationId,
        idOf(request),
        {
          cosignerName: body.cosignerName,
          cosignerNpi: body.cosignerNpi,
          // 42 CFR 418.26(b) — the signer's capacity is judged on the SERVER-derived roles, never the body.
          actorRoleKeys: request.context?.roles ?? [],
          capacity: body.capacity,
          orderText: body.orderText,
          orderReference: body.orderReference,
        },
        body.ifVersion,
        userId,
      );
    },
  );

  // GAP-121 — the other half of the two-person control: the director declines instead of cosigning. The
  // discharge is voided and the admission stays active. Same permission + signer-set predicate as the cosign.
  app.post(
    "/api/v1/discharges/:id/decline-for-cause",
    { preHandler: [DISCHARGE_COSIGN, ABAC_DISCHARGE_ORDER_SIGNER] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(DischargeDeclineSchema, request.body);
      return service.declineDischarge(
        organizationId,
        idOf(request),
        { declineReason: body.declineReason },
        body.ifVersion,
        userId,
      );
    },
  );

  // ── NOR (routes 41–42) ─────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/nor",
    { preHandler: [NOR_ACKNOWLEDGE, admissionScope("nor.acknowledge")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(NorAcknowledgeSchema, request.body);
      const res = await service.acknowledgeNor(
        organizationId,
        idOf(request),
        {
          deliveryMethod: body.deliveryMethod,
          acknowledgedByRole: body.acknowledgedByRole,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/admissions/:id/nor/uploaded-evidence",
    { preHandler: [NOR_ACKNOWLEDGE, admissionScope("nor.acknowledge")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(UploadedNoticeOfRightsSchema, request.body);
      const res = await service.attachUploadedNoticeOfRights(
        organizationId,
        idOf(request),
        body,
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/admissions/:id/nor",
    {
      preHandler: [NOR_READ, admissionScope("nor.read")],
      config: { auditRead: { resourceKind: "nor", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getNor(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  // ── Compliance windows (routes 43–46) ────────────────────────────────────────────────────────
  app.get(
    "/api/v1/admissions/:id/compliance-windows",
    {
      preHandler: [COMPLIANCE_READ, admissionScope("compliance.read")],
      config: {
        auditRead: { resourceKind: "compliance_window", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const rows = await service.listComplianceWindowsForAdmission(organizationId, idOf(request));
      return rows === null ? notFound(idOf(request)) : { items: rows };
    },
  );

  app.get(
    "/api/v1/compliance-windows",
    {
      preHandler: [COMPLIANCE_READ],
      config: { auditRead: { resourceKind: "compliance_window", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ComplianceListQuerySchema, request.query);
      return service.listComplianceWindows(organizationId, q);
    },
  );

  app.post(
    "/api/v1/compliance-windows/:id/close",
    {
      preHandler: [COMPLIANCE_CLOSE, admissionScope("compliance.close", "complianceWindow")],
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ComplianceCloseSchema, request.body);
      return service.closeComplianceWindow(organizationId, idOf(request), body.ifVersion);
    },
  );

  app.post(
    "/api/v1/compliance-windows/:id/override",
    { preHandler: [COMPLIANCE_OVERRIDE, ABAC_COMPLIANCE_OVERRIDE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ComplianceOverrideSchema, request.body);
      return service.overrideComplianceWindow(
        organizationId,
        idOf(request),
        body.reason,
        body.ifVersion,
        userId,
      );
    },
  );
}
