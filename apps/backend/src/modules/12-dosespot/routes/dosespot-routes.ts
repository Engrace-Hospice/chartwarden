// apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts — M12-T08 the §4.1 route inventory behind
// the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the §4.6 keys
// M12 registers into M3's catalog (M12_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected MedicationOrderRouteService
// (in-memory slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the author routes (POST /medication-orders, /:id/correct) add `requireAbac('prescriber_eligible')`
// with the body's `medClass` as the target; the controlled sign routes add `requireAbac('dea_schedule_authorized')`
// with the body's `schedule`; the refill routes add `requireAbac('refill_inbox_scope')` (target = :id; the list
// route resolves to allow and the service narrows the inbox). The §4.1 caseload column maps to the shared
// `caseload_or_scope` predicate (registered by M5/M6/M7) — bound by the §4.6 default ABAC on each clinical
// key. The §4.6 "via M11 seam" predicates (`signer_eligible` / `cosigner_role_match`) resolve against M11's
// order store, not M12's medication_order — M12 enforces signer/cosigner eligibility in the service layer
// (defense-in-depth) rather than re-binding those cross-store predicates at the route.
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ApproveRefillRequest,
  CompleteRequest,
  ControlledSubstancePolicyRequest,
  CorrectMedicationOrderRequest,
  CosignRequest,
  CreateMedicationOrderRequest,
  DenyRefillRequest,
  DiscontinueRequest,
  EnrollPrescriberRequest,
  HistoryRecordParamsSchema,
  MedicationOrderListQuerySchema,
  MembershipParamsSchema,
  OrderParamsSchema,
  PatientParamsSchema,
  ReconcileRequest,
  RecordVerbalRequest,
  RefillInboxPolicyRequest,
  RefillParamsSchema,
  RequestSignatureRequest,
  RevokePrescriberRequest,
  RxBenefitLookupRequest,
  SignControlledCompleteRequest,
  SignControlledInitiateRequest,
  SignMedicationOrderRequest,
  UpdateMedicationOrderRequest,
  parse,
} from "./dosespot-typebox";
import type { MedicationOrderRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DoseSpotRouteDeps {
  service: MedicationOrderRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("prescribing.read");
const DRAFT = P("prescribing.draft");
const SIGN = P("prescribing.sign");
const SIGN_CONTROLLED = P("prescribing.sign_controlled_substance");
const VERBAL = P("prescribing.verbal.record");
const COSIGN = P("prescribing.cosign");
const DISCONTINUE = P("prescribing.discontinue");
const REFILL_DECIDE = P("prescribing.refill_decide");
const ROSTER = P("prescribing.admin.roster");
const POLICY = P("prescribing.admin.policy");
const HISTORY_READ = P("prescribing.history.read");
const HISTORY_RECONCILE = P("prescribing.history.reconcile");
const RX_BENEFIT = P("prescribing.rx_benefit.lookup");

// §4.7 — the three ABAC predicates M12 owns. The author target lifts `medClass` from the body; the controlled
// sign target lifts `schedule`; the refill-inbox target defaults to the `:id` route param.
const medClassTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const body = request.body as { medClass?: unknown } | undefined;
  return typeof body?.medClass === "string" ? { medClass: body.medClass } : {};
};
const scheduleTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const body = request.body as { schedule?: unknown } | undefined;
  return typeof body?.schedule === "string" ? { schedule: body.schedule } : {};
};
const ABAC_DRAFT = requireAbac("prescribing.draft", "prescriber_eligible", { getTarget: medClassTarget }) as PreHandler;
const ABAC_SIGN_CONTROLLED = requireAbac("prescribing.sign_controlled_substance", "dea_schedule_authorized", { getTarget: scheduleTarget }) as PreHandler;
const ABAC_REFILL_SCOPE = requireAbac("prescribing.read", "refill_inbox_scope") as PreHandler; // target = :id (or none → allow)
const ABAC_REFILL_DECIDE = requireAbac("prescribing.refill_decide", "refill_inbox_scope") as PreHandler;

export function registerDoseSpotRoutes(app: FastifyInstance, deps: DoseSpotRouteDeps): void {
  const { service } = deps;

  // 1 — list medication orders.
  app.get("/api/v1/medication-orders", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(MedicationOrderListQuerySchema, request.query);
    return service.listOrders(organizationId, { patientId: q.patientId, prescriberId: q.prescriberId, medClass: q.medClass, status: q.status });
  });

  // 3 — create draft (prescriber_eligible ABAC floor on the body's medClass).
  app.post("/api/v1/medication-orders", { preHandler: [DRAFT, ABAC_DRAFT] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(CreateMedicationOrderRequest, request.body);
    const res = await service.createDraft(organizationId, userId, {
      patientId: b.patientId, admissionId: b.admissionId, medClass: b.medClass, rxnormRxcui: b.rxnormRxcui,
      ndc: b.ndc, drugName: b.drugName, strength: b.strength, doseForm: b.doseForm, route: b.route, data: b.data,
      prescriberDiscipline: b.prescriberDiscipline, prescribingPhysicianMdmId: b.prescribingPhysicianMdmId,
      dispensingPharmacyMdmId: b.dispensingPharmacyMdmId, deaSchedule: b.deaSchedule,
      containsControlled: b.containsControlled, refillsAuthorized: b.refillsAuthorized,
    });
    return reply.code(201).send(res);
  });

  // 2 — medication order detail.
  app.get("/api/v1/medication-orders/:id", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    return service.getOrder(organizationId, id);
  });

  // 4 — edit a draft.
  app.patch("/api/v1/medication-orders/:id", { preHandler: [DRAFT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(UpdateMedicationOrderRequest, request.body);
    return service.editDraft(organizationId, id, { data: b.data, drugName: b.drugName, strength: b.strength, refillsAuthorized: b.refillsAuthorized });
  });

  // 5 — draft → pending_signature.
  app.post("/api/v1/medication-orders/:id/request-signature", { preHandler: [DRAFT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(RequestSignatureRequest, request.body);
    return service.requestSignature(organizationId, id, b.signerDiscipline);
  });

  // 6 — standard sign (→ signed).
  app.post("/api/v1/medication-orders/:id/sign", { preHandler: [SIGN] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(SignMedicationOrderRequest, request.body);
    return service.signOrder(organizationId, userId, id, { signerDiscipline: b.signerDiscipline, signedAtClient: b.signedAtClient, signerIsOrderingPhysician: b.signerIsOrderingPhysician });
  });

  // 7 — controlled sign initiate (60s 2FA nonce; dea_schedule_authorized ABAC).
  app.post("/api/v1/medication-orders/:id/sign-controlled/initiate", { preHandler: [SIGN_CONTROLLED, ABAC_SIGN_CONTROLLED] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(SignControlledInitiateRequest, request.body);
    return service.signControlledInitiate(organizationId, userId, id, b.schedule);
  });

  // 8 — controlled sign complete (2FA → signed).
  app.post("/api/v1/medication-orders/:id/sign-controlled/complete", { preHandler: [SIGN_CONTROLLED] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    parse(SignControlledCompleteRequest, request.body);
    return service.signControlledComplete(organizationId, userId, id);
  });

  // 9 — record as verbal (→ verbal_pending; controlled is Phase-1-OFF per D18).
  app.post("/api/v1/medication-orders/:id/verbal", { preHandler: [VERBAL] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(RecordVerbalRequest, request.body);
    return service.recordVerbal(organizationId, userId, id, {
      recorderDiscipline: b.recorderDiscipline, verbalAttestation: b.verbalAttestation,
      receivedAt: b.receivedAt, namedPrescriberMdmId: b.namedPrescriberMdmId,
    });
  });

  // 10 — attach a cosignature (service enforces no-self-cosign).
  app.post("/api/v1/medication-orders/:id/cosign", { preHandler: [COSIGN] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(CosignRequest, request.body);
    return service.cosignOrder(organizationId, userId, id, { cosignerRole: b.cosignerRole, attestationText: b.attestationText });
  });

  // 11 — discontinue.
  app.post("/api/v1/medication-orders/:id/discontinue", { preHandler: [DISCONTINUE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(DiscontinueRequest, request.body);
    return service.discontinueOrder(organizationId, userId, id, { reason: b.reason, effectiveAt: b.effectiveAt, notes: b.notes });
  });

  // 12 — complete (one-shot / no-refills-no-renewal).
  app.post("/api/v1/medication-orders/:id/complete", { preHandler: [DISCONTINUE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(CompleteRequest, request.body);
    return service.completeOrder(organizationId, userId, id, b.reason);
  });

  // 13 — corrected order (replaces_medication_order_id; prescriber_eligible ABAC).
  app.post("/api/v1/medication-orders/:id/correct", { preHandler: [DRAFT, ABAC_DRAFT] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const b = parse(CorrectMedicationOrderRequest, request.body);
    const res = await service.correctOrder(organizationId, userId, id, {
      patientId: b.patientId, admissionId: b.admissionId, medClass: b.medClass, rxnormRxcui: b.rxnormRxcui,
      ndc: b.ndc, drugName: b.drugName, strength: b.strength, doseForm: b.doseForm, route: b.route, data: b.data,
      prescriberDiscipline: b.prescriberDiscipline, prescribingPhysicianMdmId: b.prescribingPhysicianMdmId,
      dispensingPharmacyMdmId: b.dispensingPharmacyMdmId, deaSchedule: b.deaSchedule,
      containsControlled: b.containsControlled, refillsAuthorized: b.refillsAuthorized,
    });
    return reply.code(201).send(res);
  });

  // 14 — retransmit a transmission_failed order (mints a corrected order).
  app.post("/api/v1/medication-orders/:id/retransmit", { preHandler: [SIGN] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const res = await service.retransmit(organizationId, userId, id);
    return reply.code(201).send(res);
  });

  // 15 — DoseSpot transmission status incl. retry history.
  app.get("/api/v1/medication-orders/:id/transmission", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    return service.getTransmission(organizationId, id);
  });

  // 16 — active medications for a patient.
  app.get("/api/v1/patients/:patientId/medications/active", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { patientId } = parse(PatientParamsSchema, request.params);
    return service.activeMedications(organizationId, patientId);
  });

  // 17 — medication history list.
  app.get("/api/v1/patients/:patientId/medications/history", { preHandler: [HISTORY_READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { patientId } = parse(PatientParamsSchema, request.params);
    return service.medicationHistory(organizationId, patientId);
  });

  // 18 — enqueue a medication-history refresh (DoseSpot MedHx pull).
  app.post("/api/v1/patients/:patientId/medications/history/refresh", { preHandler: [HISTORY_READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { patientId } = parse(PatientParamsSchema, request.params);
    return service.refreshHistory(organizationId, patientId);
  });

  // 19 — reconcile a medication-history record.
  app.post("/api/v1/medication-history-records/:id/reconcile", { preHandler: [HISTORY_RECONCILE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(HistoryRecordParamsSchema, request.params);
    const b = parse(ReconcileRequest, request.body);
    return service.reconcileHistory(organizationId, userId, id, b.decision);
  });

  // 20 — refill inbox (refill_inbox_scope ABAC; list resolves to allow + the service narrows).
  app.get("/api/v1/refills", { preHandler: [READ, ABAC_REFILL_SCOPE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    return service.listRefills(organizationId, userId);
  });

  // 21 — refill detail.
  app.get("/api/v1/refills/:id", { preHandler: [READ, ABAC_REFILL_SCOPE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(RefillParamsSchema, request.params);
    return service.getRefill(organizationId, id);
  });

  // 22 — approve a refill (mints a new medication_order).
  app.post("/api/v1/refills/:id/approve", { preHandler: [REFILL_DECIDE, ABAC_REFILL_DECIDE] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(RefillParamsSchema, request.params);
    const b = parse(ApproveRefillRequest, request.body);
    const res = await service.approveRefill(organizationId, userId, id, { refillsAuthorized: b.refillsAuthorized, responseChannel: b.responseChannel, notes: b.notes });
    return reply.code(201).send(res);
  });

  // 23 — deny a refill.
  app.post("/api/v1/refills/:id/deny", { preHandler: [REFILL_DECIDE, ABAC_REFILL_DECIDE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(RefillParamsSchema, request.params);
    const b = parse(DenyRefillRequest, request.body);
    return service.denyRefill(organizationId, userId, id, { denialReason: b.denialReason, responseChannel: b.responseChannel });
  });

  // 24 — RxBenefit cached lookup.
  app.post("/api/v1/rx-benefit/lookup", { preHandler: [RX_BENEFIT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const b = parse(RxBenefitLookupRequest, request.body);
    return service.rxBenefitLookup(organizationId, b.patientId, b.rxnormRxcui);
  });

  // 25 — per-tenant prescriber roster.
  app.get("/api/v1/admin/dosespot-prescribers", { preHandler: [ROSTER] }, async (request) => {
    const { organizationId } = actorOf(request);
    return service.listPrescribers(organizationId);
  });

  // 26 — enroll a prescriber into DoseSpot.
  app.post("/api/v1/admin/dosespot-prescribers/:membershipId/enroll", { preHandler: [ROSTER] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    const { membershipId } = parse(MembershipParamsSchema, request.params);
    const b = parse(EnrollPrescriberRequest, request.body);
    const res = await service.enrollPrescriber(organizationId, membershipId, b.deaAuthorizedSchedules ?? []);
    return reply.code(201).send(res);
  });

  // 27 — revoke a prescriber.
  app.post("/api/v1/admin/dosespot-prescribers/:membershipId/revoke", { preHandler: [ROSTER] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { membershipId } = parse(MembershipParamsSchema, request.params);
    const b = parse(RevokePrescriberRequest, request.body);
    return service.revokePrescriber(organizationId, membershipId, b.reason);
  });

  // 28 — refill-inbox policy read.
  app.get("/api/v1/admin/refill-inbox-policy", { preHandler: [POLICY] }, async (request) => {
    const { organizationId } = actorOf(request);
    return service.getRefillInboxPolicy(organizationId);
  });

  // 29 — refill-inbox policy update (tighten-only).
  app.patch("/api/v1/admin/refill-inbox-policy", { preHandler: [POLICY] }, async (request) => {
    const { organizationId } = actorOf(request);
    const b = parse(RefillInboxPolicyRequest, request.body);
    return service.putRefillInboxPolicy(organizationId, { slaWarnHours: b.slaWarnHours, slaCriticalHours: b.slaCriticalHours });
  });

  // 30 — controlled-substance policy read.
  app.get("/api/v1/admin/controlled-substance-policy", { preHandler: [POLICY] }, async (request) => {
    const { organizationId } = actorOf(request);
    return service.getControlledSubstancePolicy(organizationId);
  });

  // 31 — controlled-substance policy update (tighten-only, 21 CFR 1306.22).
  app.patch("/api/v1/admin/controlled-substance-policy", { preHandler: [POLICY] }, async (request) => {
    const { organizationId } = actorOf(request);
    const b = parse(ControlledSubstancePolicyRequest, request.body);
    return service.putControlledSubstancePolicy(organizationId, { scheduleIiiToVMaxRefills: b.scheduleIiiToVMaxRefills });
  });
}
