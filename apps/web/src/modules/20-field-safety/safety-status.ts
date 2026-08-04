// apps/web/src/modules/20-field-safety — shared status presentation for the M20 Field Safety surfaces
// (Track B / ADR-0030, §5 / DESIGN.md §6.6). Every M20 screen renders the same StatusPill for a given wire
// enum through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M15 discipline-status.ts /
// M16 bereavement-status.ts / M19 oncall-status.ts precedent — each web slice owns its own, because
// apps/web/src/modules/* may not import a sibling module).
//
// Every key below is a value from the FROZEN union in `packages/types/src/safety.ts` (M20-T01), which
// itself mirrors the `packages/db/src/enums.ts` pgEnums and the §3.3 CHECK vocabularies. The DB wins on
// conflict. A wire value a map does not carry falls through to `neutral` rather than throwing — but on a
// SAFETY board `neutral` renders as "inert/terminal", so a missing key is how a live alert comes to look
// like a closed one. Each map is therefore asserted COMPLETE in safety-status.test.ts, not sampled.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/complete · warning≈needs-attention ·
// error≈breached/failed · critical(gold)≈reserved irreversible/safety · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";
import type { SafetyConsentPurpose, SafetySubscriptionAlertKind } from "./safety-api";

/**
 * `safety_sos_lifecycle_state` (§2.2.2).
 *
 * `emergency_terminus` is `critical` AND is in {@link SOS_OPEN_STATES}: per M20-F05 it re-escalates on a
 * loop and exits only on acknowledgment, never on timeout. A grey terminal pill there would tell a
 * supervisor scanning the board that the 3 a.m. alert nobody answered had finished.
 *
 * `cancel_attempted_but_rejected` is `critical`, not neutral and emphatically not success: D5's rejected
 * cancel is the HOSTILE-ACTOR signal — the button was pressed, the biometric did not pass, and the alert
 * PROCEEDS. It is the one lifecycle value where a calm colour would actively mislead.
 *
 * `cancelled_in_window` is `neutral`: the clinician un-pressed her own button inside five seconds and
 * nothing happened. That is the only genuinely inert SOS state in the module.
 */
export const SOS_STATE_TONE: Record<string, StatusTone> = {
  raised: "critical",
  cancel_window_open: "warning",
  acknowledging: "progress",
  acknowledged: "progress",
  escalation_tier_1: "error",
  escalation_tier_2: "error",
  escalation_tier_3: "critical",
  emergency_terminus: "critical",
  resolving: "progress",
  resolved: "success",
  cancelled_in_window: "neutral",
  cancel_attempted_but_rejected: "critical",
  incident_opened: "warning",
};

/**
 * `SAFETY_SOS_OPEN_STATES` (§2.2.2) — the states an alert is still LIVE in, mirrored here only so the
 * board can say "open" without asking a second route. The SERVER decides what `/sos/active` returns;
 * nothing here re-filters a page the server already scoped.
 */
export const SOS_OPEN_STATES: readonly string[] = [
  "raised",
  "cancel_window_open",
  "acknowledging",
  "acknowledged",
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
  "emergency_terminus",
  "resolving",
];

/** Every `safety_sos_lifecycle_state` value. */
export const SOS_STATES: readonly string[] = [
  ...SOS_OPEN_STATES,
  "resolved",
  "cancelled_in_window",
  "cancel_attempted_but_rejected",
  "incident_opened",
];

/** The §2.2.2 escalation rungs, in LADDER order. The SLA watchdog climbs this; the board sorts on it. */
export const SOS_ESCALATION_TIERS: readonly string[] = [
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
];

/** `safety_sos_cancel_status` (D5). See {@link SOS_STATE_TONE} on why the rejected arm is `critical`. */
export const SOS_CANCEL_STATUS_TONE: Record<string, StatusTone> = {
  not_cancelled: "neutral",
  cancelled_in_window: "neutral",
  cancel_attempted_but_rejected: "critical",
};

/** §3.3 `safety_sos_alert.outcome` — how the responder ENDED the alert (the last act). */
export const SOS_OUTCOMES: readonly string[] = [
  "no_action_needed",
  "clinician_safe_continued",
  "visit_cancelled",
  "incident_opened",
  "911_called",
  "other",
];

/** §3.3 `safety_acknowledgment.outcome` — what the acknowledging responder DID (the first act). Distinct
 *  from {@link SOS_OUTCOMES}, and the two must never be offered from one picker. */
export const ACKNOWLEDGMENT_OUTCOMES: readonly string[] = [
  "reached_clinician_by_phone",
  "dispatched_supervisor",
  "911_called",
  "no_action_needed",
  "other",
];

/** `safety_check_in_status` — the clinician's own attestation (D2). */
export const CHECK_IN_STATUS_TONE: Record<string, StatusTone> = {
  ok: "success",
  concerned_continue: "warning",
  concerned_stop: "error",
};

/** `safety_check_in_kind`. `ad_hoc` and `between_visits` are the two a clinician may post unprompted. */
export const CHECK_IN_KINDS: readonly string[] = [
  "pre_visit",
  "mid_visit",
  "post_visit",
  "between_visits",
  "ad_hoc",
];

/** The kinds an UNPROMPTED post may declare. `pre_visit` / `mid_visit` / `post_visit` each require a
 *  `visit_id` (§3.3's `m20_sci_visit_kind`) and exist to fulfil a materialized obligation — offering them
 *  on the ad-hoc card would produce a 422 the clinician cannot act on, at the moment she is asking for
 *  attention. Fulfilling an obligation happens from the obligation's own card, which carries its visit. */
export const AD_HOC_CHECK_IN_KINDS: readonly string[] = ["between_visits", "ad_hoc"];

/**
 * `safety_check_in_state` (§2.2.1) — the state of an OBLIGATION, not of a post.
 *
 * `proposed` is `progress` rather than neutral: it is an outstanding promise to check in, and the whole D4
 * ladder exists because those go unnoticed. `incident_opened` is `warning` — the obligation ended in an
 * incident, which is a finding, not a completion.
 */
export const CHECK_IN_STATE_TONE: Record<string, StatusTone> = {
  proposed: "progress",
  recorded: "success",
  overdue: "error",
  escalated: "critical",
  superseded: "neutral",
  incident_opened: "warning",
};

/**
 * `SafetyOverdueBadge` (§4.2) — the dashboard's per-clinician verdict.
 *
 * `escalated` is `critical`: by §7.3's D4 ladder that rung means the supervisor page went unanswered and
 * the next rung is an SOS-equivalent. It is the reserved safety tone precisely because the board is what
 * somebody scans instead of reading every row.
 */
export const OVERDUE_BADGE_TONE: Record<string, StatusTone> = {
  on_time: "success",
  reminder: "warning",
  overdue: "error",
  escalated: "critical",
};

/** `SafetyCheckInBadge` (§4.3) — the per-visit trio M17 renders. `not_required` is NOT "done": the tenant
 *  policy simply asks for nothing here, and rendering it green would claim an attestation exists. */
export const CHECK_IN_BADGE_TONE: Record<string, StatusTone> = {
  not_required: "neutral",
  pending: "progress",
  recorded: "success",
  overdue: "error",
};

/** `safety_incident_category` (§1.1). */
export const INCIDENT_CATEGORIES: readonly string[] = [
  "physical_assault",
  "verbal_assault",
  "threatened",
  "dog_bite",
  "animal_other",
  "vehicle_accident_on_duty",
  "theft_during_visit",
  "medical_emergency_clinician_self",
  "weather_emergency",
  "environmental_hazard",
  "near_miss",
  "other",
];

/** `safety_incident_severity`. `life_threatening` is the reserved tone; `serious` is an error. */
export const INCIDENT_SEVERITY_TONE: Record<string, StatusTone> = {
  minor: "neutral",
  moderate: "warning",
  serious: "error",
  life_threatening: "critical",
};

/** `safety_incident_severity`, in ORDER of severity — the ledger sorts on this index, so it must not be
 *  re-sorted alphabetically ("life_threatening" would land second). */
export const INCIDENT_SEVERITIES: readonly string[] = [
  "minor",
  "moderate",
  "serious",
  "life_threatening",
];

/**
 * `safety_incident_state` (§2.2.3).
 *
 * `returned_to_clinician` is `warning`, not neutral: the ball is with a clinician who may not be looking,
 * and it is the state a supervisor's queue must not lose. `reopened` is `warning` for the same reason —
 * §6 makes reopening the only way to undo an OSHA sign-off, so a reopened row has an open filing question
 * attached to it. `closed_no_action` is `neutral` and `closed_with_action_plan` is `success`: only one of
 * the two closures left the agency with something to do differently.
 */
export const INCIDENT_STATE_TONE: Record<string, StatusTone> = {
  draft: "progress",
  submitted: "progress",
  under_review: "progress",
  returned_to_clinician: "warning",
  closed_with_action_plan: "success",
  closed_no_action: "neutral",
  reopened: "warning",
};

/** Every `safety_incident_state` — the ledger's filter picker. */
export const INCIDENT_STATES: readonly string[] = [
  "draft",
  "submitted",
  "under_review",
  "returned_to_clinician",
  "closed_with_action_plan",
  "closed_no_action",
  "reopened",
];

/**
 * The states the §4.1 row-16 transition route accepts (`IncidentTransitionState`).
 *
 * `draft` and `submitted` are ABSENT because each is reached by its own route, and a transition picker
 * that offered `submitted` would let a supervisor un-submit — which is exactly the immutability entry
 * point §2.2.3 puts there. The server refuses either way; offering it would only teach the supervisor that
 * the button lies.
 */
export const INCIDENT_TRANSITION_STATES: readonly string[] = [
  "under_review",
  "returned_to_clinician",
  "closed_with_action_plan",
  "closed_no_action",
  "reopened",
];

/** The two `safety_incident_state` closures — the transition form asks for an action plan on exactly one
 *  of them (§3.3's `m20_si_action_plan_required`). */
export const INCIDENT_CLOSED_STATES: readonly string[] = [
  "closed_with_action_plan",
  "closed_no_action",
];

/** `safety_high_risk_category` (D12). EVERY category is advisory; none blocks a visit. */
export const HIGH_RISK_CATEGORIES: readonly string[] = [
  "documented_prior_incident",
  "community_self_reported_unsafe",
  "nighttime_only_advisory",
  "weather_advisory_seasonal",
  "general_caution",
];

/** D12 tones. `documented_prior_incident` is the strongest because it is the only one backed by a filed
 *  incident rather than by a report or a season — and it is still ADVISORY, which the screen says in
 *  words beside the pill (colour is never the only signal, Hard Rule §10.10). */
export const HIGH_RISK_CATEGORY_TONE: Record<string, StatusTone> = {
  documented_prior_incident: "error",
  community_self_reported_unsafe: "warning",
  nighttime_only_advisory: "warning",
  weather_advisory_seasonal: "progress",
  general_caution: "neutral",
};

/** §3.3 `safety_high_risk_area.policy_for_visits_to_area` (D12). `requires_buddy_visit` is a FLAG M20
 *  emits; ENFORCING it is M17's routing concern and M20 never blocks the visit either way. */
export const HIGH_RISK_AREA_POLICIES: readonly string[] = [
  "advisory_only",
  "requires_pre_visit_check_in",
  "requires_buddy_visit",
];

/** §3.3 `safety_supervisor_subscription.scope_kind` (D8). */
export const SUBSCRIPTION_SCOPE_KINDS: readonly string[] = [
  "explicit",
  "location",
  "provider_entity",
  "role",
];

/** Which selector each `scope_kind` REQUIRES (§3.3's `m20_sss_scope_integrity`). The form asks for the
 *  named one and only the named one; `role` requires none. Mirrored so the DON is told which field to
 *  fill BEFORE the round trip — never instead of the server's own 422. */
export const SUBSCRIPTION_SCOPE_SELECTOR: Record<
  string,
  "clinician" | "location" | "providerEntity" | null
> = {
  explicit: "clinician",
  location: "location",
  provider_entity: "providerEntity",
  role: null,
};

/** `safety_subscription_model` (D8) — the tenant-wide DEFAULT, distinct from one row's scope kind. */
export const SUBSCRIPTION_MODELS: readonly string[] = [
  "location_scoped",
  "provider_entity_scoped",
  "role_scoped",
  "explicit_only",
];

/** §3.3 `safety_supervisor_subscription.alert_kinds[]` — which alert classes one row pages on. */
export const ALERT_KINDS: readonly SafetySubscriptionAlertKind[] = [
  "sos",
  "overdue",
  "incident",
  "high_risk_area",
];

/** §3.3 `safety_emergency_contact_consent.consent_purpose` (D6 / D10 / M20-F16). */
export const CONSENT_PURPOSES: readonly NonNullable<SafetyConsentPurpose>[] = [
  "sos_coordinates",
  "continuous_location_during_sos",
  "emergency_contact_call",
];

/**
 * `safety_emergency_contact_consent_status` (§2.2.8 / D10).
 *
 * `expired` is `warning` and `revoked` is `neutral`, which looks backwards until you read §2.2.8: a
 * REVOKED consent is the clinician's own decision and needs no action, whereas an EXPIRED one is the
 * tenant's rotation clock having run out on somebody who never said no — a lapse to re-ask about.
 */
export const CONSENT_STATUS_TONE: Record<string, StatusTone> = {
  granted: "success",
  revoked: "neutral",
  expired: "warning",
};

/** §4.2 `SafetyLocationSource` — where the board's last-known marker came from. */
export const LOCATION_SOURCE_TONE: Record<string, StatusTone> = {
  evv_check_in: "success",
  evv_check_out: "neutral",
  m20_check_in: "success",
  sos_active: "critical",
};

/** §4.3 `SafetyCoverageGapReason` (§7.8 / §2.2.5). Every arm is a finding; none is informational. */
export const COVERAGE_GAP_REASON_TONE: Record<string, StatusTone> = {
  no_subscription: "error",
  all_subscriptions_deactivated: "critical",
  vacation_forwards_unresolved: "warning",
};

/** §7.9 — how stale a last-known position may be before the board says so. Not a policy knob: it is the
 *  reading threshold for a HUMAN scanning a grid, and it is stated on the screen beside the column. */
export const LOCATION_STALE_MINUTES = 60;

/**
 * Default picker selections, NAMED rather than written as `SOME_LIST[0]`. Under
 * `noUncheckedIndexedAccess` an index read is `string | undefined`, which would make every form's initial
 * state nullable for no reason (the M16-T07 lesson).
 */
export const DEFAULT_CHECK_IN_KIND = "ad_hoc";
export const DEFAULT_CHECK_IN_STATUS = "ok";
export const DEFAULT_INCIDENT_CATEGORY = "other";
export const DEFAULT_INCIDENT_SEVERITY = "minor";
export const DEFAULT_INCIDENT_TRANSITION = "under_review";
export const DEFAULT_HIGH_RISK_CATEGORY = "general_caution";
export const DEFAULT_HIGH_RISK_AREA_POLICY = "advisory_only";
export const DEFAULT_SUBSCRIPTION_SCOPE_KIND = "explicit";
export const DEFAULT_SOS_OUTCOME = "clinician_safe_continued";
export const DEFAULT_ACK_OUTCOME = "reached_clinician_by_phone";
export const DEFAULT_CONSENT_PURPOSE = "sos_coordinates";

// ── the server-side minimums each form mirrors ─────────────────────────────────────────────────────────
//
// Each is the SERVER's floor (`m20-typebox.ts` / the §3.3 CHECK), mirrored so the clinician learns before
// the round trip — never INSTEAD of it. Where the two ever disagree the server wins and the form's counter
// is simply wrong about a request the server rejects, which is the safe direction of that failure.

/** §3.3 `m20_sci_concern_note` — a non-`ok` check-in owes ≥20 characters somebody will read. */
export const CONCERN_NOTE_MIN_CHARS = 20;
/** §4.2 `AmendCheckInBody.amendmentReason`. */
export const AMENDMENT_REASON_MIN_CHARS = 10;
/** §2.2.6's CRITICAL tier — an acknowledgment says what was actually DONE, in ≥40 characters. */
export const ACK_ACTION_TAKEN_MIN_CHARS = 40;
/** §4.2 `ResolveSosRequest.resolutionNarrative` — the account a deposition reads. */
export const SOS_RESOLUTION_MIN_CHARS = 100;
/** §4.2 `CreateIncidentBody.narrative` (and §3.3's ≥200-byte cipher floor once submitted). */
export const INCIDENT_NARRATIVE_MIN_CHARS = 200;
/** §4.2 `TransitionIncidentBody.reason` — including the §6 reopen, which needs a real one. */
export const INCIDENT_TRANSITION_REASON_MIN_CHARS = 30;
/** §4.2 `OshaSignoffBody.reason` — §7.6's citation of the governing rule. */
export const OSHA_REASON_MIN_CHARS = 40;
/** §2.2.4 `PatchPolicyBody.editReason` — why an agency changed its own watch. */
export const POLICY_EDIT_REASON_MIN_CHARS = 30;
/** §6's post-SOS coordinate escalation narrative. */
export const COORD_ACCESS_REASON_MIN_CHARS = 40;

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — "" is a valid key). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (`escalation_tier_2` → "Escalation tier 2"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A lifecycle state → the sentence a supervisor recognises at 3 a.m. */
export function sosStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "raised":
      return "Raised";
    case "cancel_window_open":
      return "Cancel window open";
    case "acknowledging":
      return "Alerting — unacknowledged";
    case "acknowledged":
      return "Acknowledged";
    case "escalation_tier_1":
      return "Escalated — tier 1";
    case "escalation_tier_2":
      return "Escalated — tier 2";
    case "escalation_tier_3":
      return "Escalated — tier 3";
    case "emergency_terminus":
      // NOT "ended". M20-F05 makes this the looping end of the chain, not its close.
      return "Emergency terminus — still unanswered";
    case "resolving":
      return "Resolving";
    case "resolved":
      return "Resolved";
    case "cancelled_in_window":
      return "Cancelled in window";
    case "cancel_attempted_but_rejected":
      return "Cancel REJECTED — alert proceeding";
    case "incident_opened":
      return "Incident opened";
    default:
      return humanize(state);
  }
}

/** A check-in status → the clinician's own words, as she chose them. */
export function checkInStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "ok":
      return "I'm OK";
    case "concerned_continue":
      return "Concerned — continuing";
    case "concerned_stop":
      return "Not OK — stopping";
    default:
      return humanize(status);
  }
}

/** An incident category → the label on a workers-comp form. */
export function incidentCategoryLabel(category: string | null | undefined): string {
  switch (category) {
    case "vehicle_accident_on_duty":
      return "Vehicle accident on duty";
    case "medical_emergency_clinician_self":
      return "Medical emergency — clinician";
    case "theft_during_visit":
      return "Theft during visit";
    case "near_miss":
      return "Near miss";
    default:
      return humanize(category);
  }
}

/** A consent purpose → what the clinician is actually agreeing to, in her language. */
export function consentPurposeLabel(purpose: string | null | undefined): string {
  switch (purpose) {
    case "sos_coordinates":
      return "Location at the moment I press SOS";
    case "continuous_location_during_sos":
      return "Continuous location while an SOS is active";
    case "emergency_contact_call":
      return "Calling my emergency contact";
    default:
      return humanize(purpose);
  }
}

/** A location source → how we last heard from her. */
export function locationSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "evv_check_in":
      return "EVV arrival";
    case "evv_check_out":
      return "EVV departure";
    case "m20_check_in":
      return "Safety check-in";
    case "sos_active":
      return "Active SOS stream";
    default:
      return humanize(source);
  }
}

/** A coverage-gap reason → the sentence the DON has to act on. */
export function coverageGapLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "no_subscription":
      return "Nobody is subscribed to this clinician";
    case "all_subscriptions_deactivated":
      return "Every subscription covering this clinician has been deactivated";
    case "vacation_forwards_unresolved":
      return "The only cover is a vacation forward that does not resolve";
    default:
      return humanize(reason);
  }
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** A date + HH:MM label for an instant — the grain a safety timeline is read at. */
export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** HH:MM alone — a column whose date is the row's own context. */
export function clockTime(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(11, 16);
}

/** A short opaque id label for a queue column. The full id is never truncated in a LINK TARGET — only in
 *  what a human reads. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 8);
}

/** Whole minutes SINCE an instant (0 when the instant is in the future). The SOS board sorts on it and
 *  §9.7's SLA targets are stated in seconds/minutes. */
export function minutesSince(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return 0;
  const mins = Math.floor((now - ms) / 60_000);
  return mins > 0 ? mins : 0;
}

/** Whole seconds UNTIL an instant (0 once it has passed) — the D5 five-second cancel ring counts on it. */
export function secondsUntil(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return 0;
  const secs = Math.ceil((ms - now) / 1000);
  return secs > 0 ? secs : 0;
}

/** A minute count → the duration label ("2h 14m"). An UNANSWERABLE duration is "—", never "0m": a tile
 *  reading "0m" for a median over no alerts would read as an achievement. */
export function durationLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A second count → a policy label ("45s" / "2m 00s"). Used by the policy editor's effective-value preview,
 *  where §2.2.4's SLA knobs are stated in seconds and read by a human in minutes. */
export function secondsLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Is a last-known position stale enough to say so? Age in minutes, or `null` when there is NO position at
 *  all — and the two must render differently: "no position" and "an hour old" are different facts. */
export function isLocationStale(ageMinutes: number | null | undefined): boolean {
  return typeof ageMinutes === "number" && ageMinutes >= LOCATION_STALE_MINUTES;
}

/** An instant suitable for a `datetime-local` input's initial value (local minute precision). */
export function nowLocalInput(offsetMinutes = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value → the ISO instant §4.2's `date-time` format expects. An unparseable value
 *  becomes "now" rather than travelling as garbage the clinician cannot see; every field using it is
 *  either optional or an occurrence time the form defaults to now anyway. */
export function toInstant(local: string): string {
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/** An ISO instant N days before now — what a 90-day personal history asks the server for. */
export function daysAgoInstant(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/**
 * Does a free-text field clear the SERVER's floor?
 *
 * Trims first, because §3.3's CHECKs are all `length(btrim(...))` — a reason of forty spaces satisfies a
 * naive `.length` test on the client and is refused by the database, which is the worst of both.
 */
export function meetsMinChars(value: string, min: number): boolean {
  return value.trim().length >= min;
}

/** The counter a min-length field shows: how many characters are still owed, or 0. */
export function charsRemaining(value: string, min: number): number {
  const n = min - value.trim().length;
  return n > 0 ? n : 0;
}
