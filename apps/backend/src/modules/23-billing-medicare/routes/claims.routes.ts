import {
  ClaimAssembleRequest,
  type ClaimDocument837iDetail,
  type ClaimGap,
  ClaimReplaceRequest,
  ClaimSubmitRequest,
  ClaimVoidRequest,
  ManualValidateRequest,
} from "@chartwarden/billing";
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
//     (§2.5; the write service surfaces a stale precondition as 409 STALE_VERSION).
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
  StaleVersionError,
  actorOf,
  ifMatchVersionOf,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
  requireIfMatch,
} from "@chartwarden/shared/route-kit";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ORG_WIDE_BILLING_SCOPE_ROLES } from "../abac-predicates";
import type { ClaimAssemblyService } from "../services/claim-assembly";
import {
  issueClaimPreviewToken,
  notApplicableClaimRouteFingerprint,
  verifyClaimPreviewToken,
} from "../services/claim-preview-integrity";
import { type M23WriteActor, writeActorOf } from "./actor";
import {
  ClaimIdParamsSchema,
  ClaimListQuerySchema,
  ClaimPatchDraftBodySchema,
  InDoubtSubmissionListQuerySchema,
  InDoubtSubmissionListResponseSchema,
} from "./billing-typebox";
import {
  CLAIM_CASELOAD,
  P,
  PROVIDER_SCOPE,
  STEP_UP,
  targetClaimId,
  targetProviderFromBody,
} from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { ClaimLineView } from "./read-service";
import type { AssembledClaimLineInput, M23WriteRouteService } from "./write-service";

export interface ClaimsRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
  readonly assemblyService: ClaimAssemblyService;
  readonly payerRouteStatus: (
    organizationId: string,
    providerEntityId: string,
    effectiveDate?: string,
    claimId?: string,
  ) => Promise<
    | { readonly status: "verified"; readonly routeFingerprint: string }
    | { readonly status: "not_configured"; readonly reasonCode?: string }
    | { readonly status: "not_applicable" }
  >;
  /** Same authoritative 837I renderer, used only to validate and project a protected preview. */
  readonly renderPreview?: (input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly claimId: string;
    readonly providerEntityId: string;
    readonly effectiveDate?: string;
    readonly routeFingerprint?: string;
  }) => Promise<
    | {
        readonly status: "rendered";
        readonly document: ClaimDocument837iDetail;
        readonly sourceFingerprint: string | null;
        readonly accountReference: string;
        readonly usage: "test" | "production";
      }
    | { readonly status: "blocked"; readonly gaps: readonly ClaimGap[] }
  >;
  readonly previewIntegrityKey?: string;
  readonly now?: () => number;
}

function routeFingerprintFor(
  route: Awaited<ReturnType<ClaimsRouteDeps["payerRouteStatus"]>>,
  organizationId: string,
  providerEntityId: string,
): string | null {
  if (route.status === "verified") return route.routeFingerprint;
  if (route.status === "not_applicable")
    return notApplicableClaimRouteFingerprint(organizationId, providerEntityId);
  return null;
}

// ── §6 coder_icd_only_scope: the field-allowlist for a Coder-restricted actor ────────────────────────────
/** Roles that grant the BROAD `billing.claim.update_draft` (full DRAFT edit, including economic fields). */
const BROAD_DRAFT_EDIT_ROLES: ReadonlySet<string> = new Set(["billing_manager", "biller"]);

/** 403 FIELD_OUT_OF_SCOPE — a Coder-restricted actor carried a non-ICD field on the DRAFT PATCH (§6). */
function fieldOutOfScope(field: string): ChartWardenError {
  return new ChartWardenError(
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
  if (body.totalExpectedPaymentCents !== undefined)
    throw fieldOutOfScope("totalExpectedPaymentCents");
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
const READ_CLAIM = CLAIM_CASELOAD("billing.claim.read");

/**
 * The §4.7 provider scope for the claim LIST, resolved SERVER-side from the assembled request context.
 *
 * The list used to carry `PROVIDER_SCOPE("billing.claim.read", targetProviderFromQuery)`. That is a
 * PER-ROW predicate: `provider_entity_billing_scope` resolves the ProviderEntity of ONE resource and
 * asks whether the actor is scoped to it. On the unfiltered list there is no such resource —
 * `targetProviderFromQuery` yielded `providerEntityId: ""`, `resolveBillingScopeFacts` returned null,
 * and the predicate denied at its `if (!facts) return false` BEFORE `inProviderScope`'s org-wide-role
 * bypass could run. With `notFoundOnDeny: true` that denial surfaced as a 404, so the Claim Workbench
 * was dead for EVERY caller — including an org admin — and the screen blamed an unbound seam.
 *
 * A per-row predicate cannot gate a collection: collections FILTER, point-reads gate (the same rule the
 * M30 `incidentVisibility` fix established). `GET /claims/:id` keeps its per-row `CLAIM_CASELOAD` gate;
 * the list now narrows rows to what the actor may see.
 *
 * Returns `undefined` for an unrestricted actor and an ARRAY to narrow to exactly those providers. The
 * role set is imported from the predicate module so this filter and the point-read gate cannot drift.
 *
 * `context.providerEntityIds` is now assembled (TASK-013/ARCH-008 — `bootstrap/plugins/authenticate.ts`
 * stamps it from the actor's `ActorEnrichment`), so an empty array here is a real fact: this actor's
 * membership carries no `defaultProviderEntityId`, which correctly narrows the list to zero claims
 * rather than leaving it unrestricted.
 */
export function resolveClaimProviderScope(request: FastifyRequest): readonly string[] | undefined {
  const ctx = request.context;
  const roles = ctx?.roles ?? [];
  if (ORG_WIDE_BILLING_SCOPE_ROLES.some((r) => roles.includes(r))) return undefined;
  if (ctx?.attributes?.actorKind === "system") return undefined; // M25/M26 service-to-service
  return ctx?.providerEntityIds ?? [];
}

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

const ClaimSubmissionHistoryItemSchema = Type.Object(
  {
    submissionId: Type.String({ format: "uuid" }),
    providerEntityId: Type.String({ format: "uuid" }),
    kind: Type.Union([
      Type.Literal("claim_837i"),
      Type.Literal("noe"),
      Type.Literal("notr"),
      Type.Literal("transfer_notice"),
    ]),
    claimId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    noeId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    notrId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    transferNoticeId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    claimControlNumber: Type.String(),
    attemptIndex: Type.Integer({ minimum: 0 }),
    outcome: Type.Union([
      Type.Literal("queued"),
      Type.Literal("generated"),
      Type.Literal("submitted"),
      Type.Literal("failed_worker"),
      Type.Literal("failed_portal"),
      Type.Literal("held_stale_source"),
    ]),
    dispatchState: Type.Union([
      Type.Literal("pending"),
      Type.Literal("sending"),
      Type.Literal("in_doubt"),
      Type.Literal("finished"),
    ]),
    dispatchReasonCode: Type.Union([Type.String({ pattern: "^[A-Z0-9_]{1,64}$" }), Type.Null()]),
    outcomeReason: Type.Union([Type.String(), Type.Null()]),
    generatedFileUri: Type.Union([Type.String(), Type.Null()]),
    submittedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

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
  const { readService, writeService, assemblyService, payerRouteStatus } = deps;

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
  app.get(
    "/api/v1/billing/claims",
    { preHandler: [READ], config: { auditRead: { resourceKind: "claim", list: true } } },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(ClaimListQuerySchema, request.query);
      // `providerEntityScope` is the AUTHORIZATION narrowing (server-derived); `providerEntityId` is the
      // caller's optional display filter. Both are ANDed, so naming a provider outside your scope
      // returns an empty page rather than someone else's claims.
      return readService.listClaims(
        actor,
        {
          providerEntityId: q.providerEntityId,
          patientId: q.patientId,
          state: q.state,
          ...(q.attention ? { attention: q.attention } : {}),
          providerEntityScope: resolveClaimProviderScope(request),
        },
        q.cursor,
        q.limit,
      );
    },
  );

  // Submission-first operational read: uncertainty is selected from durable attempts, then joined to
  // claims in the same tenant and narrowed by the same server-derived provider scope as the claim queue.
  app.get(
    "/api/v1/billing/claims/in-doubt-submissions",
    {
      preHandler: [READ],
      schema: {
        querystring: InDoubtSubmissionListQuerySchema,
        response: { 200: InDoubtSubmissionListResponseSchema },
      },
      config: { auditRead: { resourceKind: "claim_submission", list: true } },
    },
    async (request) => {
      const query = parse(InDoubtSubmissionListQuerySchema, request.query);
      const scope = resolveClaimProviderScope(request);
      if (query.providerEntityId && scope && !scope.includes(query.providerEntityId)) {
        throw new NotFoundError("in-doubt submission provider not found");
      }
      return deps.readService.listInDoubtSubmissions(
        actorOf(request),
        {
          providerEntityId: query.providerEntityId,
          providerEntityScope: scope,
        },
        query.cursor,
        query.limit,
      );
    },
  );

  // GET /billing/claim-validation-summary — org-wide claim counts by newest-validation outcome. Aggregate only
  // (counts + one timestamp, no claim or patient identity), so like the other M23 rollups it opts out of
  // read-audit. It applies the SAME server-derived provider scope as the list, so it never counts claims the
  // actor cannot list; a failing query surfaces as an error, never as zeros.
  app.get(
    "/api/v1/billing/claim-validation-summary",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          none: "claim counts by validation outcome — aggregate, no claim or patient identity",
        },
      },
    },
    async (request) =>
      readService.getClaimValidationOverview(actorOf(request), {
        providerEntityScope: resolveClaimProviderScope(request),
      }),
  );

  // #3 GET /claims/:id — single-claim detail (lines + HIPPS + SIA + latest run + submissions + acks). §4.1.
  app.get(
    "/api/v1/billing/claims/:id",
    {
      preHandler: [READ, READ_CLAIM],
      config: { auditRead: { resourceKind: "claim", resourceIdParam: "id" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return readService.getClaim(actor, id);
    },
  );

  // Read-only preparation projection. Claim facts and lines come from the existing authoritative read model;
  // payer routing is checked against the same server-side resolver used by the submission worker. No payer ID,
  // credentials, MBI, TIN or raw X12 is returned by this endpoint.
  app.get(
    "/api/v1/billing/claims/:id/preparation",
    {
      preHandler: [READ, READ_CLAIM],
      config: { auditRead: { resourceKind: "claim", resourceIdParam: "id" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const claim = await readService.getClaim(actor, id);
      const route = await payerRouteStatus(actor.organizationId, claim.providerEntityId, claim.serviceFrom, claim.claimId);
      const now = (deps.now ?? Date.now)();
      const boundRouteFingerprint = routeFingerprintFor(
        route,
        actor.organizationId,
        claim.providerEntityId,
      );
      const rendered =
        route.status === "not_configured"
          ? {
              status: "blocked" as const,
              gaps: [{ field: "payerRoute", reason: route.reasonCode ?? "not_verified" }],
            }
          : deps.renderPreview
            ? await deps.renderPreview({
                organizationId: actor.organizationId,
                actorUserId: actor.userId,
                claimId: id,
                providerEntityId: claim.providerEntityId,
                effectiveDate: claim.serviceFrom,
                ...(boundRouteFingerprint ? { routeFingerprint: boundRouteFingerprint } : {}),
              })
            : { status: "blocked" as const, gaps: [] as readonly ClaimGap[] };
      const submissionEligible =
        claim.state === "ready" &&
        route.status !== "not_configured" &&
        rendered.status === "rendered" &&
        (claim.latestValidation?.outcome === "all_pass" ||
          claim.latestValidation?.outcome === "ready_for_submission");
      const confirmationExpiresAt = now + 10 * 60 * 1000;
      const previewConfirmation =
        deps.previewIntegrityKey &&
        deps.previewIntegrityKey.length >= 32 &&
        rendered.status === "rendered" &&
        rendered.sourceFingerprint &&
        boundRouteFingerprint &&
        submissionEligible
          ? issueClaimPreviewToken(
              {
                organizationId: actor.organizationId,
                claimId: id,
                providerEntityId: claim.providerEntityId,
                actorUserId: actor.userId,
                claimVersion: claim.version,
                sourceFingerprint: rendered.sourceFingerprint,
                routeFingerprint: boundRouteFingerprint,
                accountReference: rendered.accountReference,
                usage: rendered.usage,
                issuedAt: now,
                expiresAt: confirmationExpiresAt,
              },
              deps.previewIntegrityKey,
            )
          : null;
      return {
        route: {
          status: route.status,
          ...(route.status === "not_configured" && route.reasonCode
            ? { reasonCode: route.reasonCode }
            : {}),
        },
        previewVersion: claim.version,
        previewGeneratedAt: new Date().toISOString(),
        previewExpiresAt: previewConfirmation
          ? new Date(confirmationExpiresAt).toISOString()
          : null,
        previewConfirmationToken: previewConfirmation,
        rendererStatus: rendered.status,
        ...(rendered.status === "rendered"
          ? {
              billingPreview: {
                tob: rendered.document.tob,
                serviceFrom: rendered.document.serviceFrom,
                serviceTo: rendered.document.serviceTo,
                admissionDate: rendered.document.admissionDate,
                lines: rendered.document.lines.map((line) => ({
                  lineNumber: line.lineNumber,
                  revenueCode: line.revenueCode,
                  hcpcs: line.hcpcs,
                  modifiers: line.modifiers,
                  units: line.units,
                  chargeCents: line.chargeCents,
                  serviceDateFrom: line.serviceDateFrom,
                  serviceDateTo: line.serviceDateTo,
                })),
                diagnosisCodes: rendered.document.diagnoses.map((diagnosis) => diagnosis.icd10Code),
                totalChargeCents: rendered.document.totalChargeCents,
                nonCoveredChargeCents: rendered.document.nonCoveredChargeCents,
              },
            }
          : { rendererGaps: rendered.gaps.map(({ field, reason }) => ({ field, reason })) }),
        payloadDigest: null,
        payloadDigestStatus: "not_available_from_read_projection" as const,
        submissionEligible: submissionEligible && previewConfirmation !== null,
      };
    },
  );

  // #4 PATCH /claims/:id — DRAFT re-assembly edit (§2.5 If-Match; coder ICD-only scope). §4.1.
  app.patch(
    "/api/v1/billing/claims/:id",
    { preHandler: [AI_REJECT, UPDATE, UPDATE_ABAC, IDEMPOTENT, IF_MATCH] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      const body = parse(ClaimPatchDraftBodySchema, request.body);
      enforceCoderIcdScope(actor, body);
      const expectedVersion = ifMatchVersionOf(request);
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
      const body = parse(ClaimSubmitRequest, request.body);
      // §2.5 precondition presence; the write service re-asserts the row version + step-up freshness (D2).
      // The §4.2 `ClaimSubmitRequest` body fields (ifVersion/acknowledgeAllOverrides) are belt-and-suspenders
      // only — the authoritative version is the If-Match header and the blocking guard is server-side.
      const expectedVersion = ifMatchVersionOf(request);
      if (body.ifVersion !== expectedVersion) {
        throw new StaleVersionError("the claim version does not match the reviewed preview");
      }
      if (
        !deps.previewIntegrityKey ||
        deps.previewIntegrityKey.length < 32 ||
        !deps.renderPreview
      ) {
        throw new ChartWardenError(
          "CLAIM_PREVIEW_UNAVAILABLE",
          "a current reviewed claim preview is required",
          503,
        );
      }
      const claim = await readService.getClaim(actor, id);
      const route = await payerRouteStatus(actor.organizationId, claim.providerEntityId, claim.serviceFrom, claim.claimId);
      if (route.status === "not_configured") {
        throw new ChartWardenError(
          route.reasonCode ?? "PAYER_ROUTE_NOT_VERIFIED",
          "the Medicare payer route is not verified for this provider and clearinghouse environment",
          422,
        );
      }
      const currentRouteFingerprint = routeFingerprintFor(
        route,
        actor.organizationId,
        claim.providerEntityId,
      );
      if (!currentRouteFingerprint)
        throw new ChartWardenError(
          "CLAIM_PREVIEW_STALE",
          "refresh the claim preview before submitting",
          409,
        );
      const expectedRouteFingerprint =
        route.status === "verified" ? route.routeFingerprint : undefined;
      const reviewed = verifyClaimPreviewToken(
        body.previewConfirmationToken,
        deps.previewIntegrityKey,
        {
          organizationId: actor.organizationId,
          claimId: id,
          providerEntityId: claim.providerEntityId,
          actorUserId: actor.userId,
        },
        (deps.now ?? Date.now)(),
      );
      if (
        !reviewed ||
        reviewed.claimVersion !== claim.version ||
        reviewed.claimVersion !== expectedVersion ||
        reviewed.routeFingerprint !== currentRouteFingerprint
      ) {
        throw new ChartWardenError(
          "CLAIM_PREVIEW_STALE",
          "the reviewed claim preview is expired or no longer current; refresh it",
          409,
        );
      }
      const current = await deps.renderPreview({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        claimId: id,
        providerEntityId: claim.providerEntityId,
        routeFingerprint: currentRouteFingerprint,
      });
      if (
        current.status !== "rendered" ||
        !current.sourceFingerprint ||
        current.sourceFingerprint !== reviewed.sourceFingerprint ||
        current.accountReference !== reviewed.accountReference ||
        current.usage !== reviewed.usage
      ) {
        throw new ChartWardenError(
          "CLAIM_PREVIEW_STALE",
          "claim billing information changed after review; refresh and review the preview",
          409,
        );
      }
      const eligible =
        claim.state === "ready" &&
        (claim.latestValidation?.outcome === "all_pass" ||
          claim.latestValidation?.outcome === "ready_for_submission");
      if (!eligible)
        throw new ChartWardenError(
          "GUARD_FAILED",
          "the claim is no longer eligible for submission",
          422,
        );
      const res = await writeService.submitClaim(actor, id, {
        expectedVersion,
        ...(expectedRouteFingerprint ? { expectedRouteFingerprint } : {}),
        reviewedSourceFingerprint: reviewed.sourceFingerprint,
      });
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
      ifMatchVersionOf(request);
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
      ifMatchVersionOf(request);
      const res = await writeService.voidClaim(actor, id, { reason: body.reason });
      return reply.code(201).send(res);
    },
  );

  // #10 GET /claims/:id/lines — the claim_line projection. §4.1.
  app.get(
    "/api/v1/billing/claims/:id/lines",
    {
      preHandler: [READ, READ_CLAIM],
      config: { auditRead: { resourceKind: "claim_line", resourceIdParam: "id", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return readService.listClaimLines(actor, id);
    },
  );

  // #11 GET /claims/:id/state-history — the per-claim transition timeline (cursor-paginated). §4.1.
  app.get(
    "/api/v1/billing/claims/:id/state-history",
    {
      preHandler: [READ, READ_CLAIM],
      config: { auditRead: { resourceKind: "claim", resourceIdParam: "id", list: true } },
    },
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
    {
      preHandler: [READ, READ_CLAIM],
      schema: { response: { 200: Type.Array(ClaimSubmissionHistoryItemSchema) } },
      config: {
        auditRead: { resourceKind: "claim_submission", resourceIdParam: "id", list: true },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return readService.listClaimSubmissions(actor, id);
    },
  );

  // #13 GET /claims/:id/acknowledgments — all 999 / 277CA / 835 acknowledgments. §4.1.
  app.get(
    "/api/v1/billing/claims/:id/acknowledgments",
    {
      preHandler: [READ, READ_CLAIM],
      config: {
        auditRead: { resourceKind: "claim_acknowledgment", resourceIdParam: "id", list: true },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(ClaimIdParamsSchema, request.params);
      return readService.listClaimAcknowledgments(actor, id);
    },
  );
}
