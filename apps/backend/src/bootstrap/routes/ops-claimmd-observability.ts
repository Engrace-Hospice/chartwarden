import { PLATFORM_OPS_ROLE_KEYS, requireAbac, requirePermission } from "@chartwarden/auth";
import { ForbiddenError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";

const OBSERVE_PERMISSION = "billing.rule_config.platform_admin";
const OBSERVE_GUARDS = [
  requirePermission(OBSERVE_PERMISSION),
  requireAbac(OBSERVE_PERMISSION, "platform_billing_scope"),
];

type Snapshot = {
  readonly cursorPresent: boolean;
  readonly lastSuccessAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly streamFailed: boolean;
  readonly sampledAt: number;
  readonly [key: string]: unknown;
};

const StreamSchema = Type.Object(
  {
    cursor: Type.Object({ present: Type.Boolean(), valueExposed: Type.Literal(false) }),
    lastAttemptAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    lastSuccessAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    outcome: Type.Union([
      Type.Literal("failure_recorded"),
      Type.Literal("success_recorded"),
      Type.Literal("no_durable_attempt"),
    ]),
    backlog: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ClaimMdOperationalObservabilityResponseSchema = Type.Object(
  {
    scope: Type.Literal("central_claimmd_account"),
    accountReferenceExposed: Type.Literal(false),
    usage: Type.Union([Type.Literal("test"), Type.Literal("production")]),
    responses: StreamSchema,
    eras: StreamSchema,
    requestBudget: Type.Object({
      status: Type.Literal("unavailable"),
      reasonCode: Type.Literal("NO_DURABLE_REQUEST_BUDGET_OBSERVATION"),
    }),
    workerHeartbeat: Type.Object({
      status: Type.Literal("unavailable"),
      reasonCode: Type.Literal("NO_DURABLE_WORKER_HEARTBEAT"),
    }),
    sampledAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toStream(snapshot: Snapshot, backlog: Readonly<Record<string, number>>) {
  return {
    cursor: { present: snapshot.cursorPresent, valueExposed: false as const },
    lastAttemptAt: iso(snapshot.lastAttemptAt),
    lastSuccessAt: iso(snapshot.lastSuccessAt),
    outcome: snapshot.streamFailed
      ? ("failure_recorded" as const)
      : snapshot.lastSuccessAt !== null
        ? ("success_recorded" as const)
        : ("no_durable_attempt" as const),
    backlog,
  };
}

/** Account-wide read surface. It returns bounded aggregates and never a cursor token, account id, or payload. */
export function registerOpsClaimMdObservabilityRoute(
  app: FastifyInstance,
  input: {
    readonly usage: "test" | "production";
    readonly responseSnapshot: () => Promise<Snapshot>;
    readonly eraSnapshot: () => Promise<Snapshot>;
  },
): void {
  app.get(
    "/api/v1/ops/claimmd/observability",
    {
      preHandler: OBSERVE_GUARDS,
      schema: { response: { 200: ClaimMdOperationalObservabilityResponseSchema } },
      config: {
        auditRead: {
          none: "Platform-only account aggregates; no tenant, payload, cursor token, or credential is returned",
        },
      },
    },
    async (request: FastifyRequest) => {
      const context = request.context;
      if (
        !context?.userId ||
        !context.roles?.some((role) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(role))
      )
        throw new ForbiddenError("authenticated platform operator required");
      const [responses, eras] = await Promise.all([input.responseSnapshot(), input.eraSnapshot()]);
      const responseBacklog = {
        unresolved: Number(responses.unresolvedCount ?? 0),
        pendingDelivery: Number(
          (responses.delivery as Record<string, number> | undefined)?.pending ?? 0,
        ),
      };
      const eraBacklog = {
        discovered: Number((eras.capture as Record<string, number> | undefined)?.discovered ?? 0),
        retryableFailure: Number(
          (eras.capture as Record<string, number> | undefined)?.retryable_failure ?? 0,
        ),
        heldDelivery: Number((eras.delivery as Record<string, number> | undefined)?.held ?? 0),
        pendingResolution: Number(
          (eras.resolution as Record<string, number> | undefined)?.pending ?? 0,
        ),
      };
      return {
        scope: "central_claimmd_account" as const,
        accountReferenceExposed: false as const,
        usage: input.usage,
        responses: toStream(responses, responseBacklog),
        eras: toStream(eras, eraBacklog),
        requestBudget: {
          status: "unavailable" as const,
          reasonCode: "NO_DURABLE_REQUEST_BUDGET_OBSERVATION" as const,
        },
        workerHeartbeat: {
          status: "unavailable" as const,
          reasonCode: "NO_DURABLE_WORKER_HEARTBEAT" as const,
        },
        sampledAt: new Date(Math.max(responses.sampledAt, eras.sampledAt)).toISOString(),
      };
    },
  );
}
