import { Type } from "@sinclair/typebox";

const CentString = Type.String({ pattern: "^-?[0-9]+$" });
const CasGroupTotals = Type.Object(
  {
    CO: CentString,
    CR: CentString,
    OA: CentString,
    PI: CentString,
    PR: CentString,
  },
  { additionalProperties: false },
);

export const RevenueCycleSummaryQuerySchema = Type.Object(
  {
    providerEntityId: Type.Optional(Type.String({ format: "uuid" })),
    fromDate: Type.String({ format: "date" }),
    toDate: Type.String({ format: "date" }),
  },
  { additionalProperties: false },
);

export const RevenueCycleSummaryResponseSchema = Type.Object(
  {
    dateBasis: Type.Literal("era_received_at_utc"),
    fromDate: Type.String({ format: "date" }),
    toDate: Type.String({ format: "date" }),
    providerEntityId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    completeness: Type.Literal("exact_for_m25_remittance_advice"),
    receivedAdviceCount: Type.Integer({ minimum: 0 }),
    reportedAdviceCount: Type.Integer({ minimum: 0 }),
    reportedEraPaymentCents: CentString,
    reportedClaimPaymentCents: CentString,
    fullyPostedClaimPaymentCents: CentString,
    postedClaimPaymentCents: CentString,
    fullyPostedAdviceCount: Type.Integer({ minimum: 0 }),
    partialPostedAdviceCount: Type.Integer({ minimum: 0 }),
    reportedAdjustmentsByGroup: CasGroupTotals,
    reportedPlbCents: CentString,
    unmatchedLineCount: Type.Integer({ minimum: 0 }),
    latestReceivedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    claimMdStagesIncluded: Type.Literal(false),
    authoritativeAr: Type.Object(
      {
        status: Type.Literal("unavailable"),
        reasonCode: Type.Literal("NO_CANONICAL_RECEIVABLE_LEDGER"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
