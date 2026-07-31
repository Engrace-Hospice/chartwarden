// apps/web/src/modules/15-discipline-care-plans — shared status presentation for the M15 Discipline Care
// Plans surfaces (Track B / ADR-0030, §5 / DESIGN.md §6.6). Every M15 screen renders the same StatusPill
// for a given wire enum through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M24
// medicaid-status.ts / M25 remittance-status.ts / M26 cap-status.ts precedent).
//
// Every key below is a value from the FROZEN pgEnum list in packages/db/src/enums.ts (M15-T01) — not from
// the prose spec. A wire value the map does not carry falls through to `neutral` rather than throwing, but
// a *silently wrong vocabulary* is the failure mode these maps exist to prevent (the M30 lesson: a wire
// enum published as a bare string is a lie the UI cannot see), so the source of each map is named.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/complete · warning≈needs-attention ·
// error≈breached/failed · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";

/** `discipline_plan_status` (enums.ts §3.2) — the §2.2.1 plan-root lifecycle. */
export const PLAN_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  active: "success",
  draft_revising: "progress",
  discharged: "neutral",
};

/** `discipline_plan_version_status` — the §2.2.2 version chain. `in_review` is the sealed-quorum state. */
export const VERSION_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  in_review: "progress",
  signed: "success",
  superseded: "neutral",
};

/** `discipline_goal_status` — §2.2.3. `not_met` is the clinical signal, not an error. */
export const GOAL_STATUS_TONE: Record<string, StatusTone> = {
  not_started: "neutral",
  in_progress: "progress",
  met: "success",
  not_met: "warning",
  revised: "progress",
  discontinued: "neutral",
};

/** `discipline_intervention_status` — §2.2.3. */
export const INTERVENTION_STATUS_TONE: Record<string, StatusTone> = {
  active: "progress",
  discontinued: "neutral",
  completed: "success",
};

/** `discipline_assessment_status` — the append-only correction-of-record ladder (§2.2.3 / M9 D9). */
export const ASSESSMENT_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  signed: "success",
  amended: "progress",
};

/**
 * `SupervisoryCadenceState["status"]` (lifecycle/supervisory.ts) — the §7.1 42 CFR §418.76(h) ladder.
 * `gate_engaged` is the CHHA encounter-sign block, so it is the only error tone: past that mark a new
 * aide visit cannot be signed without a documented Clinical-Supervisor override.
 */
export const CADENCE_STATUS_TONE: Record<string, StatusTone> = {
  on_time: "success",
  due: "warning",
  overdue: "error",
  gate_engaged: "error",
};

/** `volunteer_gate_status` — §2.2.6 / 42 CFR §418.78(b),(d). Everything but `satisfied` /
 *  `expiring_soon` FAILS the gate and flips the volunteer inactive (fail-CLOSED, M15-F11). */
export const GATE_STATUS_TONE: Record<string, StatusTone> = {
  satisfied: "success",
  expiring_soon: "warning",
  expired: "error",
  revoked: "error",
  not_yet_satisfied: "warning",
};

/** The gate statuses that FAIL 418.78 — the volunteer is not schedulable while any of these stands. */
export const FAILING_GATE_STATUSES: readonly string[] = [
  "expired",
  "revoked",
  "not_yet_satisfied",
];

/** `VolunteerHourRatio["status"]` (volunteer/hours.ts) — the §7.6 418.78(e) 5% banding. `unavailable`
 *  is the HONEST missing-denominator badge (M27 cost basis unbound), never a 0% breach. */
export const RATIO_STATUS_TONE: Record<string, StatusTone> = {
  green: "success",
  yellow: "warning",
  red: "error",
  unavailable: "neutral",
};

/** `volunteer_hour_entry_source` — §2.2.7 ledger numerator sources. */
export const HOUR_SOURCE_TONE: Record<string, StatusTone> = {
  encounter: "success",
  volunteer_admin_hours: "progress",
  manual_adjustment: "warning",
};

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — "" is a valid key). */
export function toneOf(map: Record<string, StatusTone>, key: string | null | undefined): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (`gate_engaged` → "Gate engaged"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `discipline_plan_kind` → the CoP-facing screen label. */
export function kindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "aide_poc":
      return "Aide Plan of Care";
    case "msw_plan":
      return "MSW Plan";
    case "spiritual_plan":
      return "Spiritual Care Plan";
    case "volunteer_plan":
      return "Volunteer Plan";
    default:
      return humanize(kind);
  }
}

/** The regulation each plan kind answers to — shown as the card's eyebrow (§1.3). */
export function kindRegulation(kind: string | null | undefined): string {
  switch (kind) {
    case "aide_poc":
      return "42 CFR §418.76";
    case "msw_plan":
    case "spiritual_plan":
      return "42 CFR §418.64";
    case "volunteer_plan":
      return "42 CFR §418.78";
    default:
      return "";
  }
}

/** `volunteer_gate_kind` → label. */
export function gateKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "background_check":
      return "Background check";
    case "tb_screening":
      return "TB screening";
    case "confidentiality_agreement":
      return "Confidentiality agreement";
    case "initial_training":
      return "Initial training";
    case "annual_ce":
      return "Annual CE";
    case "assignment_specific_training":
      return "Assignment-specific training";
    case "vaccination_status":
      return "Vaccination status";
    default:
      return humanize(kind);
  }
}

/** `aide_supervisory_attestation_mode` → the 418.76(h)(2) label. */
export function attestationModeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case "aide_present":
      return "Aide present";
    case "observation_of_work":
      return "Observation of aide's work";
    default:
      return humanize(mode);
  }
}

/** `discipline_assessment_kind` → label. */
export function assessmentKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "msw_psychosocial":
      return "MSW psychosocial";
    case "chaplain_spiritual":
      return "Chaplain spiritual";
    case "aide_environmental":
      return "Aide environmental";
    case "volunteer_relationship":
      return "Volunteer relationship";
    default:
      return humanize(kind);
  }
}

/** The §7.8/§7.9 `redacted_categories` marker → the caller-facing sentence. */
export function redactionLabel(categories: readonly string[]): string | null {
  if (categories.length === 0) return null;
  const parts = categories.map((c) =>
    c === "sud" ? "substance-use disorder" : c === "family_violence" ? "family violence" : c,
  );
  return `Some ${parts.join(" and ")} content is withheld from this view.`;
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** A date + HH:MM label for an instant (the supervisory / signature ledgers). */
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

/** A relative-due label for the §7.1 next-due banner and the gate `valid_until` countdown. */
export function dueLabel(value: string | null | undefined, now = Date.now()): string {
  const days = daysUntil(value, now);
  if (days === null) return "—";
  if (days === 0) return "due today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const overdue = -days;
  return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
}

/** Minutes → an hours label for the 418.78(e) ledger (`5400` → "90.0 h"). */
export function hours(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  return `${(minutes / 60).toFixed(1)} h`;
}

/** A 0..1 fraction as a percentage label; null is the honest em-dash, never "0.0%". */
export function pct(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}
