// apps/backend/src/modules/23-billing-medicare/routes/rate-table-typebox.ts — M23 hospice rate-table request/response
// TypeBox shapes (F-210). Named `*-typebox` (not `*schema*`) for the same table-ownership-heuristic reason as
// `billing-typebox.ts`. All money is WHOLE INTEGER CENTS, PRE-wage-index (the wage index is applied at assembly).
// Org / actor / membership binding is server-side — no body field carries an org id or the entering membership.
import { type Static, Type } from "@sinclair/typebox";
import { ValidationError } from "@wardenx/types";
import { parse } from "./billing-typebox";

const uuid = () => Type.String({ format: "uuid" });
const isoDate = () => Type.String({ format: "date" });
const cents = () => Type.Integer({ minimum: 1, maximum: 1_000_000 });

const RateFields = {
  fiscalYearStarting: Type.Integer({
    minimum: 2000,
    maximum: 2100,
    description: "Federal fiscal year's STARTING calendar year (Oct 1): 2025 = FY2026 (Oct 2025 - Sep 2026).",
  }),
  effectiveFrom: isoDate(),
  effectiveTo: Type.Optional(
    isoDate(), // omitted = the end of the fiscal year
  ),
  rhcDays1to60PerDiemCents: cents(),
  rhcDays61PlusPerDiemCents: cents(),
  chcPerDiemCents: cents(),
  ircPerDiemCents: cents(),
  gipPerDiemCents: cents(),
  chcHourlyRateCents: cents(),
  entryReason: Type.Optional(Type.String({ maxLength: 2000 })),
};

export const CreateRateTableBodySchema = Type.Object({
  providerEntityId: uuid(),
  ...RateFields,
});
export type CreateRateTableBody = Static<typeof CreateRateTableBodySchema>;

export const SupersedeRateTableBodySchema = Type.Object({
  /** Scopes the row for the §4.7 provider-entity check; must match the row being superseded. */
  providerEntityId: uuid(),
  ...RateFields,
});
export type SupersedeRateTableBody = Static<typeof SupersedeRateTableBodySchema>;

export const RateTableIdParamsSchema = Type.Object({ id: uuid() });

export const RateTableListQuerySchema = Type.Object({
  providerEntityId: uuid(),
  includeSuperseded: Type.Optional(Type.Boolean()),
});
export const RateTableGetQuerySchema = Type.Object({ providerEntityId: uuid() });
export const RateTableEffectiveQuerySchema = Type.Object({
  providerEntityId: uuid(),
  onDate: isoDate(),
});

export const RateTableViewSchema = Type.Object({
  rateTableId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  fiscalYearStarting: Type.Integer(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  rhcDays1to60PerDiemCents: Type.Integer(),
  rhcDays61PlusPerDiemCents: Type.Integer(),
  chcPerDiemCents: Type.Integer(),
  ircPerDiemCents: Type.Integer(),
  gipPerDiemCents: Type.Integer(),
  chcHourlyRateCents: Type.Integer(),
  enteredByMembershipId: Type.String(),
  entryReason: Type.Union([Type.String(), Type.Null()]),
  supersededAt: Type.Union([Type.String(), Type.Null()]),
  supersededById: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type RateTableView = Static<typeof RateTableViewSchema>;

export const RateTableListResponseSchema = Type.Object({ rateTables: Type.Array(RateTableViewSchema) });
export const RateTableEffectiveResponseSchema = Type.Union([RateTableViewSchema, Type.Null()]);

/**
 * TypeBox `Value.Convert` TRUNCATES a fractional number into an `Integer` field (215.5 becomes 215) instead of
 * rejecting it, which on a hand-keyed financial input silently changes what was typed. Reject any non-integer
 * `*Cents` value on the raw body BEFORE the shared `parse` runs.
 */
export function assertWholeCents(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.endsWith("Cents") && typeof value === "number" && !Number.isInteger(value)) {
      throw new ValidationError("request validation failed", [
        { field: key, code: "INVALID", message: `${key} must be a whole number of cents` },
      ]);
    }
  }
}

export { parse };
