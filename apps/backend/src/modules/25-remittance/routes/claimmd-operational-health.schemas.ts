import { Type } from "@sinclair/typebox";

export const ClaimMdTenantOperationalHealthQuerySchema = Type.Object(
  { providerEntityId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

export const ClaimMdTenantOperationalHealthResponseSchema = Type.Object(
  {
    scope: Type.Literal("tenant_attributed_m25_stages"),
    providerEntityId: Type.String({ format: "uuid" }),
    completeness: Type.Literal("exact_for_authorized_provider_stages"),
    stageCount: Type.Integer({ minimum: 0 }),
    states: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    exceptionCount: Type.Integer({ minimum: 0 }),
    oldestExceptionAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    latestStageAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    centralCapture: Type.Object({
      status: Type.Literal("restricted"),
      reasonCode: Type.Literal("CENTRAL_ACCOUNT_METADATA_NOT_TENANT_VISIBLE"),
    }),
    requestBudget: Type.Object({
      status: Type.Literal("unavailable"),
      reasonCode: Type.Literal("NO_DURABLE_REQUEST_BUDGET_OBSERVATION"),
    }),
    sampledAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
