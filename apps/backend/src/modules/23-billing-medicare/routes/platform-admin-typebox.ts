// apps/backend/src/modules/23-billing-medicare/routes/platform-admin-typebox.ts — M23 platform-admin request/response
// shapes (§4.1 #41 / #42, GAP-144). Named `*-typebox` for the same table-ownership-heuristic reason as
// `billing-typebox.ts`.
import { type Static, Type } from "@sinclair/typebox";

/** Upper bound on one load: CMS publishes roughly 6,000 hospice CCNs per fiscal year. */
export const WAGE_INDEX_LOAD_MAX_ROWS = 7000;

/**
 * POST /admin/billing/wage-indexes/load. The server does NOT fetch `sourceReference` — an outbound fetch of a
 * caller-supplied URI is an SSRF and egress surface on the API tier. The operator downloads the CMS file, the
 * rows arrive in the body, and `sourceReference` records where they came from (the audit trail).
 */
export const LoadWageIndexesBodySchema = Type.Object({
  fiscalYearStarting: Type.Integer({
    minimum: 2000,
    maximum: 2100,
    description: "Federal fiscal year's STARTING calendar year (Oct 1): 2025 = FY2026.",
  }),
  sourceReference: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "The CMS wage-index file URI / Federal Register notice the rows were taken from.",
  }),
  rows: Type.Array(
    Type.Object({
      ccn: Type.String({ pattern: "^[0-9A-Za-z]{6}$" }),
      cbsaCode: Type.Optional(Type.String({ pattern: "^[0-9]{5}$" })),
      factorDecimal: Type.String({ pattern: "^\\d(\\.\\d{1,4})?$" }),
    }),
    { minItems: 1, maxItems: WAGE_INDEX_LOAD_MAX_ROWS },
  ),
});
export type LoadWageIndexesBody = Static<typeof LoadWageIndexesBodySchema>;

export const LoadWageIndexesResultSchema = Type.Object({
  fiscalYearStarting: Type.Integer(),
  sourceReference: Type.String(),
  inserted: Type.Integer(),
  updated: Type.Integer(),
});
export type LoadWageIndexesResult = Static<typeof LoadWageIndexesResultSchema>;

/** POST /admin/billing/platform-rules — register a new platform validation rule (spec #41). */
export const RegisterPlatformRuleBodySchema = Type.Object({
  ruleKey: Type.String({ pattern: "^[a-z][a-z0-9_]{2,63}$" }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  severity: Type.Union([Type.Literal("error"), Type.Literal("warn"), Type.Literal("info")]),
  /** The regulatory-required tag: a tagged rule cannot be disabled or re-parameterized by a tenant overlay (D5). */
  regulatoryRequired: Type.Boolean(),
});
export type RegisterPlatformRuleBody = Static<typeof RegisterPlatformRuleBodySchema>;
