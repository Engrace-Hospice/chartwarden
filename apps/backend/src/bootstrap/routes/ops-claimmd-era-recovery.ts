import {
  PLATFORM_OPS_ROLE_KEYS,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { createClaimMdEraRecoveryService } from "../../modules/25-remittance/ingest/claimmd-era-recovery";

type RecoveryService = ReturnType<typeof createClaimMdEraRecoveryService>;
const RECOVERY_PERMISSION = "billing.rule_config.platform_admin";
const RECOVERY_GUARDS = [
  requirePermission(RECOVERY_PERMISSION),
  requireAbac(RECOVERY_PERMISSION, "platform_billing_scope"),
  requireStepUp(RECOVERY_PERMISSION),
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Platform-only ERA recovery invocation. This endpoint accepts no tenant/provider identity and
 * returns only a state receipt. A platform-owned role, platform scope, permission and fresh step-up
 * are required; actor identity comes exclusively from the authenticated request context.
 */
export function registerOpsClaimMdEraRecoveryRoute(
  app: FastifyInstance,
  input: {
    readonly service: RecoveryService;
    readonly accountReference: string;
    readonly usage: "test" | "production";
  },
): void {
  app.post(
    "/api/v1/ops/claimmd/eras/:inboxId/recovery",
    { preHandler: RECOVERY_GUARDS },
    async (request: FastifyRequest) => {
      const context = request.context;
      // The explicit role check also prevents ABAC break-glass from turning a tenant billing grant
      // into account-wide recovery authority.
      if (
        !context?.userId ||
        !context.roles?.some((role) => (PLATFORM_OPS_ROLE_KEYS as readonly string[]).includes(role))
      )
        throw new ForbiddenError("authenticated platform operator required");
      const params = request.params as { inboxId?: unknown };
      const body = request.body as Record<string, unknown> | null;
      const inboxId = params?.inboxId;
      if (typeof inboxId !== "string" || !UUID.test(inboxId) || !body || typeof body !== "object") {
        throw new ValidationError("invalid ERA recovery request", [
          { field: "request", code: "INVALID", message: "invalid identifier or body" },
        ]);
      }
      const requiredStrings = [
        "actionId",
        "accountReference",
        "stage",
        "reasonCode",
        "expectedState",
      ] as const;
      if (
        requiredStrings.some((key) => typeof body[key] !== "string") ||
        !UUID.test(body.actionId as string) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(body.accountReference as string) ||
        !["capture", "ownership_resolution", "m25_delivery"].includes(body.stage as string) ||
        !/^[A-Z][A-Z0-9_]{2,63}$/.test(body.reasonCode as string) ||
        !["test", "production"].includes(body.usage as string) ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 0 ||
        (body.expectedState as string).length < 1 ||
        (body.expectedState as string).length > 64
      ) {
        throw new ValidationError("invalid ERA recovery request", [
          {
            field: "body",
            code: "INVALID",
            message: "fields do not match a supported recovery action",
          },
        ]);
      }
      if (body.accountReference !== input.accountReference || body.usage !== input.usage) {
        throw new ValidationError("recovery account does not match this runtime", [
          {
            field: "accountReference",
            code: "SCOPE_MISMATCH",
            message: "account/environment must match the configured Claim.MD binding",
          },
        ]);
      }
      const actor = {
        id: context.userId,
        kind: "platform_operator" as const,
        authorization: RECOVERY_PERMISSION,
      };
      try {
        return await input.service.requeue(
          {
            actionId: body.actionId as string,
            inboxId,
            accountReference: body.accountReference as string,
            usage: body.usage as "test" | "production",
            stage: body.stage as "capture" | "ownership_resolution" | "m25_delivery",
            reasonCode: body.reasonCode as string,
            expectedState: body.expectedState as string,
            expectedVersion: body.expectedVersion,
          },
          actor,
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "CLAIMMD_ERA_RECOVERY_NOT_FOUND") throw new NotFoundError("Claim.MD ERA");
        if (code === "CLAIMMD_ERA_RECOVERY_FORBIDDEN") throw new ForbiddenError();
        if (code.startsWith("CLAIMMD_ERA_RECOVERY_STALE") || code.endsWith("ACTION_ID_CONFLICT"))
          throw new ConflictError(
            "ERA recovery state changed; refresh the state and submit a new action",
          );
        if (code.startsWith("CLAIMMD_ERA_RECOVERY_"))
          throw new ValidationError("ERA recovery was rejected", [
            { field: "recovery", code, message: "operation failed closed" },
          ]);
        throw error;
      }
    },
  );
}
