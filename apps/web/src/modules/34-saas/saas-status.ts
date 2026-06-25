// apps/web/src/modules/34-saas — shared status presentation for the M34 platform-ops surfaces (R1).
// Every M34 screen renders the same StatusPill for a given status by resolving it through these tone
// maps, so the §6.6 badge taxonomy is applied once. The eleven-state tenant lifecycle palette is the
// spec §5.2 "Status pill colors" mapping (Card 1 — Lifecycle):
//   signup_intent (gray) · provisioning (yellow-striped) · onboarding (yellow) · active (green) ·
//   suspended (orange) · at_risk (orange-striped) · offboarding_initiated (red) ·
//   final_export_pending (red) · retained (purple) · destruction_pending (purple-striped) ·
//   destroyed (black).
// Lantern maps those design colors onto the StatusTone vocabulary: progress(primary)≈yellow-striped
// "in flight", success≈green, warning≈orange "needs attention", error≈red "irreversible underway",
// neutral≈gray/black "inert", critical≈the §10 gold reserved for controlled/irreversible acts. The
// cryptographic shred (tenant.shred.execute) is critical — it pairs this tone with a Guardrail
// confirm-by-typing ceremony (§5.3); destruction_pending warns that the irreversible window is open.
import type { StatusTone } from "@wardenx/ui";

/** §5.2 eleven-state tenant lifecycle → §6.6 tone. */
export const LIFECYCLE_TONE: Record<string, StatusTone> = {
  signup_intent: "neutral", // gray — not yet a tenant
  provisioning: "progress", // yellow-striped — in flight
  onboarding: "progress", // yellow — in flight
  active: "success", // green
  suspended: "warning", // orange — needs attention
  at_risk: "warning", // orange-striped — needs attention
  offboarding_initiated: "error", // red — irreversible path opened
  final_export_pending: "error", // red — irreversible path, export gating
  retained: "neutral", // purple — inert hold
  destruction_pending: "warning", // purple-striped — irreversible window open
  destroyed: "neutral", // black — terminal, inert
};

/** Support-session lifecycle → tone. Active consented PHI access is a controlled (gold) state. */
export const SUPPORT_SESSION_TONE: Record<string, StatusTone> = {
  pending: "progress",
  active: "critical", // consented break-glass variant — controlled, ambient-alert banner
  expired: "neutral",
  closed: "neutral",
  revoked: "error",
};

/** DSAR export job status → tone (§4.4 — §164.524 30-day SLA; aging surfaces on the CountdownChip).
 * Values mirror the backend `DSAR_STATUS` enum (tenant-typebox): the one-time §164.524 extension is
 * `extended` (warning — the SLA window is being consumed); `denied` is a permitted-denial terminal. */
export const DSAR_TONE: Record<string, StatusTone> = {
  requested: "progress",
  generating: "progress",
  review_pending: "progress",
  fulfilled: "success",
  denied: "error",
  extended: "warning",
};

/** Tenant export job status → tone (§3.8 NDJSON archive; 24h single-download URL).
 * Values mirror the backend `TENANT_EXPORT_STATUS` enum (tenant-typebox). */
export const TENANT_EXPORT_TONE: Record<string, StatusTone> = {
  requested: "progress",
  generating: "progress",
  fulfilled: "success",
  expired: "neutral",
  cancelled: "neutral",
};

/** Onboarding task status → tone (§2.3 eleven-step machine; blocked/overdue need attention). */
export const ONBOARDING_TASK_TONE: Record<string, StatusTone> = {
  pending: "neutral",
  in_progress: "progress",
  blocked: "warning",
  overdue: "error",
  completed: "success",
  skipped: "neutral",
};

/** Platform-tenant BAA record status → tone (§3.9 register; expiring/expired need attention). */
export const BAA_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  pending_attestation: "progress",
  active: "success",
  expiring: "warning",
  expired: "error",
  superseded: "neutral",
};

/**
 * Platform-tenant BAA register status → tone, keyed on the LIVE wire enum the
 * `/api/v1/platform/baa-register` route serves (platform-typebox `BAA_STATUS`):
 * `executed | pending | terminated | missing`. `missing` is the gap the register exists to surface,
 * so it reads as an error; `terminated` is inert (neutral). Distinct from `BAA_TONE` above, which is
 * the §3.9 attestation-lifecycle vocabulary used on the tenant-facing surface.
 */
export const PLATFORM_BAA_TONE: Record<string, StatusTone> = {
  executed: "success",
  pending: "progress",
  terminated: "neutral",
  missing: "error",
};

/**
 * Feature-flag kind → tone (§4.7 admin surface). `kill_switch` is the controlled/irreversible-leaning
 * emergency lever — it reads `critical` (the §10 gold) so the row carrying a live kill-switch is
 * visually distinguished from ordinary product/rollout/migration flags.
 */
export const FLAG_KIND_TONE: Record<string, StatusTone> = {
  product: "neutral",
  rollout: "progress",
  kill_switch: "critical",
  migration: "warning",
};

/** Tenant signup-intent status → tone (Phase-3 §3.11; qualify/convert pipeline). */
export const SIGNUP_TONE: Record<string, StatusTone> = {
  new: "progress",
  qualifying: "progress",
  qualified: "success",
  converted: "success",
  rejected: "error",
  expired: "neutral",
};

/** Tenant invitation status → tone (§3.4 platform → first-admin invite chain, distinct from M2). */
export const INVITATION_TONE: Record<string, StatusTone> = {
  pending: "progress",
  accepted: "success",
  expired: "neutral",
  revoked: "error",
};

/** Tenant key-ring status → tone (§3.5 DEK lifecycle; destroyed is terminal, rotate is in-flight). */
export const KEY_RING_TONE: Record<string, StatusTone> = {
  active: "success",
  rotating: "progress",
  rotation_pending: "warning",
  destruction_pending: "warning",
  destroyed: "neutral", // DEK destroyed — no actions (§5.2 Card 3)
};

/** Title-case an underscore enum value, e.g. `at_risk` → `At Risk`. */
export function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Title-case helper for any word/phrase (`final_export_pending` → `Final Export Pending`). */
export const cap = (s: string): string => statusLabel(s);

/** Resolve a tenant-lifecycle status to its tone, defaulting to neutral for unknown values. */
export function lifecycleTone(status: string): StatusTone {
  return LIFECYCLE_TONE[status] ?? "neutral";
}
