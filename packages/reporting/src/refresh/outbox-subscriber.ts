// @wardenx/reporting · refresh — the INCREMENTAL tier: the outbox-subscriber (M33 §4.5 / §2.6 / D15).
//
// The reactive half of the three-tier strategy. It subscribes to the ~60 upstream topics in the §4.5
// OUTBOX_SUBSCRIPTION_MAP; each delivered event projects to its `mv_keys_invalidated[]`, and the subscriber
// dispatches one debounced `report.mv_refresh` job per invalidated MV (`trigger_kind='incremental_outbox'`,
// `trigger_outbox_event_id` set). The per-MV debounce + the BullMQ idempotency jobId (both in the dispatcher)
// collapse a burst within each MV's `debounce_window_seconds` into one refresh — so a redelivered upstream
// event does NOT re-refresh within the window (the §2.6 idempotency guarantee).
//
// PURE: {@link plannedMvKeysForEvent} is the pure topic→MV projection; {@link handleUpstreamInvalidation} is
// the thin port-injected orchestrator that fans each MV out through the shared dispatcher. The cross-module
// reach is the foundation outbox event STRING alone — no M5–M28 import (no new manifest `dependsOn` edge).
import { OUTBOX_INVALIDATING_TOPICS, mvKeysForTopic } from "../catalog/outbox-subscription-map";
import {
  type MvRefreshDispatcherPorts,
  type RefreshDispatchResult,
  dispatchMvRefresh,
} from "./dispatcher";

/** The structural minimum the subscriber reads off a delivered upstream outbox event (the owning module owns
 *  the canonical superset). `organizationId` rides onto the refresh job; `eventId` becomes the
 *  `report_run.trigger_outbox_event_id` provenance link. */
export interface UpstreamOutboxEvent {
  /** The outbox event id (→ `report_run.trigger_outbox_event_id`). */
  readonly eventId: string;
  /** The topic string keyed in the §4.5 map (`mN.<entity>.<event>` / the bare `idg.decision_recorded`). */
  readonly eventName: string;
  /** The org the event was emitted in; null for a platform-wide upstream event (rare). */
  readonly organizationId: string | null;
}

/**
 * The pure topic→MV projection (§4.5). Returns the `mv_key`s a delivered topic invalidates — an empty list
 * for an unknown topic OR a nightly-covered `[]` topic, in which case the subscriber enqueues nothing. This
 * is the function the §4.5 `outbox.subscription-fanout.test.ts` asserts against the documented catalog.
 */
export function plannedMvKeysForEvent(eventName: string): readonly string[] {
  return mvKeysForTopic(eventName);
}

/** The per-event fan-out report: the dispatch result for each invalidated MV (or an empty list = no-op). */
export interface IncrementalDispatchReport {
  readonly eventName: string;
  readonly mvKeys: readonly string[];
  readonly dispatches: readonly RefreshDispatchResult[];
}

/**
 * Handle one delivered upstream outbox event (the incremental tier's consumer body, §4.5). Projects the topic
 * to its `mv_keys_invalidated[]` and dispatches a debounced `report.mv_refresh` job per MV through the shared
 * {@link dispatchMvRefresh} (which applies the strategy guard + the §2.6 debounce/idempotency). Unknown and
 * nightly-covered topics fan out to nothing — a deliberate no-op, never an error (M33 tolerates upstream
 * emitting events it does not map). Idempotency rides the M1 outbox-consumer rail `(eventId, consumerName)`
 * plus the dispatcher's debounce floor; a redelivery collapses onto the same in-flight job.
 */
export async function handleUpstreamInvalidation(
  event: UpstreamOutboxEvent,
  ports: MvRefreshDispatcherPorts,
): Promise<IncrementalDispatchReport> {
  const mvKeys = plannedMvKeysForEvent(event.eventName);
  const dispatches: RefreshDispatchResult[] = [];
  for (const mvKey of mvKeys) {
    dispatches.push(
      await dispatchMvRefresh(
        {
          mvKey,
          triggerKind: "incremental_outbox",
          organizationId: event.organizationId,
          triggerOutboxEventId: event.eventId,
        },
        ports,
      ),
    );
  }
  return { eventName: event.eventName, mvKeys, dispatches };
}

// ── forward-declared subscription bindings (the boot dispatcher wires these; P2C binds the live rail) ─────

/** The shared consumer name every incremental-invalidation binding registers under. Consumer dedup is keyed
 *  `(eventId, consumerName)` per the M1 outbox-consumer pattern (the M22/M34 `consumerName` precedent). */
export const M33_MV_REFRESH_CONSUMER_NAME = "m33.mv-refresh-invalidator" as const;

/** One forward-declared `{ eventName, consumerName }` binding (the M22 `bindings.ts` / M34 subscription
 *  shape) the boot dispatcher wires once the live transactional-outbox dispatcher accessor lands (P2C). */
export interface MvRefreshSubscription {
  readonly eventName: string;
  readonly consumerName: typeof M33_MV_REFRESH_CONSUMER_NAME;
}

/** Every §4.5 topic that actually triggers an incremental refresh (the non-empty rows), forward-declared as a
 *  consumer binding. The `[]` nightly-covered topics need no binding (the nightly tier owns those MVs). */
export const M33_MV_REFRESH_SUBSCRIPTIONS: readonly MvRefreshSubscription[] =
  OUTBOX_INVALIDATING_TOPICS.map((eventName) => ({
    eventName,
    consumerName: M33_MV_REFRESH_CONSUMER_NAME,
  }));

/** DEFERRED until the live transactional-outbox dispatcher accessor exists in bootstrap (P2C). Mirrors the
 *  M22 `*_DEFERRED` flag: P2B authors the pure consumer + declares the bindings; P2C binds the dispatcher. */
export const M33_MV_REFRESH_SUBSCRIPTIONS_DEFERRED = true as const;
