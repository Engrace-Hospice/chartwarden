// apps/backend/src/modules/21-supplies/lifecycle/serving-location.ts — GAP-064.
//
// The serving Location of a supply request / comfort-kit dispatch is a SERVER fact: it drives the par-stock
// decrement and the §4.4 controlled-substance dispatcher eligibility, so it may never be taken from the
// request body on trust. Two pure verifiers the write service calls before it evaluates eligibility,
// decrements a shelf or inserts a row.
import { SupplyStateError } from "./errors";

/** Inputs to {@link verifyRequestServingLocation}. */
export interface RequestLocationFacts {
  /** The Location the caller CLAIMED in the body. */
  readonly bodyLocationId: string;
  /** The Location M6 holds for the admission, or null/undefined when the admission is not sited yet. */
  readonly admissionLocationId: string | null | undefined;
  /** The Locations the acting membership is assigned to (server-assembled request context). */
  readonly actorLocationIds: readonly string[];
}

/**
 * Verify the Location a NEW supply request is anchored to. The admission's siting wins; a body that
 * disagrees is refused (`M21_LOCATION_MISMATCH`). An unsited admission offers no server fact, so the body
 * is only honoured when it is within the actor's own assigned Locations — otherwise
 * `M21_SERVING_LOCATION_UNRESOLVED`. Returns the verified Location id.
 */
export function verifyRequestServingLocation(facts: RequestLocationFacts): string {
  const { bodyLocationId, admissionLocationId, actorLocationIds } = facts;
  if (typeof admissionLocationId === "string" && admissionLocationId.length > 0) {
    if (admissionLocationId !== bodyLocationId) {
      throw new SupplyStateError(
        "M21_LOCATION_MISMATCH",
        "the supplied locationId is not the Location this admission is served from",
      );
    }
    return admissionLocationId;
  }
  if (!actorLocationIds.includes(bodyLocationId)) {
    throw new SupplyStateError(
      "M21_SERVING_LOCATION_UNRESOLVED",
      "the admission has no serving Location and the supplied locationId is not one the actor is assigned to",
    );
  }
  return bodyLocationId;
}

/**
 * A dispatch ships from the Location its supply request is anchored to. The stored request Location is the
 * authority; a differing body value is refused (`M21_LOCATION_MISMATCH`) before eligibility is evaluated,
 * a shelf is decremented or a row is written. Returns the request's Location id.
 */
export function assertDispatchLocationMatchesRequest(
  requestLocationId: string,
  bodyLocationId: string,
): string {
  if (requestLocationId !== bodyLocationId) {
    throw new SupplyStateError(
      "M21_LOCATION_MISMATCH",
      "the supplied locationId does not match the Location of the supply request being dispatched",
    );
  }
  return requestLocationId;
}
