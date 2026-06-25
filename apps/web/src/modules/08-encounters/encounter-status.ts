// apps/web/src/modules/08-encounters — shared encounter presentation helpers (R1, Lantern).
// The encounter / late-entry / cosignature enums each map to the §6.6 badge taxonomy tone so every M8
// surface (cosignature queue, encounter read, my-drafts) renders the same StatusPill for a state.
import type { StatusTone } from "@wardenx/ui";

// EncounterStatus (§2.3: draft → finalized → {signed | cosign_pending → cosigned} → voided) → tone.
export const ENCOUNTER_TONE: Record<string, StatusTone> = {
  draft: "progress",
  finalized: "progress",
  signed: "success",
  cosign_pending: "warning",
  cosigned: "success",
  voided: "neutral",
};

// CosignatureStatus (§2.4 D3 request lifecycle) → tone.
export const COSIGN_TONE: Record<string, StatusTone> = {
  pending: "progress",
  routed: "progress",
  acknowledged: "progress",
  escalated: "warning",
  hard_cap_reached: "error",
  supervisor_released: "neutral",
  signed: "success",
};

// LateEntryTier (§2.5 D4) → tone. `normal` is calm; the escalating tiers warn/alert.
export function lateEntryTone(tier: string): StatusTone {
  switch (tier) {
    case "late_entry":
      return "warning";
    case "significant_late_entry":
    case "administrative_override":
      return "error";
    default: // normal
      return "neutral";
  }
}

// §5.5 cosignature SLA: a 48h hard cap measured from the primary signature. The Lantern CountdownChip
// counts DOWN to this cap (warning ≤36h left ≈ ≥12h elapsed, alert ≤24h left ≈ ≥24h elapsed, error past).
export const COSIGN_HARD_CAP_HOURS = 48;
export function cosignDueAt(signedAt: string): Date {
  return new Date(new Date(signedAt).getTime() + COSIGN_HARD_CAP_HOURS * 3_600_000);
}
export function cosignOverdue(signedAt: string | null): boolean {
  return signedAt ? Date.now() > cosignDueAt(signedAt).getTime() : false;
}

/** Title-case an underscore enum value, e.g. `cosign_pending` → `Cosign Pending`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
