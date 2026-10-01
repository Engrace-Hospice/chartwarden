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
const laborShare = () =>
  Type.String({
    pattern: "^\\d(\\.\\d{1,4})?$",
    description: 'Decimal fraction with at most four places, e.g. "0.6871" (not a percent).',
  });

const RateFields = {
  fiscalYearStarting: Type.Integer({
    minimum: 2000,
    maximum: 2100,
    description:
      "Federal fiscal year's STARTING calendar year (Oct 1): 2025 = FY2026 (Oct 2025 - Sep 2026).",
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
  // F-211 — the CMS-published labor share per level of care (decimal-fraction STRINGS, e.g. "0.6871"); the wage index adjusts
  // only this share of each rate. The pure rules bound them to 0.30-0.90.
  laborShareRhc: laborShare(),
  laborShareChc: laborShare(),
  laborShareIrc: laborShare(),
  laborShareGip: laborShare(),
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
  /** NULL on a version entered before migration 0280: it cannot price a claim until superseded with labor shares. */
  laborShareRhc: Type.Union([Type.String(), Type.Null()]),
  laborShareChc: Type.Union([Type.String(), Type.Null()]),
  laborShareIrc: Type.Union([Type.String(), Type.Null()]),
  laborShareGip: Type.Union([Type.String(), Type.Null()]),
  enteredByMembershipId: Type.String(),
  entryReason: Type.Union([Type.String(), Type.Null()]),
  supersededAt: Type.Union([Type.String(), Type.Null()]),
  supersededById: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type RateTableView = Static<typeof RateTableViewSchema>;

export const RateTableListResponseSchema = Type.Object({
  rateTables: Type.Array(RateTableViewSchema),
});
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
    // F-211: `Value.Convert` would COERCE a JSON number into the labor-share `String` field; they are decimal strings.
    if (key.startsWith("laborShare") && value !== undefined && typeof value !== "string") {
      throw new ValidationError("request validation failed", [
        { field: key, code: "INVALID", message: `${key} must be a decimal string, e.g. "0.6871"` },
      ]);
    }
  }
}

export { parse };
