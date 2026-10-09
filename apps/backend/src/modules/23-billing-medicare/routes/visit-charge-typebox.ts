// apps/backend/src/modules/23-billing-medicare/routes/visit-charge-typebox.ts — M23 hospice VISIT-CHARGE SCHEDULE
// request/response TypeBox shapes (migration 1056). Named `*-typebox` (not `*schema*`) for the same table-ownership-
// heuristic reason as `billing-typebox.ts`. All money is WHOLE INTEGER CENTS per 15-minute unit. Org / actor /
// membership binding is server-side — no body field carries an org id or the entering membership.
import { type Static, Type } from "@sinclair/typebox";
import { VISIT_CHARGE_MAX_CENTS } from "@wardenx/billing";
import { ValidationError } from "@wardenx/types";
import { parse } from "./billing-typebox";

const uuid = () => Type.String({ format: "uuid" });
const isoDate = () => Type.String({ format: "date" });
const charge = () =>
  Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: VISIT_CHARGE_MAX_CENTS,
      description:
        "Charge per 15-minute unit in whole cents ($25.00 is 2500). Omit when no charge is entered for this discipline (claim assembly then fails closed); 0 is a deliberate free charge.",
    }),
  );

const ScheduleFields = {
  effectiveFrom: isoDate(),
  effectiveTo: Type.Optional(isoDate()), // omitted = open-ended
  rnUnitChargeCents: charge(),
  lpnUnitChargeCents: charge(),
  aideUnitChargeCents: charge(),
  mswUnitChargeCents: charge(),
  ptUnitChargeCents: charge(),
  otUnitChargeCents: charge(),
  slpUnitChargeCents: charge(),
  entryReason: Type.Optional(Type.String({ maxLength: 2000 })),
};

export const CreateVisitChargeBodySchema = Type.Object({
  providerEntityId: uuid(),
  ...ScheduleFields,
});
export type CreateVisitChargeBody = Static<typeof CreateVisitChargeBodySchema>;

export const SupersedeVisitChargeBodySchema = Type.Object({
  /** Scopes the row for the §4.7 provider-entity check; must match the row being superseded. */
  providerEntityId: uuid(),
  ...ScheduleFields,
});
export type SupersedeVisitChargeBody = Static<typeof SupersedeVisitChargeBodySchema>;

export const VisitChargeIdParamsSchema = Type.Object({ id: uuid() });
export const VisitChargeListQuerySchema = Type.Object({
  providerEntityId: uuid(),
  includeSuperseded: Type.Optional(Type.Boolean()),
});
export const VisitChargeGetQuerySchema = Type.Object({ providerEntityId: uuid() });
export const VisitChargeEffectiveQuerySchema = Type.Object({
  providerEntityId: uuid(),
  onDate: isoDate(),
});

const nullableCents = () => Type.Union([Type.Integer(), Type.Null()]);

export const VisitChargeViewSchema = Type.Object({
  visitChargeScheduleId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  /** NULL = no charge entered for the discipline: a claim billing such a visit fails closed. */
  rnUnitChargeCents: nullableCents(),
  lpnUnitChargeCents: nullableCents(),
  aideUnitChargeCents: nullableCents(),
  mswUnitChargeCents: nullableCents(),
  ptUnitChargeCents: nullableCents(),
  otUnitChargeCents: nullableCents(),
  slpUnitChargeCents: nullableCents(),
  enteredByMembershipId: Type.String(),
  entryReason: Type.Union([Type.String(), Type.Null()]),
  supersededAt: Type.Union([Type.String(), Type.Null()]),
  supersededById: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type VisitChargeView = Static<typeof VisitChargeViewSchema>;

export const VisitChargeListResponseSchema = Type.Object({
  visitChargeSchedules: Type.Array(VisitChargeViewSchema),
});
export const VisitChargeEffectiveResponseSchema = Type.Union([VisitChargeViewSchema, Type.Null()]);

/**
 * TypeBox `Value.Convert` TRUNCATES a fractional number into an `Integer` field (25.5 becomes 25) instead of
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
