// apps/backend/src/modules/11-orders/routes/server-derived-facts.ts — GAP-031 (M11).
//
// Authorization and cosign facts are computed on the server, never trusted from the request body:
//   - drafter / signer / recorder discipline is a property of the AUTHENTICATED caller (the session's role
//     grants). The body still names a discipline (the API contract), but a name the caller does not hold
//     is refused 422 DISCIPLINE_NOT_HELD, so the value stored on `order_record.drafter_discipline` and
//     `order_signature.signer_discipline` is always one the actor really has;
//   - the §2.5 cosign inputs (who will sign, and the level-of-care transition) come from the STORED order:
//     the drafter's discipline and the `level_of_care_change` payload's own fromLevel/toLevel.
import type { LevelOfCare } from "@wardenx/orders";
import { WardenXError } from "@wardenx/types";

const LEVELS: readonly string[] = ["rhc", "irc", "chc", "gip"];
const HTTP_UNPROCESSABLE = 422;

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * §2.2 `recordVerbal` — "recording actor is RN+ with `orders.verbal.record`". The recorder RECEIVES an order
 * a prescriber gave, so this is a seniority floor, NOT `disciplineCanOrder` (an RN may record a verbal lab
 * order she could not author). LPN, aide and the non-nursing disciplines are below the floor. Role keys
 * double as disciplines in this codebase, so the RN-equivalent and physician role keys are in the set.
 */
const VERBAL_RECORDER_DISCIPLINES: ReadonlySet<string> = new Set([
  "rn",
  "rn_case_manager",
  "np",
  "pa",
  "md",
  "physician",
  "hospice_physician",
  "medical_director",
]);

export function isVerbalRecorderDiscipline(discipline: string): boolean {
  return VERBAL_RECORDER_DISCIPLINES.has(norm(discipline));
}

/** Refuse (422 DISCIPLINE_NOT_HELD) a body-supplied discipline the authenticated caller does not hold. */
export function assertDisciplineHeld(held: readonly string[], claimed: string): void {
  const claimedKey = norm(claimed);
  if (held.some((d) => norm(d) === claimedKey)) return;
  throw new WardenXError(
    "DISCIPLINE_NOT_HELD",
    `The caller does not hold the '${claimed}' discipline.`,
    HTTP_UNPROCESSABLE,
  );
}

export interface DerivedCosignFacts {
  readonly signerDiscipline: string;
  readonly levelChange?: { readonly fromLevel: LevelOfCare; readonly toLevel: LevelOfCare };
}

const isLevel = (v: unknown): v is LevelOfCare => typeof v === "string" && LEVELS.includes(v);

/**
 * The §2.5 cosign inputs, derived from the stored order. The drafter signs their own order, or — for an
 * RN/LPN draft — a physician does, for whom the stricter axes cannot be weakened by drafter-side claims; so
 * the signer discipline is the stored drafter discipline. The level transition is the order payload's own.
 */
export function deriveCosignFacts(order: {
  readonly kind: string;
  readonly drafterDiscipline: string;
  readonly data: unknown;
}): DerivedCosignFacts {
  const base = { signerDiscipline: order.drafterDiscipline };
  if (order.kind !== "level_of_care_change") return base;
  const d = (order.data ?? {}) as { fromLevel?: unknown; toLevel?: unknown };
  if (!isLevel(d.fromLevel) || !isLevel(d.toLevel)) return base;
  return { ...base, levelChange: { fromLevel: d.fromLevel, toLevel: d.toLevel } };
}
