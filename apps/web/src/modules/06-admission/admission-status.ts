// apps/web/src/modules/06-admission — shared admission-domain status presentation helpers (R1, Lantern).
// The admission, referral, and compliance-window state enums each map to the §6.6 badge taxonomy tone
// so every M6 surface renders the same StatusPill for a given state.
import type { StatusTone } from "@wardenx/ui";

// Admission lifecycle (M6 §5.2) → tone. Real DB enum (packages/db/src/schema/admission/admissions.ts):
// referred, pending, notice_of_rights_acknowledged, active, on_hold, discharged, bereavement, closed.
export const ADMISSION_TONE: Record<string, StatusTone> = {
  referred: "progress",
  pending: "progress",
  notice_of_rights_acknowledged: "progress",
  active: "success",
  on_hold: "warning",
  discharged: "neutral",
  bereavement: "neutral",
  closed: "neutral",
};

// Referral lifecycle (M6 §5.2.1) → tone. Real DB enum (packages/db/src/schema/admission/referrals.ts):
// received, evaluated, accepted, rejected, withdrawn, admitted — NOT the `triaged`/`declined`/
// `ineligible` vocabulary an earlier draft of this map used (TASK-031 fix: the in-memory reference
// service's naming leaked into this map and never matched the real Drizzle-backed status column, so
// this map's "triaged"/"declined"/"ineligible" entries were dead and the referral-inbox.tsx state
// filter could never select a referral past `received` in production).
export const REFERRAL_TONE: Record<string, StatusTone> = {
  received: "progress",
  evaluated: "progress",
  accepted: "success",
  rejected: "error",
  withdrawn: "neutral",
  admitted: "success",
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
