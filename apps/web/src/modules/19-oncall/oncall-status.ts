// apps/web/src/modules/19-oncall — shared status presentation for the M19 On-Call Triage surfaces
// (Track B / ADR-0030, §5 / DESIGN.md §6.6). Every M19 screen renders the same StatusPill for a given wire
// enum through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M15 discipline-status.ts /
// M16 bereavement-status.ts / M21 supplies-status.ts precedent — each web slice owns its own, because
// apps/web/src/modules/* may not import a sibling module).
//
// Every key below is a value from the FROZEN union in `packages/types/src/oncall.ts` (M19-T01), which
// itself mirrors the `packages/db/src/enums.ts` pgEnums. The DB wins on conflict. A wire value a map does
// not carry falls through to `neutral` rather than throwing — but a *silently wrong vocabulary* is the
// failure mode these maps exist to prevent, so each map names its source enum.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/complete · warning≈needs-attention ·
// error≈breached/failed · critical(gold)≈reserved irreversible/safety · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";
import type {
  EscalationTier,
  MinimizationProfile,
  OncallModel,
  ShiftDiscipline,
  TriageAnswerType,
  TriageCallerKind,
  TriageCallState,
  TriageDispositionValue,
  TriageInboundChannel,
} from "./oncall-api";

/**
 * `triage_call_state` (§2.2.1 / D6).
 *
 * `escalated_unresolved` reads `critical`, not `error`: a call parked there is one where a named human has
 * been paged and has not answered, which is the safety condition the whole D7 ladder exists for — the gold
 * tone is Lantern's reserved-for-irreversible/safety band and this is the one call state that earns it.
 *
 * `documented_pending_encounter` is `warning`, NOT `success`: the disposition is chosen but the M8
 * encounter is unsigned, and §2.7's class D-B strands a call here when the `EncounterCreator` seam is
 * unreachable. A green pill there would read as "done" on the supervisor board for a call that still owes
 * a clinical record.
 *
 * `abandoned` is `error` rather than `neutral` although it IS terminal: §2.2.4 lets a call reach it with a
 * mandatory escalation still open only by the escalation being resolved first, and a caller who hung up
 * mid-red-flag is a follow-up obligation, not a closed ticket.
 */
export const CALL_STATE_TONE: Record<string, StatusTone> = {
  open: "warning",
  protocol_in_progress: "progress",
  awaiting_callback: "warning",
  disposition_pending: "progress",
  documented_pending_encounter: "warning",
  escalated_unresolved: "critical",
  documented: "success",
  closed: "neutral",
  abandoned: "error",
};

/** `TRIAGE_CALL_OPEN_STATES` (§2.2.1) — the six states a call is still LIVE in, mirrored here only for the
 *  queue's filter picker. The SERVER decides what `openOnly=true` returns; nothing here re-filters a page
 *  the server already scoped. `documented_pending_encounter` is deliberately IN the set (M19-F06 /
 *  ADR-0022): a call stranded by a down M8 seam must stay on the supervisor board. */
export const OPEN_CALL_STATES: readonly TriageCallState[] = [
  "open",
  "protocol_in_progress",
  "awaiting_callback",
  "disposition_pending",
  "documented_pending_encounter",
  "escalated_unresolved",
];

/** Every `triage_call_state` value, for the queue's state filter. */
export const CALL_STATES: readonly TriageCallState[] = [
  ...OPEN_CALL_STATES,
  "documented",
  "closed",
  "abandoned",
];

/** `triage_escalation_tier` (D7), in LADDER order — this array order is the escalation ladder the inbox
 *  and the tier picker render, so it must not be re-sorted alphabetically. */
export const ESCALATION_TIERS: readonly EscalationTier[] = [
  "tier_1_rn_supervisor",
  "tier_2_clinical_manager",
  "tier_3_medical_director",
  "tier_4_compliance_officer",
  "tier_5_external",
];

/** A tier's severity tone. The ladder rises: a medical-director page at 2 a.m. is not the same event as an
 *  RN-supervisor one, and the inbox sorts on tier as well as age. */
export const ESCALATION_TIER_TONE: Record<string, StatusTone> = {
  tier_1_rn_supervisor: "progress",
  tier_2_clinical_manager: "warning",
  tier_3_medical_director: "critical",
  tier_4_compliance_officer: "critical",
  tier_5_external: "warning",
};

/** `triage_escalation_state` (§2.2.4). `open` is `error` on an inbox whose entire purpose is that nobody
 *  has answered yet — the SLA clock beside it is what turns that into a number. */
export const ESCALATION_STATE_TONE: Record<string, StatusTone> = {
  open: "error",
  acknowledged: "progress",
  resolved: "success",
};

/** `triage_escalation_trigger`. The two the SERVER writes itself (D5/D7) are the ones no tenant policy can
 *  suppress, and they read as the strongest signals. */
export const ESCALATION_TRIGGER_TONE: Record<string, StatusTone> = {
  manual: "neutral",
  red_flag_question: "error",
  mandatory_protocol: "critical",
  sla_breach: "warning",
};

/** `oncall_shift_status` (§2.2.2). `cancelled` reads `error`, not `neutral`: a cancelled shift is a hole in
 *  the CoP 418.100(c)(2) coverage record until another shift fills it, and the roster's gap banner is
 *  driven off exactly that. */
export const SHIFT_STATUS_TONE: Record<string, StatusTone> = {
  scheduled: "progress",
  active: "success",
  completed: "neutral",
  cancelled: "error",
};

/** `oncall_shift_discipline`. `external` is the Hybrid/Centralized case where the covering actor is a
 *  vendor rather than a membership — structurally a different arm of `OnCallActor`, never a nullable id. */
export const SHIFT_DISCIPLINES: readonly ShiftDiscipline[] = [
  "clinical_rn",
  "clinical_lpn",
  "medical_director",
  "msw",
  "chaplain",
  "external",
];

/** `triage_call_inbound_channel` — the transport the call arrived on. The three `inbound_*` values are the
 *  D10 machine-opened ones (M17 no-show, M18 late check-out, M36 delivery failure); a human intake form
 *  offers only the four a person can actually dial in on (see {@link HUMAN_INBOUND_CHANNELS}). */
export const INBOUND_CHANNELS: readonly TriageInboundChannel[] = [
  "phone",
  "sms",
  "email",
  "portal_message",
  "inbound_visit_failure",
  "inbound_evv_anomaly",
  "inbound_alert_failure",
];

/** The channels a HUMAN intake form may declare. The three `inbound_*` values are written by the D10
 *  consumers; offering them on the intake screen would let a clinician mint a call that claims M17 detected
 *  a missed visit. (The server's own narrowing is `OpenableSource`, which pins `source` to `manual`; the
 *  channel has no such union, so the restriction lives here and is stated on the screen.) */
export const HUMAN_INBOUND_CHANNELS: readonly TriageInboundChannel[] = [
  "phone",
  "sms",
  "email",
  "portal_message",
];

/** `triage_call_caller_kind`. `system_inbound` is likewise D10-only and absent from the intake picker. */
export const CALLER_KINDS: readonly TriageCallerKind[] = [
  "patient",
  "caregiver",
  "external_clinician",
  "portal_session",
  "system_inbound",
  "bereaved_family",
];

/** The caller kinds a human intake may declare (`system_inbound` excluded — see above). */
export const HUMAN_CALLER_KINDS: readonly TriageCallerKind[] = [
  "patient",
  "caregiver",
  "external_clinician",
  "portal_session",
  "bereaved_family",
];

/** `triage_call_source` — what caused the row to exist. Rendered, never selected: §4.2's `OpenableSource`
 *  admits `manual` alone, and `paper_origin` is the §2.7 re-entry route's own value. */
export const CALL_SOURCE_TONE: Record<string, StatusTone> = {
  manual: "neutral",
  no_show: "warning",
  late_checkout: "warning",
  geofence_anomaly: "warning",
  m36_delivery_failure: "error",
  paper_origin: "critical",
};

/** `triage_disposition` (D6) — all ten values including the two that are NOT selectable through the
 *  disposition route (`escalated_unresolved` and `abandoned` each have their own route and permission). */
export const DISPOSITION_TONE: Record<string, StatusTone> = {
  caregiver_education_only: "success",
  prn_intervention_authorized: "success",
  verbal_order_recorded: "progress",
  visit_dispatched_now: "warning",
  visit_scheduled_first_light: "progress",
  gip_admission_proposed: "critical",
  ed_transfer_acknowledged: "error",
  pronouncement_scheduled: "critical",
  escalated_unresolved: "critical",
  abandoned: "error",
};

/** `triage_protocol_answer_type` — selects which of the three typed value columns the answer writes, and
 *  therefore which D5 red-flag predicate arm may be evaluated against it. */
export const ANSWER_TYPES: readonly TriageAnswerType[] = [
  "boolean",
  "integer",
  "scale_0_10",
  "free_text",
  "enum",
];

/** `triage_risk_band` (D11) and `triage_ai_confidence` (D12). Both are ADVISORY: neither gates anything,
 *  and the panel renders them inside an AI-provenance card that says so. */
export const RISK_BAND_TONE: Record<string, StatusTone> = {
  low: "success",
  medium: "warning",
  high: "error",
};

/** `oncall_model` (D3). `direct` ships live at Phase 1; the other two are behind a per-customer flag. */
export const ONCALL_MODELS: readonly OncallModel[] = ["direct", "hybrid", "centralized"];

/** The D13 PHI-minimization profiles a vendor binding may declare (§4.2 `CreateVendorBindingBody`). */
export const MINIMIZATION_PROFILES: readonly MinimizationProfile[] = [
  "hybrid_phi_min",
  "centralized_phi_min",
];

/**
 * Default picker selections, NAMED rather than written as `SOME_LIST[0]`. Under
 * `noUncheckedIndexedAccess` an index read is `string | undefined`, which would make every form's initial
 * state nullable for no reason — and a `??` fallback at each call site puts the same literal in five files
 * (the M16-T07 lesson).
 */
export const DEFAULT_INBOUND_CHANNEL = "phone";
export const DEFAULT_CALLER_KIND = "caregiver";
export const DEFAULT_SHIFT_DISCIPLINE = "clinical_rn";
export const DEFAULT_ESCALATION_TIER = "tier_1_rn_supervisor";
export const DEFAULT_ANSWER_TYPE = "boolean";
export const DEFAULT_MINIMIZATION_PROFILE = "hybrid_phi_min";

/** The §8.6 / D12 AI-governance confidence floor. A suggestion at or above it that the clinician overrides
 *  needs a ≥10-char reason; below it, no reason is demanded (see `M19_AI_CONFIDENCE_FLOOR`). Mirrored here
 *  as the BAND names the wire carries — the numeric floor is the server's and is never re-decided here. */
export const AI_CONFIDENCE_AT_OR_ABOVE_FLOOR: readonly string[] = ["high"];

/** §8.6 — the minimum length of a D12 override reason. The SERVER enforces it (`ApplyProtocolBody`'s
 *  `minLength: 10`); the form mirrors it so the clinician learns before the round trip, never instead. */
export const AI_OVERRIDE_REASON_MIN_CHARS = 10;

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — "" is a valid key). */
export function toneOf(map: Record<string, StatusTone>, key: string | null | undefined): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (`disposition_pending` → "Disposition pending"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A tier → the ladder label a supervisor reads ("Tier 3 · Medical director"). */
export function tierLabel(tier: string | null | undefined): string {
  if (!tier) return "—";
  const m = /^tier_(\d)_(.+)$/.exec(tier);
  if (!m) return humanize(tier);
  return `Tier ${m[1]} · ${humanize(m[2])}`;
}

/** A discipline → its roster label. */
export function disciplineLabel(discipline: string | null | undefined): string {
  switch (discipline) {
    case "clinical_rn":
      return "RN";
    case "clinical_lpn":
      return "LPN";
    case "medical_director":
      return "Medical director";
    case "msw":
      return "MSW";
    case "chaplain":
      return "Chaplain";
    case "external":
      return "External vendor";
    default:
      return humanize(discipline);
  }
}

/** A disposition → the sentence a clinician recognises. Deliberately NOT the lay-language portal wording:
 *  §5.3's portal projection is a different surface with a different reader, and it is the SERVER's
 *  `PortalTriageSummary` that produces it. */
export function dispositionLabel(disposition: string | null | undefined): string {
  switch (disposition) {
    case "caregiver_education_only":
      return "Caregiver education only";
    case "prn_intervention_authorized":
      return "PRN intervention authorized";
    case "verbal_order_recorded":
      return "Verbal order recorded";
    case "visit_dispatched_now":
      return "Visit dispatched now";
    case "visit_scheduled_first_light":
      return "Visit scheduled — first light";
    case "gip_admission_proposed":
      return "GIP admission proposed";
    case "ed_transfer_acknowledged":
      return "ED transfer acknowledged";
    case "pronouncement_scheduled":
      return "Pronouncement scheduled";
    case "escalated_unresolved":
      return "Escalated — unresolved";
    case "abandoned":
      return "Abandoned";
    default:
      return humanize(disposition);
  }
}

/** A D5 red-flag predicate → the sentence the catalog editor shows beside the question. A closed union
 *  renders as prose; an unknown arm renders its raw `kind` rather than silently reading as "no predicate",
 *  because a red-flag question with no visible predicate is the one nobody checks. */
export function redFlagMatchLabel(match: unknown): string {
  const m = match as { kind?: string; value?: boolean; threshold?: number; values?: string[] } | null;
  if (!m || typeof m.kind !== "string") return "—";
  switch (m.kind) {
    case "bool_is":
      return `fires when the answer is ${m.value === true ? "yes" : "no"}`;
    case "int_at_least":
      return `fires at or above ${m.threshold}`;
    case "int_at_most":
      return `fires at or below ${m.threshold}`;
    case "enum_in":
      return `fires on any of: ${(m.values ?? []).join(", ")}`;
    case "text_any":
      return "fires when any non-blank text is recorded";
    default:
      return `unrecognised predicate (${m.kind})`;
  }
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** A date + HH:MM label for an instant — the grain a triage timeline is read at. */
export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** HH:MM alone — the roster's shift-window columns, where the date is the row's own context. */
export function clockTime(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(11, 16);
}

/** A short opaque id label for an identifier surfaced in a queue column. The full id is never truncated in
 *  a link target — only in what a human reads. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 8);
}

/** Whole minutes SINCE an instant (0 when the instant is in the future). The escalation inbox and the
 *  call board both sort on it, and §9.7's SLA targets are stated in minutes. */
export function minutesSince(value: string | null | undefined, now = Date.now()): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return 0;
  const mins = Math.floor((now - ms) / 60_000);
  return mins > 0 ? mins : 0;
}

/** A minute count → the duration label ("2h 14m"). Tabular by construction so a column of them aligns. */
export function durationLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "—";
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** An instant suitable for a `datetime-local` input's initial value (local minute precision). */
export function nowLocalInput(offsetMinutes = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value → the ISO instant §4.2's `date-time` format expects. An unparseable value
 *  becomes "now" rather than being sent as garbage the server would 422 on a field the clinician cannot
 *  see; every such field is optional or defaulted, so "now" is never a silently wrong clinical fact. */
export function toInstant(local: string): string {
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/** Is `now` inside the half-open window `[startsAt, endsAt)`? The "am I on shift right now?" question the
 *  §5.1 `/me/oncall` banner answers, computed from the row rather than asked of a second route. */
export function isWithinWindow(
  startsAt: string,
  endsAt: string,
  now = Date.now(),
): boolean {
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return now >= s && now < e;
}
