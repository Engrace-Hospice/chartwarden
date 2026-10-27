// apps/backend/src/modules/41-billing-commercial/routes/ack-quarantine.routes.ts - operator actions on held acknowledgments (#820).
//
//   GET  /api/v1/billing/commercial/ack-quarantine?providerEntityId              unresolved held rows of one provider entity
//   POST /api/v1/billing/commercial/ack-quarantine/replay                        re-apply that entity's held rows now (no waiting for the pull)
//   POST /api/v1/billing/commercial/ack-quarantine/:id/resolve                   close ONE row (the only exit for a `malformed` row)
//   POST /api/v1/billing/commercial/ack-quarantine/abandon-foreign               close the org's rows held from another vendor's stream
//
// Per reason (see jobs/ack-held-replay.ts): no_receipt / scope_mismatch / vendor_mismatch are REPLAYED automatically each pull as soon as
// the blocking condition clears, and past 45 days are abandoned; `replay` just runs that pass on demand. `malformed` kept nothing, so a
// person closes it with `resolve`. Mutations follow the submit/reconcile gate: commercial_billing.submit, the provider scope, a FRESH
// step-up, no AI actor, an Idempotency-Key. The acting user is stamped on every m41.claim.ack_abandoned event. Org and actor come from
// the server-assembled request context, never the body. Responses carry ids, reasons, control numbers and counts only.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { COMMERCIAL_BILLING_PERMISSIONS, ForbiddenError, NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { billingScopeReach } from "../../23-billing-medicare/abac-predicates";
import {
  type PreHandler,
  actorOf,
  rejectAiActor,
  writeActorOf,
} from "../../23-billing-medicare/routes/actor";
import { parse } from "../../23-billing-medicare/routes/billing-typebox";
import { requireIdempotencyKey } from "../../23-billing-medicare/routes/concurrency";
import type { AckApplyDeps } from "../jobs/ack-apply";
import {
  abandonForeignHeldEvents,
  listHeldRows,
  replayHeldEvents,
  resolveHeldRowByOperator,
} from "../jobs/ack-held-replay";
import {
  AckQuarantineAbandonForeignBodySchema,
  AckQuarantineListQuerySchema,
  AckQuarantineResolveParamsSchema,
  AckQuarantineScopeBodySchema,
} from "./commercial-typebox";

const READ = requirePermission(COMMERCIAL_BILLING_PERMISSIONS.READ) as PreHandler;
const SUBMIT = requirePermission(COMMERCIAL_BILLING_PERMISSIONS.SUBMIT) as PreHandler;
const STEP_UP = requireStepUp(COMMERCIAL_BILLING_PERMISSIONS.SUBMIT) as PreHandler;
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
type Req = { readonly body?: unknown; readonly query?: unknown };
const scope = (key: string, from: "body" | "query"): PreHandler =>
  requireAbac(key, "commercial_billing_provider_scope", {
    getTarget: (r: Req) => ({
      providerEntityId:
        (r[from] as { providerEntityId?: string } | undefined)?.providerEntityId ?? "",
    }),
    notFoundOnDeny: true,
  }) as PreHandler;

export function registerCommercialAckQuarantineRoutes(
  app: FastifyInstance,
  deps: { readonly ack: AckApplyDeps },
): void {
  const { ack } = deps;
  const gate = (): PreHandler[] => [
    SUBMIT,
    scope(COMMERCIAL_BILLING_PERMISSIONS.SUBMIT, "body"),
    STEP_UP,
    NO_AI,
    IDEMPOTENT,
  ];

  app.get(
    "/api/v1/billing/commercial/ack-quarantine",
    {
      preHandler: [READ, scope(COMMERCIAL_BILLING_PERMISSIONS.READ, "query")],
      config: {
        auditRead: {
          none: "Quarantine rows: id, reason, control number, clearinghouse key, age. No patient data and no event payload",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AckQuarantineListQuerySchema, request.query);
      const items = await listHeldRows(ack, {
        organizationId,
        providerEntityId: q.providerEntityId,
      });
      return { items: items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
    },
  );

  app.post(
    "/api/v1/billing/commercial/ack-quarantine/replay",
    { preHandler: gate() },
    async (request) => {
      const { organizationId } = writeActorOf(request);
      const b = parse(AckQuarantineScopeBodySchema, request.body);
      return replayHeldEvents(ack, { organizationId, providerEntityId: b.providerEntityId });
    },
  );

  app.post(
    "/api/v1/billing/commercial/ack-quarantine/:id/resolve",
    { preHandler: gate() },
    async (request) => {
      const { organizationId, userId } = writeActorOf(request);
      const { id } = parse(AckQuarantineResolveParamsSchema, request.params);
      const b = parse(AckQuarantineScopeBodySchema, request.body);
      const outcome = await resolveHeldRowByOperator(
        ack,
        { organizationId, providerEntityId: b.providerEntityId },
        id,
        userId,
      );
      if (outcome === "not_found") throw new NotFoundError("quarantine row", id);
      return { id, outcome };
    },
  );

  // Org-wide (it crosses provider entities), so only an organization-wide billing actor may run it; there is no provider scope to name.
  app.post(
    "/api/v1/billing/commercial/ack-quarantine/abandon-foreign",
    { preHandler: [SUBMIT, STEP_UP, NO_AI, IDEMPOTENT] },
    async (request) => {
      const { organizationId, userId } = writeActorOf(request);
      parse(AckQuarantineAbandonForeignBodySchema, request.body);
      if (!request.context || !billingScopeReach(request.context).all) {
        throw new ForbiddenError(
          "closing held acknowledgments across the organization needs an organization-wide billing scope",
        );
      }
      return abandonForeignHeldEvents(ack, organizationId, userId);
    },
  );
}
