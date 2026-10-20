/** Re-find helpers for the COP27 seed: pure, so the idempotency rule is unit-testable. */

/** A referral is re-found by the marker it was created with, never by the patient's name. */
export function findByMarker<T extends { externalReferralId: string | null }>(
  items: readonly T[],
  marker: string,
): T | null {
  return items.find((r) => r.externalReferralId === marker) ?? null;
}

/**
 * A directly-created patient is re-found by its (unique, fictional) name: the patient list cannot search
 * identifiers. The marker identifier is added afterwards by ensureMarkerIdentifier. A patient created by the
 * earlier scheme carries the marker itself as its legal last name; it is still re-found, so a re-run against
 * an un-reseeded environment does not create a second one.
 */
export function matchesDemoPatient(
  p: { firstName: string; lastName: string },
  spec: { firstName: string; lastName: string; marker: string },
): boolean {
  return (
    (p.firstName === spec.firstName && p.lastName === spec.lastName) || p.lastName === spec.marker
  );
}
