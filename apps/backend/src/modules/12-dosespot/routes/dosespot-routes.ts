// apps/backend/src/modules/12-dosespot/routes/dosespot-routes.ts — M12-T08 the §4.1 route inventory behind
// the REAL Authorization Contract (`requirePermission`/`requireAbac` from @chartwarden/auth, M3) on the §4.6 keys
// M12 registers into M3's catalog (M12_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected MedicationOrderRouteService
// (in-memory slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the author routes (POST /medication-orders, /:id/correct) add `requireAbac('prescriber_eligible')`
// with the body's `medClass` as the target; the controlled sign routes add `requireAbac('dea_schedule_authorized')`
// with the body's `schedule`; the refill routes add `requireAbac('refill_inbox_scope')` (target = :id; the list
// route resolves to allow and the service narrows the inbox). The §4.1 caseload column maps to the shared
// `caseload_or_scope` predicate (registered by M5/M6/M7) — bound by the §4.6 default ABAC on each clinical
// key. GAP-033: every patient-bearing route except the refill routes (which keep `refill_inbox_scope`) is bound to
// `caseload_or_scope` with 404-on-deny — `:id` routes resolve the order/history row to its patient first
// (unknown id = the same 404), including sign / sign-controlled / cosign / complete / retransmit. Every
// non-GET guard sets `breakGlassBypassable: false` (an emergency read grant never authorises a write);
// reads keep break-glass. `listOrders` takes a REQUIRED caseload scope.
// GAP-035 follow-up: request-signature validates the body's `signerDiscipline` against the session roles
// (422 DISCIPLINE_NOT_HELD, the M11 idiom); retransmit binds the same signer ABAC as sign and the service
// applies the sign standing rule (authoring prescriber or named physician) — the spec's "the prescriber
// retransmits, the prescriber re-signs". A verbal record needs an enrolled named prescriber
// (422 NAMED_PRESCRIBER_NOT_ENROLLED); `GET /prescribing/named-prescribers` lists the valid choices.
// GAP-035: the standard sign route binds M12's own `medication_signer_eligible`
// (session disciplines, after `orderScope`); the named-prescriber / ordering-physician decision is made in the
// service inside the sign transaction from the STORED order and the signer's roster row — no discipline or
// ordering-physician flag is read from the body. M11's `signer_eligible` / `cosigner_role_match` resolve against
// M11's order store (no row for a medication_order id) so they are not bound here; cosign (GAP-034) is enforced in the service from the session + stored order.
import { type AbacTarget, hasOrgWideScope, requireAbac, requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestStepUpFresh } from "../../../bootstrap/index";
import { prescriberDisciplinesOf } from "../abac-predicates";
import { assertDisciplineHeld, resolveDraftingDiscipline } from "../prescriber-eligibility";
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
  ReportMedicationErrorRequest,
  RequestSignatureRequest,
  RevokePrescriberRequest,
  RxBenefitLookupRequest,
  SetCoverageDeterminationRequest,
  SignControlledCompleteRequest,
  SignControlledInitiateRequest,
  SignMedicationOrderRequest,
  UpdateMedicationOrderRequest,
  parse,
} from "./dosespot-typebox";
import type { DoseSpotAbacActor, MedicationOrderRouteService, OrderListScope } from "./service";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DoseSpotRouteDeps {
  service: MedicationOrderRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" — same bug/fix as
  // M7/M8/M9/M10/M11: this used to read `ctx.userId` (the raw Better Auth user id, a DIFFERENT id
  // from the org membership), FK-violating
  // `medication_order_prescriber_membership_id_membership_id_fk`.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

/**
 * The §2.7 refill inbox needs BOTH ids (GAP-026): the named-prescriber axis keys on the membership id
 * {@link actorOf} resolves, and the caseload axis goes through M5's `CaseloadProvider`, which reads
 * `patient_assignment.clinician_user_id` — the M2 USER id. Everything else on this router keys on one
 * axis only, so only the inbox route uses this.
 */
function refillActorOf(request: FastifyRequest): {
  organizationId: string;
  actor: DoseSpotAbacActor;
} {
  const { organizationId, userId: membershipId } = actorOf(request);
  return {
    organizationId,
    actor: { userId: request.context?.userId ?? "", membershipId },
  };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("prescribing.read");
/** GAP-036 — step-up operation key for acknowledging an allergy conflict (tenants may only tighten it). */
const ALLERGY_OVERRIDE_STEP_UP_OPERATION = "prescribing.allergy_override";
const DRAFT = P("prescribing.draft");
const SIGN = P("prescribing.sign");
const SIGN_CONTROLLED = P("prescribing.sign_controlled_substance");
const VERBAL = P("prescribing.verbal.record");
const COSIGN = P("prescribing.cosign");
const DISCONTINUE = P("prescribing.discontinue");
const REPORT_ERROR = P("prescribing.report_error");
const COVERAGE = P("prescribing.coverage_determine");
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
const ABAC_DRAFT = requireAbac("prescribing.draft", "prescriber_eligible", {
  getTarget: medClassTarget,
  breakGlassBypassable: false, // a mutating route: break-glass never stands in for prescriber eligibility
}) as PreHandler;
const ABAC_SIGN_CONTROLLED = requireAbac(
  "prescribing.sign_controlled_substance",
  "dea_schedule_authorized",
  { getTarget: scheduleTarget, breakGlassBypassable: false },
) as PreHandler;
// GAP-035 — standard sign: the caller's SESSION disciplines must satisfy the signer matrix. Bound after
// `orderScope` (scope before ABAC) and never break-glass-bypassable.
const ABAC_SIGN_ELIGIBLE = requireAbac("prescribing.sign", "medication_signer_eligible", {
  breakGlassBypassable: false,
}) as PreHandler;
const ABAC_REFILL_SCOPE = requireAbac("prescribing.read", "refill_inbox_scope") as PreHandler; // target = :id (or none → allow)
const ABAC_REFILL_DECIDE = requireAbac(
  "prescribing.refill_decide",
  "refill_inbox_scope",
) as PreHandler;

// GAP-033 — the shared `caseload_or_scope` predicate, bound by name (no import edge into M7), 404 on deny.
// Its `patientId` arm allows an org-wide oversight role, a session pinned to the patient, or an open
// `patient_assignment`.
//
// GAP-033 (round 2) — `mutating` guards (every non-GET route) set `breakGlassBypassable: false`: an
// emergency read grant (§2.2) is proof of emergency, not licence to write to / transmit for a chart the
// actor is not on. Reads keep break-glass.
const chartScope = (
  action: string,
  patientIdOf: (request: { readonly params?: unknown; readonly body?: unknown }) => unknown,
  mutating = false,
): PreHandler =>
  requireAbac(action, "caseload_or_scope", {
    getTarget: (request) => ({ patientId: patientIdOf(request) }),
    notFoundOnDeny: true,
    breakGlassBypassable: !mutating,
  }) as PreHandler;
const paramPatientId = (request: { readonly params?: unknown }): unknown =>
  (request.params as { patientId?: unknown } | undefined)?.patientId;
const bodyPatientId = (request: { readonly body?: unknown }): unknown =>
  (request.body as { patientId?: unknown } | null | undefined)?.patientId;

/** The caller's list scope (GAP-033): org-wide role, a session-pinned patient, else their caseload. */
function listScopeOf(request: FastifyRequest): OrderListScope {
  const ctx = request.context;
  const pinned = ctx?.attributes.sessionPatientId;
  return {
    orgWide: hasOrgWideScope(ctx?.roles ?? []),
    userId: ctx?.userId ?? "",
    sessionPatientId: typeof pinned === "string" && pinned.length > 0 ? pinned : null,
  };
}

export function registerDoseSpotRoutes(app: FastifyInstance, deps: DoseSpotRouteDeps): void {
  const { service } = deps;

  // GAP-033 — an `:id` route resolves the row to its patient (org-scoped, RLS-backstopped), then asks
  // `caseload_or_scope` about THAT patient. An absent / cross-tenant id is the same 404 as a deny.
  const resolvedScope =
    (
      action: string,
      resolve: (organizationId: string, id: string) => Promise<string | null>,
      mutating: boolean,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const organizationId = request.context?.organizationId;
      if (!organizationId) throw new UnauthorizedError();
      const id = (request.params as { id?: unknown } | undefined)?.id;
      const patientId = typeof id === "string" ? await resolve(organizationId, id) : null;
      if (!patientId) throw new NotFoundError("resource");
      await chartScope(action, () => patientId, mutating)(request, reply);
    };
  const orderScope = (action: string, mutating = true): PreHandler =>
    resolvedScope(action, (org, id) => service.loadOrderPatientId(org, id), mutating);
  const orderReadScope = (action: string): PreHandler => orderScope(action, false);
  const historyRecordScope = (action: string): PreHandler =>
    resolvedScope(action, (org, id) => service.loadHistoryRecordPatientId(org, id), true);

  // 1 — list medication orders.
  app.get(
    "/api/v1/medication-orders",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "medication_order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MedicationOrderListQuerySchema, request.query);
      return service.listOrders(organizationId, {
        patientId: q.patientId,
        prescriberId: q.prescriberId,
        medClass: q.medClass,
        status: q.status,
        scope: listScopeOf(request),
      });
    },
  );

  // 3 — create draft (prescriber_eligible ABAC floor on the body's medClass).
  app.post(
    "/api/v1/medication-orders",
    { preHandler: [DRAFT, ABAC_DRAFT, chartScope("prescribing.draft", bodyPatientId, true)] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(CreateMedicationOrderRequest, request.body);
      // GAP-034 follow-up — the drafting discipline is persisted and later decides the cosign requirement, so it
      // is resolved from the SESSION (an RN who claims "physician" is recorded as the RN and owes the cosign).
      const draftingDiscipline = resolveDraftingDiscipline(
        prescriberDisciplinesOf(request.context),
        b.prescriberDiscipline,
      );
      const res = await service.createDraft(organizationId, userId, {
        patientId: b.patientId,
        admissionId: b.admissionId,
        medClass: b.medClass,
        rxnormRxcui: b.rxnormRxcui,
        ndc: b.ndc,
        drugName: b.drugName,
        strength: b.strength,
        doseForm: b.doseForm,
        route: b.route,
        data: b.data,
        prescriberDiscipline: draftingDiscipline,
        prescribingPhysicianMdmId: b.prescribingPhysicianMdmId,
        dispensingPharmacyMdmId: b.dispensingPharmacyMdmId,
        deaSchedule:
          b.deaSchedule ?? (b.data as { deaSchedule?: typeof b.deaSchedule } | null)?.deaSchedule,
        containsControlled:
          b.containsControlled ??
          (b.data as { containsControlled?: boolean } | null)?.containsControlled,
        refillsAuthorized: b.refillsAuthorized,
      });
      return reply.code(201).send(res);
    },
  );

  // 2 — medication order detail.
  app.get(
    "/api/v1/medication-orders/:id",
    {
      preHandler: [READ, orderReadScope("prescribing.read")],
      config: { auditRead: { resourceKind: "medication_order", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      // `viewerMayRetransmit` — the retransmit route's own standing inputs (acting membership + session
      // disciplines), so the UI offers Retransmit only to a caller the write would accept.
      return service.getOrder(organizationId, id, {
        membershipId: userId,
        disciplines: prescriberDisciplinesOf(request.context),
      });
    },
  );

  // 4 — edit a draft.
  app.patch(
    "/api/v1/medication-orders/:id",
    { preHandler: [DRAFT, orderScope("prescribing.draft")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(UpdateMedicationOrderRequest, request.body);
      return service.editDraft(organizationId, id, {
        data: b.data,
        drugName: b.drugName,
        strength: b.strength,
        refillsAuthorized: b.refillsAuthorized,
      });
    },
  );

  // 5 — draft → pending_signature.
  app.post(
    "/api/v1/medication-orders/:id/request-signature",
    { preHandler: [DRAFT, orderScope("prescribing.draft")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(RequestSignatureRequest, request.body);
      // The body still names a discipline (the API contract) but it must be one the SESSION holds.
      const held = prescriberDisciplinesOf(request.context);
      assertDisciplineHeld(held, b.signerDiscipline);
      // GAP-036 — the acting membership is the session's, never a body field (it is who the M39 Part 2
      // gate answers for).
      // GAP-036 — an allergy acknowledgement carries the reason AND the session's step-up freshness
      // (server-resolved); the service re-enforces both, so a reason alone never overrides.
      const allergyOverride =
        b.allergyOverrideReason === undefined
          ? undefined
          : {
              reason: b.allergyOverrideReason,
              stepUpFresh: await requestStepUpFresh(request, ALLERGY_OVERRIDE_STEP_UP_OPERATION),
            };
      return service.requestSignature(
        organizationId,
        id,
        b.signerDiscipline,
        held,
        userId,
        allergyOverride,
      );
    },
  );

  // 6 — standard sign (→ signed).
  app.post(
    "/api/v1/medication-orders/:id/sign",
    { preHandler: [SIGN, orderScope("prescribing.sign"), ABAC_SIGN_ELIGIBLE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(SignMedicationOrderRequest, request.body);
      // GAP-035 — discipline comes from the session, the ordering-physician standing from the stored
      // order + roster inside the service; nothing about either is read off the body.
      return service.signOrder(organizationId, userId, id, {
        signerDisciplines: prescriberDisciplinesOf(request.context),
        signedAtClient: b.signedAtClient,
      });
    },
  );

  // 7 — controlled sign initiate (60s 2FA nonce; dea_schedule_authorized ABAC).
  app.post(
    "/api/v1/medication-orders/:id/sign-controlled/initiate",
    {
      // scope BEFORE the DEA ABAC so an off-caseload actor gets the same 404 as an unknown id.
      preHandler: [
        SIGN_CONTROLLED,
        orderScope("prescribing.sign_controlled_substance"),
        ABAC_SIGN_CONTROLLED,
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(SignControlledInitiateRequest, request.body);
      const held = prescriberDisciplinesOf(request.context);
      assertDisciplineHeld(held, b.signerDiscipline);
      return service.signControlledInitiate(organizationId, userId, id, b.schedule, {
        signerDiscipline: b.signerDiscipline,
        signerDisciplines: held,
      });
    },
  );

  // 8 — controlled sign complete (2FA → signed).
  app.post(
    "/api/v1/medication-orders/:id/sign-controlled/complete",
    { preHandler: [SIGN_CONTROLLED, orderScope("prescribing.sign_controlled_substance")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      parse(SignControlledCompleteRequest, request.body);
      return service.signControlledComplete(organizationId, userId, id, {
        signerDisciplines: prescriberDisciplinesOf(request.context),
      });
    },
  );

  // 9 — record as verbal (→ verbal_pending; controlled is Phase-1-OFF per D18).
  app.post(
    "/api/v1/medication-orders/:id/verbal",
    { preHandler: [VERBAL, orderScope("prescribing.verbal.record")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(RecordVerbalRequest, request.body);
      const held = prescriberDisciplinesOf(request.context);
      assertDisciplineHeld(held, b.recorderDiscipline);
      return service.recordVerbal(organizationId, userId, id, {
        recorderDiscipline: b.recorderDiscipline,
        recorderDisciplines: held,
        verbalAttestation: b.verbalAttestation,
        receivedAt: b.receivedAt,
        namedPrescriberMdmId: b.namedPrescriberMdmId,
      });
    },
  );

  // 10 — attach a cosignature (service enforces status, session role, no self-cosign, M11 seam record).
  app.post(
    "/api/v1/medication-orders/:id/cosign",
    { preHandler: [COSIGN, orderScope("prescribing.cosign")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(CosignRequest, request.body);
      return service.cosignOrder(organizationId, userId, id, {
        cosignerRole: b.cosignerRole,
        attestationText: b.attestationText,
        // GAP-034 — the roles the SESSION holds; the service refuses a claimed `cosignerRole` outside them.
        cosignerDisciplines: prescriberDisciplinesOf(request.context),
      });
    },
  );

  // 11 — discontinue.
  app.post(
    "/api/v1/medication-orders/:id/discontinue",
    { preHandler: [DISCONTINUE, orderScope("prescribing.discontinue")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(DiscontinueRequest, request.body);
      return service.discontinueOrder(organizationId, userId, id, {
        reason: b.reason,
        effectiveAt: b.effectiveAt,
        notes: b.notes,
      });
    },
  );

  // F-205 (#248) — file a clinician-initiated medication-error report against an order. Not a status
  // transition (the order's lifecycle/version is untouched); emits `m12.medication.error_reported` for
  // M30's auto-incident-draft consumer.
  app.post(
    "/api/v1/medication-orders/:id/report-error",
    { preHandler: [REPORT_ERROR, orderScope("prescribing.report_error")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(ReportMedicationErrorRequest, request.body);
      return service.reportMedicationError(organizationId, userId, id, {
        errorCategory: b.errorCategory,
        summary: b.summary,
      });
    },
  );

  // COP27 (42 CFR 418.24(c)) — set/change the hospice coverage determination (covered_related |
  // not_covered_unrelated | not_covered_other + reason). Not a lifecycle transition; caseload-scoped and
  // never break-glass-bypassable like every other write. The determining membership is the SESSION's.
  app.put(
    "/api/v1/medication-orders/:id/coverage-determination",
    { preHandler: [COVERAGE, orderScope("prescribing.coverage_determine")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(SetCoverageDeterminationRequest, request.body);
      return service.setCoverageDetermination(organizationId, userId, id, {
        hospiceCoverage: b.hospiceCoverage,
        reason: b.reason ?? null,
      });
    },
  );

  // 12 — complete (one-shot / no-refills-no-renewal).
  app.post(
    "/api/v1/medication-orders/:id/complete",
    { preHandler: [DISCONTINUE, orderScope("prescribing.discontinue")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(CompleteRequest, request.body);
      return service.completeOrder(organizationId, userId, id, b.reason);
    },
  );

  // 13 — corrected order (replaces_medication_order_id; prescriber_eligible ABAC).
  app.post(
    "/api/v1/medication-orders/:id/correct",
    { preHandler: [DRAFT, ABAC_DRAFT, orderScope("prescribing.draft")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const b = parse(CorrectMedicationOrderRequest, request.body);
      const draftingDiscipline = resolveDraftingDiscipline(
        prescriberDisciplinesOf(request.context),
        b.prescriberDiscipline,
      ); // persisted → resolved from the session
      const res = await service.correctOrder(organizationId, userId, id, {
        patientId: b.patientId,
        admissionId: b.admissionId,
        medClass: b.medClass,
        rxnormRxcui: b.rxnormRxcui,
        ndc: b.ndc,
        drugName: b.drugName,
        strength: b.strength,
        doseForm: b.doseForm,
        route: b.route,
        data: b.data,
        prescriberDiscipline: draftingDiscipline,
        prescribingPhysicianMdmId: b.prescribingPhysicianMdmId,
        dispensingPharmacyMdmId: b.dispensingPharmacyMdmId,
        deaSchedule: b.deaSchedule,
        containsControlled: b.containsControlled,
        refillsAuthorized: b.refillsAuthorized,
      });
      return reply.code(201).send(res);
    },
  );

  // 14 — retransmit a transmission_failed order (mints a corrected order).
  app.post(
    "/api/v1/medication-orders/:id/retransmit",
    // scope first (404 off-caseload), then the signer ABAC (session disciplines); the service decides the
    // authoring-prescriber / named-physician standing from the stored order + roster.
    { preHandler: [SIGN, orderScope("prescribing.sign"), ABAC_SIGN_ELIGIBLE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const res = await service.retransmit(organizationId, userId, id, {
        signerDisciplines: prescriberDisciplinesOf(request.context),
      });
      return reply.code(201).send(res);
    },
  );

  // 15 — DoseSpot transmission status incl. retry history.
  app.get(
    "/api/v1/medication-orders/:id/transmission",
    {
      preHandler: [READ, orderReadScope("prescribing.read")],
      config: { auditRead: { resourceKind: "medication_order", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      return service.getTransmission(organizationId, id);
    },
  );

  // 16 — active medications for a patient.
  app.get(
    "/api/v1/patients/:patientId/medications/active",
    {
      preHandler: [READ, chartScope("prescribing.read", paramPatientId)],
      config: { auditRead: { resourceKind: "medication_order", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.activeMedications(organizationId, patientId);
    },
  );

  // 17 — medication history list.
  app.get(
    "/api/v1/patients/:patientId/medications/history",
    {
      preHandler: [HISTORY_READ, chartScope("prescribing.history.read", paramPatientId)],
      config: { auditRead: { resourceKind: "medication_order", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.medicationHistory(organizationId, patientId);
    },
  );

  // 18 — enqueue a medication-history refresh (DoseSpot MedHx pull).
  app.post(
    "/api/v1/patients/:patientId/medications/history/refresh",
    { preHandler: [HISTORY_READ, chartScope("prescribing.history.read", paramPatientId, true)] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.refreshHistory(organizationId, patientId);
    },
  );

  // 19 — reconcile a medication-history record.
  app.post(
    "/api/v1/medication-history-records/:id/reconcile",
    { preHandler: [HISTORY_RECONCILE, historyRecordScope("prescribing.history.reconcile")] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(HistoryRecordParamsSchema, request.params);
      const b = parse(ReconcileRequest, request.body);
      return service.reconcileHistory(organizationId, userId, id, b.decision);
    },
  );

  // 20 — refill inbox (refill_inbox_scope ABAC; list resolves to allow + the service narrows).
  app.get(
    "/api/v1/refills",
    {
      preHandler: [READ, ABAC_REFILL_SCOPE],
      config: { auditRead: { resourceKind: "refill", list: true } },
    },
    async (request) => {
      const { organizationId, actor } = refillActorOf(request);
      return service.listRefills(organizationId, actor);
    },
  );

  // 21 — refill detail.
  app.get(
    "/api/v1/refills/:id",
    {
      preHandler: [READ, ABAC_REFILL_SCOPE],
      config: { auditRead: { resourceKind: "refill", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(RefillParamsSchema, request.params);
      return service.getRefill(organizationId, id);
    },
  );

  // 22 — approve a refill (mints a new medication_order).
  app.post(
    "/api/v1/refills/:id/approve",
    { preHandler: [REFILL_DECIDE, ABAC_REFILL_DECIDE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(RefillParamsSchema, request.params);
      const b = parse(ApproveRefillRequest, request.body);
      const res = await service.approveRefill(organizationId, userId, id, {
        refillsAuthorized: b.refillsAuthorized,
        responseChannel: b.responseChannel,
        notes: b.notes,
      });
      return reply.code(201).send(res);
    },
  );

  // 23 — deny a refill.
  app.post(
    "/api/v1/refills/:id/deny",
    { preHandler: [REFILL_DECIDE, ABAC_REFILL_DECIDE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(RefillParamsSchema, request.params);
      const b = parse(DenyRefillRequest, request.body);
      return service.denyRefill(organizationId, userId, id, {
        denialReason: b.denialReason,
        responseChannel: b.responseChannel,
      });
    },
  );

  // 24 — RxBenefit cached lookup.
  app.post(
    "/api/v1/rx-benefit/lookup",
    { preHandler: [RX_BENEFIT, chartScope("prescribing.rx_benefit.lookup", bodyPatientId, true)] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const b = parse(RxBenefitLookupRequest, request.body);
      return service.rxBenefitLookup(organizationId, b.patientId, b.rxnormRxcui);
    },
  );

  // 25 — per-tenant prescriber roster.
  app.get(
    "/api/v1/admin/dosespot-prescribers",
    {
      preHandler: [ROSTER],
      config: {
        auditRead: { none: "prescriber enrollment/credential roster; no patient data" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listPrescribers(organizationId);
    },
  );

  // 25b — the verbal-record picker: ACTIVE prescribers with an MDM id (what `namedPrescriberMdmId` accepts).
  // Gated by the verbal-record permission (a recording RN has no `prescribing.admin.roster`).
  app.get(
    "/api/v1/prescribing/named-prescribers",
    {
      preHandler: [VERBAL],
      config: {
        auditRead: { none: "prescriber roster ids (membership + MDM id); no patient data" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listNamedPrescribers(organizationId);
    },
  );

  // 26 — enroll a prescriber into DoseSpot. This is THE way `externalPhysicianMdmId` is set: it links the
  // membership to the M40 ExternalPhysician a verbal order names (spec §2.2/§2.3, no on-behalf signing).
  app.post(
    "/api/v1/admin/dosespot-prescribers/:membershipId/enroll",
    { preHandler: [ROSTER] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { membershipId } = parse(MembershipParamsSchema, request.params);
      const b = parse(EnrollPrescriberRequest, request.body);
      const res = await service.enrollPrescriber(
        organizationId,
        membershipId,
        b.deaAuthorizedSchedules ?? [],
        b.externalPhysicianMdmId,
      );
      return reply.code(201).send(res);
    },
  );

  // 27 — revoke a prescriber.
  app.post(
    "/api/v1/admin/dosespot-prescribers/:membershipId/revoke",
    { preHandler: [ROSTER] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { membershipId } = parse(MembershipParamsSchema, request.params);
      const b = parse(RevokePrescriberRequest, request.body);
      return service.revokePrescriber(organizationId, membershipId, b.reason);
    },
  );

  // 28 — refill-inbox policy read.
  app.get(
    "/api/v1/admin/refill-inbox-policy",
    {
      preHandler: [POLICY],
      config: {
        auditRead: { none: "org-level refill-inbox SLA policy configuration; no patient data" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getRefillInboxPolicy(organizationId);
    },
  );

  // 29 — refill-inbox policy update (tighten-only).
  app.patch("/api/v1/admin/refill-inbox-policy", { preHandler: [POLICY] }, async (request) => {
    const { organizationId } = actorOf(request);
    const b = parse(RefillInboxPolicyRequest, request.body);
    return service.putRefillInboxPolicy(organizationId, {
      slaWarnHours: b.slaWarnHours,
      slaCriticalHours: b.slaCriticalHours,
    });
  });

  // 30 — controlled-substance policy read.
  app.get(
    "/api/v1/admin/controlled-substance-policy",
    {
      preHandler: [POLICY],
      config: {
        auditRead: {
          none: "org-level controlled-substance refill policy configuration; no patient data",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getControlledSubstancePolicy(organizationId);
    },
  );

  // 31 — controlled-substance policy update (tighten-only, 21 CFR 1306.22).
  app.patch(
    "/api/v1/admin/controlled-substance-policy",
    { preHandler: [POLICY] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const b = parse(ControlledSubstancePolicyRequest, request.body);
      return service.putControlledSubstancePolicy(organizationId, {
        scheduleIiiToVMaxRefills: b.scheduleIiiToVMaxRefills,
      });
    },
  );
}
