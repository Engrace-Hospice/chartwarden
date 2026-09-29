// apps/backend/src/modules/11-orders/routes/held-transmissions-routes.ts — the held-order worklist (F-191, #248).
//
//   GET /api/v1/orders/held-transmissions
//
// The orders an operator must resolve WITH THE LAB: `dlq_exhausted` (incl. F-183's "held, delivery unverified"),
// `application_reject`, and `recovery_blocked:*`. A message may already be at the lab, so none of them is retried
// automatically — F-188's attested recovery (`POST /orders/:id/recover-transmission`) is the way out, and it needs a human
// to call the lab. Before this route nothing told anyone they were waiting.
//
// AUTHORIZATION: `orders.amend` — the permission the actions on this list (`resend-transmission`, `recover-transmission`)
// already require, so the people who can act on an entry are exactly the people who can see it. The org comes from the
// authenticated request context, never a parameter, and the read runs under `withOrgContext`, so RLS backstops it.
// `held-transmissions` is a static segment beside the `/api/v1/orders/:id` parameter routes; Fastify's router matches the
// static segment first, so it is never read as an order id (a route test pins that).
//
// NO PHI beyond what the order list already exposes (`patientId`); the reason is a fixed token, never free text.
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StuckTransmissionRecovery } from "../stuck-transmission-recovery";
import { HeldTransmissionsQuerySchema } from "./held-transmissions-typebox";
import { parse } from "./orders-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const AMEND = requirePermission("orders.amend") as PreHandler;

export interface HeldTransmissionRouteDeps {
  readonly recovery: Pick<StuckTransmissionRecovery, "listHeld">;
}

export function registerHeldTransmissionRoutes(app: FastifyInstance, deps: HeldTransmissionRouteDeps): void {
  app.get(
    "/api/v1/orders/held-transmissions",
    {
      preHandler: [AMEND],
      // §2.5 — the worklist returns `patientId` for every held order, so it is a PHI read and is audited as one (the
      // `results-pending-review` lab list's declaration): a route that returns patient ids without it fails boot.
      config: { auditRead: { resourceKind: "lab_order", list: true } },
    },
    async (request) => {
    const organizationId = request.context?.organizationId;
    if (!organizationId) throw new UnauthorizedError();
    const q = parse(HeldTransmissionsQuerySchema, request.query);
    return deps.recovery.listHeld(organizationId, { limit: q.limit ?? 50, cursor: q.cursor });
    },
  );
}
