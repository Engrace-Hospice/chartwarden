// @wardenx/inpatient — M37-T08, §2.8 D9. The dietary tray-service intake helpers. Lightweight per-meal
// documentation; the DB CHECK `intake_fraction BETWEEN 0 AND 1` is the schema backstop. Pure & IO-free.

/** §2.8 — intake fraction must be within [0, 1] (the schema CHECK mirror; null is allowed = not recorded). */
export function isIntakeFractionValid(fraction: number | null): boolean {
  return fraction === null || (fraction >= 0 && fraction <= 1);
}

/** §2.8 — the low-intake threshold below which a caregiver-assisted comfort feed becomes a documentation concern. */
export const COMFORT_FEEDING_LOW_INTAKE_THRESHOLD = 0.2;

/**
 * §2.8 — the CoP 418.110 comfort-feeding documentation surface: a meal shows on the end-of-life
 * comfort-feeding board when intake is below the threshold, feeding was caregiver-assisted, and the diet
 * order is `comfort_feeding`.
 */
export function isComfortFeedingConcern(
  intakeFraction: number | null,
  caregiverAssistedFeeding: boolean,
  dietOrderKind: string,
): boolean {
  return (
    intakeFraction !== null &&
    intakeFraction < COMFORT_FEEDING_LOW_INTAKE_THRESHOLD &&
    caregiverAssistedFeeding &&
    dietOrderKind === "comfort_feeding"
  );
}
