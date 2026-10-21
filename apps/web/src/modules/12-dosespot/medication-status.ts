// apps/web/src/modules/12-dosespot — shared medication/prescribing presentation helpers (R1, Lantern).
// The §2.2 medication-order (14-state), transmission, refill, IAL2, and EPCS-certification enums each map
// to the §6.6 badge taxonomy tone (grounded in the @chartwarden/types unions). Controlled-substance / EPCS is
// the ONE place the gold `critical` tone is used (DESIGN.md §10 — gold is reserved for controlled-substance).
import type { StatusTone } from "@chartwarden/ui";

// MedicationOrderStatus — the §2.2 D2 14-state lifecycle.
export const MED_ORDER_TONE: Record<string, StatusTone> = {
  draft: "progress",
  pending_signature: "warning",
  verbal_pending: "warning",
  epcs_identity_pending: "warning",
  signed: "progress",
  queued_for_transmission: "progress",
  transmitted: "progress",
  ack_received: "success",
  nack_received: "error",
  active: "success",
  completed: "neutral",
  discontinued: "neutral",
  transmission_failed: "error",
  expired_unsigned: "error",
};

// DoseSpotSendState — the §4.10 NewRx-transmission observed state.
export const SEND_TONE: Record<string, StatusTone> = {
  not_required: "neutral",
  queued: "progress",
  in_flight: "progress",
  transmitted: "progress",
  acked: "success",
  nacked: "error",
  failed: "error",
};

// RefillRequestStatus = pending | approved | denied | expired.
export const REFILL_TONE: Record<string, StatusTone> = {
  pending: "warning",
  approved: "success",
  denied: "error",
  expired: "neutral",
};

// Ial2Status = not_started | in_progress | verified | expired | revoked.
export const IAL2_TONE: Record<string, StatusTone> = {
  not_started: "neutral",
  in_progress: "progress",
  verified: "success",
  expired: "warning",
  revoked: "error",
};

// EpcsCertificationStatus = not_certified | audit_in_progress | certified | revoked.
export const EPCS_TONE: Record<string, StatusTone> = {
  not_certified: "neutral",
  audit_in_progress: "progress",
  certified: "success",
  revoked: "error",
};

/** A controlled-substance schedule label, e.g. `II` → `C-II`. */
export function controlledLabel(deaSchedule: string | null): string {
  return `C-${deaSchedule ?? "?"}`;
}

/** Title-case an underscore enum value, e.g. `pending_signature` → `Pending Signature`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
