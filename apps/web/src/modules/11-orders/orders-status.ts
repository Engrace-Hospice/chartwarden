// apps/web/src/modules/11-orders — shared order presentation helpers (R1, Lantern).
// The order / priority / standing-order / transmission / results / cosign enums each map to the §6.6
// badge taxonomy tone (grounded in the @wardenx/types unions) so every M11 surface renders the same
// StatusPill for a state.
import type { StatusTone } from "@wardenx/ui";

// OrderStatus = draft | pending_signature | verbal_pending | active | completed | discontinued | expired_unsigned.
export const ORDER_TONE: Record<string, StatusTone> = {
  draft: "progress",
  pending_signature: "warning",
  verbal_pending: "warning",
  active: "success",
  completed: "neutral",
  discontinued: "neutral",
  expired_unsigned: "error",
};

// OrderPriority = routine | stat | asap.
export const PRIORITY_TONE: Record<string, StatusTone> = {
  routine: "neutral",
  asap: "warning",
  stat: "error",
};

// StandingOrderStatus = active | paused | expired | discontinued.
export const STANDING_TONE: Record<string, StatusTone> = {
  active: "success",
  paused: "warning",
  expired: "neutral",
  discontinued: "neutral",
};

// OrderTransmissionStatus = not_required | pending | pending_retry | transmitted | failed.
export const TRANSMISSION_TONE: Record<string, StatusTone> = {
  not_required: "neutral",
  pending: "progress",
  pending_retry: "warning",
  transmitted: "success",
  failed: "error",
};

// OrderResultsStatus = not_expected | awaiting_results | partial_results_received | results_received | results_overdue.
export const RESULTS_TONE: Record<string, StatusTone> = {
  not_expected: "neutral",
  awaiting_results: "progress",
  partial_results_received: "progress",
  results_received: "success",
  results_overdue: "error",
};

// The §2.5 order cosignature posture (inline "pending" | "attached" | null).
export const COSIGN_TONE: Record<string, StatusTone> = {
  pending: "warning",
  attached: "success",
};

/** Title-case an underscore enum value, e.g. `verbal_pending` → `Verbal Pending`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
