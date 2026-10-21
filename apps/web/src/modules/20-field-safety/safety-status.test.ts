// apps/web/src/modules/20-field-safety/safety-status.test.ts — the M20 presentation vocabulary
// (§5 / §6.6 / §9.1).
//
// The pure helpers live in `safety-status.ts` (it imports only the `StatusTone` *type* from @chartwarden/ui,
// erased at runtime), so this suite is colocated in apps/web — a `packages/` test importing it would
// create a forbidden package→app dependency-cruiser edge (the M19 oncall-status.test.ts precedent).
//
// WHAT THIS SUITE IS ACTUALLY GUARDING, beyond "the map has the right keys":
//
//   1. THE ENUM MIRRORS ARE COMPLETE. A wire value a map does not carry falls through to `neutral`, which
//      renders as a grey "inert/terminal" pill. On a SAFETY board that turns an alert nobody has answered
//      into one that looks finished, so every member of every frozen union is asserted present rather
//      than sampled.
//   2. THE THREE SEVERITY DECISIONS THAT COULD BE QUIETLY UNDONE. `emergency_terminus` is OPEN and
//      `critical` (M20-F05 makes it loop, not end); `cancel_attempted_but_rejected` is `critical` (D5's
//      hostile-actor signal — the alert PROCEEDS); `cancelled_in_window` is the one genuinely inert SOS
//      state. A later reader "simplifying" any of the three would break a safety read, not a colour.
//   3. THE TRANSITION PICKER CANNOT OFFER AN UN-SUBMIT. §2.2.3 puts the immutability entry point at
//      `submitted`, and `INCIDENT_TRANSITION_STATES` is what the form renders.
//   4. THE AD-HOC CHECK-IN PICKER CANNOT MINT A VISIT ATTESTATION. The three visit-bound kinds each
//      require a `visit_id` (§3.3's `m20_sci_visit_kind`), so offering them loose would produce a 422 at
//      the moment a clinician is asking for attention.
//   5. THE SCOPE SELECTOR MAP MATCHES §3.3's `m20_sss_scope_integrity`. A wrong entry here asks the DON
//      for a field the database does not want and omits the one it does.
//   6. TRIMMED LENGTH, NOT RAW LENGTH. Every §3.3 free-text CHECK is `length(btrim(...))`; forty spaces
//      must not satisfy a form whose server refuses it.
//   7. A ZERO IS NOT AN UNANSWERABLE. `durationLabel(undefined)` is "—"; a tile printing "0m" for a
//      median over no alerts would read as an achievement.
import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGMENT_OUTCOMES,
  ACK_ACTION_TAKEN_MIN_CHARS,
  AD_HOC_CHECK_IN_KINDS,
  ALERT_KINDS,
  CHECK_IN_BADGE_TONE,
  CHECK_IN_KINDS,
  CHECK_IN_STATE_TONE,
  CHECK_IN_STATUS_TONE,
  CONCERN_NOTE_MIN_CHARS,
  CONSENT_PURPOSES,
  CONSENT_STATUS_TONE,
  COORD_ACCESS_REASON_MIN_CHARS,
  COVERAGE_GAP_REASON_TONE,
  HIGH_RISK_AREA_POLICIES,
  HIGH_RISK_CATEGORIES,
  HIGH_RISK_CATEGORY_TONE,
  INCIDENT_CATEGORIES,
  INCIDENT_CLOSED_STATES,
  INCIDENT_NARRATIVE_MIN_CHARS,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATES,
  INCIDENT_STATE_TONE,
  INCIDENT_TRANSITION_STATES,
  LOCATION_SOURCE_TONE,
  LOCATION_STALE_MINUTES,
  OSHA_REASON_MIN_CHARS,
  OVERDUE_BADGE_TONE,
  SOS_CANCEL_STATUS_TONE,
  SOS_ESCALATION_TIERS,
  SOS_OPEN_STATES,
  SOS_OUTCOMES,
  SOS_RESOLUTION_MIN_CHARS,
  SOS_STATES,
  SOS_STATE_TONE,
  SUBSCRIPTION_MODELS,
  SUBSCRIPTION_SCOPE_KINDS,
  SUBSCRIPTION_SCOPE_SELECTOR,
  charsRemaining,
  checkInStatusLabel,
  clockTime,
  consentPurposeLabel,
  coverageGapLabel,
  dateTime,
  daysAgoInstant,
  durationLabel,
  humanize,
  incidentCategoryLabel,
  isLocationStale,
  locationSourceLabel,
  meetsMinChars,
  minutesSince,
  nowLocalInput,
  secondsLabel,
  secondsUntil,
  shortDate,
  shortId,
  sosStateLabel,
  toInstant,
  toneOf,
} from "./safety-status";

/** The frozen `safety_sos_lifecycle_state` union (packages/types/src/safety.ts, M20-T01). */
const ALL_SOS_STATES = [
  "raised",
  "cancel_window_open",
  "acknowledging",
  "acknowledged",
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
  "emergency_terminus",
  "resolving",
  "resolved",
  "cancelled_in_window",
  "cancel_attempted_but_rejected",
  "incident_opened",
] as const;

/** The frozen `safety_incident_state` union. */
const ALL_INCIDENT_STATES = [
  "draft",
  "submitted",
  "under_review",
  "returned_to_clinician",
  "closed_with_action_plan",
  "closed_no_action",
  "reopened",
] as const;

/** The frozen `safety_check_in_state` union. */
const ALL_CHECK_IN_STATES = [
  "proposed",
  "recorded",
  "overdue",
  "escalated",
  "superseded",
  "incident_opened",
] as const;

/** `SafetyOverdueBadge` (§4.2) and `SafetyCheckInBadge` (§4.3). */
const ALL_OVERDUE_BADGES = ["on_time", "reminder", "overdue", "escalated"] as const;
const ALL_CHECK_IN_BADGES = ["not_required", "pending", "recorded", "overdue"] as const;

/** `SafetyCoverageGapReason` (§4.3) and `SafetyLocationSource` (§4.2). */
const ALL_GAP_REASONS = [
  "no_subscription",
  "all_subscriptions_deactivated",
  "vacation_forwards_unresolved",
] as const;
const ALL_LOCATION_SOURCES = [
  "evv_check_in",
  "evv_check_out",
  "m20_check_in",
  "sos_active",
] as const;

describe("M20 SOS lifecycle vocabulary (§2.2.2)", () => {
  it("carries every frozen safety_sos_lifecycle_state — a missing key renders a live alert as inert", () => {
    for (const s of ALL_SOS_STATES) {
      expect(SOS_STATE_TONE[s], `no tone declared for ${s}`).toBeDefined();
    }
    expect(Object.keys(SOS_STATE_TONE).sort()).toEqual([...ALL_SOS_STATES].sort());
    expect([...SOS_STATES].sort()).toEqual([...ALL_SOS_STATES].sort());
  });

  it("keeps emergency_terminus in the OPEN set — M20-F05 makes it loop, not end", () => {
    // Treating it as terminal is how the chain would quietly stop on an alert nobody has answered.
    expect(SOS_OPEN_STATES).toContain("emergency_terminus");
    expect(SOS_OPEN_STATES).not.toContain("resolved");
    expect(SOS_OPEN_STATES).not.toContain("cancelled_in_window");
    expect(SOS_OPEN_STATES).toHaveLength(9);
    expect(SOS_STATE_TONE.emergency_terminus).toBe("critical");
  });

  it("reads a REJECTED cancel as the strongest signal and a successful one as inert (D5)", () => {
    // The button was pressed, the check failed, and the alert PROCEEDS. A calm colour here would tell a
    // supervisor the opposite of what happened.
    expect(SOS_STATE_TONE.cancel_attempted_but_rejected).toBe("critical");
    expect(SOS_CANCEL_STATUS_TONE.cancel_attempted_but_rejected).toBe("critical");
    // She un-pressed her own button inside five seconds; nothing happened.
    expect(SOS_STATE_TONE.cancelled_in_window).toBe("neutral");
    expect(SOS_CANCEL_STATUS_TONE.cancelled_in_window).toBe("neutral");
    expect(SOS_CANCEL_STATUS_TONE.not_cancelled).toBe("neutral");
  });

  it("keeps the three escalation rungs in LADDER order, not alphabetical", () => {
    expect(SOS_ESCALATION_TIERS).toEqual([
      "escalation_tier_1",
      "escalation_tier_2",
      "escalation_tier_3",
    ]);
    expect(SOS_ESCALATION_TIERS.indexOf("escalation_tier_3")).toBeGreaterThan(
      SOS_ESCALATION_TIERS.indexOf("escalation_tier_1"),
    );
  });

  it("labels every state in words a supervisor reads at 3 a.m., never as a raw enum", () => {
    for (const s of ALL_SOS_STATES) {
      expect(sosStateLabel(s)).not.toContain("_");
    }
    // The two labels that carry a fact the enum name does not.
    expect(sosStateLabel("emergency_terminus")).toContain("still unanswered");
    expect(sosStateLabel("cancel_attempted_but_rejected")).toContain("proceeding");
    expect(sosStateLabel(null)).toBe("—");
  });

  it("carries every SOS and acknowledgment outcome, and keeps the two vocabularies apart", () => {
    expect(SOS_OUTCOMES).toHaveLength(6);
    expect(ACKNOWLEDGMENT_OUTCOMES).toHaveLength(5);
    // The acknowledgment is the FIRST act, the outcome the LAST. `dispatched_supervisor` is not a way an
    // alert ends and `visit_cancelled` is not something a responder did on picking up.
    expect(SOS_OUTCOMES).toContain("visit_cancelled");
    expect(SOS_OUTCOMES).not.toContain("dispatched_supervisor");
    expect(ACKNOWLEDGMENT_OUTCOMES).toContain("dispatched_supervisor");
    expect(ACKNOWLEDGMENT_OUTCOMES).not.toContain("visit_cancelled");
  });
});

describe("M20 check-in vocabulary (D2 / D4 / §2.2.1)", () => {
  it("tones every attestation status, with 'stopping' as the strongest", () => {
    expect(CHECK_IN_STATUS_TONE.ok).toBe("success");
    expect(CHECK_IN_STATUS_TONE.concerned_continue).toBe("warning");
    expect(CHECK_IN_STATUS_TONE.concerned_stop).toBe("error");
    expect(Object.keys(CHECK_IN_STATUS_TONE).sort()).toEqual(
      ["ok", "concerned_continue", "concerned_stop"].sort(),
    );
  });

  it("labels the statuses in the clinician's own words", () => {
    expect(checkInStatusLabel("ok")).toBe("I'm OK");
    expect(checkInStatusLabel("concerned_stop")).toContain("stopping");
    expect(checkInStatusLabel(null)).toBe("—");
  });

  it("carries every check-in state and never reads an outstanding obligation as inert", () => {
    for (const s of ALL_CHECK_IN_STATES) {
      expect(CHECK_IN_STATE_TONE[s], `no tone for ${s}`).toBeDefined();
    }
    // An unanswered promise to check in is the thing the whole D4 ladder exists for.
    expect(CHECK_IN_STATE_TONE.proposed).toBe("progress");
    expect(CHECK_IN_STATE_TONE.escalated).toBe("critical");
    expect(CHECK_IN_STATE_TONE.superseded).toBe("neutral");
  });

  it("offers only the two UNPROMPTED kinds on the ad-hoc picker (§3.3 m20_sci_visit_kind)", () => {
    expect(CHECK_IN_KINDS).toHaveLength(5);
    expect(AD_HOC_CHECK_IN_KINDS).toEqual(["between_visits", "ad_hoc"]);
    for (const visitBound of ["pre_visit", "mid_visit", "post_visit"]) {
      expect(CHECK_IN_KINDS).toContain(visitBound);
      // Each needs a visit_id; offering it loose produces a 422 at the worst moment.
      expect(AD_HOC_CHECK_IN_KINDS).not.toContain(visitBound);
    }
  });

  it("tones the D4 overdue ladder with the last rung as the reserved safety tone", () => {
    for (const b of ALL_OVERDUE_BADGES) {
      expect(OVERDUE_BADGE_TONE[b], `no tone for ${b}`).toBeDefined();
    }
    expect(OVERDUE_BADGE_TONE.on_time).toBe("success");
    expect(OVERDUE_BADGE_TONE.escalated).toBe("critical");
  });

  it("keeps 'not required' distinct from 'recorded' on the per-visit badge trio", () => {
    for (const b of ALL_CHECK_IN_BADGES) {
      expect(CHECK_IN_BADGE_TONE[b], `no tone for ${b}`).toBeDefined();
    }
    // Green here would claim an attestation that never happened.
    expect(CHECK_IN_BADGE_TONE.not_required).toBe("neutral");
    expect(CHECK_IN_BADGE_TONE.recorded).toBe("success");
  });
});

describe("M20 incident vocabulary (§2.2.3 / D9)", () => {
  it("carries every frozen safety_incident_state", () => {
    for (const s of ALL_INCIDENT_STATES) {
      expect(INCIDENT_STATE_TONE[s], `no tone for ${s}`).toBeDefined();
    }
    expect([...INCIDENT_STATES].sort()).toEqual([...ALL_INCIDENT_STATES].sort());
  });

  it("keeps returned-to-clinician and reopened as needing attention, not as inert", () => {
    // The ball is with somebody who may not be looking; a supervisor's queue must not lose either.
    expect(INCIDENT_STATE_TONE.returned_to_clinician).toBe("warning");
    expect(INCIDENT_STATE_TONE.reopened).toBe("warning");
    // Only ONE of the two closures left the agency with something to do differently.
    expect(INCIDENT_STATE_TONE.closed_with_action_plan).toBe("success");
    expect(INCIDENT_STATE_TONE.closed_no_action).toBe("neutral");
  });

  it("cannot offer an un-submit: the transition picker excludes draft and submitted", () => {
    expect(INCIDENT_TRANSITION_STATES).toEqual([
      "under_review",
      "returned_to_clinician",
      "closed_with_action_plan",
      "closed_no_action",
      "reopened",
    ]);
    expect(INCIDENT_TRANSITION_STATES).not.toContain("draft");
    // §2.2.3 puts the immutability entry point exactly here.
    expect(INCIDENT_TRANSITION_STATES).not.toContain("submitted");
  });

  it("names the two closures, and only the action-plan one demands a plan", () => {
    expect(INCIDENT_CLOSED_STATES).toEqual(["closed_with_action_plan", "closed_no_action"]);
    for (const s of INCIDENT_CLOSED_STATES) expect(INCIDENT_STATES).toContain(s);
  });

  it("carries all twelve categories and four severities, severities in ORDER", () => {
    expect(INCIDENT_CATEGORIES).toHaveLength(12);
    // Sorted alphabetically, "life_threatening" would land second. The ledger ranks on this index.
    expect(INCIDENT_SEVERITIES).toEqual(["minor", "moderate", "serious", "life_threatening"]);
    for (const s of INCIDENT_SEVERITIES) {
      expect(INCIDENT_SEVERITY_TONE[s], `no tone for ${s}`).toBeDefined();
    }
    expect(INCIDENT_SEVERITY_TONE.life_threatening).toBe("critical");
    expect(INCIDENT_SEVERITY_TONE.minor).toBe("neutral");
  });

  it("labels every category without leaving a raw enum on a workers-comp form", () => {
    for (const c of INCIDENT_CATEGORIES) {
      expect(incidentCategoryLabel(c)).not.toContain("_");
    }
    expect(incidentCategoryLabel("medical_emergency_clinician_self")).toBe(
      "Medical emergency — clinician",
    );
  });
});

describe("M20 subscription + area + consent vocabulary (D6 / D8 / D10 / D12)", () => {
  it("maps every scope kind to the selector §3.3's m20_sss_scope_integrity requires", () => {
    expect([...SUBSCRIPTION_SCOPE_KINDS].sort()).toEqual(
      ["explicit", "location", "provider_entity", "role"].sort(),
    );
    expect(SUBSCRIPTION_SCOPE_SELECTOR.explicit).toBe("clinician");
    expect(SUBSCRIPTION_SCOPE_SELECTOR.location).toBe("location");
    expect(SUBSCRIPTION_SCOPE_SELECTOR.provider_entity).toBe("providerEntity");
    // `role` requires none — asking for one would be asking for a column the CHECK does not want.
    expect(SUBSCRIPTION_SCOPE_SELECTOR.role).toBeNull();
    for (const k of SUBSCRIPTION_SCOPE_KINDS) {
      expect(Object.hasOwn(SUBSCRIPTION_SCOPE_SELECTOR, k), `no selector rule for ${k}`).toBe(true);
    }
  });

  it("keeps the tenant-wide model distinct from one row's scope kind", () => {
    expect(SUBSCRIPTION_MODELS).toEqual([
      "location_scoped",
      "provider_entity_scoped",
      "role_scoped",
      "explicit_only",
    ]);
    // They are different vocabularies and must never be offered from one picker.
    for (const m of SUBSCRIPTION_MODELS) expect(SUBSCRIPTION_SCOPE_KINDS).not.toContain(m);
  });

  it("carries the four alert kinds a subscription may page on", () => {
    expect(ALERT_KINDS).toEqual(["sos", "overdue", "incident", "high_risk_area"]);
  });

  it("tones every coverage-gap reason as a FINDING — none is informational", () => {
    for (const r of ALL_GAP_REASONS) {
      expect(COVERAGE_GAP_REASON_TONE[r], `no tone for ${r}`).toBeDefined();
      expect(COVERAGE_GAP_REASON_TONE[r]).not.toBe("neutral");
      expect(COVERAGE_GAP_REASON_TONE[r]).not.toBe("success");
    }
    expect(COVERAGE_GAP_REASON_TONE.all_subscriptions_deactivated).toBe("critical");
    expect(coverageGapLabel("no_subscription")).toContain("Nobody is subscribed");
    expect(coverageGapLabel(null)).toBe("—");
  });

  it("carries the five D12 categories and three area policies, all advisory", () => {
    expect(HIGH_RISK_CATEGORIES).toHaveLength(5);
    for (const c of HIGH_RISK_CATEGORIES) {
      expect(HIGH_RISK_CATEGORY_TONE[c], `no tone for ${c}`).toBeDefined();
    }
    expect(HIGH_RISK_AREA_POLICIES).toEqual([
      "advisory_only",
      "requires_pre_visit_check_in",
      "requires_buddy_visit",
    ]);
  });

  it("carries the three consent purposes and keeps expired apart from revoked (§2.2.8)", () => {
    expect(CONSENT_PURPOSES).toEqual([
      "sos_coordinates",
      "continuous_location_during_sos",
      "emergency_contact_call",
    ]);
    // A rotation that lapsed is a lapse to re-ask about; a withdrawal is her decision and needs nothing.
    // A coercion review reads exactly this difference, so the two must not render alike.
    expect(CONSENT_STATUS_TONE.expired).toBe("warning");
    expect(CONSENT_STATUS_TONE.revoked).toBe("neutral");
    expect(CONSENT_STATUS_TONE.granted).toBe("success");
    expect(CONSENT_STATUS_TONE.expired).not.toBe(CONSENT_STATUS_TONE.revoked);
  });

  it("labels each consent purpose as the thing she is agreeing to, not as a column name", () => {
    for (const p of CONSENT_PURPOSES) {
      expect(consentPurposeLabel(p)).not.toContain("_");
    }
    expect(consentPurposeLabel("sos_coordinates")).toContain("SOS");
  });

  it("tones and labels every last-known-location source", () => {
    for (const s of ALL_LOCATION_SOURCES) {
      expect(LOCATION_SOURCE_TONE[s], `no tone for ${s}`).toBeDefined();
      expect(locationSourceLabel(s)).not.toContain("_");
    }
    expect(LOCATION_SOURCE_TONE.sos_active).toBe("critical");
    expect(locationSourceLabel("evv_check_in")).toBe("EVV arrival");
  });
});

describe("M20 server-floor mirrors", () => {
  it("mirrors each §4.2 / §3.3 minimum at the value the server actually enforces", () => {
    expect(CONCERN_NOTE_MIN_CHARS).toBe(20);
    expect(ACK_ACTION_TAKEN_MIN_CHARS).toBe(40);
    expect(SOS_RESOLUTION_MIN_CHARS).toBe(100);
    expect(INCIDENT_NARRATIVE_MIN_CHARS).toBe(200);
    expect(OSHA_REASON_MIN_CHARS).toBe(40);
    expect(COORD_ACCESS_REASON_MIN_CHARS).toBe(40);
  });

  it("counts TRIMMED characters, because every §3.3 CHECK is length(btrim(...))", () => {
    // Forty spaces satisfies a naive `.length` and is refused by the database — the worst of both.
    expect(meetsMinChars(" ".repeat(50), 40)).toBe(false);
    expect(meetsMinChars(`  ${"x".repeat(40)}  `, 40)).toBe(true);
    expect(charsRemaining(" ".repeat(50), 40)).toBe(40);
    expect(charsRemaining("x".repeat(41), 40)).toBe(0);
  });
});

describe("M20 formatting helpers", () => {
  it("defaults an unknown enum to neutral rather than throwing", () => {
    expect(toneOf(SOS_STATE_TONE, "a_state_that_does_not_exist")).toBe("neutral");
    expect(toneOf(SOS_STATE_TONE, null)).toBe("neutral");
    expect(toneOf(SOS_STATE_TONE, "")).toBe("neutral");
  });

  it("humanizes a wire enum and renders an absent value as an em dash", () => {
    expect(humanize("escalation_tier_2")).toBe("Escalation tier 2");
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
    expect(minutesSince("2026-07-31T04:00:00.000Z", now)).toBe(0);
    expect(minutesSince(null, now)).toBe(0);
  });

  it("counts the D5 cancel window DOWN and floors it at zero once it has closed", () => {
    const now = Date.parse("2026-07-31T03:00:00.000Z");
    expect(secondsUntil("2026-07-31T03:00:05.000Z", now)).toBe(5);
    // An expired window is 0, not a negative number the ring would render as text.
    expect(secondsUntil("2026-07-31T02:59:55.000Z", now)).toBe(0);
    expect(secondsUntil(null, now)).toBe(0);
    expect(secondsUntil("not-an-instant", now)).toBe(0);
  });

  it("distinguishes a zero duration from an unanswerable one", () => {
    expect(durationLabel(0)).toBe("0m");
    expect(durationLabel(45)).toBe("45m");
    expect(durationLabel(134)).toBe("2h 14m");
    expect(durationLabel(120)).toBe("2h 00m");
    // A median over no alerts is "—". Printing "0m" would read as an achievement.
    expect(durationLabel(undefined)).toBe("—");
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(Number.NaN)).toBe("—");
  });

  it("renders the policy SLA knobs in seconds and minutes the way a human reads them", () => {
    expect(secondsLabel(45)).toBe("45s");
    expect(secondsLabel(120)).toBe("2m 00s");
    expect(secondsLabel(null)).toBe("—");
    expect(secondsLabel(Number.NaN)).toBe("—");
  });

  it("treats 'no position' and 'a stale position' as different facts", () => {
    // A clinician who has never checked in and one whose last ping was two hours ago need different
    // phone calls; a helper that answered `true` for both would collapse them on the board.
    expect(isLocationStale(null)).toBe(false);
    expect(isLocationStale(undefined)).toBe(false);
    expect(isLocationStale(LOCATION_STALE_MINUTES)).toBe(true);
    expect(isLocationStale(LOCATION_STALE_MINUTES - 1)).toBe(false);
  });

  it("round-trips a datetime-local value into an ISO instant", () => {
    const iso = toInstant("2026-07-31T02:14");
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
    expect(iso.endsWith("Z")).toBe(true);
    // An unparseable value becomes "now" rather than travelling as garbage.
    expect(Number.isNaN(Date.parse(toInstant("nonsense")))).toBe(false);
    expect(nowLocalInput()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("computes the 90-day history window the personal page asks the server for", () => {
    const now = Date.parse("2026-07-31T00:00:00.000Z");
    expect(daysAgoInstant(90, now)).toBe("2026-05-02T00:00:00.000Z");
  });
});
