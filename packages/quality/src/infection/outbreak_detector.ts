// @wardenx/quality — M30 §7.8 / D11 (WF-18): the 14-day infection-cluster outbreak detector.
//
// The core of §7.8: given a stream of normalized surveillance events for an org, detect clusters of
// `≥3` events sharing the same `(provider_entity, pathogen, body_site)` triple within any rolling
// 14-day window, and shape each into the `infection_outbreak_case` insert the backend persists
// server-side (V-18 — outbreak cases are NEVER user-created). Detection fires on the THIRD event of a
// cluster (WF-18); subsequent events in the same cluster extend the live case (the worker's
// increment-`event_count` / bump-`last_event_at` job, NOT this detector's concern).
//
// PURE DOMAIN (P2a): a deterministic function over an event list. No DB, no clock, no idempotency
// lookup — the worker (a LATER phase) dedupes the emitted case against the `uq_outbreak_window` unique
// index `(provider_entity, pathogen, body_site, window_start, window_end)`. The detected case maps onto
// the FROZEN `infection_outbreak_case` schema, whose status enum opens at `'open'`.
//
// NOTE ON THE CLUSTER KEY: the frozen schema (and D11) key the outbreak case on
// `(provider_entity, pathogen, body_site)`. Spec WF-18 additionally names `exposureRoute /
// transmission_context` in the triple, but the schema's outbreak-case columns + unique index carry only
// pathogen + body site, so the detector keys on the schema triple (architecture wins over the WF-18
// prose). Transmission context remains an event attribute, not a cluster discriminator.
import type { schema } from "@wardenx/db";
import type { NormalizedSurveillanceEvent } from "./surveillance";

/** The rolling detection window in days (D11). */
export const OUTBREAK_WINDOW_DAYS = 14;

/** Minimum events within the window to declare a cluster (D11). */
export const OUTBREAK_MIN_EVENTS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OUTBREAK_WINDOW_MS = OUTBREAK_WINDOW_DAYS * MS_PER_DAY;

/**
 * A detected outbreak cluster — the server-derived input for an `infection_outbreak_case` insert
 * (V-18). Carries the qualifying window and triggering event count; the case opens at `'open'`.
 */
export interface DetectedOutbreakCluster {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly pathogen: string;
  readonly bodySite: string;
  /** The `observedAt` of the earliest event in the qualifying window. */
  readonly windowStart: Date;
  /** The `observedAt` of the event whose arrival first satisfied the `≥3 in 14d` rule (WF-18). */
  readonly windowEnd: Date;
  /** Event count within the qualifying window at detection (`≥ OUTBREAK_MIN_EVENTS`). */
  readonly triggeringEventCount: number;
  /** The status a freshly-detected case opens at (the frozen `m30_outbreak_status` default). */
  readonly status: "open";
}

/**
 * Detect outbreak clusters over a list of normalized surveillance events (WF-18). Events may span many
 * `(providerEntity, pathogen, bodySite)` clusters and arrive unsorted; the detector groups by
 * `clusterKey`, sorts each group by `observedAt`, and runs a two-pointer sliding window. For each
 * cluster it emits AT MOST ONE case — the earliest 14-day window in which the count first reaches
 * `OUTBREAK_MIN_EVENTS` (mirroring the trigger firing on the third insertion). Subsequent growth of a
 * live cluster is the worker's `event_count` increment, not a new case here.
 *
 * Returned clusters are ordered by `windowEnd` ascending (detection order).
 */
export function detectOutbreakClusters(
  events: readonly NormalizedSurveillanceEvent[],
): DetectedOutbreakCluster[] {
  // Group by the (providerEntity, pathogen, bodySite) cluster key.
  const groups = new Map<string, NormalizedSurveillanceEvent[]>();
  for (const event of events) {
    const bucket = groups.get(event.clusterKey);
    if (bucket === undefined) {
      groups.set(event.clusterKey, [event]);
    } else {
      bucket.push(event);
    }
  }

  const detected: DetectedOutbreakCluster[] = [];

  for (const bucket of groups.values()) {
    if (bucket.length < OUTBREAK_MIN_EVENTS) {
      continue; // cannot reach the threshold — skip without sorting.
    }
    // Ascending by observation instant (stable on ties — order within a tie does not affect the window).
    const ordered = [...bucket].sort((a, b) => a.observedAtMs - b.observedAtMs);

    let left = 0;
    for (let right = 0; right < ordered.length; right++) {
      const head = ordered[right];
      if (head === undefined) {
        continue; // unreachable under noUncheckedIndexedAccess — keeps the index access total.
      }
      // Shrink the window from the left until it spans ≤ 14 days.
      while (ordered[left] !== undefined && head.observedAtMs - ordered[left]!.observedAtMs > OUTBREAK_WINDOW_MS) {
        left++;
      }
      const windowCount = right - left + 1;
      if (windowCount >= OUTBREAK_MIN_EVENTS) {
        const start = ordered[left];
        if (start !== undefined) {
          detected.push({
            organizationId: head.organizationId,
            providerEntityId: head.providerEntityId,
            pathogen: head.pathogen,
            bodySite: head.bodySite,
            windowStart: start.observedAt,
            windowEnd: head.observedAt,
            triggeringEventCount: windowCount,
            status: "open",
          });
        }
        break; // one case per cluster — the worker grows it from here.
      }
    }
  }

  detected.sort((a, b) => a.windowEnd.getTime() - b.windowEnd.getTime());
  return detected;
}

/**
 * Shape a detected cluster into the FROZEN `infection_outbreak_case` insert (V-18). Server-only fields
 * (`id`, timestamps) default in the DB; the worker (a LATER phase) applies this then relies on
 * `uq_outbreak_window` for idempotency.
 */
export function toNewOutbreakCase(
  cluster: DetectedOutbreakCluster,
): schema.NewInfectionOutbreakCase {
  return {
    organizationId: cluster.organizationId,
    providerEntityId: cluster.providerEntityId,
    pathogen: cluster.pathogen,
    bodySite: cluster.bodySite,
    windowStart: cluster.windowStart,
    windowEnd: cluster.windowEnd,
    triggeringEventCount: cluster.triggeringEventCount,
    status: cluster.status,
  };
}
