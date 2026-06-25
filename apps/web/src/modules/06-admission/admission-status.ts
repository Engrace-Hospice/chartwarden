// apps/web/src/modules/06-admission — shared admission-domain status presentation helpers (R1, Lantern).
// The admission, referral, and compliance-window state enums each map to the §6.6 badge taxonomy tone
// so every M6 surface renders the same StatusPill for a given state.
import type { StatusTone } from "@wardenx/ui";

// Admission lifecycle (M6 §5.2) → tone.
export const ADMISSION_TONE: Record<string, StatusTone> = {
  pending: "progress",
  active: "success",
  on_hold: "warning",
  discharged: "neutral",
  bereavement: "neutral",
};

// Referral lifecycle (M6 §5.2.1) → tone.
export const REFERRAL_TONE: Record<string, StatusTone> = {
  received: "progress",
  triaged: "progress",
  accepted: "success",
  declined: "error",
  ineligible: "error",
  withdrawn: "neutral",
};

// Compliance-window state (M6 §5.2.11) → tone. Overdue is a deadline breach → error.
export const WINDOW_TONE: Record<string, StatusTone> = {
  open: "progress",
  overdue: "error",
  closed: "neutral",
};

/** Title-case an underscore enum value, e.g. `on_hold` → `On Hold`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
