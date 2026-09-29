// apps/backend/src/modules/11-orders/routes/orders-routes.ts — M11-T06 the §4.1 route inventory (28 routes)
// behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) on the
// §4.6 keys M11 registers into M3's catalog (M11_CONTRIBUTED_PERMISSIONS). Org binding is server-side
// (`request.context`, never the body). Handlers compose over the injected OrderRouteService (in-memory slice;
// Drizzle in prod under `withOrgContext` so RLS backstops).
//
// §4.7 wiring: the author routes (POST /orders, /orders/:id/correct) add `requireAbac('discipline_can_order')`
// with the body's `kind` as the target; the sign routes (/orders/:id/sign, /sign-on-behalf) add
// `requireAbac('signer_eligible')` (target = `:id`); the cosign route adds `requireAbac('m11.cosigner_role_match')`
// (target = `:id`). The §4.1 caseload column maps to the shared `caseload_or_scope` predicate (registered by
// M5/M6/M7) — bound by the §4.6 default ABAC on each clinical key, enforced by M3's authorization middleware.
import {
  type AbacTarget,
  requireAbac,
  requirePermission,
  resolveActorPermissions,
} from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CompleteOrderRequest,
  CorrectOrderRequest,
  CosignRequest,
  CreateOrderRequest,
  CreateVerbalOrderRequest,
  CreateStandingOrderRequest,
  DiscontinueRequest,
  DiscontinueStandingOrderRequest,
  OrderListQuerySchema,
  OrderParamsSchema,
  PatientParamsSchema,
  RecordVerbalRequest,
  RegenerateVerbalTimerRequest,
  RequestSignatureRequest,
  SignOnBehalfRequest,
  SignOrderRequest,
  SpawnStandingOrderRequest,
  StandingOrderParamsSchema,
  UpdateOrderRequest,
  UpdateStandingOrderRequest,
  VerbalPolicyRequest,
  VerbalTimerParamsSchema,
  parse,
} from "./orders-typebox";
import type { OrderDetailActor, OrderRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export interface OrderRouteDeps {
  service: OrderRouteService;
}

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
} {
  const ctx = request.context;
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" — same bug/fix as
  // M7/M8/M9/M10: this used to read `ctx.userId` (the raw Better Auth user id, a DIFFERENT id from
  // the org membership), FK-violating `order_record_drafter_membership_id_membership_id_fk`.
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string")
    throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

/** Assemble the read-projection actor from the authenticated request context and M3's existing resolver. */
async function detailActorOf(
  request: FastifyRequest,
): Promise<OrderDetailActor> {
  const { organizationId, userId: membershipId } = actorOf(request);
  const ctx = request.context;
  const granted = await resolveActorPermissions({ organizationId, userId: ctx.userId });
  // Clinical discipline derives from the session's role grants (#87): nothing produces a
  // `disciplines` context attribute, and a stray one must not widen the order-action floors.
  return { membershipId, roles: ctx.roles, disciplines: ctx.roles, permissions: granted };
}

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("orders.read");
const DRAFT = P("orders.draft");
const SIGN = P("orders.sign");
const SIGN_ON_BEHALF = P("orders.sign_on_behalf");
const VERBAL = P("orders.verbal.record");
const COSIGN = P("orders.cosign");
const DISCONTINUE = P("orders.discontinue");
const AMEND = P("orders.amend");
const COMPLETE = P("orders.complete");
const STANDING_MANAGE = P("orders.standing.manage");
const STANDING_SPAWN = P("orders.standing.spawn");
const POLICY_READ = P("orders.policy.read");
const POLICY_MANAGE = P("orders.policy.manage");
const ADMIN_REGEN = P("orders.admin.regenerate_verbal_timer");

// §4.7 — the three ABAC predicates M11 owns. The author target lifts `kind` from the body; the sign / cosign
// targets default to the `:id` route param (the resolver loads the order's kind / cosign axis).
const kindTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const body = request.body as { kind?: unknown; order?: { kind?: unknown } } | undefined;
  const kind = body?.kind ?? body?.order?.kind;
  return typeof kind === "string" ? { kind } : {};
};
const ABAC_DRAFT = requireAbac("orders.draft", "discipline_can_order", {
  getTarget: kindTarget,
}) as PreHandler;
const ABAC_AMEND = requireAbac("orders.amend", "discipline_can_order", {
  getTarget: kindTarget,
}) as PreHandler;
const ABAC_SIGN = requireAbac("orders.sign", "signer_eligible") as PreHandler; // target = :id
const ABAC_COSIGN = requireAbac(
  "orders.cosign",
  "m11.cosigner_role_match",
) as PreHandler; // target = :id

export function registerOrderRoutes(
  app: FastifyInstance,
  deps: OrderRouteDeps,
): void {
  const { service } = deps;

  // 1 — list orders by patient / admission / kind / status.
  app.get(
    "/api/v1/orders",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(OrderListQuerySchema, request.query);
      return service.listOrders(organizationId, {
        patientId: q.patientId,
        admissionId: q.admissionId,
        kind: q.kind,
        status: q.status,
      });
    },
  );

  // (these static collection routes precede `/orders/:id` so the radix tree resolves them first.)
  // 13 — physician's pending-signature inbox.
  app.get(
    "/api/v1/orders/pending-signature",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.pendingSignature(organizationId);
    },
  );
  // 14 — RN's verbal-expiring queue.
  app.get(
    "/api/v1/orders/verbal-expiring",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.verbalExpiring(organizationId);
    },
  );
  // 15 — RN's cosign-pending queue.
  app.get(
    "/api/v1/orders/cosign-pending",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.cosignPending(organizationId);
    },
  );
  // 16 — lab orders with results awaiting clinician review (D17).
  app.get(
    "/api/v1/orders/results-pending-review",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "lab_order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.resultsPendingReview(organizationId);
    },
  );
  // 17 — derived suggestion banner state (D7).
  app.get(
    "/api/v1/orders/suggestions/:patientId",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "order_suggestion",
          patientIdParam: "patientId",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientParamsSchema, request.params);
      return service.suggestions(organizationId, patientId);
    },
  );

  // 3 — create a draft order (RN/LPN/MD etc. per `discipline_can_order`).
  app.post("/api/v1/orders", { preHandler: [DRAFT, ABAC_DRAFT] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(CreateOrderRequest, request.body);
    const res = await service.createDraft(
      organizationId,
      userId,
      {
        patientId: body.patientId,
        admissionId: body.admissionId,
        kind: body.kind,
        drafterDiscipline: body.drafterDiscipline,
        data: body.data,
        priority: body.priority,
        orderingPhysicianMdmId: body.orderingPhysicianMdmId,
        sourceEncounterId: body.sourceEncounterId,
        triggeringAssessmentId: body.triggeringAssessmentId,
        triggeringHopeAssessmentId: body.triggeringHopeAssessmentId,
        replacesOrderId: body.replacesOrderId,
      },
      await detailActorOf(request),
    );
    return reply.code(201).send(res);
  });

  app.post("/api/v1/verbal-orders", { preHandler: [DRAFT, ABAC_DRAFT, VERBAL] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(CreateVerbalOrderRequest, request.body);
    const res = await service.createVerbalOrder(organizationId, userId, {
      order: body.order,
      verbal: body.verbal,
    }, await detailActorOf(request));
    return reply.code(201).send(res);
  });

  // 2 — order detail with signatures + discontinuation history.
  app.get(
    "/api/v1/orders/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "order", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      return service.getOrder(organizationId, id, await detailActorOf(request));
    },
  );

  // 4 — edit a draft (status='draft' only).
  app.patch("/api/v1/orders/:id", { preHandler: [DRAFT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(UpdateOrderRequest, request.body);
    return service.editDraft(
      organizationId,
      id,
      body.data,
      body.priority,
      await detailActorOf(request),
    );
  });

  // 5 — draft → pending_signature (resolves the §2.5 cosign requirement).
  app.post("/api/v1/orders/:id/request-signature", { preHandler: [DRAFT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(RequestSignatureRequest, request.body);
    return service.requestSignature(
      organizationId,
      id,
      {
        signerDiscipline: body.signerDiscipline,
        levelChange: body.levelChange,
      },
      await detailActorOf(request),
    );
  });

  // 6 — sign (→ active); signer_eligible ABAC floor (§4.7).
  app.post("/api/v1/orders/:id/sign", { preHandler: [SIGN, ABAC_SIGN] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(SignOrderRequest, request.body);
    return service.signOrder(
      organizationId,
      userId,
      id,
      {
        signerDiscipline: body.signerDiscipline,
        signedAtClient: body.signedAtClient,
      },
      await detailActorOf(request),
    );
  });

  // 7 — sign on behalf (medical_director only).
  app.post(
    "/api/v1/orders/:id/sign-on-behalf",
    { preHandler: [SIGN_ON_BEHALF, ABAC_SIGN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const body = parse(SignOnBehalfRequest, request.body);
      return service.signOnBehalf(
        organizationId,
        userId,
        id,
        {
          signerDiscipline: body.signerDiscipline,
          signedAtClient: body.signedAtClient,
          onBehalfOf: body.onBehalfOf,
          reason: body.reason,
        },
        await detailActorOf(request),
      );
    },
  );

  // 8 — record as verbal (→ verbal_pending; starts the 48h timer).
  app.post("/api/v1/orders/:id/verbal", { preHandler: [VERBAL] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(RecordVerbalRequest, request.body);
    return service.recordVerbal(
      organizationId,
      userId,
      id,
      {
        recorderDiscipline: body.recorderDiscipline,
        verbalAttestation: body.verbalAttestation,
        readBackVerified: body.readBackVerified,
        effectiveAt: body.effectiveAt,
        receivedAt: body.receivedAt,
        orderingPhysicianMdmId: body.orderingPhysicianMdmId,
      },
      await detailActorOf(request),
    );
  });

  // 9 — attach a cosignature (m11.cosigner_role_match ABAC).
  app.post("/api/v1/orders/:id/cosign", { preHandler: [COSIGN, ABAC_COSIGN] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(CosignRequest, request.body);
    return service.cosignOrder(
      organizationId,
      userId,
      id,
      {
        cosignerRole: body.cosignerRole,
        attestationText: body.attestationText,
      },
      await detailActorOf(request),
    );
  });

  // 10 — discontinue active / pending / verbal order.
  app.post("/api/v1/orders/:id/discontinue", { preHandler: [DISCONTINUE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(DiscontinueRequest, request.body);
    return service.discontinueOrder(
      organizationId,
      userId,
      id,
      {
        reason: body.reason,
        effectiveAt: body.effectiveAt,
        notes: body.notes,
      },
      await detailActorOf(request),
    );
  });

  // 11 — issue a corrected order (replaces_order_id); discipline_can_order ABAC on the new kind.
  app.post(
    "/api/v1/orders/:id/correct",
    { preHandler: [AMEND, ABAC_AMEND] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(OrderParamsSchema, request.params);
      const body = parse(CorrectOrderRequest, request.body);
      const res = await service.correctOrder(
        organizationId,
        userId,
        id,
        {
          patientId: body.patientId,
          admissionId: body.admissionId,
          kind: body.kind,
          drafterDiscipline: body.drafterDiscipline,
          data: body.data,
          priority: body.priority,
          orderingPhysicianMdmId: body.orderingPhysicianMdmId,
          sourceEncounterId: body.sourceEncounterId,
          triggeringAssessmentId: body.triggeringAssessmentId,
          triggeringHopeAssessmentId: body.triggeringHopeAssessmentId,
        },
        await detailActorOf(request),
      );
      return reply.code(201).send(res);
    },
  );

  // 12 — manual completion (incl. lab "Mark reviewed").
  app.post("/api/v1/orders/:id/complete", { preHandler: [COMPLETE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    const body = parse(CompleteOrderRequest, request.body);
    return service.completeOrder(
      organizationId,
      userId,
      id,
      body.reason,
      await detailActorOf(request),
    );
  });

  // F-179 (#248) — re-run the outbound lab-ORM producer for a signed lab order whose HL7 request was REFUSED at
  // sign time (`orm_refused:*`) after someone fixed the missing fact. `orders.amend` (RN Case Manager, MD/NP/PA,
  // Medical Director, Clinical Supervisor — the roles that can correct an order, hence fix its facts); no step-up
  // (the order was already signed for exactly this transmission — a resend discloses nothing new). There is no
  // body: the target is the order, the action is fixed. The audit actor is the Better Auth USER id (the M4
  // audit trigger's `actor_user_id` FKs `user`, unlike the membership id the rest of M11 passes).
  app.post("/api/v1/orders/:id/resend-transmission", { preHandler: [AMEND] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(OrderParamsSchema, request.params);
    return service.resendLabTransmission(
      organizationId,
      userId,
      id,
      await detailActorOf(request),
      request.context?.userId ?? "",
    );
  });

  // 18 — list standing orders.
  app.get(
    "/api/v1/standing-orders",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "standing_order", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listStandingOrders(organizationId);
    },
  );
  // 19 — standing-order template + spawn history.
  app.get(
    "/api/v1/standing-orders/:id",
    {
      preHandler: [READ],
      config: {
        auditRead: { resourceKind: "standing_order", resourceIdParam: "id" },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(StandingOrderParamsSchema, request.params);
      return service.getStandingOrder(organizationId, id);
    },
  );
  // 20 — create template.
  app.post(
    "/api/v1/standing-orders",
    { preHandler: [STANDING_MANAGE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(CreateStandingOrderRequest, request.body);
      const res = await service.createStandingOrder(organizationId, userId, {
        patientId: body.patientId,
        admissionId: body.admissionId,
        kind: body.kind,
        signerDiscipline: body.signerDiscipline,
        orderingPhysicianMdmId: body.orderingPhysicianMdmId,
        cadence: body.cadence,
        data: body.data,
        effectiveFrom: body.effectiveFrom,
        effectiveUntil: body.effectiveUntil,
        maxSpawns: body.maxSpawns,
      });
      return reply.code(201).send(res);
    },
  );
  // 21 — edit (limited fields when active).
  app.patch(
    "/api/v1/standing-orders/:id",
    { preHandler: [STANDING_MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(StandingOrderParamsSchema, request.params);
      const body = parse(UpdateStandingOrderRequest, request.body);
      return service.editStandingOrder(organizationId, id, {
        data: body.data,
        effectiveUntil: body.effectiveUntil,
        maxSpawns: body.maxSpawns,
      });
    },
  );
  // 22 — pause (no new spawns).
  app.post(
    "/api/v1/standing-orders/:id/pause",
    { preHandler: [STANDING_MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(StandingOrderParamsSchema, request.params);
      return service.pauseStandingOrder(organizationId, id);
    },
  );
  // 23 — resume.
  app.post(
    "/api/v1/standing-orders/:id/resume",
    { preHandler: [STANDING_MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(StandingOrderParamsSchema, request.params);
      return service.resumeStandingOrder(organizationId, id);
    },
  );
  // 24 — discontinue template.
  app.post(
    "/api/v1/standing-orders/:id/discontinue",
    { preHandler: [STANDING_MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(StandingOrderParamsSchema, request.params);
      const body = parse(DiscontinueStandingOrderRequest, request.body);
      return service.discontinueStandingOrder(
        organizationId,
        id,
        body.alsoDiscontinueInstances ?? false,
      );
    },
  );
  // 25 — PRN manual spawn.
  app.post(
    "/api/v1/standing-orders/:id/spawn",
    { preHandler: [STANDING_SPAWN] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(StandingOrderParamsSchema, request.params);
      parse(SpawnStandingOrderRequest, request.body);
      const res = await service.spawnStandingOrder(organizationId, userId, id);
      return reply.code(201).send(res);
    },
  );

  // 26 — org-admin verbal-policy read.
  app.get(
    "/api/v1/admin/orders/verbal-policy",
    {
      preHandler: [POLICY_READ],
      config: {
        auditRead: {
          none: "org-level verbal-order policy configuration; no patient-identifying data",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getVerbalPolicy(organizationId);
    },
  );
  // 27 — org-admin verbal-policy update (service enforces tighten-only).
  app.put(
    "/api/v1/admin/orders/verbal-policy",
    { preHandler: [POLICY_MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const body = parse(VerbalPolicyRequest, request.body);
      return service.putVerbalPolicy(organizationId, {
        windowHours: body.windowHours,
        businessHoursOnly: body.businessHoursOnly,
        lpnCosignRequiredKinds: body.lpnCosignRequiredKinds,
        npCosignRequiredKinds: body.npCosignRequiredKinds,
      });
    },
  );
  // 28 — platform-ops verbal-timer regeneration (audited as elevated access).
  app.post(
    "/api/v1/admin/orders/regenerate-verbal-timer/:id",
    { preHandler: [ADMIN_REGEN] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(VerbalTimerParamsSchema, request.params);
      parse(RegenerateVerbalTimerRequest, request.body);
      return service.regenerateVerbalTimer(
        organizationId,
        id,
        await detailActorOf(request),
      );
    },
  );
}
