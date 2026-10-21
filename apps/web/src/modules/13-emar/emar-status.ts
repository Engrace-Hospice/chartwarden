// apps/web/src/modules/13-emar — shared eMAR presentation helpers (R1, Lantern).
// The §2.2 administration, §2.3 scheduled-dose, §2.5 late-entry, §2.8 reconciliation, and §2.7 comfort-kit
// enums each map to the §6.6 badge taxonomy tone (grounded in the @chartwarden/types unions). Controlled
// substances keep the gold `critical` treatment (DESIGN.md §10), consistent with M12.
import type { StatusTone } from "@chartwarden/ui";

// AdministrationStatus = committed | pending_caregiver_review | superseded | voided.
export const ADMIN_STATUS_TONE: Record<string, StatusTone> = {
  committed: "success",
  pending_caregiver_review: "warning",
  superseded: "neutral",
  voided: "neutral",
};

// ScheduledDoseStatus = pending | administered | missed | cancelled | intentionally_held.
export const DOSE_TONE: Record<string, StatusTone> = {
  pending: "progress",
  administered: "success",
  missed: "error",
  cancelled: "neutral",
  intentionally_held: "warning",
};

// ReconciliationDecisionKind = carry_forward | discontinue | hold | new_order | document_only.
export const DECISION_TONE: Record<string, StatusTone> = {
  carry_forward: "success",
  new_order: "progress",
  hold: "warning",
  discontinue: "error",
  document_only: "neutral",
};

// ReconciliationWorksheetStatus = pending | in_progress | finalized | voided.
export const WORKSHEET_TONE: Record<string, StatusTone> = {
  pending: "progress",
  in_progress: "progress",
  finalized: "success",
  voided: "neutral",
};

// ComfortKitDisposalStatus = deployed | return_required | returned | disposed_unreturned.
export const DISPOSAL_TONE: Record<string, StatusTone> = {
  deployed: "progress",
  return_required: "warning",
  returned: "success",
  disposed_unreturned: "error",
};

// AdministrationLateEntryTier = normal | late | significant_late | administrative_override.
export function lateEntryTone(tier: string): StatusTone {
  switch (tier) {
    case "late":
      return "warning";
    case "significant_late":
    case "administrative_override":
      return "error";
    default: // normal
      return "neutral";
  }
}

/** Title-case an underscore enum value, e.g. `pending_caregiver_review` → `Pending Caregiver Review`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
