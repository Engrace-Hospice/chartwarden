// apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts — M23 (§4.1 routes #1–#13, claims
// core). The claim lifecycle surface: server-authoritative assembly, the validation re-run trigger, the
// READY→SUBMITTED submit (+M2 step-up), the TOB-817 replace / TOB-818 void builders, the cursor-paginated
// list + the single-claim detail, and the per-claim sub-collections (lines / state-history / submissions /
// acknowledgments).
//
// GUARD LADDER (the M27 cost-reports.routes.ts precedent, M23-flavored):
//   - org/actor/membership binding is ALWAYS server-side (`request.context` via actorOf/writeActorOf), NEVER
//     read off the body — every authored row is stamped with the server-assembled membership id.
//   - reads gate `billing.claim.read` + the §4.7 ABAC: list/assemble carry `provider_entity_billing_scope`
//     (PE in the actor's billing scope); claim-context reads carry `claim_in_billing_manager_caseload` (the
//     claim's patient in caseload AND its PE in scope) — the spec's `caseload_or_scope (via patient FK)`.
//   - every MUTATING route composes `rejectAiActor` FIRST (D13 AI-block) + `Idempotency-Key` presence
//     (§4.1.1); the versioned-root edits (PATCH / submit / replace / void) additionally carry `If-Match`
//     (§2.5; the write service surfaces a stale precondition as 412 VERSION_CONFLICT).
//   - submit / replace / void are filing actions → `provider_entity_billing_scope` + the §D14 `requireStepUp`
//     assertion; the write service ALSO re-validates step-up freshness at dispatch (D2).
//   - `claim_line` is INTERNAL-WRITE-ONLY (§3.3): there is NO line-mutation route; lines are written only by
//     assemble / the draft re-assembly PATCH / replace / void, all inside the write service's own tx.
//
// EVENTS: every mutation's §4.10 `m23.*` outbox row is emitted by the read/write/assembly service IN the
// same transaction as the state change (D2 outbox-only) — this plugin never emits directly.
//
// SPEC/IMPLEMENTATION NOTE (route #4 PATCH): the P3 write service models a DRAFT edit as a full line-set
// re-assembly (`updateDraftClaim` replaces lines + totals), so the wire body is the re-assembly shape
// (billing-typebox `ClaimPatchDraftBodySchema`) rather than the spec's TOB/override metadata delta. The
// Coder's `coder_icd_only_scope` field-allowlist (§6) is enforced here over that body — a Coder-restricted
// actor may not carry the economic total fields (403 FIELD_OUT_OF_SCOPE). TOB re-choice routes through
// :replace / :void (817/818) per §4.1, not this PATCH.
import {
  ClaimAssembleRequest,
  ClaimReplaceRequest,
  ClaimVoidRequest,
  ManualValidateRequest,
} from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { actorOf, rejectAiActor, writeActorOf, type M23WriteActor } from "./actor";
import {
  ClaimIdParamsSchema,
  ClaimListQuerySchema,
  ClaimPatchDraftBodySchema,
  parse,
} from "./billing-typebox";
import { requireIdempotencyKey, requireIfMatch, parseIfMatch } from "./concurrency";
import {
  CLAIM_CASELOAD,
  P,
  PROVIDER_SCOPE,
  STEP_UP,
  targetClaimId,
  targetProviderFromBody,
  targetProviderFromQuery,
} from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { ClaimLineView } from "./read-service";
import type { AssembledClaimLineInput, M23WriteRouteService } from "./write-service";
import type { ClaimAssemblyService } from "../services/claim-assembly";

export interface ClaimsRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
  readonly assemblyService: ClaimAssemblyService;
}

// ── §6 coder_icd_only_scope: the field-allowlist for a Coder-restricted actor ────────────────────────────
/** Roles that grant the BROAD `billing.claim.update_draft` (full DRAFT edit, including economic fields). */
const BROAD_DRAFT_EDIT_ROLES: ReadonlySet<string> = new Set(["billing_manager", "biller"]);

/** 403 FIELD_OUT_OF_SCOPE — a Coder-restricted actor carried a non-ICD field on the DRAFT PATCH (§6). */
function fieldOutOfScope(field: string): WardenXError {
  return new WardenXError(
    "FIELD_OUT_OF_SCOPE",
    `the coder role may only edit the claim's ICD-10 list + sequencing; '${field}' is out of scope`,
    403,
  );
}

/**
 * Enforce the Coder's ICD-only DRAFT-edit scope (§6 / §4.7 `coder_icd_only_scope`). When the actor holds the
 * `coder` role and NO broad draft-edit role, the PATCH body may carry only the line set (where the coder
 * adjusts ICD pointer positions) — never the economic `totalChargeCents` / `totalExpectedPaymentCents`
 * fields. A broader role (Billing Manager / Biller) is unrestricted. The deeper "no non-ICD line field
 * changed" invariant is enforced by the write service's draft re-assembly path.
 */
function enforceCoderIcdScope(
  actor: M23WriteActor,
  body: { readonly totalChargeCents?: number; readonly totalExpectedPaymentCents?: number },
): void {
  const isCoder = actor.roles.includes("coder");
  const hasBroad = actor.roles.some((r) => BROAD_DRAFT_EDIT_ROLES.has(r));
  if (!isCoder || hasBroad) return;
  if (body.totalChargeCents !== undefined) throw fieldOutOfScope("totalChargeCents");
  if (body.totalExpectedPaymentCents !== undefined) throw fieldOutOfScope("totalExpectedPaymentCents");
}

/** Map a read-side `ClaimLineView` back to the write-side `AssembledClaimLineInput` (replace copies lines). */
function toAssembledLine(view: ClaimLineView): AssembledClaimLineInput {
  return {
    lineNumber: view.lineNumber,
    revenueCode: view.revenueCode,
    qCode: view.qCode,
    levelOfCare: view.levelOfCare,
    ...(view.hcpcsCode !== null ? { hcpcsCode: view.hcpcsCode } : {}),
    serviceDateFrom: view.serviceDateFrom,
    serviceDateTo: view.serviceDateTo,
    unitCount: view.unitCount,
    unitRateCents: view.unitRateCents,
    lineChargeCents: view.lineChargeCents,
    levelOfCarePeriodId: view.levelOfCarePeriodId,
    modifiers: view.modifiers,
    icdPointerPositions: view.icdPointerPositions,
    backingEncounterIds: view.backingEncounterIds,
  };
}

// ── §4.7 / §4.6 guard instances (shared across the route registrations) ──────────────────────────────────
const READ = P("billing.claim.read");
const READ_PROVIDER = PROVIDER_SCOPE("billing.claim.read", targetProviderFromQuery);
const READ_CLAIM = CLAIM_CASELOAD("billing.claim.read");

const ASSEMBLE = P("billing.claim.assemble");
const ASSEMBLE_ABAC = PROVIDER_SCOPE("billing.claim.assemble", targetProviderFromBody);
const UPDATE = P("billing.claim.update_draft");
const UPDATE_ABAC = CLAIM_CASELOAD("billing.claim.update_draft");
const DELETE = P("billing.claim.delete_draft");
const DELETE_ABAC = CLAIM_CASELOAD("billing.claim.delete_draft");
const VALIDATE = P("billing.validation.run");
const VALIDATE_ABAC = CLAIM_CASELOAD("billing.validation.run");
const SUBMIT = P("billing.claim.submit");
const SUBMIT_ABAC = PROVIDER_SCOPE("billing.claim.submit", targetClaimId);
const SUBMIT_STEPUP = STEP_UP("billing.claim.submit");
const REPLACE = P("billing.claim.replace");
const REPLACE_ABAC = PROVIDER_SCOPE("billing.claim.replace", targetClaimId);
const REPLACE_STEPUP = STEP_UP("billing.claim.replace");
const VOID = P("billing.claim.void");
const VOID_ABAC = PROVIDER_SCOPE("billing.claim.void", targetClaimId);
const VOID_STEPUP = STEP_UP("billing.claim.void");

const AI_REJECT = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const IF_MATCH = requireIfMatch();

/** A small cursor-page query (state-history pagination); claims list has its own typed query. */
const PageQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

/** Register the §4.1 claims-core routes (#1–#13) over the read / write / assembly services. */
export function registerClaimsRoutes(app: FastifyInstance, deps: ClaimsRouteDeps): void {
  const { readService, writeService, assemblyService } = deps;

  // #1 POST /claims/assemble — server-authoritative DRAFT assembly (PE scope + idempotency + AI-block). §4.1.
  app.post(
    "/api/v1/billing/claims/assemble",
    { preHandler: [AI_REJECT, ASSEMBLE, ASSEMBLE_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(ClaimAssembleRequest, request.body);
      const res = await assemblyService.assemble(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          membershipId: actor.membershipId,
          actorKind: actor.actorKind,
        },
        body,
      );
      return reply.code(201).send(res);
    },
  );

  // #2 GET /claims — cursor-paginated list (filter by state / patient / PE). §4.1.
  app.get("/api/v1/billing/claims", { preHandler: [READ, READ_PROVIDER] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(ClaimListQuerySchema, request.query);
    return readService.listClaims(
      actor,
      { providerEntityId: q.providerEntityId, patientId: q.patientId, state: q.state },
      q.cursor,
      q.limit,
    );
  });

  // #3 GET /claims/:id — single-claim detail (lines + HIPPS + SIA + latest run + submissions + acks). §4.1.
  app.get("/api/v1/billing/claims/:id", { preHandler: [READ, READ_CLAIM] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(ClaimIdParamsSchema, request.params);
    return readService.getClaim(actor, id);
  });

  // #4 PATCH /claims/:id — DRAFT re-assembly edit (§2.5 If-Match; coder ICD-only scope). §4.1.
  app.patch(
    "/api/v1/billing/claims/:id",
    { preHandler: [AI_REJECT, UPDATE, UPDATE_ABAC, IDEMPOTENT, IF_MATCH] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const body = parse(ClaimPatchDraftBodySchema, request.body);
      enforceCoderIcdScope(actor, body);
      const expectedVersion = parseIfMatch(request);
      const res = await writeService.updateDraftClaim(actor, id, {
        expectedVersion,
        lines: body.lines,
        ...(body.totalChargeCents !== undefined ? { totalChargeCents: body.totalChargeCents } : {}),
        ...(body.totalExpectedPaymentCents !== undefined
          ? { totalExpectedPaymentCents: body.totalExpectedPaymentCents }
          : {}),
      });
      return reply.code(200).send(res);
    },
  );

  // #5 DELETE /claims/:id — DRAFT-only delete (AI-block + idempotency). §4.1.
  app.delete(
    "/api/v1/billing/claims/:id",
    { preHandler: [AI_REJECT, DELETE, DELETE_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      await writeService.deleteDraftClaim(actor, id);
      return reply.code(204).send();
    },
  );

  // #6 POST /claims/:id/validate — trigger a `validation_run` (the manual re-run / initial trigger). §4.1.
  app.post(
    "/api/v1/billing/claims/:id/validate",
    { preHandler: [AI_REJECT, VALIDATE, VALIDATE_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      parse(ManualValidateRequest, request.body ?? {});
      const res = await writeService.validateClaim(actor, id);
      return reply.code(202).send(res);
    },
  );

  // #7 POST /claims/:id/submit — READY → SUBMITTED; emits m23.claim.submit_requested (PE scope + step-up). §4.1.
  app.post(
    "/api/v1/billing/claims/:id/submit",
    { preHandler: [AI_REJECT, SUBMIT, SUBMIT_ABAC, SUBMIT_STEPUP, IDEMPOTENT, IF_MATCH] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      // §2.5 precondition presence; the write service re-asserts the row version + step-up freshness (D2).
      // The §4.2 `ClaimSubmitRequest` body fields (ifVersion/acknowledgeAllOverrides) are belt-and-suspenders
      // only — the authoritative version is the If-Match header and the blocking guard is server-side.
      parseIfMatch(request);
      const res = await writeService.submitClaim(actor, id);
      return reply.code(202).send(res);
    },
  );

  // #8 POST /claims/:id/replace — build a TOB-817 replacement DRAFT (copies the original's lines). §4.1.
  app.post(
    "/api/v1/billing/claims/:id/replace",
    { preHandler: [AI_REJECT, REPLACE, REPLACE_ABAC, REPLACE_STEPUP, IDEMPOTENT, IF_MATCH] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const body = parse(ClaimReplaceRequest, request.body);
      parseIfMatch(request);
      const originalLines = await readService.listClaimLines(actor, id);
      const res = await writeService.replaceClaim(actor, id, {
        reason: body.reason,
        lines: originalLines.map(toAssembledLine),
      });
      return reply.code(201).send(res);
    },
  );

  // #9 POST /claims/:id/void — build a TOB-818 void DRAFT (no service lines). §4.1.
  app.post(
    "/api/v1/billing/claims/:id/void",
    { preHandler: [AI_REJECT, VOID, VOID_ABAC, VOID_STEPUP, IDEMPOTENT, IF_MATCH] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const body = parse(ClaimVoidRequest, request.body);
      parseIfMatch(request);
      const res = await writeService.voidClaim(actor, id, { reason: body.reason });
      return reply.code(201).send(res);
    },
  );

  // #10 GET /claims/:id/lines — the claim_line projection. §4.1.
  app.get("/api/v1/billing/claims/:id/lines", { preHandler: [READ, READ_CLAIM] }, async (request) => {
    const actor = actorOf(request);
    const { id } = parse(ClaimIdParamsSchema, request.params);
    return readService.listClaimLines(actor, id);
  });

  // #11 GET /claims/:id/state-history — the per-claim transition timeline (cursor-paginated). §4.1.
  app.get(
    "/api/v1/billing/claims/:id/state-history",
    { preHandler: [READ, READ_CLAIM] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const q = parse(PageQuerySchema, request.query);
      return readService.listClaimStateHistory(actor, id, q.cursor, q.limit);
    },
  );

  // #12 GET /claims/:id/submissions — all dispatch attempts. §4.1.
  app.get(
    "/api/v1/billing/claims/:id/submissions",
    { preHandler: [READ, READ_CLAIM] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return readService.listClaimSubmissions(actor, id);
    },
  );

  // #13 GET /claims/:id/acknowledgments — all 999 / 277CA / 835 acknowledgments. §4.1.
  app.get(
    "/api/v1/billing/claims/:id/acknowledgments",
    { preHandler: [READ, READ_CLAIM] },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return readService.listClaimAcknowledgments(actor, id);
    },
  );
}
