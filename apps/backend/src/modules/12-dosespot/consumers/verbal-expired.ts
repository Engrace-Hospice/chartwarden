// apps/backend/src/modules/12-dosespot/consumers/verbal-expired.ts — the M11 verbal-expiry backref consumer
// (M12-T08, spec §4.5 / §2.3 D3). PHASE-1 PURE DECISION CORE.
//
// M11 owns the single verbal 48h timer (D3 — M12 ships NO parallel timer). When a verbal medication order
// passes its deadline unsigned, M11's timer emits `m11.order.verbal_expired_unsigned` with
// `target_kind='medication_order'`. M12 subscribes: flip the M12 row to `expired_unsigned` (via the machine's
// `expire` event), emit `m12.medication_order.list_changed`, and raise the M36 high-severity alert. The
// consumed event name is a STRING literal only (no M11 schema import); M12 reads M11 solely through the
// foundation outbox (M11 is already in M12's dependsOn for the seam, but this consumer adds no schema edge).
import type { MedicationOrderStatus } from "@chartwarden/types";

/** The `m11.order.verbal_expired_unsigned` payload subset M12 reads (only the medication-order target). */
export interface VerbalExpiredPayload {
  readonly orderId: string;
  readonly organizationId: string;
  /** M11's discriminator — M12 only acts on `medication_order` targets. */
  readonly targetKind: string;
  readonly expiredAt: string;
}

/** The M12 row's current status the worker reads before deciding (only `verbal_pending` is expirable). */
export interface VerbalExpiredFacts {
  readonly status: MedicationOrderStatus;
  readonly patientId: string;
}

/** The effect descriptor the worker executes (flip via the machine + list refresh + alert), or a skip. */
export type VerbalExpiredAction =
  | { readonly kind: "skip"; readonly reason: "not_medication_order" | "not_verbal_pending" }
  | {
      readonly kind: "expire";
      readonly orderId: string;
      readonly patientId: string;
      readonly emitListChanged: true;
      readonly alert: "medication_order.verbal_expired_unsigned";
    };

/**
 * Decide the M12 reaction to an `m11.order.verbal_expired_unsigned` delivery (pure). Only a `medication_order`
 * target still in `verbal_pending` is expired; anything else is a no-op skip (idempotent on redelivery — a
 * row already flipped to `expired_unsigned` reads as not-verbal_pending).
 */
export function decideVerbalExpiry(
  payload: VerbalExpiredPayload,
  facts: VerbalExpiredFacts,
): VerbalExpiredAction {
  if (payload.targetKind !== "medication_order")
    return { kind: "skip", reason: "not_medication_order" };
  if (facts.status !== "verbal_pending") return { kind: "skip", reason: "not_verbal_pending" };
  return {
    kind: "expire",
    orderId: payload.orderId,
    patientId: facts.patientId,
    emitListChanged: true,
    alert: "medication_order.verbal_expired_unsigned",
  };
}
