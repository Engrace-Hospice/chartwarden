// apps/web/src/modules/30-quality — shared status presentation for the M30 HQRP & Quality surfaces
// (§6.6). Every M30 screen resolves a wire enum through these maps so the badge taxonomy is applied ONCE
// (the M25 `remittance-status.ts` / M39 `consent-status.ts` precedent).
//
// Lantern six-tone alphabet: progress≈in-flight · success≈meets target · warning≈at-risk · error≈breach ·
// critical(gold)≈reserved irreversible ceremony · neutral≈inert/insufficient data.
import type { StatusTone, paths } from "@wardenx/ui";

// ── the wire vocabularies, DERIVED ────────────────────────────────────────────────────────────
//
// These were hand-typed from the module SPEC and almost none of them matched the frozen pgEnums the
// server emits: the band was `amber` (server: `yellow`), incident states `reported`/`investigating`/
// `closed` (server: `submitted`/`under_investigation`/`closed_followup_complete`), severities
// `major`/`sentinel` (server: `severe`/`critical`), and every QAPI phase but `abandoned` was invented.
// `Record<string, StatusTone>` accepted all of it, so the maps compiled, the screens rendered, and
// every unmatched row silently fell through `toneOf`'s `?? "neutral"` — a StatusPill taxonomy that was
// mostly decoration. Deriving the keys from the generated client makes a wrong key a compile error and
// a MISSING key a compile error too, so a vocabulary that grows server-side cannot be ignored here.
type MeasureRow =
  paths["/api/v1/quality/measures"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type CitationRow =
  paths["/api/v1/quality/cop/citations"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type IncidentRow =
  paths["/api/v1/quality/incidents"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
type ProjectRow =
  paths["/api/v1/quality/qapi/projects"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

type MortalityRow =
  paths["/api/v1/quality/mortality"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

export type MortalityStatus = MortalityRow["status"];
export type MeasureBandColor = NonNullable<MeasureRow["latestValue"]>["bandColor"];
export type MeasureDomain = MeasureRow["domain"];
export type CopStatus = CitationRow["status"];
export type IncidentState = IncidentRow["state"];
export type IncidentSeverity = IncidentRow["severity"];
export type QapiProjectPhase = ProjectRow["phase"];

/**
 * `MeasureBandColor` → tone. `insufficient_n` maps to NEUTRAL, and that is the whole point: a measure
 * suppressed under the CMS reportable-denominator floor has no verdict, and colouring it green (or red)
 * would assert one the data does not support. It reads as "no verdict", never as "passing".
 */
export const MEASURE_BAND_TONE: Record<MeasureBandColor, StatusTone> = {
  green: "success",
  yellow: "warning",
  red: "error",
  insufficient_n: "neutral",
};

/** CoP compliance status → tone. A deficiency is an ERROR: 418.310 makes it terminable. */
export const COP_STATUS_TONE: Record<CopStatus, StatusTone> = {
  compliant: "success",
  at_risk: "warning",
  deficient: "error",
};

/** Incident state → tone. `submitted` is untriaged work; `closed_followup_complete` is terminal/inert. */
export const INCIDENT_STATE_TONE: Record<IncidentState, StatusTone> = {
  draft: "neutral",
  submitted: "warning",
  triaged: "progress",
  under_investigation: "progress",
  resolved: "success",
  closed_followup_complete: "neutral",
  reopened: "warning",
};

/** Incident severity → tone. Severity is the triage signal, so it is deliberately louder than state. */
export const INCIDENT_SEVERITY_TONE: Record<IncidentSeverity, StatusTone> = {
  minor: "neutral",
  moderate: "warning",
  severe: "error",
  critical: "error",
};

/** QAPI project phase → tone. `completed` is the good terminal state; `corrective_action` is a breach
 *  the programme is answering, so it reads louder than ordinary in-flight work. */
export const QAPI_PHASE_TONE: Record<QapiProjectPhase, StatusTone> = {
  proposed: "neutral",
  active: "progress",
  corrective_action: "warning",
  completed: "success",
  abandoned: "neutral",
};

/** Mortality-review status → tone. `created` is untouched work (warning), `completed` is terminal. */
export const MORTALITY_STATUS_TONE: Record<MortalityStatus, StatusTone> = {
  created: "warning",
  in_progress: "progress",
  completed: "success",
};

/** Measure domain → a short human label for the hub's grouping. */
export const DOMAIN_LABEL: Record<MeasureDomain, string> = {
  hci: "HCI",
  hvldl: "HVLDL",
  hope: "HOPE",
  cahps: "CAHPS",
  operational: "Operational",
};

/**
 * Resolve a wire value through a tone map, falling back to neutral.
 *
 * The maps are now keyed by the DERIVED vocabulary, so `value` is typed to that vocabulary at every
 * call site and the fallback should be unreachable. It stays because the value crosses the wire: a
 * server mid-deploy can emit a member this build does not know, and an unknown status must render
 * inert rather than throw. It is a runtime guard, no longer a silent absorber of authoring mistakes —
 * a wrong literal is now caught by tsc at the map.
 */
export function toneOf<K extends string>(map: Record<K, StatusTone>, value?: K | null): StatusTone {
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
export function ratePct(rate: number | null, bandColor?: MeasureBandColor): string {
  if (bandColor === "insufficient_n" || rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * The measure whose CMS value is a MEAN rather than a proportion: HCI indicator 8, skilled-nursing minutes
 * per routine-home-care day. Its numerator/denominator are SN minutes / RHC days, and its wire `rate` is that
 * mean rescaled to a share of the day (÷ 1440) so it fits the proportion contract — which would read as a
 * meaningless "1.0%". It is shown in CMS's own unit instead, from the exact numerator/denominator.
 */
const MINUTES_PER_DAY_MEASURES = new Set(["hci_indicator_08"]);

/** Render a measure value's rate: minutes per RHC day for HCI 8, a percentage for everything else. */
export function measureRate(
  measureId: string,
  value: {
    readonly rate: number | null;
    readonly bandColor?: MeasureBandColor;
    readonly numerator: number;
    readonly denominator: number;
  },
): string {
  if (MINUTES_PER_DAY_MEASURES.has(measureId)) {
    if (value.bandColor === "insufficient_n" || value.rate === null || value.denominator <= 0)
      return "—";
    return `${(value.numerator / value.denominator).toFixed(1)} min/day`;
  }
  return ratePct(value.rate, value.bandColor);
}

/** `18 / 20` — the population behind the rate, always shown beside it. */
export function fraction(numerator: number, denominator: number): string {
  return `${numerator} / ${denominator}`;
}

/**
 * Turn a failed read into a message that does not assert a cause it cannot know.
 *
 * The first cut of these screens said "you may lack <permission>" for ANY error, which sent me chasing a
 * permission grant when the real failure was a 422 (a query value outside the schema's bounds). Copy that
 * guesses wrong is worse than copy that says less: it points the reader at the wrong fix.
 */
export function readErrorMessage(status: number | undefined, permission: string): string {
  if (status === 403) return `Not permitted — this view needs ${permission}.`;
  if (status === 401) return "Session expired — sign in again.";
  if (status === 422) return "The server rejected this request as malformed (422).";
  if (status && status >= 500) return `The server failed to answer (${status}).`;
  return status
    ? `Unavailable (HTTP ${status}).`
    : "Unavailable — the server could not be reached.";
}
