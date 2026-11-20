// apps/web/src/modules/08-encounters/review — how a refused finalize or sign becomes a list of blockers (WF09 WP3). Pure.
//
// The server is the only judge. A failed finalize is `422 COMPLIANCE_GATE_FAILED` whose `error.details` is `[{ field?, code, message }]`,
// one per failure; the gate's own `check` id is STRIPPED before it reaches the wire (gate.ts `assertGatePassed`), so a blocker is read
// from `code` and `field`. The generated client types `details` as `Record<string, never>[]`, so every read here validates the shape at
// runtime and a garbled answer still yields something to render: a code this model does not know becomes a generic blocker (never
// dropped), and a 5xx or a dropped connection becomes "unavailable" with FIXED words: the server's message for a 503 can embed upstream
// error text, so it is never carried.
import type { GateCheckId } from "./gate-register";
import {
  type HeadingOf,
  type NoteTarget,
  SCALE_KEYS,
  type ScaleKey,
  VITAL_KEYS,
  type VitalKey,
  targetLabel,
} from "./note-target";

export type Moment = "finalize" | "sign";

export interface Blocker {
  /** The server's code for this failure (`UNKNOWN` when the answer carried none). */
  readonly code: string;
  readonly field: string | null;
  /** The register check this code belongs to, derived here because the wire strips it; null for a code with no check. */
  readonly check: GateCheckId | null;
  /** What is wrong, in the app's words. */
  readonly what: string;
  /** Why it blocks, and what to do. */
  readonly why: string;
  readonly remedy: NoteTarget;
  /** The remedy button's text, or null when there is nowhere to go. */
  readonly remedyLabel: string | null;
}

export type Refusal =
  | {
      readonly outcome: "blocked";
      readonly moment: Moment;
      readonly code: string;
      /** True for a gate failure: the gate evaluates every check in one pass, so it lists every failure it found. */
      readonly gateRanInFull: boolean;
      /**
       * True when the server refused before it wrote anything for this step (a gate failure or a refusal this model knows is raised
       * before the write), so "the note was not finalized" is true of it. False for a code it does not know, such as a note that
       * already moved on in another tab: nothing is then said about what the note's status is.
       */
      readonly decidedBeforeWrite: boolean;
      readonly blockers: readonly Blocker[];
    }
  | {
      readonly outcome: "unavailable";
      readonly moment: Moment;
      /**
       * `service`: the server said it could not decide (rate limit, a gate it could not run) before writing anything;
       * `connection`: no answer arrived; `unconfirmed`: an error answer that does not say whether the note changed (500, 502, 504).
       */
      readonly reason: "service" | "connection" | "unconfirmed";
    };

/** What the blocker panel shows: the last answer the server gave to a finalize (or sign), and nothing it has not said. */
export type GateAttempt =
  | { readonly state: "none" }
  | { readonly state: "running" }
  | { readonly state: "finalized" }
  | { readonly state: "refused"; readonly refusal: Refusal };

const MAX_SERVER_TEXT = 240;
const UNKNOWN_CODE = "UNKNOWN";
const RATE_LIMITED = 429;
const FIRST_SERVER_ERROR = 500;

const VITAL_LABEL: Readonly<Record<VitalKey, string>> = {
  bp: "Blood pressure",
  heartRate: "Heart rate",
  respiratoryRate: "Respiratory rate",
  temperature: "Temperature",
  spo2: "SpO₂",
  pain: "Pain score",
};
const SCALE_LABEL: Readonly<Record<ScaleKey, string>> = { pps: "PPS", esas_r: "ESAS-r" };

const isVital = (value: string | null | undefined): value is VitalKey =>
  value !== null && value !== undefined && (VITAL_KEYS as readonly string[]).includes(value);
const isScale = (value: string | null | undefined): value is ScaleKey =>
  value !== null && value !== undefined && (SCALE_KEYS as readonly string[]).includes(value);

// ── where each code is fixed ───────────────────────────────────────────────────────────────────────────

/**
 * The place in the note where `code` (with its `field`) is put right. A code this does not know opens the note. The late-entry reason is
 * collected only for a finalize: the sign request can carry one, but no screen sends it yet, so at sign there is nowhere to enter it.
 */
export function remedyFor(
  code: string,
  field: string | null | undefined,
  moment: Moment = "finalize",
): NoteTarget {
  const named = typeof field === "string" && field !== "" ? field : null;
  switch (code) {
    case "MISSING_SECTION":
    case "INVALID_SELECTION":
      return named ? { kind: "section", sectionId: named } : { kind: "open_note" };
    case "MISSING_VITAL":
      return isVital(named) ? { kind: "vitals", vital: named } : { kind: "vitals" };
    case "MISSING_SCALE":
      return isScale(named) ? { kind: "scales", scale: named } : { kind: "open_note" };
    case "CARE_PLAN_REVIEW_OVERDUE":
      return { kind: "care_plan_review" };
    case "DRAFT_SECTION_UNRESOLVED":
    case "DRAFT_SECTION_STALE":
      return named ? { kind: "draft_section", sectionId: named } : { kind: "open_note" };
    case "LATE_ENTRY_REASON_REQUIRED":
      return moment === "finalize" ? { kind: "late_entry_reason" } : { kind: "none" };
    case "VOCAB_VERSION_MISMATCH":
      return { kind: "save_selections" };
    case "NARRATIVE_EDIT_STALE":
      return { kind: "note_text" };
    case "STEP_UP_REQUIRED":
    case "STEP_UP_AUTH_REQUIRED":
      return { kind: "reauthenticate" };
    case "NOTE_CLOSURE_REQUIRED":
      return { kind: "my_notes" };
    case "NO_TEMPLATE_FOR_PAIR":
    case "MODALITY_CONFIRMATION_REQUIRED":
    case "MODALITY_CONFLICTS_WITH_VISIT_TYPE":
    case "VISIT_TIME_INVALID":
    case "VISIT_TIME_OVERLAP":
    case "NO_ELIGIBLE_COSIGNER":
    case "F2F_DUAL_WRITE_REQUIRED":
    case "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED":
    case "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED":
    case "DRAFT_OFF_AFTER_FINALIZE":
    case "ILLEGAL_TRANSITION":
    case "IMMUTABLE_AFTER_SIGN":
      return { kind: "none" };
    default:
      return { kind: "open_note" };
  }
}

// ── the app's words for each code ──────────────────────────────────────────────────────────────────────

interface RuleContext {
  readonly field: string | null;
  readonly moment: Moment;
  readonly headingOf: HeadingOf;
  /** The server's own sentence, when it sent one (capped). */
  readonly message: string | null;
}
interface Rule {
  readonly check: GateCheckId | null;
  readonly what: (context: RuleContext) => string;
  readonly why: (context: RuleContext) => string;
}

const headingFor = ({ field, headingOf }: RuleContext, fallback: string): string =>
  field === null ? fallback : headingOf(field);

const fixed = (text: string) => (): string => text;

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  [
    "MISSING_SECTION",
    {
      check: "required_sections",
      what: (c) => `${headingFor(c, "A required section")} has no entry`,
      why: (c) =>
        c.field === "vitals_review"
          ? "The template requires this section, and recorded vitals do not fill it: enter your own text."
          : "The template requires this section. Add a selection or your own text.",
    },
  ],
  [
    "NO_TEMPLATE_FOR_PAIR",
    {
      check: "required_sections",
      what: fixed("No note template exists for this visit type and discipline"),
      why: fixed("The server cannot judge this note without one. Ask an administrator."),
    },
  ],
  [
    "MISSING_VITAL",
    {
      check: "required_vitals",
      what: ({ field }) =>
        `${isVital(field) ? VITAL_LABEL[field] : "A required vital"} is not recorded`,
      why: fixed(
        "This visit type requires it. Record it in the visit vitals, then finalize again.",
      ),
    },
  ],
  [
    "MISSING_SCALE",
    {
      check: "required_scales",
      what: ({ field }) =>
        `${isScale(field) ? SCALE_LABEL[field] : "A required scale"} is not on file`,
      why: fixed("Recertification visits require it. Record the assessment, then finalize again."),
    },
  ],
  [
    "CARE_PLAN_REVIEW_OVERDUE",
    {
      check: "care_plan_review",
      what: fixed("The patient's care plan review is overdue"),
      why: fixed(
        "The care plan has not had its 5-day initial review, or is past its 15-day review window. Review it, then finalize again.",
      ),
    },
  ],
  [
    "DRAFT_SECTION_UNRESOLVED",
    {
      check: "draft_sections_resolved",
      what: (c) => `${headingFor(c, "A drafted section")}: drafted text is not resolved`,
      why: fixed("Confirm the drafted text or deselect it."),
    },
  ],
  [
    "DRAFT_SECTION_STALE",
    {
      check: "draft_sections_resolved",
      what: (c) => `${headingFor(c, "A drafted section")}: drafted text changed`,
      why: fixed("The draft changed after you resolved it. Review it and resolve it again."),
    },
  ],
  [
    "LATE_ENTRY_REASON_REQUIRED",
    {
      check: "late_entry_ceiling",
      what: fixed("A late-entry reason is required"),
      why: ({ moment }) =>
        moment === "sign"
          ? "This note is being signed more than 1 calendar day after the visit date and no reason is on file. The reason is required, and it cannot be entered on this screen yet."
          : "This note is being documented more than 1 calendar day after the visit date.",
    },
  ],
  [
    "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED",
    {
      check: "late_entry_ceiling",
      what: fixed("A late-entry override is required"),
      why: fixed("A supervisor must record the override. You cannot approve it yourself."),
    },
  ],
  [
    "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED",
    {
      check: "late_entry_ceiling",
      what: fixed("A late-entry override is required"),
      why: fixed("A director must record the override. You cannot approve it yourself."),
    },
  ],
  [
    "VOCAB_VERSION_MISMATCH",
    {
      check: "vocab_version_pin",
      what: fixed("The clinical vocabulary was updated"),
      why: fixed("The wording of a selected statement may have changed since you last saved."),
    },
  ],
  [
    "NARRATIVE_EDIT_STALE",
    {
      check: null,
      what: fixed("Your edited note text is out of date"),
      why: fixed("The selections or vitals changed after you edited the note text."),
    },
  ],
  [
    "STEP_UP_REQUIRED",
    {
      check: "step_up_fresh",
      what: fixed("A fresh sign-in is required to sign"),
      why: fixed("Signing needs a step-up sign-in from the last 5 minutes."),
    },
  ],
  [
    "STEP_UP_AUTH_REQUIRED",
    {
      check: "step_up_fresh",
      what: fixed("A fresh sign-in is required to sign"),
      why: fixed("Signing needs a step-up sign-in from the last 5 minutes."),
    },
  ],
  [
    "NO_ELIGIBLE_COSIGNER",
    {
      check: "eligible_cosigner",
      what: fixed("No RN is available to cosign"),
      why: fixed(
        "LPN and aide notes need an RN case manager on the patient's care team. Ask an administrator to assign one.",
      ),
    },
  ],
  [
    "MODALITY_CONFIRMATION_REQUIRED",
    {
      check: null,
      what: fixed("How the visit was delivered is not confirmed"),
      why: fixed("Choose it in the sign dialog, then sign again."),
    },
  ],
  [
    "MODALITY_CONFLICTS_WITH_VISIT_TYPE",
    {
      check: null,
      what: fixed("The delivery chosen does not fit this visit type"),
      why: fixed(
        "A telephonic visit cannot be recorded as in person or video. Change it in the sign dialog.",
      ),
    },
  ],
  [
    "VISIT_TIME_INVALID",
    {
      check: null,
      what: fixed("The visit times could not be accepted"),
      why: ({ message }) => message ?? "Check the times in the sign dialog, then sign again.",
    },
  ],
  [
    "VISIT_TIME_OVERLAP",
    {
      check: null,
      what: fixed("The visit times overlap another visit you documented"),
      why: fixed("Correct the times in the sign dialog, or clear them and sign without times."),
    },
  ],
  [
    "F2F_DUAL_WRITE_REQUIRED",
    {
      check: "f2f_attested",
      what: fixed("The face-to-face record is not linked to this encounter"),
      why: fixed(
        "A face-to-face encounter must already be linked to its face-to-face record before it can be signed. Link the record, then sign again.",
      ),
    },
  ],
  [
    "DRAFT_OFF_AFTER_FINALIZE",
    {
      check: null,
      what: fixed("The visit-note draft was switched off after this note was finalized"),
      why: fixed("Ask an administrator to switch the visit-note draft back on, then sign again."),
    },
  ],
  [
    "ILLEGAL_TRANSITION",
    {
      check: null,
      what: fixed("The note is no longer in the state this screen showed"),
      why: fixed(
        "It was changed somewhere else, such as another tab. This screen has read the note again and shows what the server holds now.",
      ),
    },
  ],
  [
    "IMMUTABLE_AFTER_SIGN",
    {
      check: null,
      what: fixed("The note is no longer in the state this screen showed"),
      why: fixed(
        "It was changed somewhere else, such as another tab. This screen has read the note again and shows what the server holds now.",
      ),
    },
  ],
]);

/** The register check each code this model words belongs to (null for a code the register has no check for): pinned by a test. */
export const CHECK_BY_CODE: ReadonlyMap<string, GateCheckId | null> = new Map(
  [...RULES].map(([code, rule]) => [code, rule.check]),
);

/** The refusals that mean the note moved on since this screen read it (another tab finalized or signed it): the screen reads it again. */
const STATUS_MOVED_CODES: ReadonlySet<string> = new Set([
  "ILLEGAL_TRANSITION",
  "IMMUTABLE_AFTER_SIGN",
]);

/** Refusals the server raises before it writes anything for the step, besides the codes this model words itself. */
const REFUSED_BEFORE_WRITE_EXTRA: ReadonlySet<string> = new Set([
  "COMPLIANCE_GATE_FAILED",
  "INVALID_SELECTION",
  "NOTE_CLOSURE_REQUIRED",
]);

const refusedBeforeWrite = (code: string): boolean =>
  !STATUS_MOVED_CODES.has(code) && (RULES.has(code) || REFUSED_BEFORE_WRITE_EXTRA.has(code));

const UNKNOWN_RULE: Rule = {
  check: null,
  what: () => "The server reported a problem",
  why: ({ message }) => message ?? "It did not say more. Open the note and check it.",
};

// ── reading the answer ─────────────────────────────────────────────────────────────────────────────────

interface Facts {
  /** `null` is a write that never got an answer; `undefined` is an input that was not a refusal at all. */
  readonly status: number | null | undefined;
  readonly code: string | null;
  readonly message: string | null;
  readonly details: unknown;
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const capped = (text: string | null): string | null =>
  text !== null && text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT)}…` : text;

/** A write result (`{ status, code, message, details }`) or a raw error envelope (`{ error: { code, message, details } }`). */
function factsOf(input: unknown): Facts {
  const outer = asRecord(input);
  if (outer === null) return { status: undefined, code: null, message: null, details: undefined };
  const envelope = asRecord(outer.error) ?? outer;
  const status =
    outer.status === null || typeof outer.status === "number" ? outer.status : undefined;
  return {
    status,
    code: asText(envelope.code),
    message: capped(asText(envelope.message)),
    details: envelope.details,
  };
}

interface DetailItem {
  readonly code: string;
  readonly field: string | null;
  readonly message: string | null;
}

function detailItems(details: unknown): readonly DetailItem[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((raw): DetailItem[] => {
    const item = asRecord(raw);
    if (item === null) return [];
    return [
      {
        code: asText(item.code) ?? UNKNOWN_CODE,
        field: asText(item.field),
        message: capped(asText(item.message)),
      },
    ];
  });
}

/**
 * `service` only when the answer itself says nothing was written: a rate limit, or the server's own "could not decide" (`*_UNAVAILABLE`,
 * raised before the step runs). Any other 5xx (a 500, or a 502/504 from a proxy that may have passed the request on) does not say whether
 * the note changed, so it is `unconfirmed`.
 */
function unavailableReason({
  status,
  code,
}: Facts): Extract<Refusal, { outcome: "unavailable" }>["reason"] | null {
  if (status === null && code === null) return "connection";
  if (status === RATE_LIMITED || code?.endsWith("_UNAVAILABLE")) return "service";
  return typeof status === "number" && status >= FIRST_SERVER_ERROR ? "unconfirmed" : null;
}

interface Where {
  readonly moment: Moment;
  readonly headingOf: HeadingOf;
}

function makeBlocker(
  code: string,
  field: string | null,
  message: string | null,
  where: Where,
  overrides: Partial<Pick<Blocker, "what" | "why" | "remedy">> = {},
): Blocker {
  const { moment, headingOf } = where;
  const rule = RULES.get(code) ?? UNKNOWN_RULE;
  const context: RuleContext = { field, moment, headingOf, message };
  const remedy = overrides.remedy ?? remedyFor(code, field, moment);
  return {
    code,
    field,
    check: rule.check,
    what: overrides.what ?? rule.what(context),
    why: overrides.why ?? rule.why(context),
    remedy,
    remedyLabel: targetLabel(remedy, headingOf),
  };
}

const SELECTION_WHAT = "a statement cannot be used as entered";

function selectionBlocker(item: DetailItem, where: Where): Blocker {
  const section = item.field === null ? "A section" : where.headingOf(item.field);
  return makeBlocker(item.code, item.field, item.message, where, {
    what: `${section}: ${SELECTION_WHAT}`,
    why: item.message ?? "Open the section and correct the statement.",
    remedy: remedyFor("INVALID_SELECTION", item.field),
  });
}

function fallbackBlocker(code: string, message: string | null, where: Where): Blocker {
  const generic: Partial<Pick<Blocker, "what" | "why" | "remedy">> =
    code === "COMPLIANCE_GATE_FAILED"
      ? {
          what: `The server did not ${where.moment} the note`,
          why: "It did not list what to fix. Open the note and check each required section.",
          remedy: { kind: "open_note" },
        }
      : {};
  return makeBlocker(code, null, message, where, generic);
}

function closureBlocker(details: unknown, where: Where): Blocker {
  const count = detailItems(details).find((item) => item.field === "overdueCount")?.message ?? "";
  const overdue = /^\d{1,4}$/.test(count) ? Number(count) : 0;
  const why =
    overdue > 0
      ? `You have ${overdue} overdue ${overdue === 1 ? "note" : "notes"}. Close ${overdue === 1 ? "it" : "them"} first.`
      : "You have an overdue note. Close it first.";
  return makeBlocker("NOTE_CLOSURE_REQUIRED", null, null, where, {
    what: "Overdue notes must be closed first",
    why,
  });
}

function blockersFor(facts: Facts, where: Where): readonly Blocker[] {
  const code = facts.code ?? UNKNOWN_CODE;
  if (code === "NOTE_CLOSURE_REQUIRED") return [closureBlocker(facts.details, where)];
  const items = detailItems(facts.details);
  const listed = code === "COMPLIANCE_GATE_FAILED" || code === "DRAFT_SECTION_STALE";
  if (code === "INVALID_SELECTION" && items.length > 0) {
    return items.map((item) => selectionBlocker(item, where));
  }
  if (listed && items.length > 0) {
    return items.map((item) => makeBlocker(item.code, item.field, item.message, where));
  }
  return [fallbackBlocker(code, facts.message, where)];
}

/**
 * The server's refusal of a finalize or sign as blockers, or as "unavailable" when it could not decide. `input` is a write result or an
 * error envelope; anything else (garbage included) still yields a generic blocker. Never throws.
 */
export function parseRefusal(input: unknown, moment: Moment, headingOf: HeadingOf): Refusal {
  const facts = factsOf(input);
  const reason = unavailableReason(facts);
  if (reason !== null) return { outcome: "unavailable", moment, reason };
  const code = facts.code ?? UNKNOWN_CODE;
  return {
    outcome: "blocked",
    moment,
    code,
    gateRanInFull: code === "COMPLIANCE_GATE_FAILED",
    decidedBeforeWrite: refusedBeforeWrite(code),
    blockers: blockersFor(facts, { moment, headingOf }),
  };
}

/** The input `parseRefusal` reads for a raw API answer: the HTTP status with the error envelope the body carries. */
export function responseRefusal(status: number | undefined, body: unknown): unknown {
  return { status, ...(asRecord(body) ?? {}) };
}

/**
 * Whether the blocker panel says this refusal in its own words: a gate failure, a code it knows, a note that moved on, or the server could
 * not decide. The screen then shows no banner for it, so one live region speaks. A code the panel does not know keeps the screen's banner,
 * which carries the server's own sentence and any link to the record that fixes it (the care plan, the EVV reconciliation).
 */
export const panelWordsRefusal = (attempt: GateAttempt): boolean =>
  attempt.state === "refused" &&
  (attempt.refusal.outcome === "unavailable" ||
    attempt.refusal.decidedBeforeWrite ||
    STATUS_MOVED_CODES.has(attempt.refusal.code));

/** Whether the last refusal says the note moved on since this screen read it (finalized or signed in another tab): read the note again. */
export const refusalMovedStatus = (attempt: GateAttempt): boolean =>
  attempt.state === "refused" &&
  attempt.refusal.outcome === "blocked" &&
  STATUS_MOVED_CODES.has(attempt.refusal.code);

/** The server's code for a note documented more than 24 hours late that carries no reason. */
const LATE_ENTRY_REASON_CODE = "LATE_ENTRY_REASON_REQUIRED";

/** Whether the last refused finalize asked for a late-entry reason, so the screen shows the field that collects it (a sign cannot take one). */
export const asksForLateEntryReason = (attempt: GateAttempt): boolean =>
  attempt.state === "refused" &&
  attempt.refusal.outcome === "blocked" &&
  attempt.refusal.moment === "finalize" &&
  attempt.refusal.blockers.some((blocker) => blocker.code === LATE_ENTRY_REASON_CODE);

/** The panel's state when a finalize or sign got no answer: the result is not known, so nothing is claimed about the note. */
export const connectionLostAttempt = (moment: Moment): GateAttempt => ({
  state: "refused",
  refusal: { outcome: "unavailable", moment, reason: "connection" },
});

/** The panel's state for a refused write: a new object per answer, so the panel moves focus to the first blocker each time. */
export function refusedAttempt(input: unknown, moment: Moment, headingOf: HeadingOf): GateAttempt {
  return { state: "refused", refusal: parseRefusal(input, moment, headingOf) };
}
