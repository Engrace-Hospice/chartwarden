// apps/web/src/modules/16-bereavement — shared status presentation for the M16 Bereavement surfaces
// (Track B / ADR-0030, §5 / DESIGN.md §6.6). Every M16 screen renders the same StatusPill for a given wire
// enum through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M15 discipline-status.ts /
// M24 medicaid-status.ts precedent).
//
// Every key below is a value from the FROZEN pgEnum list in packages/db/src/enums.ts (M16-T01) — not from
// the prose spec. A wire value the map does not carry falls through to `neutral` rather than throwing, but
// a *silently wrong vocabulary* is the failure mode these maps exist to prevent, so the source of each map
// is named.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/complete · warning≈needs-attention ·
// error≈breached/failed · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";

/** `bereavement_plan_status` (§3.2) — the §2.2 plan root. Every `closed_*` is terminal, so neutral: a
 *  completed 13-month program and an early close are both "done", and the CLOSURE REASON (not the status
 *  pill) is what distinguishes a fulfilled obligation from a curtailed one. */
export const PLAN_STATUS_TONE: Record<string, StatusTone> = {
  eligible: "warning",
  initiating: "progress",
  active: "success",
  paused: "warning",
  closed_completed: "neutral",
  closed_declined: "neutral",
  closed_early: "neutral",
  closed_legal_hold_extended: "neutral",
};

/** `bereaved_contact_status` (§3.2) — the §2.3 per-survivor machine. */
export const CONTACT_STATUS_TONE: Record<string, StatusTone> = {
  proposed: "warning",
  active: "success",
  opted_out: "neutral",
  deceased: "neutral",
  unreachable: "warning",
  ineligible_post_review: "neutral",
};

/** `bereavement_outreach_status` (§3.2) — the §2.4 touchpoint machine. `missed` is the only CoP 418.64(d)
 *  failure signal; `declined` / `no_response` are recorded OUTCOMES of a touchpoint the agency did make. */
export const OUTREACH_STATUS_TONE: Record<string, StatusTone> = {
  scheduled: "neutral",
  in_progress: "progress",
  completed: "success",
  declined: "neutral",
  no_response: "warning",
  missed: "error",
  cancelled: "neutral",
};

/** `bereavement_risk_tier` (§3.2 / D3). `complicated` is a D8 promotion, never a rubric output — it means
 *  the survivor screened positive and has been referred out (§7.7), so it reads as error, not merely high. */
export const RISK_TIER_TONE: Record<string, StatusTone> = {
  low: "success",
  moderate: "warning",
  high: "warning",
  complicated: "error",
};

/** A tier's ICON — Hard Rule §10.10: a risk tier is never signalled by colour alone (§5.1). */
export const RISK_TIER_GLYPH: Record<string, string> = {
  low: "○",
  moderate: "◐",
  high: "◕",
  complicated: "●",
};

/** `bereavement_confidence_band` (§3.2 / D17) — how much of the factor vector was actually knowable. */
export const CONFIDENCE_BAND_TONE: Record<string, StatusTone> = {
  HIGH: "success",
  MEDIUM: "warning",
  LOW: "error",
};

/** `bereavement_data_completeness` (§3.2 / D17). */
export const DATA_COMPLETENESS_TONE: Record<string, StatusTone> = {
  complete: "success",
  partial: "warning",
  minimal: "error",
};

/** `bereavement_contact_log_outcome` (§3.2). */
export const LOG_OUTCOME_TONE: Record<string, StatusTone> = {
  engaged: "success",
  brief_acknowledgement: "success",
  declined: "neutral",
  no_response: "warning",
  voicemail_left: "progress",
  wrong_number: "warning",
  returned_undeliverable: "warning",
  requested_followup: "progress",
  requested_no_further_contact: "warning",
  crisis_referral: "error",
};

/** `bereavement_plan_closure_reason` (§3.2 / D7). Only `thirteen_month_completion` is the obligation MET. */
export const CLOSURE_REASON_TONE: Record<string, StatusTone> = {
  thirteen_month_completion: "success",
  all_contacts_declined: "neutral",
  patient_opt_out_pre_death: "neutral",
  patient_opt_out_post_creation: "neutral",
  tenant_offboarding: "warning",
  all_bereaved_deceased: "neutral",
  geographic_relocation: "warning",
  family_legal_action: "error",
  other_early: "warning",
};

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — "" is a valid key). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (`closed_early` → "Closed early"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `bereavement_outreach_kind` → the counselor-facing label. */
export function outreachKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "phone_call":
      return "Phone call";
    case "in_person_visit":
      return "In-person visit";
    case "sympathy_card":
      return "Sympathy card";
    case "sympathy_letter":
      return "Sympathy letter";
    case "anniversary_letter":
      return "Anniversary letter";
    case "email":
      return "Email";
    case "portal_message":
      return "Portal message";
    case "group_support_invitation":
      return "Group support invitation";
    case "external_referral":
      return "External referral";
    default:
      return humanize(kind);
  }
}

/** The nine `bereavement_outreach_kind` values, in the §4.2 order. */
export const OUTREACH_KINDS: readonly string[] = [
  "phone_call",
  "in_person_visit",
  "sympathy_card",
  "sympathy_letter",
  "anniversary_letter",
  "email",
  "portal_message",
  "group_support_invitation",
  "external_referral",
];

/** The eight NON-encounter kinds §4.2's `CompleteOutreachBody` accepts without an M8 encounter (D15). */
export const NON_ENCOUNTER_OUTREACH_KINDS: readonly string[] = OUTREACH_KINDS.filter(
  (k) => k !== "in_person_visit",
);

/** The ten `bereavement_contact_log_outcome` values (§3.2). */
export const LOG_OUTCOMES: readonly string[] = [
  "engaged",
  "brief_acknowledgement",
  "declined",
  "no_response",
  "voicemail_left",
  "wrong_number",
  "returned_undeliverable",
  "requested_followup",
  "requested_no_further_contact",
  "crisis_referral",
];

/** The sixteen `bereaved_contact_relationship` values (§3.2; M38 owns the authoritative set). */
export const RELATIONSHIP_CODES: readonly string[] = [
  "spouse",
  "domestic_partner",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "aunt_uncle",
  "cousin",
  "in_law",
  "friend",
  "neighbor",
  "clergy",
  "colleague",
  "caregiver_non_family",
  "other",
];

/** The five §4.2 `CloseEarlyBody` reasons — the D7 cosign-required subset. The four system-driven closure
 *  reasons are cascades no route may request, which is why they are absent from the picker. */
export const EARLY_CLOSE_REASONS: readonly string[] = [
  "tenant_offboarding",
  "all_bereaved_deceased",
  "geographic_relocation",
  "family_legal_action",
  "other_early",
];

/** `bereavement_plan_pause_kind` (§3.2). */
export const PAUSE_KINDS: readonly string[] = [
  "operational",
  "family_request",
  "counselor_unavailable_temp",
];

/** `bereavement_opt_out_kind` (§3.2 / D9). */
export const OPT_OUT_KINDS: readonly string[] = ["full", "channel_specific", "pause_temporarily"];

/**
 * The default picker selections, named rather than written as `SOME_LIST[0]`. Under
 * `noUncheckedIndexedAccess` an index read is `string | undefined`, which would make every ceremony's
 * initial state nullable for no reason — and a `??` fallback at each call site would put the same literal
 * in five files.
 */
export const DEFAULT_LOG_OUTCOME = "engaged";
export const DEFAULT_NON_ENCOUNTER_KIND = "phone_call";
export const DEFAULT_OPT_OUT_KIND = "full";
export const DEFAULT_PAUSE_KIND = "operational";
export const DEFAULT_EARLY_CLOSE_REASON = "tenant_offboarding";

/** `bereavement_anniversary_mark` (§3.2 / D4) → the label the planner shows on a marked touchpoint. */
export function anniversaryMarkLabel(mark: string | null | undefined): string {
  switch (mark) {
    case "one_month":
      return "1 month";
    case "three_month":
      return "3 months";
    case "six_month":
      return "6 months";
    case "nine_month_high_risk_only":
      return "9 months (high risk)";
    case "anniversary":
      return "Anniversary";
    default:
      return humanize(mark);
  }
}

/** The eight D3/D17 rubric factors, in the frozen `RecomputeRiskBody.factors` key order. */
export const RISK_FACTOR_KEYS: readonly string[] = [
  "ambivalent_relationship",
  "sudden_unexpected_death",
  "prior_unresolved_loss",
  "preexisting_mental_health",
  "social_isolation",
  "financial_strain",
  "primary_caregiver_role",
  "active_substance_use",
];

/** A rubric factor key → its counselor-facing question. */
export function riskFactorLabel(key: string): string {
  switch (key) {
    case "ambivalent_relationship":
      return "Ambivalent relationship with the decedent";
    case "sudden_unexpected_death":
      return "Sudden or unexpected death";
    case "prior_unresolved_loss":
      return "Prior unresolved loss";
    case "preexisting_mental_health":
      return "Pre-existing mental-health condition";
    case "social_isolation":
      return "Social isolation";
    case "financial_strain":
      return "Financial strain";
    case "primary_caregiver_role":
      return "Was the primary caregiver";
    case "active_substance_use":
      return "Active substance use";
    default:
      return humanize(key);
  }
}

/**
 * The §4.3.2 / D18 first-contact denial code → the sentence the counselor sees. A machine code the UI
 * cannot name would be worse than no banner at all: the coordinator must know WHICH gate to clear.
 */
export function firstContactGateLabel(code: string | null | undefined): string {
  switch (code) {
    case "external_source_cosign_pending":
      return "Pending medical-director cosign — this plan came from an external (HL7 ADT) death notice and the platform-mandated cosign has not been received. Counselor first contact is locked until it is.";
    case "tenant_gate_death_certificate_missing":
      return "Your organization requires an uploaded death certificate before first contact on an external-source plan.";
    case "tenant_gate_coordinator_acknowledgment_missing":
      return "Your organization requires a bereavement-coordinator acknowledgment before first contact on an external-source plan.";
    case null:
    case undefined:
      return "";
    default:
      return `First contact is gated: ${humanize(code)}.`;
  }
}

/** The §7.13 `redactedCategories` marker → the caller-facing sentence. */
export function redactionLabel(categories: readonly string[]): string | null {
  if (categories.length === 0) return null;
  const parts = categories.map((c) =>
    c === "sud"
      ? "substance-use disorder"
      : c === "clinical_risk"
        ? "clinical risk"
        : c === "decedent_clinical"
          ? "decedent clinical"
          : humanize(c).toLowerCase(),
  );
  return `Some ${parts.join(" and ")} content is withheld from this view.`;
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** A date + HH:MM label for an instant. */
export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** A short opaque id label for a PHI-adjacent identifier surfaced in a queue column. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 8);
}

/** Whole days between now and an instant — negative when the instant has passed. */
export function daysUntil(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.floor((ms - now) / 86_400_000);
}

/** A relative-due label for the touchpoint planner and the 13-month window countdown. */
export function dueLabel(value: string | null | undefined, now = Date.now()): string {
  const days = daysUntil(value, now);
  if (days === null) return "—";
  if (days === 0) return "due today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const overdue = -days;
  return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
}

/**
 * §5.1 #17 — the 30/14/7-day pre-anniversary banner. The anniversary is one year after the death, and the
 * D4 schedule already carries the marked touchpoint; this only decides whether to SURFACE it, and does so
 * from the death date rather than from an outreach row, so the banner still appears when the anniversary
 * touchpoint was cancelled and needs re-scheduling.
 */
export function anniversaryCountdown(
  deathDate: string | null | undefined,
  now = Date.now(),
): { days: number; mark: 30 | 14 | 7 } | null {
  if (!deathDate) return null;
  const death = Date.parse(`${deathDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(death)) return null;
  const anniversary = new Date(death);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  const days = Math.floor((anniversary.getTime() - now) / 86_400_000);
  if (days < 0 || days > 30) return null;
  const mark = days <= 7 ? 7 : days <= 14 ? 14 : 30;
  return { days, mark };
}

/** A 0..100 integer rule score as its own label; null is the honest em-dash, never "0". */
export function scoreLabel(value: number | null | undefined): string {
  if (value == null) return "—";
  return String(value);
}
