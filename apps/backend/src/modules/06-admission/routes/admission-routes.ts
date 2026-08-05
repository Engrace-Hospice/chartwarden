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
import { requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { M6_ROLE_PREDICATE_NAMES } from "../abac-predicates";
import { deriveDischargePermissionKey } from "../discharge";
import {
  AdmissionActivateSchema,
  AdmissionCreateSchema,
  AdmissionHoldSchema,
  AdmissionListQuerySchema,
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
  ReferralCreateSchema,
  ReferralDeclineSchema,
  ReferralListQuerySchema,
  ReferralTriageSchema,
  ReferralUpdateSchema,
  RevocationCreateSchema,
  TransferInSchema,
  TransferOutSchema,
  parse,
} from "./admission-typebox";
import { type AdmissionRouteService, ResourceNotFoundError } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AdmissionRouteDeps {
  service: AdmissionRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
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
const ABAC_DISCHARGE_MD = requireAbac(
  "discharge.cosign_for_cause",
  M6_ROLE_PREDICATE_NAMES.dischargeMedicalDirector,
) as PreHandler;
const ABAC_COMPLIANCE_OVERRIDE = requireAbac(
  "compliance.override",
  M6_ROLE_PREDICATE_NAMES.complianceWindowOverride,
) as PreHandler;

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

const notFound = (id: string): never => {
  throw new ResourceNotFoundError(id);
};

export function registerAdmissionRoutes(app: FastifyInstance, deps: AdmissionRouteDeps): void {
  const { service } = deps;

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
      const { organizationId } = actorOf(request);
      const q = parse(ReferralListQuerySchema, request.query);
      return service.listReferrals(organizationId, q);
    },
  );

  app.get(
    "/api/v1/referrals/:id",
    {
      preHandler: [REFERRAL_READ],
      config: { auditRead: { resourceKind: "referral", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getReferral(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.patch("/api/v1/referrals/:id", { preHandler: [REFERRAL_UPDATE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(ReferralUpdateSchema, request.body);
    return service.updateReferral(organizationId, idOf(request), body.ifVersion);
  });

  app.post("/api/v1/referrals/:id/triage", { preHandler: [REFERRAL_TRIAGE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(ReferralTriageSchema, request.body);
    return service.triageReferral(organizationId, idOf(request), body.outcome, body.ifVersion);
  });

  app.post("/api/v1/referrals/:id/accept", { preHandler: [REFERRAL_ACCEPT] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(ReferralAcceptSchema, request.body);
    return service.acceptReferral(
      organizationId,
      idOf(request),
      {
        patientId: body.patientId,
        primaryDiagnosisIcd10: body.primaryDiagnosisIcd10,
        attendingPhysicianId: body.attendingPhysicianId,
      },
      body.ifVersion,
      userId,
    );
  });

  app.post("/api/v1/referrals/:id/decline", { preHandler: [REFERRAL_DECLINE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(ReferralDeclineSchema, request.body);
    return service.declineReferral(organizationId, idOf(request), body.reason, body.ifVersion);
  });

  // ── Admission (routes 8–14) ────────────────────────────────────────────────────────────────
  app.post("/api/v1/admissions", { preHandler: [ADMISSION_CREATE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(AdmissionCreateSchema, request.body);
    const res = await service.createAdmission(organizationId, body, userId);
    return reply.code(201).send(res);
  });

  app.get(
    "/api/v1/admissions",
    {
      preHandler: [ADMISSION_READ],
      config: { auditRead: { resourceKind: "admission", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AdmissionListQuerySchema, request.query);
      return service.listAdmissions(organizationId, q);
    },
  );

  app.get(
    "/api/v1/admissions/:id",
    {
      preHandler: [ADMISSION_READ],
      config: { auditRead: { resourceKind: "admission", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getAdmission(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  // Patient-scoped Election & Certification aggregate — the patient-chart "Election & Certification"
  // tab. Gated by `election.read`; a patient with no admission returns a truthful empty (admission null),
  // never a 404. RLS scopes every underlying read to the caller's org.
  app.get(
    "/api/v1/patients/:patientId/election-certification",
    {
      preHandler: [ELECTION_READ],
      config: {
        auditRead: { resourceKind: "election_certification", patientIdParam: "patientId" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return service.getPatientElectionCertification(organizationId, patientId);
    },
  );

  app.patch("/api/v1/admissions/:id", { preHandler: [ADMISSION_UPDATE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(AdmissionUpdateSchema, request.body);
    return service.updateAdmission(organizationId, idOf(request), body.ifVersion);
  });

  app.post("/api/v1/admissions/:id/hold", { preHandler: [ADMISSION_HOLD] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(AdmissionHoldSchema, request.body);
    return service.holdAdmission(organizationId, idOf(request), body.reason, body.ifVersion);
  });

  app.post("/api/v1/admissions/:id/resume", { preHandler: [ADMISSION_HOLD] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(AdmissionResumeSchema, request.body);
    return service.resumeAdmission(organizationId, idOf(request), body.ifVersion);
  });

  app.post(
    "/api/v1/admissions/:id/activate",
    { preHandler: [ADMISSION_ACTIVATE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(AdmissionActivateSchema, request.body);
      return service.activateAdmission(organizationId, idOf(request), body.ifVersion);
    },
  );

  // ── Election statement & period (routes 15–21) ───────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/election-statements",
    { preHandler: [ELECTION_DRAFT] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(ElectionStatementDraftSchema, request.body);
      const res = await service.draftElectionStatement(
        organizationId,
        idOf(request),
        body.electionPeriodId,
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/election-statements/:id",
    {
      preHandler: [ELECTION_READ],
      config: { auditRead: { resourceKind: "election_statement", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getElectionStatement(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.post(
    "/api/v1/election-statements/:id/sign",
    { preHandler: [ELECTION_SIGN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ElectionSignSchema, request.body);
      return service.signElection(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/election-statements/:id/void",
    { preHandler: [ELECTION_VOID] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(ElectionVoidSchema, request.body);
      return service.voidElection(organizationId, idOf(request), body.reason, body.ifVersion);
    },
  );

  app.get(
    "/api/v1/admissions/:id/election-periods",
    {
      preHandler: [ELECTION_READ],
      config: { auditRead: { resourceKind: "election_period", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const rows = await service.listElectionPeriods(organizationId, idOf(request));
      return rows === null ? notFound(idOf(request)) : { items: rows };
    },
  );

  app.post(
    "/api/v1/admissions/:id/election-periods",
    { preHandler: [ELECTION_DRAFT] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      parse(ElectionPeriodCreateSchema, request.body);
      const res = await service.createElectionPeriod(organizationId, idOf(request));
      return reply.code(201).send(res);
    },
  );

  app.patch("/api/v1/election-periods/:id", { preHandler: [ELECTION_DRAFT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(ElectionPeriodPatchSchema, request.body);
    return service.patchElectionPeriod(organizationId, idOf(request), body.ifVersion);
  });

  // ── CTI (routes 22–27) ───────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/election-periods/:id/cti",
    { preHandler: [CTI_DRAFT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CtiDraftSchema, request.body);
      const res = await service.draftCti(
        organizationId,
        {
          electionPeriodId: idOf(request),
          hospiceMedicalDirectorId: body.hospiceMedicalDirectorId,
          attendingPhysicianId: body.attendingPhysicianId,
          isRecert: body.isRecert,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/cti/:id",
    {
      preHandler: [CTI_READ],
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
    { preHandler: [CTI_SIGN_HOSPICE_MD] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CtiSignSchema, request.body);
      return service.signCtiHospiceMd(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post(
    "/api/v1/cti/:id/sign-attending",
    { preHandler: [CTI_SIGN_ATTENDING] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CtiSignSchema, request.body);
      return service.signCtiAttending(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  app.post("/api/v1/cti/:id/void", { preHandler: [CTI_VOID] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(CtiVoidSchema, request.body);
    return service.voidCti(organizationId, idOf(request), body.reason, body.ifVersion);
  });

  app.post("/api/v1/cti/:id/mark-late", { preHandler: [CTI_MARK_LATE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(CtiMarkLateSchema, request.body);
    return service.markCtiLate(organizationId, idOf(request), body.ifVersion);
  });

  // ── F2F (routes 28–32) ─────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/face-to-face",
    { preHandler: [F2F_SCHEDULE] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(F2fScheduleSchema, request.body);
      const res = await service.scheduleF2f(organizationId, {
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
      preHandler: [F2F_READ],
      config: { auditRead: { resourceKind: "face_to_face", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const row = await service.getF2f(organizationId, idOf(request));
      return row ?? notFound(idOf(request));
    },
  );

  app.post("/api/v1/face-to-face/:id/complete", { preHandler: [F2F_COMPLETE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(F2fCompleteSchema, request.body);
    return service.completeF2f(organizationId, idOf(request), body.ifVersion);
  });

  app.post(
    "/api/v1/face-to-face/:id/attest",
    { preHandler: [F2F_ATTEST, ABAC_F2F_ATTEST] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(F2fAttestSchema, request.body);
      return service.attestF2f(organizationId, idOf(request), body.ifVersion, userId);
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
    { preHandler: [LOC_CHANGE] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(LocChangeSchema, request.body);
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
      preHandler: [LOC_READ],
      config: { auditRead: { resourceKind: "level_of_care", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const rows = await service.listLoc(organizationId, idOf(request));
      return rows === null ? notFound(idOf(request)) : { items: rows };
    },
  );

  app.patch("/api/v1/level-of-care/:id", { preHandler: [LOC_CHANGE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(LocPatchSchema, request.body);
    return service.patchLoc(organizationId, idOf(request), body.reason, body.ifVersion);
  });

  // The §2.3.5 confirm handshake (M6-T04 fix, 2026-08-05): IRC/GIP periods land in `assigning` until this
  // fires; it verifies a real M37 bed assignment exists (never trusts a caller-supplied bed id) before
  // transitioning to `active`.
  app.post(
    "/api/v1/level-of-care/:id/confirm-bed",
    { preHandler: [LOC_CHANGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(LocConfirmBedSchema, request.body);
      return service.confirmLocBedAssignment(organizationId, idOf(request), body.ifVersion);
    },
  );

  // ── Revocation / transfer / discharge (routes 36–40) ─────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/revocation",
    { preHandler: [REVOCATION_CREATE] },
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
    { preHandler: [TRANSFER_OUT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(TransferOutSchema, request.body);
      const res = await service.transferOut(
        organizationId,
        idOf(request),
        {
          effectiveDate: body.effectiveDate,
          otherHospiceName: body.otherHospiceName,
          otherHospiceCcn: body.otherHospiceCcn,
          narrative: body.narrative,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/admissions/:id/transfer-in",
    { preHandler: [TRANSFER_IN] },
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
    { preHandler: [dischargeReasonGuard()] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(DischargeCreateSchema, request.body);
      const res = await service.discharge(
        organizationId,
        idOf(request),
        {
          reason: body.reason,
          dischargeDate: body.dischargeDate,
          narrative: body.narrative,
          forCauseReason: body.forCauseReason,
        },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.post(
    "/api/v1/discharges/:id/cosign-for-cause",
    { preHandler: [DISCHARGE_COSIGN, ABAC_DISCHARGE_MD] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(DischargeCosignSchema, request.body);
      return service.cosignDischarge(organizationId, idOf(request), body.ifVersion, userId);
    },
  );

  // ── NOR (routes 41–42) ─────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/admissions/:id/nor",
    { preHandler: [NOR_ACKNOWLEDGE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(NorAcknowledgeSchema, request.body);
      const res = await service.acknowledgeNor(
        organizationId,
        idOf(request),
        { deliveryMethod: body.deliveryMethod, acknowledgedByRole: body.acknowledgedByRole },
        userId,
      );
      return reply.code(201).send(res);
    },
  );

  app.get(
    "/api/v1/admissions/:id/nor",
    {
      preHandler: [NOR_READ],
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
      preHandler: [COMPLIANCE_READ],
      config: { auditRead: { resourceKind: "compliance_window", resourceIdParam: "id" } },
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
    { preHandler: [COMPLIANCE_CLOSE] },
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
