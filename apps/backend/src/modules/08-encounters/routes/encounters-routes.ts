// apps/backend/src/modules/08-encounters/routes/encounters-routes.ts — M8-T09 the §4.1 route inventory
// (31 routes) behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth,
// M3) on the §4.5 keys M8 registers into M3's catalog (M8_CONTRIBUTED_PERMISSIONS). Org binding is
// server-side (`request.context`, never the body). Handlers compose over the injected EncounterRouteService
// (in-memory slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.6: the cosignature routes (19/20) additionally wire `requireAbac('cosigner_role_match')` — the new
// predicate M8 owns (RN ∧ not-self-author; caseload composed by the reused `caseload_membership`). §7.7:
// the selections PATCH carries `If-Match` (the row version) → 412 VERSION_MISMATCH on skew. Sign routes
// (14/20/21/25) carry the client's step-up timestamp; freshness (≤ 5 min, §2.7 D13) is verified here and
// injected into the lifecycle machine (STEP_UP_AUTH_REQUIRED → 412 when stale).
import { requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { STEP_UP_MAX_AGE_SECONDS } from "../lifecycle/validation";
import { ifMatchVersionOf, requireIfMatch } from "./concurrency";
import {
  AddendumParamsSchema,
  AdministrativeOverrideSchema,
  BillableQuerySchema,
  CaptureMileageSchema,
  CaptureVitalsSchema,
  CarePlanLinkParamsSchema,
  CarePlanLinkSchema,
  CreateAddendumSchema,
  CreateEncounterSchema,
  EncounterListQuerySchema,
  EncounterParamsSchema,
  EvvReconcileSchema,
  HearthnoteEnhanceSchema,
  LateEntryOverrideSchema,
  ModificationDecisionSchema,
  ModificationParamsSchema,
  SignEncounterSchema,
  SignedSinceQuerySchema,
  SupervisorReleaseSchema,
  VitalParamsSchema,
  VoidEncounterSchema,
  parse,
} from "./encounters-typebox";
import type { EncounterRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface EncounterRouteDeps {
  service: EncounterRouteService;
}

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

const encounterIdOf = (request: FastifyRequest): string =>
  parse(EncounterParamsSchema, request.params).encounterId;

/** Today (org-TZ resolved upstream in prod; the slice uses the server clock for the transition stamp). */
const today = (): string => new Date().toISOString().slice(0, 10);

/** §2.7 D13 — is the client's step-up timestamp ≤ 5 minutes old (the freshness the sign machine needs). */
function stepUpFreshFrom(stepUpAuthAt: string): boolean {
  const age = (Date.now() - Date.parse(stepUpAuthAt)) / 1000;
  return age >= 0 && age <= STEP_UP_MAX_AGE_SECONDS;
}

const isRn = (roles: readonly string[]): boolean =>
  roles.includes("rn") || roles.includes("rn_case_manager");
const isSupervisor = (roles: readonly string[]): boolean =>
  roles.includes("clinical_supervisor") || roles.includes("don");

// Static permission guards (§4.5).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("encounter.read");
const AUTHOR = P("encounter.author");
const FINALIZE = P("encounter.finalize");
const SIGN = P("encounter.sign");
const COSIGN = P("encounter.cosign");
const COSIGN_RELEASE = P("encounter.cosign_supervisor_release");
const ADDENDUM_AUTHOR = P("encounter.addendum_author");
const ADDENDUM_SIGN = P("encounter.addendum_sign");
const LATE_OVERRIDE = P("encounter.late_entry_override");
const ADMIN_OVERRIDE = P("encounter.administrative_override");
const READ_INTERNAL = P("encounter.read_internal");
const VITALS = P("vitals.author");
const MILEAGE = P("mileage.author");

// §4.6 — the cosigner_role_match ABAC guard M8 owns (target = request.params → encounterId).
const ABAC_COSIGN = requireAbac("encounter.cosign", "cosigner_role_match") as PreHandler;

// §7.7 — the selections PATCH carries the read version in If-Match.
const IF_MATCH = requireIfMatch() as PreHandler;

export function registerEncounterRoutes(app: FastifyInstance, deps: EncounterRouteDeps): void {
  const { service } = deps;

  // 1 — create draft encounter.
  app.post("/api/v1/encounters", { preHandler: [AUTHOR] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(CreateEncounterSchema, request.body);
    const res = await service.createDraft(organizationId, userId, {
      patientId: body.patientId,
      admissionId: body.admissionId,
      visitId: body.visitId,
      encounterType: body.encounterType,
      discipline: body.discipline,
      serviceDate: body.serviceDate,
      faceToFaceEncounterId: body.faceToFaceEncounterId,
      bereavementPlanId: body.bereavementPlanId,
    });
    return reply.code(201).send(res);
  });

  // 26 — list encounters (static path BEFORE the :encounterId param routes for clarity).
  app.get(
    "/api/v1/encounters",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "encounter", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EncounterListQuerySchema, request.query);
      return service.listEncounters(organizationId);
    },
  );

  // 27 — RN cosignature work queue.
  app.get(
    "/api/v1/encounters/cosignature-queue",
    {
      preHandler: [COSIGN],
      config: { auditRead: { resourceKind: "encounter", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.cosignatureQueue(organizationId);
    },
  );

  // 28 — author's open drafts.
  app.get(
    "/api/v1/encounters/my-drafts",
    {
      preHandler: [AUTHOR],
      config: { auditRead: { resourceKind: "encounter", list: true } },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      return service.myDrafts(organizationId, userId);
    },
  );

  // 2 — read one encounter.
  app.get(
    "/api/v1/encounters/:encounterId",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "encounter", resourceIdParam: "encounterId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getEncounter(organizationId, encounterIdOf(request));
    },
  );

  // 3 — update selections (§7.7 If-Match).
  app.patch(
    "/api/v1/encounters/:encounterId/selections",
    { preHandler: [AUTHOR, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EncounterParamsSchema, request.params);
      return service.updateSelections(
        organizationId,
        encounterIdOf(request),
        ifMatchVersionOf(request),
      );
    },
  );

  // 4 — capture vitals.
  app.post(
    "/api/v1/encounters/:encounterId/vitals",
    { preHandler: [VITALS] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(CaptureVitalsSchema, request.body);
      const res = await service.captureVitals(organizationId, encounterIdOf(request), body);
      return reply.code(201).send(res);
    },
  );

  // 5 — edit vitals.
  app.patch(
    "/api/v1/encounters/:encounterId/vitals/:vitalId",
    { preHandler: [VITALS, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, vitalId } = parse(VitalParamsSchema, request.params);
      const body = parse(CaptureVitalsSchema, request.body);
      return service.editVitals(organizationId, encounterId, vitalId, body);
    },
  );

  // 6 — capture mileage.
  app.post(
    "/api/v1/encounters/:encounterId/mileage",
    { preHandler: [MILEAGE] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(CaptureMileageSchema, request.body);
      const res = await service.captureMileage(organizationId, encounterIdOf(request), body);
      return reply.code(201).send(res);
    },
  );

  // 7 — edit mileage.
  app.patch(
    "/api/v1/encounters/:encounterId/mileage",
    { preHandler: [MILEAGE, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(CaptureMileageSchema, request.body);
      return service.editMileage(organizationId, encounterIdOf(request), body);
    },
  );

  // 8 — link encounter to care-plan elements.
  app.post(
    "/api/v1/encounters/:encounterId/care-plan-links",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      parse(CarePlanLinkSchema, request.body);
      const res = await service.addCarePlanLink(organizationId, encounterIdOf(request));
      return reply.code(201).send(res);
    },
  );

  // 9 — remove a care-plan link while draft.
  app.delete(
    "/api/v1/encounters/:encounterId/care-plan-links/:linkId",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { encounterId, linkId } = parse(CarePlanLinkParamsSchema, request.params);
      await service.removeCarePlanLink(organizationId, encounterId, linkId);
      return reply.code(204).send();
    },
  );

  // 10 — document EVV-missing reason (D9 fallback).
  app.post(
    "/api/v1/encounters/:encounterId/evv-reconcile",
    { preHandler: [AUTHOR] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EvvReconcileSchema, request.body);
      return service.documentEvvMissing(organizationId, encounterIdOf(request));
    },
  );

  // 11 — finalize (Layer-3 gate preview).
  app.post(
    "/api/v1/encounters/:encounterId/finalize",
    { preHandler: [FINALIZE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.finalize(organizationId, encounterIdOf(request), today());
    },
  );

  // 12 — invoke HearthNote Layer-2 enhancement.
  app.post(
    "/api/v1/encounters/:encounterId/hearthnote/enhance",
    { preHandler: [FINALIZE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(HearthnoteEnhanceSchema, request.body);
      return service.enhanceHearthnote(organizationId, encounterIdOf(request));
    },
  );

  // 13 — record per-passage accept/edit/reject.
  app.patch(
    "/api/v1/encounters/:encounterId/hearthnote/modifications/:modId/decisions",
    { preHandler: [FINALIZE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, modId } = parse(ModificationParamsSchema, request.params);
      parse(ModificationDecisionSchema, request.body);
      return service.recordModificationDecision(organizationId, encounterId, modId);
    },
  );

  // 14 — sign (Layer-3 gate enforced; D13 step-up).
  app.post("/api/v1/encounters/:encounterId/sign", { preHandler: [SIGN] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(SignEncounterSchema, request.body);
    return service.sign(organizationId, encounterIdOf(request), {
      stepUpFresh: stepUpFreshFrom(body.stepUpAuthAt),
      at: today(),
    });
  });

  // 15 — significant late-entry tier override (supervisor).
  app.post(
    "/api/v1/encounters/:encounterId/late-entry-override",
    { preHandler: [LATE_OVERRIDE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(LateEntryOverrideSchema, request.body);
      return service.lateEntryOverride(organizationId, encounterIdOf(request));
    },
  );

  // 16 — administrative >14-day override (director).
  app.post(
    "/api/v1/encounters/:encounterId/administrative-override",
    { preHandler: [ADMIN_OVERRIDE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(AdministrativeOverrideSchema, request.body);
      return service.administrativeOverride(organizationId, encounterIdOf(request));
    },
  );

  // 17 — void a draft (admin-only; reason ≥ 40 chars).
  app.post(
    "/api/v1/encounters/:encounterId/void",
    { preHandler: [ADMIN_OVERRIDE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(VoidEncounterSchema, request.body);
      return service.voidEncounter(organizationId, encounterIdOf(request), {
        isAdmin: true,
        reason: body.reason,
        at: today(),
      });
    },
  );

  // 18 — read cosignature-request state.
  app.get(
    "/api/v1/encounters/:encounterId/cosignature",
    {
      preHandler: [READ],
      config: {
        auditRead: { resourceKind: "encounter_cosignature", resourceIdParam: "encounterId" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getCosignature(organizationId, encounterIdOf(request));
    },
  );

  // 19 — cosigner acknowledges (§4.6 cosigner_role_match).
  app.post(
    "/api/v1/encounters/:encounterId/cosignature/acknowledge",
    { preHandler: [COSIGN, ABAC_COSIGN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.cosignAcknowledge(organizationId, encounterIdOf(request), today());
    },
  );

  // 20 — cosigner signs (§4.6 cosigner_role_match; D13 step-up).
  app.post(
    "/api/v1/encounters/:encounterId/cosignature/sign",
    { preHandler: [COSIGN, ABAC_COSIGN] },
    async (request) => {
      const { organizationId, roles } = actorOf(request);
      parse(SignEncounterSchema, request.body); // validates the attestation + step-up timestamp shape
      return service.cosignSign(organizationId, encounterIdOf(request), {
        isQualifiedRn: isRn(roles),
        at: today(),
      });
    },
  );

  // 21 — supervisor releases past the 48h hard cap.
  app.post(
    "/api/v1/encounters/:encounterId/cosignature/supervisor-release",
    { preHandler: [COSIGN_RELEASE] },
    async (request) => {
      const { organizationId, roles } = actorOf(request);
      const body = parse(SupervisorReleaseSchema, request.body);
      return service.supervisorRelease(organizationId, encounterIdOf(request), {
        isSupervisor: isSupervisor(roles),
        reason: body.reason,
        at: today(),
      });
    },
  );

  // 22 — create addendum draft on a signed encounter.
  app.post(
    "/api/v1/encounters/:encounterId/addenda",
    { preHandler: [ADDENDUM_AUTHOR] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      parse(CreateAddendumSchema, request.body);
      const res = await service.createAddendum(organizationId, encounterIdOf(request));
      return reply.code(201).send(res);
    },
  );

  // 23 — update addendum selections (§7.7 If-Match).
  app.patch(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/selections",
    { preHandler: [ADDENDUM_AUTHOR, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, addendumId } = parse(AddendumParamsSchema, request.params);
      return service.updateAddendumSelections(organizationId, encounterId, addendumId);
    },
  );

  // 24 — finalize addendum.
  app.post(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/finalize",
    { preHandler: [ADDENDUM_AUTHOR] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, addendumId } = parse(AddendumParamsSchema, request.params);
      return service.finalizeAddendum(organizationId, encounterId, addendumId);
    },
  );

  // 25 — sign addendum (D13 step-up).
  app.post(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/sign",
    { preHandler: [ADDENDUM_SIGN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, addendumId } = parse(AddendumParamsSchema, request.params);
      const body = parse(SignEncounterSchema, request.body);
      return service.signAddendum(organizationId, encounterId, addendumId, {
        stepUpFresh: stepUpFreshFrom(body.stepUpAuthAt),
        at: today(),
      });
    },
  );

  // 29 — internal: BillableEncounterReader seam endpoint (system principal; M23/M24).
  app.get(
    "/api/v1/internal/encounters/billable",
    {
      preHandler: [READ_INTERNAL],
      config: { auditRead: { resourceKind: "encounter", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(BillableQuerySchema, request.query);
      return service.billable(organizationId, q.encounterIds);
    },
  );

  // 30 — internal: signed-since seam (system principal; M14 IDG aggregator).
  app.get(
    "/api/v1/internal/encounters/signed-since",
    {
      preHandler: [READ_INTERNAL],
      config: { auditRead: { resourceKind: "encounter", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(SignedSinceQuerySchema, request.query);
      return service.signedSince(organizationId, q.since);
    },
  );

  // 31 — internal: M22 PDF-render payload (system principal).
  app.get(
    "/api/v1/internal/encounters/:encounterId/render-payload",
    {
      preHandler: [READ_INTERNAL],
      config: {
        auditRead: { resourceKind: "encounter", resourceIdParam: "encounterId" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.renderPayload(organizationId, encounterIdOf(request));
    },
  );
}
