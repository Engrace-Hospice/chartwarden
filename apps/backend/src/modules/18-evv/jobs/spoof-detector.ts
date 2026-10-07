// apps/backend/src/modules/18-evv/jobs/spoof-detector.ts — the §4.8 / D9 `m18.gps-spoof-detector` worker
// (GAP-056): an outbox consumer of `m18.evv.check_in_recorded` + `m18.evv.check_out_recorded` that scores each new
// `evv_event` and, on a match, flags it `gps_quality = 'suspected_spoof'` and emits `m18.evv.gps_spoof_suspected`.
//
// ADVISORY, NEVER A BLOCK (D9): the event is already recorded and the visit proceeds; the flag routes a human
// review. A DLQ'd job leaves the event unflagged (the spec's accepted failure mode).
//
// SIGNALS IMPLEMENTED (a pure function, below):
//   • implausible_speed        — the distance from the same clinician's previous event divided by the elapsed time
//                                exceeds ground-travel speed (weight 2 — decisive on its own).
//   • implausibly_precise_gps  — device-reported accuracy under 1 m (not credible for a phone GPS fix; weight 1).
//   • constant_accuracy_pattern— the last N events of the clinician all report the IDENTICAL accuracy (real fixes
//                                vary; weight 1).
// The flag threshold is 2, so speed alone flags and the two softer signals only flag together.
// NOT IMPLEMENTED: the spec's mock-location-API signal — `evv_event` does not persist the device's
// developer-mode/mock-location attestation flag (it lives on M2's `device_attestation`), so it is not readable
// here. When that fact is exposed it becomes one more weighted signal in this function.
//
// The `gps_quality` write relies on migration 0351, which permits ONLY the transition to 'suspected_spoof' on the
// otherwise append-only `evv_event` row. The overwritten value is not lost: the geofence verdict lives on
// `evv_geofence_evaluation` and the original capture facts (coords, accuracy, device) are untouched.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq, lte } from "drizzle-orm";
import { decodeStoredCoords } from "../coords";
import { type Coordinate, haversineMeters } from "../domain/geofence";
import type { EvvWriteOutboxPort } from "../evv-route-service-db";

const EVENT = schema.evvEvent;

/** ~100 mph — comfortably above any ground-travel speed between two captures. */
export const SPOOF_MAX_PLAUSIBLE_SPEED_MPS = 45;
export const SPOOF_MIN_PLAUSIBLE_ACCURACY_M = 1;
/** How many of a clinician's most recent events the accuracy-pattern signal inspects (the spec's "20 events"). */
export const SPOOF_ACCURACY_PATTERN_WINDOW = 20;
/** A pattern needs at least this many events to mean anything. */
export const SPOOF_ACCURACY_PATTERN_MIN_EVENTS = 5;
const SIGNAL_WEIGHTS = {
  implausible_speed: 2,
  implausibly_precise_gps: 1,
  constant_accuracy_pattern: 1,
} as const;
export const SPOOF_FLAG_THRESHOLD = 2;

export interface SpoofEventFacts {
  readonly capturedAt: Date;
  readonly coords: Coordinate | null;
  readonly accuracyM: number;
}

export interface SpoofVerdict {
  readonly signals: readonly (keyof typeof SIGNAL_WEIGHTS)[];
  readonly score: number;
  readonly flagged: boolean;
}

/** Pure D9 scorer. `recentAccuracies` is the clinician's most recent accuracies INCLUDING this event's. */
export function scoreSpoofSignals(input: {
  readonly event: SpoofEventFacts;
  readonly prior: SpoofEventFacts | null;
  readonly recentAccuracies: readonly number[];
}): SpoofVerdict {
  const signals: (keyof typeof SIGNAL_WEIGHTS)[] = [];
  const { event, prior, recentAccuracies } = input;

  if (prior?.coords && event.coords) {
    const seconds = (event.capturedAt.getTime() - prior.capturedAt.getTime()) / 1000;
    const meters = haversineMeters(prior.coords, event.coords);
    // A zero/negative interval with real displacement is itself impossible; same-spot (0 m) never flags.
    const speed = seconds > 0 ? meters / seconds : meters > 0 ? Number.POSITIVE_INFINITY : 0;
    if (speed > SPOOF_MAX_PLAUSIBLE_SPEED_MPS) signals.push("implausible_speed");
  }
  if (event.accuracyM < SPOOF_MIN_PLAUSIBLE_ACCURACY_M) signals.push("implausibly_precise_gps");
  if (
    recentAccuracies.length >= SPOOF_ACCURACY_PATTERN_MIN_EVENTS &&
    new Set(recentAccuracies).size === 1
  ) {
    signals.push("constant_accuracy_pattern");
  }
  const score = signals.reduce((sum, s) => sum + SIGNAL_WEIGHTS[s], 0);
  return { signals, score, flagged: score >= SPOOF_FLAG_THRESHOLD };
}

export const M18_SPOOF_DETECTOR_CONSUMER = {
  eventNames: ["m18.evv.check_in_recorded", "m18.evv.check_out_recorded"],
  consumerName: "m18.gps-spoof-detector",
} as const;

export type SpoofDetectOutcome = "flagged" | "clean" | "already_flagged" | "event_not_found";

/** Score one event and flag it when the verdict crosses the threshold. Org-explicit; exported for the live suite. */
export async function detectSpoofForEvent(
  deps: { readonly db: DbClient; readonly outbox: EvvWriteOutboxPort },
  organizationId: string,
  eventId: string,
): Promise<SpoofDetectOutcome> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (raw) => {
    const tx = raw as DbClient;
    const [event] = await tx
      .select()
      .from(EVENT)
      .where(and(eq(EVENT.organizationId, organizationId), eq(EVENT.id, eventId)))
      .limit(1);
    if (!event) return "event_not_found";
    if (event.gpsQuality === "suspected_spoof") return "already_flagged";

    const history = await tx
      .select({
        id: EVENT.id,
        capturedAt: EVENT.capturedAt,
        coordsCipher: EVENT.coordsCipher,
        accuracyM: EVENT.accuracyM,
      })
      .from(EVENT)
      .where(
        and(
          eq(EVENT.organizationId, organizationId),
          eq(EVENT.postingMembershipId, event.postingMembershipId),
          lte(EVENT.eventAt, event.eventAt),
        ),
      )
      .orderBy(desc(EVENT.eventAt))
      .limit(SPOOF_ACCURACY_PATTERN_WINDOW);
    const prior = history.find((h) => h.id !== event.id) ?? null;
    const verdict = scoreSpoofSignals({
      event: {
        capturedAt: event.capturedAt,
        coords: decodeStoredCoords(event.coordsCipher),
        accuracyM: event.accuracyM,
      },
      prior: prior && {
        capturedAt: prior.capturedAt,
        coords: decodeStoredCoords(prior.coordsCipher),
        accuracyM: prior.accuracyM,
      },
      recentAccuracies: history.map((h) => h.accuracyM),
    });
    if (!verdict.flagged) return "clean";

    const [flagged] = await tx
      .update(EVENT)
      .set({ gpsQuality: "suspected_spoof" })
      .where(and(eq(EVENT.id, event.id), eq(EVENT.eventAt, event.eventAt)))
      .returning({ id: EVENT.id });
    if (!flagged) return "event_not_found";
    await deps.outbox.publish(tx, {
      eventName: "m18.evv.gps_spoof_suspected",
      organizationId,
      aggregateKind: "evv_event",
      aggregateId: event.id,
      payload: {
        eventId: event.id,
        visitId: event.visitId,
        postingMembershipId: event.postingMembershipId,
        detectionSignals: [...verdict.signals],
      },
    });
    return "flagged";
  });
}

/** The live consumer. The tenant is `event.organizationId` (the envelope), never the payload. */
export function buildM18SpoofDetectorConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: EvvWriteOutboxPort;
}) {
  return {
    consumerName: M18_SPOOF_DETECTOR_CONSUMER.consumerName,
    consumerModule: "m18" as const,
    eventTypes: M18_SPOOF_DETECTOR_CONSUMER.eventNames,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const eventId = (event.payload as Record<string, unknown> | null)?.eventId;
      if (typeof eventId !== "string" || eventId.length === 0) {
        throw new Error(`${M18_SPOOF_DETECTOR_CONSUMER.consumerName}: payload has no eventId`);
      }
      await detectSpoofForEvent(deps, event.organizationId, eventId);
    },
  };
}
