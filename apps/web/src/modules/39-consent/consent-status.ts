// apps/web/src/modules/39-consent — shared status presentation for the M39 Consent surfaces
// (§6.6). Every M39 screen resolves a wire enum through these maps so the badge taxonomy is applied ONCE
// (the M25 `remittance-status.ts` / M23 `billing-status.ts` precedent).
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/active · warning≈needs-attention/expiring ·
// error≈revoked/failed · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";

/** consent_record.status → §6.6 tone. `revoked` is an ERROR tone, not neutral: a revoked consent is an
 *  active prohibition on disclosure, not merely an inert record. */
export const CONSENT_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  active: "success",
  superseded: "neutral",
  revoked: "error",
  expired: "warning",
};

/** consent_dpoa_activation_condition → tone. `immediate` is live authority; the rest are conditional. */
export const DPOA_ACTIVATION_TONE: Record<string, StatusTone> = {
  immediate: "success",
  upon_incapacity_attested: "progress",
  upon_physician_determination: "progress",
  upon_incompetence_court_order: "progress",
};

/** consent_dpoa_agent_kind → tone. The primary is the one that decides; alternates are standby. */
export const DPOA_AGENT_KIND_TONE: Record<string, StatusTone> = {
  primary: "success",
  alternate_1: "neutral",
  alternate_2: "neutral",
};

/** Recipient/agent activeness → tone. Derived server-side, never recomputed in the browser. */
export const ACTIVE_TONE: Record<string, StatusTone> = {
  active: "success",
  removed: "neutral",
};

/**
 * Expiry urgency → tone, from the server's `daysUntilExpiry`. The bands mirror the §2.4 D9 platform
 * reminder cadence (90 / 30 / 14 / 7 / 1 days) so the screen and the reminder worker agree on what
 * "urgent" means — a screen that reddened on a different schedule than the reminders would train staff
 * to distrust one of them.
 */
export function expiryTone(daysUntilExpiry: number): StatusTone {
  if (daysUntilExpiry <= 7) return "error";
  if (daysUntilExpiry <= 30) return "warning";
  return "progress";
}

/** The urgency band label the KPI strip groups by (same D9 cadence as {@link expiryTone}). */
export function expiryBand(daysUntilExpiry: number): "≤7 days" | "8–30 days" | "31–90 days" {
  if (daysUntilExpiry <= 7) return "≤7 days";
  if (daysUntilExpiry <= 30) return "8–30 days";
  return "31–90 days";
}

/** Resolve a tone map entry, defaulting to neutral for a value the map has not seen. */
export function toneOf(map: Record<string, StatusTone>, value?: string | null): StatusTone {
  return (value ? map[value] : undefined) ?? "neutral";
}

/** `hipaa_release` → "Hipaa release". Wire enums are snake_case; the UI is not. */
export function humanize(value?: string | null): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Turn a failed read into a message that does not assert a cause it cannot know. See the M30
 * `quality-status.ts` twin — copy that guesses "you may lack <permission>" for every failure points the
 * reader at the wrong fix when the real cause is a 422 or a 500.
 */
export function readErrorMessage(status: number | undefined, permission: string): string {
  if (status === 403) return `Not permitted — this view needs ${permission}.`;
  if (status === 401) return "Session expired — sign in again.";
  if (status === 422) return "The server rejected this request as malformed (422).";
  if (status && status >= 500) return `The server failed to answer (${status}).`;
  return status ? `Unavailable (HTTP ${status}).` : "Unavailable — the server could not be reached.";
}
