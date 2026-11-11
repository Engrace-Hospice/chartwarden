import { PLATFORM_OPS_ROLE_KEYS, requireAbac, requirePermission } from "@chartwarden/auth";
import { ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

const PERMISSION = "billing.rule_config.platform_admin";
const GUARDS = [requirePermission(PERMISSION), requireAbac(PERMISSION, "platform_billing_scope")];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = ["capture", "ownership_resolution", "m25_delivery"] as const;

export const ClaimMdRecoveryReadinessQuerySchema = Type.Object(
  {
    usage: Type.Union([Type.Literal("test"), Type.Literal("production")]),
    stage: Type.Union(STAGES.map((stage) => Type.Literal(stage))),
  },
  { additionalProperties: false },
);

export const ClaimMdRecoveryReadinessResponseSchema = Type.Object(
  {
    inboxId: Type.String({ format: "uuid" }),
    usage: Type.Union([Type.Literal("test"), Type.Literal("production")]),
    stage: Type.Union(STAGES.map((stage) => Type.Literal(stage))),
    currentState: Type.String(),
    currentVersion: Type.Integer({ minimum: 0 }),
    sourceDigestPresent: Type.Boolean(),
    tenantAttribution: Type.Union([Type.Literal("verified"), Type.Literal("unattributed")]),
    leaseActive: Type.Boolean(),
    priorRecoveryAttempts: Type.Integer({ minimum: 0 }),
    disposition: Type.Union([
      Type.Literal("eligible_for_simulation"),
      Type.Literal("already_processed"),
      Type.Literal("blocked"),
    ]),
    blockers: Type.Array(Type.String()),
    financialEffects: Type.Object({
      status: Type.Literal("not_evaluated"),
      reasonCode: Type.Literal("PREFLIGHT_DOES_NOT_AUTHORIZE_FINANCIAL_REPROCESSING"),
    }),
    simulation: Type.Object({
      available: Type.Boolean(),
      mutatesSource: Type.Literal(false),
      callsVendor: Type.Literal(false),
      authorizesExecution: Type.Literal(false),
    }),
    assessedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

type Query = { usage: "test" | "production"; stage: (typeof STAGES)[number] };

function requirePlatformOperator(request: FastifyRequest): void {
  const context = request.context;
  if (
    !context?.userId ||
    !context.roles?.some((role) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(role))
  )
    throw new ForbiddenError("authenticated platform operator required");
}

export function registerOpsClaimMdRecoveryReadinessRoutes(
  app: FastifyInstance,
  input: {
    readonly accountReference: string;
    readonly usage: "test" | "production";
    readonly preflight: (query: {
      inboxId: string;
      accountReference: string;
      usage: "test" | "production";
      stage: (typeof STAGES)[number];
    }) => Promise<unknown>;
  },
): void {
  const assess = async (request: FastifyRequest) => {
    requirePlatformOperator(request);
    const inboxId = (request.params as { inboxId?: unknown })?.inboxId;
    const query = request.query as Partial<Query>;
    if (
      typeof inboxId !== "string" ||
      !UUID.test(inboxId) ||
      !query ||
      !["test", "production"].includes(query.usage ?? "") ||
      !STAGES.includes(query.stage as (typeof STAGES)[number])
    )
      throw new ValidationError("invalid recovery readiness request", []);
    if (query.usage !== input.usage)
      throw new ValidationError("recovery environment does not match this runtime", [
        {
          field: "usage",
          code: "SCOPE_MISMATCH",
          message: "environment must match the configured Claim.MD binding",
        },
      ]);
    try {
      return await input.preflight({
        inboxId,
        accountReference: input.accountReference,
        usage: query.usage,
        stage: query.stage as (typeof STAGES)[number],
      });
    } catch (error) {
      if (error instanceof Error && error.message === "CLAIMMD_ERA_PREFLIGHT_NOT_FOUND")
        throw new NotFoundError("Claim.MD ERA recovery source");
      throw error;
    }
  };

  const options = {
    preHandler: GUARDS,
    schema: {
      querystring: ClaimMdRecoveryReadinessQuerySchema,
      response: { 200: ClaimMdRecoveryReadinessResponseSchema },
    },
    config: {
      auditRead: {
        resourceKind: "claimmd_era_inbox",
        resourceIdParam: "inboxId",
      },
    },
  };
  // Literal registrations keep the route inventory and OpenAPI provenance gates authoritative.
  app.get("/api/v1/ops/claimmd/eras/:inboxId/recovery-preflight", options, assess);
  app.post("/api/v1/ops/claimmd/eras/:inboxId/recovery-dry-run", options, assess);
}
