// apps/web/src/modules/19-oncall/oncall-status.test.ts — the M19 presentation vocabulary (§5 / §6.6).
//
// The pure helpers live in `oncall-status.ts` (it imports only the `StatusTone` *type* from @wardenx/ui,
// erased at runtime), so this test is colocated in apps/web — a `packages/` test importing it would create
// a forbidden package→app dependency-cruiser edge (the M34 saas-status.test.ts precedent).
//
// WHAT THIS SUITE IS ACTUALLY GUARDING, beyond "the map has the right keys":
//
//   1. THE ENUM MIRRORS ARE COMPLETE. A wire value the map does not carry falls through to `neutral`,
//      which renders as a grey "inert/terminal" pill. For `escalated_unresolved` that would put a call
//      where a named human has been paged and has not answered on the board looking like a closed ticket.
//      So every member of every frozen union is asserted present, not merely a sample.
//   2. THE SEVERITY DIRECTION IS DELIBERATE. Three call states read stronger than a naive mapping would
//      give them, and each is a decision a later reader could quietly undo: `documented_pending_encounter`
//      is NOT success (the disposition is chosen, the clinical record is not signed),
//      `escalated_unresolved` IS the reserved safety tone, and `abandoned` is an error despite being
//      terminal (a caller who hung up mid-red-flag is a follow-up obligation).
//   3. THE RED-FLAG PREDICATE NEVER RENDERS AS "NOTHING". `redFlagMatchLabel` must produce visible prose
//      for every closed-union arm AND name an unrecognised arm — a red-flag question whose predicate
//      renders blank is the one nobody checks.
//   4. THE INTAKE PICKERS EXCLUDE THE MACHINE-ONLY VOCABULARY. A human intake form that offered
//      `system_inbound` or one of the three `inbound_*` channels would let a clinician mint a row that
//      claims a machine detected something.
//   5. A DURATION OF ZERO IS NOT THE SAME AS AN UNANSWERABLE ONE. `durationLabel(undefined)` must be "—";
//      a metrics tile that printed "0m" for a mean over no calls would read as an achievement.
import { describe, expect, it } from "vitest";
import {
  ANSWER_TYPES,
  CALLER_KINDS,
  CALL_SOURCE_TONE,
  CALL_STATES,
  CALL_STATE_TONE,
  DISPOSITION_TONE,
  ESCALATION_STATE_TONE,
  ESCALATION_TIERS,
  ESCALATION_TIER_TONE,
  ESCALATION_TRIGGER_TONE,
  HUMAN_CALLER_KINDS,
  HUMAN_INBOUND_CHANNELS,
  INBOUND_CHANNELS,
  ONCALL_MODELS,
  OPEN_CALL_STATES,
  RISK_BAND_TONE,
  SHIFT_DISCIPLINES,
  SHIFT_STATUS_TONE,
  SOURCE_FILTERS,
  STATE_FILTERS,
  clockTime,
  dateTime,
  disciplineLabel,
  dispositionLabel,
  durationLabel,
  humanize,
  isWithinWindow,
  minutesSince,
  redFlagMatchLabel,
  shortDate,
  shortId,
  tierLabel,
  toInstant,
  toneOf,
} from "./oncall-status";

/** The frozen `triage_call_state` union (packages/types/src/oncall.ts). */
const ALL_CALL_STATES = [
  "open",
  "protocol_in_progress",
  "awaiting_callback",
  "disposition_pending",
  "documented_pending_encounter",
  "documented",
  "escalated_unresolved",
  "abandoned",
  "closed",
] as const;

/** The frozen `triage_disposition` union — ten values, including the two that are not selectable through
 *  the disposition route (each has its own route and its own permission). */
const ALL_DISPOSITIONS = [
  "caregiver_education_only",
  "prn_intervention_authorized",
  "verbal_order_recorded",
  "visit_dispatched_now",
  "visit_scheduled_first_light",
  "gip_admission_proposed",
  "ed_transfer_acknowledged",
  "pronouncement_scheduled",
  "escalated_unresolved",
  "abandoned",
] as const;

/** The frozen `triage_call_source` union. */
const ALL_SOURCES = [
  "manual",
  "no_show",
  "late_checkout",
  "geofence_anomaly",
  "m36_delivery_failure",
  "paper_origin",
] as const;

describe("M19 call-state tone map (§2.2.1 / §6.6)", () => {
  it("carries every frozen triage_call_state — a missing key would render a live call as inert", () => {
    for (const state of ALL_CALL_STATES) {
      expect(CALL_STATE_TONE[state], `no tone declared for ${state}`).toBeDefined();
    }
    expect(Object.keys(CALL_STATE_TONE).sort()).toEqual([...ALL_CALL_STATES].sort());
  });

  it("keeps the three deliberate severity decisions", () => {
    // Disposition chosen, encounter unsigned — a green pill here would read as "done" on the board.
    expect(CALL_STATE_TONE.documented_pending_encounter).toBe("warning");
    // The reserved safety tone: a named human was paged and has not answered.
    expect(CALL_STATE_TONE.escalated_unresolved).toBe("critical");
    // Terminal, but a follow-up obligation rather than a closed ticket.
    expect(CALL_STATE_TONE.abandoned).toBe("error");
    // The genuinely inert one.
    expect(CALL_STATE_TONE.closed).toBe("neutral");
  });

  it("mirrors the six-state open set, including documented_pending_encounter (M19-F06 / ADR-0022)", () => {
    expect(OPEN_CALL_STATES).toHaveLength(6);
    expect(OPEN_CALL_STATES).toContain("documented_pending_encounter");
    expect(OPEN_CALL_STATES).not.toContain("closed");
    expect(OPEN_CALL_STATES).not.toContain("abandoned");
    expect(OPEN_CALL_STATES).not.toContain("documented");
  });

  it("offers every state on the queue filter", () => {
    expect([...CALL_STATES].sort()).toEqual([...ALL_CALL_STATES].sort());
  });
});

describe("M19 escalation vocabulary (D7 / §2.2.4)", () => {
  it("keeps the five tiers in LADDER order, not alphabetical", () => {
    expect(ESCALATION_TIERS).toEqual([
      "tier_1_rn_supervisor",
      "tier_2_clinical_manager",
      "tier_3_medical_director",
      "tier_4_compliance_officer",
      "tier_5_external",
    ]);
    // The inbox sort ranks on this index; a re-sort would silently reorder the queue.
    expect(ESCALATION_TIERS.indexOf("tier_3_medical_director")).toBeGreaterThan(
      ESCALATION_TIERS.indexOf("tier_1_rn_supervisor"),
    );
  });

  it("tones every tier and rises with the ladder", () => {
    for (const tier of ESCALATION_TIERS) {
      expect(ESCALATION_TIER_TONE[tier], `no tone for ${tier}`).toBeDefined();
    }
    expect(ESCALATION_TIER_TONE.tier_1_rn_supervisor).toBe("progress");
    expect(ESCALATION_TIER_TONE.tier_3_medical_director).toBe("critical");
  });

  it("reads an unacknowledged page as an error and a resolved one as success", () => {
    expect(ESCALATION_STATE_TONE.open).toBe("error");
    expect(ESCALATION_STATE_TONE.acknowledged).toBe("progress");
    expect(ESCALATION_STATE_TONE.resolved).toBe("success");
  });

  it("marks the two SERVER-written triggers as the strongest signals (D5 / D7)", () => {
    expect(ESCALATION_TRIGGER_TONE.red_flag_question).toBe("error");
    expect(ESCALATION_TRIGGER_TONE.mandatory_protocol).toBe("critical");
    expect(ESCALATION_TRIGGER_TONE.manual).toBe("neutral");
    expect(ESCALATION_TRIGGER_TONE.sla_breach).toBe("warning");
  });

  it("renders a tier as a readable ladder rung", () => {
    expect(tierLabel("tier_3_medical_director")).toBe("Tier 3 · Medical director");
    expect(tierLabel(null)).toBe("—");
    // An unrecognised tier still renders its own name rather than vanishing.
    expect(tierLabel("tier_9_unknown")).toBe("Tier 9 · Unknown");
  });
});

describe("M19 disposition + source vocabulary (D6)", () => {
  it("tones all ten dispositions, including the two that are not selectable", () => {
    for (const d of ALL_DISPOSITIONS) {
      expect(DISPOSITION_TONE[d], `no tone for ${d}`).toBeDefined();
    }
    expect(Object.keys(DISPOSITION_TONE).sort()).toEqual([...ALL_DISPOSITIONS].sort());
  });

  it("labels every disposition in clinician language, never as a raw enum", () => {
    for (const d of ALL_DISPOSITIONS) {
      expect(dispositionLabel(d)).not.toContain("_");
    }
    expect(dispositionLabel("visit_scheduled_first_light")).toBe("Visit scheduled — first light");
    expect(dispositionLabel(null)).toBe("—");
  });

  it("tones every call source and marks the back-dated one as the reserved tone", () => {
    for (const s of ALL_SOURCES) {
      expect(CALL_SOURCE_TONE[s], `no tone for ${s}`).toBeDefined();
    }
    // The one source a human write can produce that back-dates a call.
    expect(CALL_SOURCE_TONE.paper_origin).toBe("critical");
    expect(CALL_SOURCE_TONE.m36_delivery_failure).toBe("error");
  });
});

describe("M19 intake pickers exclude the machine-only vocabulary", () => {
  it("drops the three D10 inbound channels from the human picker", () => {
    expect(INBOUND_CHANNELS).toHaveLength(7);
    expect(HUMAN_INBOUND_CHANNELS).toEqual(["phone", "sms", "email", "portal_message"]);
    for (const machineOnly of [
      "inbound_visit_failure",
      "inbound_evv_anomaly",
      "inbound_alert_failure",
    ]) {
      expect(INBOUND_CHANNELS).toContain(machineOnly);
      expect(HUMAN_INBOUND_CHANNELS).not.toContain(machineOnly);
    }
  });

  it("drops system_inbound from the human caller-kind picker", () => {
    expect(CALLER_KINDS).toContain("system_inbound");
    expect(HUMAN_CALLER_KINDS).not.toContain("system_inbound");
    expect(HUMAN_CALLER_KINDS).toHaveLength(CALLER_KINDS.length - 1);
  });
});

describe("M19 roster + catalog vocabulary", () => {
  it("carries every shift discipline and tones every shift status", () => {
    expect(SHIFT_DISCIPLINES).toEqual([
      "clinical_rn",
      "clinical_lpn",
      "medical_director",
      "msw",
      "chaplain",
      "external",
    ]);
    for (const s of ["scheduled", "active", "completed", "cancelled"]) {
      expect(SHIFT_STATUS_TONE[s], `no tone for ${s}`).toBeDefined();
    }
    // A cancelled shift is a HOLE in the coverage record, not an inert row.
    expect(SHIFT_STATUS_TONE.cancelled).toBe("error");
    expect(SHIFT_STATUS_TONE.active).toBe("success");
  });

  it("labels disciplines the way a roster reads them", () => {
    expect(disciplineLabel("clinical_rn")).toBe("RN");
    expect(disciplineLabel("external")).toBe("External vendor");
    expect(disciplineLabel(null)).toBe("—");
  });

  it("carries the five answer types and the three deployment models", () => {
    expect(ANSWER_TYPES).toEqual(["boolean", "integer", "scale_0_10", "free_text", "enum"]);
    expect(ONCALL_MODELS).toEqual(["direct", "hybrid", "centralized"]);
  });

  it("tones the advisory risk bands without letting `high` read as merely a warning", () => {
    expect(RISK_BAND_TONE.low).toBe("success");
    expect(RISK_BAND_TONE.medium).toBe("warning");
    expect(RISK_BAND_TONE.high).toBe("error");
  });
});

describe("M19 red-flag predicate rendering (D5)", () => {
  it("renders visible prose for every arm of the closed union", () => {
    expect(redFlagMatchLabel({ kind: "bool_is", value: true })).toContain("yes");
    expect(redFlagMatchLabel({ kind: "bool_is", value: false })).toContain("no");
    expect(redFlagMatchLabel({ kind: "int_at_least", threshold: 7 })).toContain("7");
    expect(redFlagMatchLabel({ kind: "int_at_most", threshold: 60 })).toContain("60");
    expect(redFlagMatchLabel({ kind: "enum_in", values: ["severe", "worst"] })).toContain("severe");
    expect(redFlagMatchLabel({ kind: "text_any" })).toContain("text");
  });

  it("NAMES an unrecognised arm instead of rendering blank", () => {
    // A predicate the catalog editor does not understand must not read as "no predicate": a red-flag
    // question with no visible predicate is the one nobody checks.
    const label = redFlagMatchLabel({ kind: "regex_match" });
    expect(label).toContain("unrecognised");
    expect(label).toContain("regex_match");
  });

  it("renders an absent predicate as an em dash, distinct from an unrecognised one", () => {
    expect(redFlagMatchLabel(null)).toBe("—");
    expect(redFlagMatchLabel(undefined)).toBe("—");
    expect(redFlagMatchLabel({})).toBe("—");
  });
});

describe("M19 formatting helpers", () => {
  it("defaults an unknown enum to neutral rather than throwing", () => {
    expect(toneOf(CALL_STATE_TONE, "a_state_that_does_not_exist")).toBe("neutral");
    expect(toneOf(CALL_STATE_TONE, null)).toBe("neutral");
    expect(toneOf(CALL_STATE_TONE, "")).toBe("neutral");
  });

  it("humanizes a wire enum and renders an absent value as an em dash", () => {
    expect(humanize("disposition_pending")).toBe("Disposition pending");
    expect(humanize(null)).toBe("—");
    expect(humanize("")).toBe("—");
  });

  it("slices instants at the grain each surface reads them", () => {
    const iso = "2026-07-31T02:14:59.000Z";
    expect(shortDate(iso)).toBe("2026-07-31");
    expect(dateTime(iso)).toBe("2026-07-31 02:14");
    expect(clockTime(iso)).toBe("02:14");
    expect(dateTime(null)).toBe("—");
  });

  it("shortens an identifier for display without ever shortening a link target", () => {
    expect(shortId("0192f3a4-b5c6-7d8e-9f01-234567890abc")).toBe("0192f3a4");
    expect(shortId(null)).toBe("—");
  });

  it("counts elapsed minutes and never returns a negative age", () => {
    const now = Date.parse("2026-07-31T03:00:00.000Z");
    expect(minutesSince("2026-07-31T02:00:00.000Z", now)).toBe(60);
    // An instant in the future is age 0, not a negative duration.
    expect(minutesSince("2026-07-31T04:00:00.000Z", now)).toBe(0);
    expect(minutesSince(null, now)).toBe(0);
  });

  it("distinguishes a zero duration from an unanswerable one", () => {
    expect(durationLabel(0)).toBe("0m");
    expect(durationLabel(45)).toBe("45m");
    expect(durationLabel(134)).toBe("2h 14m");
    expect(durationLabel(120)).toBe("2h 00m");
    // A mean over no calls is "—". Printing "0m" would read as an achievement.
    expect(durationLabel(undefined)).toBe("—");
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(Number.NaN)).toBe("—");
  });

  it("treats a shift window as half-open, so a handover instant belongs to exactly one shift", () => {
    const start = "2026-07-31T19:00:00.000Z";
    const end = "2026-08-01T07:00:00.000Z";
    expect(isWithinWindow(start, end, Date.parse("2026-07-31T19:00:00.000Z"))).toBe(true);
    expect(isWithinWindow(start, end, Date.parse("2026-08-01T02:00:00.000Z"))).toBe(true);
    // The end instant belongs to the NEXT shift, not to this one.
    expect(isWithinWindow(start, end, Date.parse("2026-08-01T07:00:00.000Z"))).toBe(false);
    expect(isWithinWindow(start, end, Date.parse("2026-07-31T18:59:00.000Z"))).toBe(false);
    expect(isWithinWindow("not-an-instant", end, Date.parse(start))).toBe(false);
  });

  it("round-trips a datetime-local value into an ISO instant", () => {
    const iso = toInstant("2026-07-31T02:14");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
    expect(iso.endsWith("Z")).toBe(true);
    // An unparseable value becomes "now" rather than travelling as garbage — every field using it is
    // optional or defaulted, so "now" is never a silently wrong clinical fact.
    expect(Number.isNaN(Date.parse(toInstant("nonsense")))).toBe(false);
  });
  // ── §5.1 queue filter pickers (F-041 / #101) ────────────────────────────────────────────────────
  //
  // These ran as `key={option.value || "open"}`, and `CALL_STATES` CONTAINS `"open"` — so the
  // unnarrowed sentinel and the real open state rendered as two `<option>`s sharing one key, and React
  // stopped guaranteeing which DOM node belonged to which. The invariant is pinned here rather than in
  // the component because it is a property of the DATA, and because a duplicate key is a console
  // warning at runtime: nothing fails, so nothing catches it.

  it("gives every state-filter option a key that is unique across the list", () => {
    const keys = STATE_FILTERS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every source-filter option a key that is unique across the list", () => {
    const keys = SOURCE_FILTERS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps each sentinel key out of the enum it prepends, so a real member can never collide with it", () => {
    // The specific collision that was live: `""` falling back to the string `"open"`.
    expect(CALL_STATES).toContain("open");
    const sentinel = STATE_FILTERS.find((o) => o.value === "");
    expect(sentinel).toBeDefined();
    expect(CALL_STATES).not.toContain(sentinel?.key as never);
    const sourceSentinel = SOURCE_FILTERS.find((o) => o.value === "");
    expect(sourceSentinel).toBeDefined();
    expect(SOURCE_FILTERS.filter((o) => o.value !== "").map((o) => o.value)).not.toContain(
      sourceSentinel?.key as never,
    );
  });

  it("exposes exactly one unnarrowed sentinel per picker, and every real value once", () => {
    expect(STATE_FILTERS.filter((o) => o.value === "")).toHaveLength(1);
    expect(SOURCE_FILTERS.filter((o) => o.value === "")).toHaveLength(1);
    const states = STATE_FILTERS.filter((o) => o.value !== "").map((o) => o.value);
    expect(states).toEqual([...CALL_STATES]);
    expect(new Set(states).size).toBe(states.length);
  });
});
