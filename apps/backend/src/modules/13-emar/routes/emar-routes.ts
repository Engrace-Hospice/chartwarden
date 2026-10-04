// apps/backend/src/modules/13-emar/routes/emar-routes.ts — M13-T08 the §4.1 route inventory behind the REAL
// Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the §4.6 keys M13
// registers into M3's catalog (M13_CONTRIBUTED_PERMISSIONS). Org binding is server-side (`request.context`,
// never the body). Handlers compose over the injected EmarRouteService (in-memory slice; Drizzle in prod
// under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the record route adds `requireAbac('administering_clinician_eligible')` with the body's
// `medicationOrderId` as the target (the predicate resolves the ORDER's class — GAP-005); the witness-attest route adds `requireAbac('controlled_substance_witness_eligible')`
// with the body's `administeringClinicianMembershipId`; the caregiver acknowledge/dispute routes add
// `requireAbac('caregiver_attested_review_required')` (target = :id); the reconciliation decide/finalize routes
// add `requireAbac('reconciliation_authoring_eligible')` (target = worksheet :id). The §4.1 caseload column is
// the M13-owned `emar.scope` predicate (GAP-004), bound explicitly on every row that names it with
// `notFoundOnDeny` — an off-caseload caller learns nothing, not even that the row exists. (It used to be
// "bound by the §4.6 default ABAC", which does not exist: `requirePermission` never reads `abac`.) The
// controlled-substance witness token rides the `X-Witness-Attestation` header.
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import type { ReconciliationDecisionKind } from "@wardenx/types";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AcknowledgeCaregiverRequest,
  AcknowledgeReturnRequest,
  AddCaregiverReportedLineRequest,
  AdministrationListQuerySchema,
  AdministrationPolicyRequest,
  CorrectAdministrationRequest,
  DecisionLineParamsSchema,
  DeploymentQuerySchema,
  DisputeCaregiverRequest,
  FinalizeReconciliationRequest,
  IdParamsSchema,
  IntentionalHoldRequest,
  MissedDoseQuerySchema,
  OfflineSyncRequest,
  RecordAdministrationRequest,
  RecordCaregiverAttestedRequest,
  RecordDecisionRequest,
  RecordRefusalRequest,
  ScheduledDoseQuerySchema,
  SessionParamsSchema,
  UpdateDecisionRequest,
  VoidAdministrationRequest,
  VoidReconciliationRequest,
  WitnessAttestRequest,
  WorksheetQuerySchema,
  parse,
} from "./emar-typebox";
import type { EmarRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface EmarRouteDeps {
  service: EmarRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" — same bug/fix as
  // M7/M8/M9/M10/M11/M12: this used to read `ctx.userId` (the raw Better Auth user id, a DIFFERENT
  // id from the org membership).
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("administration.read");
const RECORD = P("administration.record");
const WITNESS_ATTEST = P("administration.witness_attest");
const CAREGIVER_RECORD = P("administration.caregiver_record");
const CAREGIVER_ACK = P("administration.caregiver_acknowledge");
const CAREGIVER_DISPUTE = P("administration.caregiver_dispute");
const CORRECT = P("administration.correct");
const VOID = P("administration.void");
const RECORD_REFUSAL = P("administration.record_refusal");
const RECORD_MISSED = P("administration.record_missed");
const READ_MISSED = P("administration.read_missed");
const ACK_MISSED = P("administration.acknowledge_missed");
const RECON_READ = P("reconciliation.read");
const RECON_DECIDE = P("reconciliation.decide");
const RECON_FINALIZE = P("reconciliation.finalize");
const RECON_VOID = P("reconciliation.void");
const KIT_READ = P("comfort_kit.read");
const KIT_ACK_RETURN = P("comfort_kit.acknowledge_return");
const POLICY = P("administration.admin.policy");

// §4.7 — the ABAC predicates M13 owns. The record target lifts the body's `medicationOrderId` (the predicate
// resolves the order's class); the witness-attest target lifts the body's `administeringClinicianMembershipId`;
// the caregiver/reconciliation targets default to the `:id` route param (resolved by the predicate).
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const orderTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const id = str((request.body as { medicationOrderId?: unknown } | undefined)?.medicationOrderId);
  return id ? { medicationOrderId: id } : {};
};
const administeringTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const body = request.body as { administeringClinicianMembershipId?: unknown } | undefined;
  return typeof body?.administeringClinicianMembershipId === "string"
    ? { administeringClinicianMembershipId: body.administeringClinicianMembershipId }
    : {};
};
const ABAC_ADMINISTER = requireAbac("administration.record", "administering_clinician_eligible", {
  getTarget: orderTarget,
}) as PreHandler;
const ABAC_WITNESS = requireAbac(
  "administration.witness_attest",
  "controlled_substance_witness_eligible",
  { getTarget: administeringTarget },
) as PreHandler;
const ABAC_CAREGIVER_ACK = requireAbac(
  "administration.caregiver_acknowledge",
  "caregiver_attested_review_required",
) as PreHandler;
const ABAC_CAREGIVER_DISPUTE = requireAbac(
  "administration.caregiver_dispute",
  "caregiver_attested_review_required",
) as PreHandler;
const ABAC_RECON_DECIDE = requireAbac(
  "reconciliation.decide",
  "reconciliation_authoring_eligible",
) as PreHandler;
const ABAC_RECON_FINALIZE = requireAbac(
  "reconciliation.finalize",
  "reconciliation_authoring_eligible",
) as PreHandler;

// GAP-004 / §4.1 — the caseload column. `emar.scope` resolves whichever id the target names to its patient.
type TargetOf = (request: FastifyRequest) => AbacTarget;
const SCOPE = (action: string, getTarget: TargetOf): PreHandler =>
  requireAbac(action, "emar.scope", {
    notFoundOnDeny: true,
    getTarget: (request) => getTarget(request as FastifyRequest),
  }) as PreHandler;
const fromParam =
  (field: string, param = "id"): TargetOf =>
  (request) => {
    const id = str((request.params as Record<string, unknown> | undefined)?.[param]);
    return id ? { [field]: id } : {};
  };
const fromPatientQuery: TargetOf = (request) => {
  const patientId = str((request.query as { patient?: unknown } | undefined)?.patient);
  return patientId ? { patientId } : {};
};
const fromBody: TargetOf = (request) => {
  const b = (request.body ?? {}) as Record<string, unknown>;
  const target: Record<string, string> = {};
  for (const field of ["patientId", "medicationOrderId", "scheduledDoseId"]) {
    const v = str(b[field]);
    if (v) target[field] = v;
  }
  return target;
};
const BY_ADMINISTRATION = fromParam("administrationId");
const BY_WORKSHEET = fromParam("worksheetId");
const BY_DEPLOYMENT = fromParam("deploymentId");

const witnessHeader = (request: FastifyRequest): string | undefined => {
  const h = request.headers["x-witness-attestation"];
  return typeof h === "string" && h.length > 0 ? h : undefined;
};

// The per-mode `data` body is carried opaquely at the route boundary (the server discriminates on `mode`). The
// §5.11 five-rights `route`/`dose` rights and the §2.9 BCMA gate read the discrete single-dose fields out of it.
type DataFields = { route?: string; doseAmount?: number | null; doseUnit?: string | null };
const dataFieldsOf = (data: unknown): DataFields => {
  const d = (data ?? {}) as {
    route?: unknown;
    administeredAmount?: unknown;
    administeredUnit?: unknown;
  };
  return {
    route: typeof d.route === "string" ? d.route : undefined,
    doseAmount: typeof d.administeredAmount === "number" ? d.administeredAmount : null,
    doseUnit: typeof d.administeredUnit === "string" ? d.administeredUnit : null,
  };
};

export function registerEmarRoutes(app: FastifyInstance, deps: EmarRouteDeps): void {
  const { service } = deps;

  // 1 — record a clinician administration (administering_clinician_eligible[:medClass] ABAC floor).
  app.post(
    "/api/v1/administrations",
    { preHandler: [RECORD, ABAC_ADMINISTER, SCOPE("administration.record", fromBody)] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(RecordAdministrationRequest, request.body);
      const data = dataFieldsOf(b.data);
      const res = await service.recordAdministration(organizationId, userId, {
        medicationOrderId: b.medicationOrderId,
        medClass: b.medClass,
        mode: b.mode,
        administeredAt: b.administeredAt,
        scheduledDoseId: b.scheduledDoseId,
        comfortKitDeploymentId: b.comfortKitDeploymentId,
        encounterId: b.encounterId,
        ivSessionId: b.ivSessionId,
        // F-031 — the per-mode body reaches the service now. It used to stop at this boundary: the route
        // lifted `route`/`administeredAmount`/`administeredUnit` out of it for the §5.11 rights and dropped
        // the rest, so an IV rate or a titration reason a caller sent was parsed, validated, and discarded.
        data: b.data,
        prn: b.prn
          ? {
              triggeringPrnReason: b.prn.triggeringPrnReason,
              requestedByKind: b.prn.requestedByKind,
            }
          : undefined,
        lateEntryReason: b.lateEntryReason,
        offlineCapture: b.offlineCapture,
        witnessToken: witnessHeader(request),
        barcodeScan: b.barcodeScan,
        route: data.route,
        doseAmount: data.doseAmount,
        doseUnit: data.doseUnit,
      });
      return reply.code(201).send(res);
    },
  );

  // 2 — mint a witness-attestation token (separate-device flow; controlled_substance_witness_eligible ABAC).
  app.post(
    "/api/v1/administrations/witness-attest",
    { preHandler: [WITNESS_ATTEST, ABAC_WITNESS] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(WitnessAttestRequest, request.body);
      const res = await service.mintWitnessToken(organizationId, userId, {
        patientId: b.patientId,
        medicationOrderId: b.medicationOrderId,
        administeringClinicianMembershipId: b.administeringClinicianMembershipId,
      });
      return reply.code(201).send(res);
    },
  );

  // 3 — caregiver-attested administration via M31 portal (portal-session gated).
  app.post(
    "/api/v1/administrations/caregiver-attested",
    { preHandler: [CAREGIVER_RECORD] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(RecordCaregiverAttestedRequest, request.body);
      const res = await service.recordCaregiverAttested(organizationId, {
        patientId: b.patientId,
        medicationOrderId: b.medicationOrderId,
        administeredAt: b.administeredAt,
        caregiverSessionId: userId,
        route: b.route,
        doseAmount: b.administeredAmount,
        doseUnit: b.administeredUnit,
        barcodeScan: b.barcodeScan,
      });
      return reply.code(201).send(res);
    },
  );

  // 4 — RN case manager acknowledges a caregiver-attested row (caregiver_attested_review_required ABAC).
  app.post(
    "/api/v1/administrations/:id/acknowledge-caregiver",
    {
      preHandler: [
        CAREGIVER_ACK,
        SCOPE("administration.caregiver_acknowledge", BY_ADMINISTRATION),
        ABAC_CAREGIVER_ACK,
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(AcknowledgeCaregiverRequest, request.body);
      return service.acknowledgeCaregiver(organizationId, userId, id);
    },
  );

  // 5 — RN case manager disputes a caregiver-attested row.
  app.post(
    "/api/v1/administrations/:id/dispute-caregiver",
    {
      preHandler: [
        CAREGIVER_DISPUTE,
        SCOPE("administration.caregiver_dispute", BY_ADMINISTRATION),
        ABAC_CAREGIVER_DISPUTE,
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(DisputeCaregiverRequest, request.body);
      return service.disputeCaregiver(organizationId, userId, id, b.disputeReason);
    },
  );

  // 6 — correction of a committed administration (creates a new row, supersedes original).
  app.post(
    "/api/v1/administrations/:id/correct",
    { preHandler: [CORRECT, SCOPE("administration.correct", BY_ADMINISTRATION)] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(CorrectAdministrationRequest, request.body);
      const res = await service.correctAdministration(organizationId, userId, id, b.reason);
      return reply.code(201).send(res);
    },
  );

  // 7 — administrative hard-void (recorded in error; step-up enforced upstream).
  app.post(
    "/api/v1/administrations/:id/void",
    { preHandler: [VOID, SCOPE("administration.void", BY_ADMINISTRATION)] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(VoidAdministrationRequest, request.body);
      return service.voidAdministration(organizationId, userId, id, b.voidReason);
    },
  );

  // 8 — read one administration.
  app.get(
    "/api/v1/administrations/:id",
    {
      preHandler: [READ, SCOPE("administration.read", BY_ADMINISTRATION)],
      config: { auditRead: { resourceKind: "administration", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getAdministration(organizationId, id);
    },
  );

  // 9 — list administrations for a patient.
  app.get(
    "/api/v1/administrations",
    {
      preHandler: [READ, SCOPE("administration.read", fromPatientQuery)],
      config: { auditRead: { resourceKind: "administration", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AdministrationListQuerySchema, request.query);
      return service.listAdministrations(organizationId, {
        patient: q.patient,
        since: q.since,
        until: q.until,
      });
    },
  );

  // 10 — list an IV continuous session sequence.
  app.get(
    "/api/v1/administrations/iv-sessions/:sessionId",
    {
      preHandler: [READ, SCOPE("administration.read", fromParam("ivSessionId", "sessionId"))],
      config: { auditRead: { resourceKind: "iv_session", resourceIdParam: "sessionId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { sessionId } = parse(SessionParamsSchema, request.params);
      return service.getIvSession(organizationId, sessionId);
    },
  );

  // 11 — record a refusal (patient declined; administering_clinician_eligible ABAC floor).
  app.post(
    "/api/v1/administrations/refuse",
    {
      preHandler: [
        RECORD_REFUSAL,
        ABAC_ADMINISTER,
        SCOPE("administration.record_refusal", fromBody),
      ],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(RecordRefusalRequest, request.body);
      const res = await service.recordRefusal(organizationId, userId, {
        patientId: b.patientId,
        medicationOrderId: b.medicationOrderId,
        medClass: b.medClass,
        scheduledDoseId: b.scheduledDoseId,
        refusedAt: b.refusedAt,
      });
      return reply.code(201).send(res);
    },
  );

  // 12 — bulk offline-queue sync from device (per-row administering_clinician_eligible enforced in service).
  app.post(
    "/api/v1/administrations/offline-sync",
    { preHandler: [RECORD] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(OfflineSyncRequest, request.body);
      // Per row, the same two gates the single-record route applies: the ORDER's class must admit the
      // caller's discipline (GAP-005) and the row's patient must be in scope (GAP-004). Checked for every
      // row before any is written, so a batch is refused whole rather than half-applied.
      for (const r of b.rows) {
        const rowTarget = () => ({
          medicationOrderId: r.medicationOrderId,
          ...(r.scheduledDoseId ? { scheduledDoseId: r.scheduledDoseId } : {}),
        });
        await requireAbac("administration.record", "administering_clinician_eligible", {
          getTarget: rowTarget,
        })(request);
        await requireAbac("administration.record", "emar.scope", {
          notFoundOnDeny: true,
          getTarget: rowTarget,
        })(request);
      }
      const res = await service.offlineSync(
        organizationId,
        userId,
        b.rows.map((r) => {
          const data = dataFieldsOf(r.data);
          return {
            medicationOrderId: r.medicationOrderId,
            medClass: r.medClass,
            mode: r.mode,
            administeredAt: r.administeredAt,
            scheduledDoseId: r.scheduledDoseId,
            comfortKitDeploymentId: r.comfortKitDeploymentId,
            encounterId: r.encounterId,
            ivSessionId: r.ivSessionId,
            data: r.data,
            offlineCapture: r.offlineCapture,
            barcodeScan: r.barcodeScan,
            route: data.route,
            doseAmount: data.doseAmount,
            doseUnit: data.doseUnit,
          };
        }),
      );
      return reply.code(201).send(res);
    },
  );

  // 13 — read the scheduled-dose timeline.
  app.get(
    "/api/v1/scheduled-doses",
    {
      preHandler: [READ, SCOPE("administration.read", fromPatientQuery)],
      config: { auditRead: { resourceKind: "scheduled_dose", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ScheduledDoseQuerySchema, request.query);
      return service.listScheduledDoses(organizationId, {
        patient: q.patient,
        from: q.from,
        to: q.to,
      });
    },
  );

  // 14 — record an intentional hold before the grace window expires.
  app.post(
    "/api/v1/scheduled-doses/:id/intentional-hold",
    {
      preHandler: [
        RECORD_MISSED,
        SCOPE("administration.record_missed", fromParam("scheduledDoseId")),
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(IntentionalHoldRequest, request.body);
      return service.intentionalHold(organizationId, userId, id);
    },
  );

  // 15 — list missed doses for a patient.
  app.get(
    "/api/v1/missed-doses",
    {
      preHandler: [READ_MISSED, SCOPE("administration.read_missed", fromPatientQuery)],
      config: { auditRead: { resourceKind: "missed_dose", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MissedDoseQuerySchema, request.query);
      return service.listMissedDoses(organizationId, { patient: q.patient, since: q.since });
    },
  );

  // 16 — case manager acknowledges a missed dose.
  app.post(
    "/api/v1/missed-doses/:id/acknowledge",
    {
      preHandler: [
        ACK_MISSED,
        SCOPE("administration.acknowledge_missed", fromParam("missedDoseId")),
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.acknowledgeMissed(organizationId, userId, id);
    },
  );

  // 17 — list reconciliation worksheets for a patient.
  app.get(
    "/api/v1/reconciliation/worksheets",
    {
      preHandler: [RECON_READ, SCOPE("reconciliation.read", fromPatientQuery)],
      config: { auditRead: { resourceKind: "reconciliation_worksheet", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(WorksheetQuerySchema, request.query);
      return service.listWorksheets(organizationId, q.patient);
    },
  );

  // 18 — read one worksheet with its lines + decisions.
  app.get(
    "/api/v1/reconciliation/worksheets/:id",
    {
      preHandler: [RECON_READ, SCOPE("reconciliation.read", BY_WORKSHEET)],
      config: { auditRead: { resourceKind: "reconciliation_worksheet", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getWorksheet(organizationId, id);
    },
  );

  // 19 — record a per-line decision (reconciliation_authoring_eligible ABAC).
  app.post(
    "/api/v1/reconciliation/worksheets/:id/decisions",
    {
      preHandler: [RECON_DECIDE, SCOPE("reconciliation.decide", BY_WORKSHEET), ABAC_RECON_DECIDE],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(RecordDecisionRequest, request.body);
      const res = await service.recordDecision(organizationId, userId, id, {
        lineKind: b.lineKind,
        sourceId: b.sourceId,
        decision: b.decision as ReconciliationDecisionKind,
        medicationDetails: b.medicationDetails,
      });
      return reply.code(201).send(res);
    },
  );

  // 20 — update a per-line decision before finalization.
  app.patch(
    "/api/v1/reconciliation/worksheets/:id/decisions/:lineId",
    {
      preHandler: [RECON_DECIDE, SCOPE("reconciliation.decide", BY_WORKSHEET), ABAC_RECON_DECIDE],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id, lineId } = parse(DecisionLineParamsSchema, request.params);
      const b = parse(UpdateDecisionRequest, request.body);
      return service.updateDecision(
        organizationId,
        userId,
        id,
        lineId,
        b.decision as ReconciliationDecisionKind,
        b.resultingMedicationOrderId,
      );
    },
  );

  // 21 — add a caregiver-reported home-med line.
  app.post(
    "/api/v1/reconciliation/worksheets/:id/add-caregiver-reported-line",
    { preHandler: [RECON_DECIDE, SCOPE("reconciliation.decide", BY_WORKSHEET)] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(AddCaregiverReportedLineRequest, request.body);
      const res = await service.addCaregiverReportedLine(organizationId, id, b.drugName);
      return reply.code(201).send(res);
    },
  );

  // 22 — finalize the worksheet (reconciliation_authoring_eligible ABAC; emits m13.reconciliation.completed).
  app.post(
    "/api/v1/reconciliation/worksheets/:id/finalize",
    {
      preHandler: [
        RECON_FINALIZE,
        SCOPE("reconciliation.finalize", BY_WORKSHEET),
        ABAC_RECON_FINALIZE,
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(FinalizeReconciliationRequest, request.body);
      return service.finalizeReconciliation(organizationId, userId, id);
    },
  );

  // 23 — void a worksheet.
  app.post(
    "/api/v1/reconciliation/worksheets/:id/void",
    { preHandler: [RECON_VOID, SCOPE("reconciliation.void", BY_WORKSHEET)] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const b = parse(VoidReconciliationRequest, request.body);
      return service.voidWorksheet(organizationId, userId, id, b.voidReason);
    },
  );

  // 24 — list active and historical comfort-kit deployments.
  app.get(
    "/api/v1/comfort-kits/deployments",
    {
      preHandler: [KIT_READ, SCOPE("comfort_kit.read", fromPatientQuery)],
      config: { auditRead: { resourceKind: "comfort_kit_deployment", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(DeploymentQuerySchema, request.query);
      return service.listDeployments(organizationId, q.patient);
    },
  );

  // 25 — read one deployment with its drawdowns.
  app.get(
    "/api/v1/comfort-kits/deployments/:id",
    {
      preHandler: [KIT_READ, SCOPE("comfort_kit.read", BY_DEPLOYMENT)],
      config: { auditRead: { resourceKind: "comfort_kit_deployment", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      return service.getDeployment(organizationId, id);
    },
  );

  // 26 — manual return acknowledgment (Phase-1 fallback when M21 absent).
  app.post(
    "/api/v1/comfort-kits/deployments/:id/acknowledge-return",
    { preHandler: [KIT_ACK_RETURN, SCOPE("comfort_kit.acknowledge_return", BY_DEPLOYMENT)] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      parse(AcknowledgeReturnRequest, request.body);
      return service.acknowledgeReturn(organizationId, userId, id);
    },
  );

  // 27 — read tenant administration policy.
  app.get(
    "/api/v1/admin/administration-policy",
    {
      preHandler: [POLICY],
      config: {
        auditRead: {
          none: "organization-level administration policy configuration (grace window, PRN interval, PDF-on-commit flag); no patient data",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getPolicy(organizationId);
    },
  );

  // 28 — update tenant administration policy (step-up enforced upstream).
  app.put("/api/v1/admin/administration-policy", { preHandler: [POLICY] }, async (request) => {
    const { organizationId } = actorOf(request);
    const b = parse(AdministrationPolicyRequest, request.body);
    return service.putPolicy(organizationId, {
      graceWindowMinutes: b.graceWindowMinutes,
      prnMinimumIntervalMinutes: b.prnMinimumIntervalMinutes,
      emarPdfOnCommit: b.emarPdfOnCommit,
    });
  });
}
