// apps/backend/src/modules/30-quality/routes/sra.routes.ts — M30 (§4.1 R-40..R-48).
//
// The Security Risk Assessment surface: annual cycles, findings (NIST 800-66r2 control references with a
// likelihood × impact risk score), and remediation plans. Every route is gated by the REAL Authorization
// Contract (`requirePermission` from @wardenx/auth, M3) on the §4.6 `sra.*` keys. The cycle-scoped
// mutation R-43 (add finding) additionally layers the `ownsSraCycle` predicate M30 OWNS (§4.7 — cycle
// owner OR `sra.admin`), resolved off the route's `:cycleId` param. R-44/R-45/R-46 carry the same
// `inOrg + ownsSraCycle` ABAC intent, but their path keys a `:findingId` / `:remediationId` — the
// `ownsSraCycle` predicate resolves a `target.cycleId` the route cannot synchronously derive from a
// finding/remediation id, so the ownership check for those is enforced inside the write service (which
// loads the row → cycle under the same `withOrgContext` tx); RBAC `sra.write` is the route gate.
//
// R-47 (close a cycle) is the TWO-PERSON co-sign route (V-12): RBAC gates `sra.close`, the route ALSO
// requires a recent M2 SESSION_POLICY step-up (W-M30-30) via `requireStepUp` (the M33 schedule
// delete-runs precedent), and passes the cosigner + actor to the write service, where
// `assertSraCloseSplitActor` (DELEGATING to the @wardenx/quality canonical guard) enforces the Security
// Officer ≠ Compliance Officer split. The `sraCloseAuthority` predicate keys on a `cosignerUserId` the
// route cannot resolve from the body's membership ids, so the authoritative close-authority check is the
// service's V-12 + the §3 DB check constraint (the route layer never trusts a body-supplied identity).
//
// MUTATIONS run through the injected write service → ONE `withOrgContext` tx on the PRIMARY (RLS scopes
// every statement to `app.org_id`); each carries `requireIdempotencyKey` (presence guard; the M1
// `applyIdempotency` middleware does the 24h replay caching). READS disclose the actor's own-org SRA rows
// (no PHI). Org/actor/owner binding is ALWAYS server-side (`request.context`). Mirrors M33
// routes/schedules.routes.ts (the `requireStepUp` precedent).
//
// R-48 (GET cycle NIST 800-66r2 PDF export) is intentionally NOT wired here: it is an M22 render-handshake
// export (the M33 `mountM33ExportDrilldownRoutes` precedent — a distinct export route service, not the
// read/write contract), with no method on `M30ReadRouteService` / `M30WriteRouteService`. It lands with
// the M30 export service in P2c rather than being invented against an absent contract method.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { requestStepUpFresh } from "../../../bootstrap/index";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  AddSraFindingBodySchema,
  CloseSraCycleBodySchema,
  CycleIdParamsSchema,
  FindingIdParamsSchema,
  OpenSraCycleBodySchema,
  PlanSraRemediationBodySchema,
  RemediationIdParamsSchema,
  SraCycleListQuerySchema,
  UpdateSraFindingBodySchema,
  UpdateSraRemediationBodySchema,
  parse,
} from "./quality-typebox";
import type { M30ReadRouteService } from "./read-service";
import type { M30WriteRouteService } from "./write-service";

export interface SraRouteDeps {
  /** The combined M30 route service (read + write); the P2c Drizzle backend implements both interfaces. */
  readonly service: M30ReadRouteService & M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
// `ownsSraCycle` (§4.7) — cycle owner OR `sra.admin`; the predicate reads the target `cycleId`, which the
// default target (`request.params`) carries only on the `:cycleId` routes (R-43).
const OWNS_CYCLE = (key: string): PreHandler => requireAbac(key, "ownsSraCycle") as PreHandler;

const SRA_READ = P("sra.read");
const SRA_WRITE = P("sra.write");
const SRA_ADMIN = P("sra.admin");
const SRA_CLOSE = P("sra.close");
const SRA_CYCLE_OWN = OWNS_CYCLE("sra.write");
// W-M30-30 — closing a cycle requires a recent step-up; the `step_up_recent` predicate resolves the
// per-operation freshness policy off this operation key (the M33 `requireStepUp` precedent).
// GAP-088 — `sraCloseAuthority`: caller is Security Officer / Compliance Officer and the body's co-signer is
// a distinct person holding the OTHER role. Break-glass cannot stand in for the second human signer.
const SRA_CLOSE_AUTHORITY = requireAbac("sra.close", "sraCloseAuthority", {
  getTarget: (request) => ({
    cosignerMembershipId: (request.body as { cosignerMembershipId?: unknown } | null)
      ?.cosignerMembershipId,
  }),
  breakGlassBypassable: false,
}) as PreHandler;
const SRA_CLOSE_STEPUP = requireStepUp("sra.close") as PreHandler;
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 SRA routes (R-40..R-47; R-48 export deferred to the P2c M30 export service). */
export function registerSraRoutes(app: FastifyInstance, deps: SraRouteDeps): void {
  const { service } = deps;

  // R-40 — list SRA cycles (annual; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/sra/cycles",
    {
      preHandler: [SRA_READ],
      config: {
        auditRead: { none: "HIPAA security-risk-assessment cycles — security posture, no PHI" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(SraCycleListQuerySchema, request.query);
      return service.listSraCycles(actor, q.cursor, q.limit);
    },
  );

  // R-41 — open a new cycle (rolls scope from the template). §4.1/§4.2.
  app.post(
    "/api/v1/quality/sra/cycles",
    { preHandler: [SRA_ADMIN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(OpenSraCycleBodySchema, request.body);
      const res = await service.openSraCycle(actor, { cycleYear: body.cycleYear });
      return reply.code(201).send(res);
    },
  );

  // R-42 — cycle detail (progress + findings + remediations). §4.1.
  app.get(
    "/api/v1/quality/sra/cycles/:cycleId",
    {
      preHandler: [SRA_READ],
      config: { auditRead: { none: "one SRA cycle with its findings — security posture, no PHI" } },
    },
    async (request) => {
      const actor = actorOf(request);
      const { cycleId } = parse(CycleIdParamsSchema, request.params);
      return service.getSraCycle(actor, cycleId);
    },
  );

  // R-43 — add a finding (NIST control reference required; `ownsSraCycle` off `:cycleId`). §4.1/§4.2.
  app.post(
    "/api/v1/quality/sra/cycles/:cycleId/findings",
    { preHandler: [SRA_WRITE, SRA_CYCLE_OWN, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { cycleId } = parse(CycleIdParamsSchema, request.params);
      const body = parse(AddSraFindingBodySchema, request.body);
      const res = await service.addSraFinding(actor, cycleId, {
        findingNumber: body.findingNumber,
        controlRef: body.controlRef,
        likelihood: body.likelihood,
        impact: body.impact,
        description: body.description,
      });
      return reply.code(201).send(res);
    },
  );

  // R-44 — update a finding's risk score / disposition (`ownsSraCycle` enforced in the service via
  // the finding→cycle resolution; no `:cycleId` in the path to gate at the route). §4.1/§4.2.
  app.patch(
    "/api/v1/quality/sra/findings/:findingId",
    { preHandler: [SRA_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { findingId } = parse(FindingIdParamsSchema, request.params);
      const body = parse(UpdateSraFindingBodySchema, request.body);
      const res = await service.updateSraFinding(actor, findingId, {
        likelihood: body.likelihood,
        impact: body.impact,
        disposition: body.disposition,
      });
      return reply.code(200).send(res);
    },
  );

  // R-45 — plan a remediation under a finding (`ownsSraCycle` enforced in the service). §4.1/§4.2.
  app.post(
    "/api/v1/quality/sra/findings/:findingId/remediation",
    { preHandler: [SRA_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { findingId } = parse(FindingIdParamsSchema, request.params);
      const body = parse(PlanSraRemediationBodySchema, request.body);
      const res = await service.planSraRemediation(actor, findingId, {
        remediationNumber: body.remediationNumber,
        plan: body.plan,
        ownerMembershipId: body.ownerMembershipId,
        dueAt: body.dueAt,
      });
      return reply.code(201).send(res);
    },
  );

  // R-46 — update a remediation's status (`ownsSraCycle` enforced in the service). §4.1/§4.2.
  app.patch(
    "/api/v1/quality/sra/remediation/:remediationId",
    { preHandler: [SRA_WRITE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { remediationId } = parse(RemediationIdParamsSchema, request.params);
      const body = parse(UpdateSraRemediationBodySchema, request.body);
      const res = await service.updateSraRemediation(actor, remediationId, {
        status: body.status,
        dueAt: body.dueAt,
      });
      return reply.code(200).send(res);
    },
  );

  // R-47 (GAP-046) — the nominee's own confirmation of a pending cycle close; the confirmer is the SESSION
  // membership vs the nominee persisted on the row (no body, no identity on the wire). Fresh step-up in THIS
  // session; the cycle closes (and `m30.sra.cycle_closed` is published) only here.
  app.post(
    "/api/v1/quality/sra/cycles/:cycleId/close/confirm",
    { preHandler: [SRA_CLOSE, SRA_CLOSE_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { cycleId } = parse(CycleIdParamsSchema, request.params);
      const res = await service.confirmSraCycleClose(actor, cycleId, {
        recentStepUp: await requestStepUpFresh(request, "sra.close"),
      });
      return reply.code(200).send(res);
    },
  );

  // R-47 — INITIATE a cycle close (GAP-046: the first of two steps). The caller signs their own slot;
  // `cosignerMembershipId` is validated as an eligible Security/Compliance Officer and recorded as the NOMINEE.
  // The cycle stays open (`closePending: true`) until the nominee confirms via `.../close/confirm`. (V-12 +
  // recent step-up W-M30-30.) RBAC gates `sra.close`,
  // `requireStepUp` enforces step-up freshness, and the write service runs `assertSraCloseSplitActor`
  // (Security Officer ≠ Compliance Officer) before the SRA `close` reducer. §4.1/§4.2.
  app.post(
    "/api/v1/quality/sra/cycles/:cycleId/close",
    { preHandler: [SRA_CLOSE, SRA_CLOSE_STEPUP, SRA_CLOSE_AUTHORITY, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { cycleId } = parse(CycleIdParamsSchema, request.params);
      const body = parse(CloseSraCycleBodySchema, request.body);
      const res = await service.closeSraCycle(actor, cycleId, {
        cosignerMembershipId: body.cosignerMembershipId,
        recentStepUp: await requestStepUpFresh(request, "sra.close"),
      });
      return reply.code(200).send(res);
    },
  );
}
