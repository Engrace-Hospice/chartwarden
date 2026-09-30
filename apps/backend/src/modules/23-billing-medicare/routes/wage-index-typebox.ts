// apps/backend/src/modules/23-billing-medicare/routes/wage-index-typebox.ts — M23 tenant-entered wage-index request/response
// TypeBox shapes (F-211). Named `*-typebox` (not `*schema*`) for the same table-ownership-heuristic reason as
// `billing-typebox.ts`. The factor is a decimal STRING (never a float). Org / actor / membership binding is server-side.
import { type Static, Type } from "@sinclair/typebox";
import { ValidationError } from "@wardenx/types";
import { parse } from "./billing-typebox";

const uuid = () => Type.String({ format: "uuid" });

const WageIndexFields = {
  ccn: Type.String({
    pattern: "^[0-9A-Za-z]{6}$",
    description: "6-character CMS Certification Number.",
  }),
  fiscalYearStarting: Type.Integer({
    minimum: 2000,
    maximum: 2100,
    description:
      "Federal fiscal year's STARTING calendar year (Oct 1): 2025 = FY2026 (Oct 2025 - Sep 2026).",
  }),
  cbsaCode: Type.Optional(Type.String({ pattern: "^[0-9]{5}$" })),
  factorDecimal: Type.String({
    pattern: "^\\d(\\.\\d{1,4})?$",
    description:
      'The published hospice wage index as a decimal string with at most four places, e.g. "1.0342".',
  }),
  sourceReference: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Where the value was keyed from (CMS wage-index table / Federal Register notice).",
  }),
  entryReason: Type.Optional(Type.String({ maxLength: 2000 })),
};

export const CreateWageIndexBodySchema = Type.Object(WageIndexFields);
export type CreateWageIndexBody = Static<typeof CreateWageIndexBodySchema>;

export const SupersedeWageIndexBodySchema = Type.Object(WageIndexFields);
export type SupersedeWageIndexBody = Static<typeof SupersedeWageIndexBodySchema>;

export const WageIndexIdParamsSchema = Type.Object({ id: uuid() });

export const WageIndexListQuerySchema = Type.Object({
  ccn: Type.Optional(Type.String({ pattern: "^[0-9A-Za-z]{6}$" })),
  fiscalYearStarting: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
  includeSuperseded: Type.Optional(Type.Boolean()),
});
export const WageIndexEffectiveQuerySchema = Type.Object({
  ccn: Type.String({ pattern: "^[0-9A-Za-z]{6}$" }),
  fiscalYearStarting: Type.Integer({ minimum: 2000, maximum: 2100 }),
});

export const WageIndexViewSchema = Type.Object({
  wageIndexId: Type.String(),
  organizationId: Type.String(),
  ccn: Type.String(),
  fiscalYearStarting: Type.Integer(),
  cbsaCode: Type.Union([Type.String(), Type.Null()]),
  factorDecimal: Type.String(),
  sourceReference: Type.String(),
  enteredByMembershipId: Type.String(),
  entryReason: Type.Union([Type.String(), Type.Null()]),
  supersededAt: Type.Union([Type.String(), Type.Null()]),
  supersededById: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type WageIndexView = Static<typeof WageIndexViewSchema>;

export const WageIndexListResponseSchema = Type.Object({
  wageIndexes: Type.Array(WageIndexViewSchema),
});
export const WageIndexEffectiveResponseSchema = Type.Union([WageIndexViewSchema, Type.Null()]);

/**
 * TypeBox `Value.Convert` COERCES a JSON number into a `String` field (1.0342 becomes "1.0342"), which would let a float
 * onto a hand-keyed financial input. The factor is a decimal STRING by contract: reject a non-string `factorDecimal` on the raw
 * body BEFORE the shared `parse` runs.
 */
export function assertFactorIsString(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const v = (raw as Record<string, unknown>).factorDecimal;
  if (v !== undefined && typeof v !== "string") {
    throw new ValidationError("request validation failed", [
      {
        field: "factorDecimal",
        code: "INVALID",
        message: 'factorDecimal must be a decimal string, e.g. "1.0342"',
      },
    ]);
  }
}

export { parse };
