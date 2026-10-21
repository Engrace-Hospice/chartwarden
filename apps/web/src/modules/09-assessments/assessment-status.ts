// apps/web/src/modules/09-assessments — shared assessment presentation helpers (R1, Lantern).
// The assessment / significant-change / scale-license enums each map to the §6.6 badge taxonomy tone
// (grounded in the @chartwarden/types unions) so every M9 surface renders the same StatusPill for a state.
import type { StatusTone } from "@chartwarden/ui";

// AssessmentStatus = "active" | "superseded" (§ correction-supersede).
export const ASSESSMENT_TONE: Record<string, StatusTone> = {
  active: "success",
  superseded: "neutral",
};

// SignificantChangeStatus = "open" | "acknowledged" | "escalated".
export const CHANGE_TONE: Record<string, StatusTone> = {
  open: "warning",
  acknowledged: "neutral",
  escalated: "error",
};

// AssessmentAlertSeverity = "clinical_urgent" | "high" | "medium".
export const SEVERITY_TONE: Record<string, StatusTone> = {
  clinical_urgent: "error",
  high: "error",
  medium: "warning",
};

// ScaleLicenseStatus = "active" | "pending_renewal" | "expired".
export const LICENSE_TONE: Record<string, StatusTone> = {
  active: "success",
  pending_renewal: "warning",
  expired: "error",
};

/** Title-case an underscore enum value, e.g. `pending_renewal` → `Pending Renewal`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
