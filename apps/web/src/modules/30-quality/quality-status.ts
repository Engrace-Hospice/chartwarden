// apps/web/src/modules/30-quality — shared status presentation for the M30 HQRP & Quality surfaces
// (§6.6). Every M30 screen resolves a wire enum through these maps so the badge taxonomy is applied ONCE
// (the M25 `remittance-status.ts` / M39 `consent-status.ts` precedent).
//
// Lantern six-tone alphabet: progress≈in-flight · success≈meets target · warning≈at-risk · error≈breach ·
// critical(gold)≈reserved irreversible ceremony · neutral≈inert/insufficient data.
import type { StatusTone } from "@wardenx/ui";

/**
 * `MeasureBandColor` → tone. `insufficient_n` maps to NEUTRAL, and that is the whole point: a measure
 * suppressed under the CMS reportable-denominator floor has no verdict, and colouring it green (or red)
 * would assert one the data does not support. It reads as "no verdict", never as "passing".
 */
export const MEASURE_BAND_TONE: Record<string, StatusTone> = {
  green: "success",
  amber: "warning",
  red: "error",
  insufficient_n: "neutral",
};

/** CoP compliance status → tone. A deficiency is an ERROR: 418.310 makes it terminable. */
export const COP_STATUS_TONE: Record<string, StatusTone> = {
  compliant: "success",
  at_risk: "warning",
  deficient: "error",
  not_assessed: "neutral",
};

/** Incident state → tone. `reported` is untriaged work; `closed` is terminal/inert. */
export const INCIDENT_STATE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  reported: "warning",
  triaged: "progress",
  investigating: "progress",
  resolved: "success",
  closed: "neutral",
  reopened: "warning",
};

/** Incident severity → tone. Severity is the triage signal, so it is deliberately louder than state. */
export const INCIDENT_SEVERITY_TONE: Record<string, StatusTone> = {
  minor: "neutral",
  moderate: "warning",
  major: "error",
  sentinel: "error",
};

/** QAPI project phase → tone (PDSA-ish lifecycle; `sustained` is the good terminal state). */
export const QAPI_PHASE_TONE: Record<string, StatusTone> = {
  chartered: "neutral",
  measuring: "progress",
  intervening: "progress",
  evaluating: "progress",
  sustained: "success",
  abandoned: "neutral",
};

/** Measure domain → a short human label for the hub's grouping. */
export const DOMAIN_LABEL: Record<string, string> = {
  hci: "HCI",
  hvldl: "HVLDL",
  hope: "HOPE",
  cahps: "CAHPS",
  operational: "Operational",
};

export function toneOf(map: Record<string, StatusTone>, value?: string | null): StatusTone {
  return (value ? map[value] : undefined) ?? "neutral";
}

export function humanize(value?: string | null): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render a measure's rate for display. A suppressed measure shows an em dash, NOT "0%" — the two mean
 * opposite things (no reportable population vs. a real zero), and conflating them on a CMS-published
 * measure is the exact misreading the `insufficient_n` band exists to prevent.
 */
export function ratePct(rate: number | null, bandColor?: string): string {
  if (bandColor === "insufficient_n" || rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** `18 / 20` — the population behind the rate, always shown beside it. */
export function fraction(numerator: number, denominator: number): string {
  return `${numerator} / ${denominator}`;
}
