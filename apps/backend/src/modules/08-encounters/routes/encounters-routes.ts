// apps/backend/src/modules/08-encounters/routes/encounters-routes.ts — M8-T09 the §4.1 route inventory
// (34 routes) behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth,
// M3) on the §4.5 keys M8 registers into M3's catalog (M8_CONTRIBUTED_PERMISSIONS). Org binding is
// server-side (`request.context`, never the body). Handlers compose over the injected EncounterRouteService
// (in-memory slice; Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.6: the cosignature routes (19/20) wire `requireAbac('m8.cosigner_role_match')` — RN ∧ not-self-
// author. GAP-014 (2026-08-09): caseload scoping is now composed too, via the M8-owned `encounter.scope`
// predicate (abac-predicates.ts) on routes 1/2/3/8/18/19/20/22 — the module previously shipped with NO
// route-level caseload enforcement despite the header comment's prior claim it was "composed separately
// upstream" (nothing ever composed it). §7.7: the selections PATCH carries `If-Match` (the row version)
// → 412 VERSION_MISMATCH on skew. Sign routes (14/20/21/25) carry the client's step-up timestamp;
// freshness (≤ 5 min, §2.7 D13) is verified here and injected into the lifecycle machine
// (STEP_UP_AUTH_REQUIRED → 412 when stale).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  UpdateSelectionsSchema,
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
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" (matches
  // `signingActorOf` below, and every `authored_by_membership_id`/`created_by_membership_id`
  // column this module's service layer writes it into — see encounters-route-service-db.ts:472's
  // own comment: "stored as the authoring membership"). This used to read `ctx.userId` (the raw
  // Better Auth user id, set unconditionally by the M2 authenticate hook — a DIFFERENT id from the
  // org membership), which meant `POST /encounters` FK-violated on `authored_by_membership_id`
  // every single call, and `GET /encounters/my-drafts` silently returned zero rows for everyone
  // (filtering by a value no draft's `authored_by_membership_id` could ever equal).
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId, roles: ctx.roles };
}

/** The real caller signing an encounter/cosignature/addendum (§3.3/D13) — membership id + M2 session
 *  id, the `encounter_signature` provenance row's actor. `requireStepUp` (composed on the sign routes)
 *  already denied the request if this session's step-up isn't fresh; the service re-resolves the same
 *  seam to capture method/timestamp for real (never trusts a client-supplied claim — see the removed
 *  `stepUpAuthAt` request-body field, git history). Both attributes are stamped by M2's authenticate
 *  hook (`apps/backend/src/bootstrap/plugins/authenticate.ts`) onto every authenticated request. */
function signingActorOf(request: FastifyRequest): { membershipId: string; sessionId: string } {
  const ctx = request.context;
  const membershipId = ctx?.attributes.membershipId;
  const sessionId = ctx?.attributes.sessionId;
  if (typeof membershipId !== "string" || typeof sessionId !== "string")
    throw new UnauthorizedError();
  return { membershipId, sessionId };
}

const encounterIdOf = (request: FastifyRequest): string =>
  parse(EncounterParamsSchema, request.params).encounterId;

/** Today (org-TZ resolved upstream in prod; the slice uses the server clock for the transition stamp). */
const today = (): string => new Date().toISOString().slice(0, 10);

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

// §4.6 — the m8.cosigner_role_match ABAC guard M8 owns (target = request.params → encounterId).
const ABAC_COSIGN = requireAbac("encounter.cosign", "m8.cosigner_role_match") as PreHandler;

// GAP-014 — the `encounter.scope` caseload guard M8 owns (abac-predicates.ts). `notFoundOnDeny: true`
// matches the platform's §2.2 existence non-leak convention (M6/M7 precedent): a cross-tenant/outside-
// caseload denial must read the same as an absent resource. Every route below already carries
// `encounterId` in `request.params` (the predicate's default target) EXCEPT create (route 1), which
// carries `patientId` in the body instead — the one case `getTarget` lifts a body field, per the same
// "still never trusted for the SUBJECT" convention M7's `discipline_scope` guard uses.
const SCOPE_FOR = (action: string): PreHandler =>
  requireAbac(action, "encounter.scope", { notFoundOnDeny: true }) as PreHandler;
const SCOPE_CREATE = requireAbac("encounter.author", "encounter.scope", {
  notFoundOnDeny: true,
  getTarget: (request) => ({
    patientId: (request.body as { patientId?: unknown } | null)?.patientId,
  }),
}) as PreHandler;

// §2.7 D13 / CoP 418.104(c) — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate
// (real, server-verified freshness; replaces the removed client-timestamp-trusting check).
const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;

// §7.7 — the selections PATCH carries the read version in If-Match.
const IF_MATCH = requireIfMatch() as PreHandler;

export function registerEncounterRoutes(app: FastifyInstance, deps: EncounterRouteDeps): void {
  const { service } = deps;

  // 1 — create draft encounter.
  app.post("/api/v1/encounters", { preHandler: [AUTHOR, SCOPE_CREATE] }, async (request, reply) => {
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
  // GAP-014: deliberately NOT `encounter.scope`-gated — a list route has no single id for the
  // predicate's target model to scope against (M6/M7 precedent); narrowing rows to caseload is a
  // query-level filtering concern, not a boolean route gate. RBAC (`READ`) + RLS still apply.
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
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: { auditRead: { resourceKind: "encounter", resourceIdParam: "encounterId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getEncounter(organizationId, encounterIdOf(request));
    },
  );

  // 3 — update selections (§7.7 If-Match). The body used to be published and never read: the clinician's
  // HearthNote arrived, the version bumped, a 200 came back, and nothing was written (#114).
  app.patch(
    "/api/v1/encounters/:encounterId/selections",
    { preHandler: [AUTHOR, SCOPE_FOR("encounter.author"), IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EncounterParamsSchema, request.params);
      const body = parse(UpdateSelectionsSchema, request.body);
      return service.updateSelections(
        organizationId,
        encounterIdOf(request),
        ifMatchVersionOf(request),
        body,
      );
    },
  );

  // 3b — read the stored selection tree back, assembled. The PATCH had no counterpart read, which is
  // why the discard was invisible from every caller-facing surface (#114).
  app.get(
    "/api/v1/encounters/:encounterId/selections",
    {
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: {
        auditRead: {
          resourceKind: "hearthnote_selection",
          resourceIdParam: "encounterId",
          fields: ["selections", "freeText", "layer1Preview"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EncounterParamsSchema, request.params);
      return service.getSelections(organizationId, encounterIdOf(request));
    },
  );

  // 3c — the authoring MENU (F-063). `PATCH .../selections` carries `sectionId` and `code` as free
  // strings and the server rejects an unknown one, so a client with no menu could only guess at both —
  // which is why there was no note composer. `resolveTemplate` + `entriesFor` have existed as pure leaf
  // packages since M8-T05; nothing put them on the wire. Derived from the ENCOUNTER's own
  // type/discipline, so the menu offered and the rules `assembleSelections` enforces are the same rules.
  //
  // Not a PHI read — the template skeleton and the shipped vocabulary corpus are the same for every
  // patient — so it carries no `auditRead` config, unlike the selections read beside it.
  app.get(
    "/api/v1/encounters/:encounterId/template",
    {
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: {
        auditRead: {
          none: "the template skeleton and the shipped vocabulary corpus are platform data, identical for every patient — the encounter id selects which (type × discipline) menu to resolve and no patient content is returned, so there is no disclosure to account for (§164.528). The selection tree this menu is used to build IS audited, on the read beside it",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EncounterParamsSchema, request.params);
      return service.getTemplate(organizationId, encounterIdOf(request));
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

  // 5b — read back the encounter's vitals (#92).
  //
  // A SIBLING read rather than an expansion of the encounter DTO: `GET /encounters` and the two work
  // queues return `EncounterView[]` through the same projection, so folding vitals into the view would
  // ship every clinician's full measurement set on every list page — a PHI over-fetch to solve a
  // single-chart problem. `encounter.read` + the same `encounter.scope` caseload predicate the
  // encounter read carries, so the vitals of an encounter are exactly as reachable as the encounter.
  app.get(
    "/api/v1/encounters/:encounterId/vitals",
    {
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: {
        auditRead: {
          resourceKind: "vitals",
          resourceIdParam: "encounterId",
          fields: [
            "bpSystolic",
            "bpDiastolic",
            "heartRate",
            "respiratoryRate",
            "temperature",
            "spo2",
            "painScore",
            "weight",
            "height",
            "bmi",
            "bloodGlucose",
          ],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listVitals(organizationId, encounterIdOf(request));
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

  // 7b — read the mileage row back (F-063). `POST`/`PATCH .../mileage` wrote a real row and nothing
  // returned it — the write-only shape #92 fixed for vitals, on the table beside it. Mileage is
  // encounter-scoped travel rather than clinical content, but it is still on a PHI-bearing row, so it
  // audits as a read of the encounter.
  app.get(
    "/api/v1/encounters/:encounterId/mileage",
    {
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: { auditRead: { resourceKind: "mileage", resourceIdParam: "encounterId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(EncounterParamsSchema, request.params);
      return service.getMileage(organizationId, encounterIdOf(request));
    },
  );

  // 8 — link encounter to care-plan elements.
  //
  // F-064 (#159) — the body used to be parsed and DISCARDED: `addCarePlanLink(organizationId,
  // encounterId)` took no third argument, so the M7 refs the link exists to record never reached the
  // service, nothing was persisted, and the 201 carried the ENCOUNTER's own id under the name `linkId`.
  app.post(
    "/api/v1/encounters/:encounterId/care-plan-links",
    { preHandler: [AUTHOR, SCOPE_FOR("encounter.author")] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CarePlanLinkSchema, request.body);
      const res = await service.addCarePlanLink(
        organizationId,
        userId,
        encounterIdOf(request),
        body,
      );
      return reply.code(201).send(res);
    },
  );

  // 8b — the links on an encounter (F-064). Without this the table would be write-only even once links
  // persist: nothing projected them, here or on `GET /api/v1/encounters/:id`.
  app.get(
    "/api/v1/encounters/:encounterId/care-plan-links",
    {
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: {
        auditRead: {
          none: "Care-plan element refs (problem/goal/intervention ids) for one encounter; no clinical content.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listCarePlanLinks(organizationId, encounterIdOf(request));
    },
  );

  // 9 — remove a care-plan link while draft.
  //
  // F-064 — a SOFT invalidate now. This used to load the encounter, check it was mutable, and return
  // 204 having removed nothing: `wardenx_app` holds DELETE on no M8 table (§3.6 append-only) and there
  // was no column to mark instead. A link that is absent or already removed is a 404, because the old
  // 204 was indistinguishable from a working delete.
  app.delete(
    "/api/v1/encounters/:encounterId/care-plan-links/:linkId",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { encounterId, linkId } = parse(CarePlanLinkParamsSchema, request.params);
      await service.removeCarePlanLink(organizationId, userId, encounterId, linkId);
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

  // 12 — invoke HearthNote Layer-2 enhancement. Answers the §2.6 D5 ladder's verdict, not a fabricated
  // modification id (#123). 200 is the spec's own status for this route, and the right one: Layer 2
  // being off is a steady state, not a fault — every call in Phase 1 returns it, and a normal outcome
  // expressed as an HTTP error would pollute error rates and client retry logic for a feature that is
  // simply switched off. The refusal is in the BODY, where a UI can render it.
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
  app.post(
    "/api/v1/encounters/:encounterId/sign",
    { preHandler: [SIGN, STEP_UP("encounter.sign")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(SignEncounterSchema, request.body); // validates the attestation-confirmed shape
      return service.sign(organizationId, encounterIdOf(request), signingActorOf(request), {
        at: today(),
      });
    },
  );

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
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: {
        auditRead: { resourceKind: "encounter_cosignature", resourceIdParam: "encounterId" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getCosignature(organizationId, encounterIdOf(request));
    },
  );

  // 19 — cosigner acknowledges (§4.6 m8.cosigner_role_match).
  app.post(
    "/api/v1/encounters/:encounterId/cosignature/acknowledge",
    { preHandler: [COSIGN, ABAC_COSIGN, SCOPE_FOR("encounter.cosign")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.cosignAcknowledge(organizationId, encounterIdOf(request), today());
    },
  );

  // 20 — cosigner signs (§4.6 m8.cosigner_role_match; D13 step-up).
  app.post(
    "/api/v1/encounters/:encounterId/cosignature/sign",
    {
      preHandler: [COSIGN, ABAC_COSIGN, SCOPE_FOR("encounter.cosign"), STEP_UP("encounter.cosign")],
    },
    async (request) => {
      const { organizationId, roles } = actorOf(request);
      parse(SignEncounterSchema, request.body); // validates the attestation-confirmed shape
      return service.cosignSign(organizationId, encounterIdOf(request), signingActorOf(request), {
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
    { preHandler: [ADDENDUM_AUTHOR, SCOPE_FOR("encounter.addendum_author")] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      parse(CreateAddendumSchema, request.body);
      const res = await service.createAddendum(organizationId, encounterIdOf(request));
      return reply.code(201).send(res);
    },
  );

  // 23 — update addendum selections (§7.7 If-Match). Same discard as route 3, same fix (#114).
  app.patch(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/selections",
    { preHandler: [ADDENDUM_AUTHOR, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, addendumId } = parse(AddendumParamsSchema, request.params);
      const body = parse(UpdateSelectionsSchema, request.body);
      return service.updateAddendumSelections(organizationId, encounterId, addendumId, body);
    },
  );

  // 23b — read an addendum's stored selection tree back, assembled (#114).
  app.get(
    "/api/v1/encounters/:encounterId/addenda/:addendumId/selections",
    {
      preHandler: [READ, SCOPE_FOR("encounter.read")],
      config: {
        auditRead: {
          resourceKind: "hearthnote_selection",
          resourceIdParam: "addendumId",
          fields: ["selections", "freeText", "layer1Preview"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, addendumId } = parse(AddendumParamsSchema, request.params);
      return service.getAddendumSelections(organizationId, encounterId, addendumId);
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
    { preHandler: [ADDENDUM_SIGN, STEP_UP("encounter.addendum.sign")] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { encounterId, addendumId } = parse(AddendumParamsSchema, request.params);
      parse(SignEncounterSchema, request.body); // validates the attestation-confirmed shape
      return service.signAddendum(
        organizationId,
        encounterId,
        addendumId,
        signingActorOf(request),
        { at: today() },
      );
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
