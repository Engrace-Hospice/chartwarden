// apps/backend/__tests__/field-safety-lifecycle.test.ts — M20-T03 (§2.2.2 SOS machine + §4.8 SLA watchdog,
// D4 overdue rungs / §7.3, D6 continuous-location gates / §7.9 / §8.7, §7.8 coverage-gap watchdog, §2.2.4
// policy resolver).
//
// The pure M20 field-safety domain core — no DB, no seams, no clock: every fact is injected. The tests that
// matter most here are the ones that pin a decision the spec's own prose and its own diagram disagree about
// (the fan-out instant, the rejected cancel, §7.3's non-existent schedule states), because those are the
// ones a later reader "fixes" back into the failure.
import type {
  IsoInstant,
  MembershipId,
  SafetyPolicyEffectiveDto,
  SafetySosLifecycleState,
} from "@chartwarden/types";
import {
  SAFETY_POLICY_FLOOR,
  SAFETY_SOS_OPEN_STATES,
  SAFETY_SOS_TERMINAL_STATES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  SAFETY_SOS_EDGES,
  SAFETY_SOS_STREAMING_STATES,
  type SafetyCheckInScheduleFacts,
  type SafetyCoverageSubjectFacts,
  type SafetySideEffect,
  type SafetySosAlertFacts,
  type SafetyStreamConsentFacts,
  type SafetySubscriptionFacts,
  acknowledgeSos,
  assertPolicyEditValid,
  assertScheduleActionable,
  assertSosVersion,
  assertStreamSampleWritable,
  availableSosCommands,
  beginSosResolution,
  cancelSos,
  coverageGapFor,
  decideLocationStreamSample,
  decideOverdueCheckIn,
  decideSosWatchdog,
  detectCoverageGaps,
  escalateSos,
  expireCancelWindow,
  isAfterHours,
  isStreamConsentActive,
  mergeEffectivePolicy,
  openIncidentFromSos,
  overdueBadgeFor,
  overdueTierFor,
  policyBoundViolations,
  policyThresholdDiffs,
  raiseSosEffects,
  repageTerminus,
  resolveSos,
  resolveSosEdge,
  safetyPolicyFloorSeed,
  sosTierDwellSeconds,
  subscriptionCovers,
  terminusLoopIteration,
} from "../src/modules/20-field-safety/lifecycle/index";

/**
 * Assert a guard raises the exact machine-readable code. `ChartWardenError.message` is prose for the clinician;
 * the CODE is the contract the §5 screens and the §7 tables key off, so the tests assert on it —
 * `toThrowError(/CODE/)` passes only when the prose happens to contain the token (the M15-T03 finding).
 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

const ORG = "org-1";
const SARAH = "mem-sarah" as MembershipId;
const MARIA = "mem-maria" as MembershipId;

/** The floor policy as an effective DTO — what every tenant starts from (§3.2 Phase E). */
const POLICY: SafetyPolicyEffectiveDto = mergeEffectivePolicy(ORG, {
  versionId: "spv-1",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
});

function alertFacts(over: Partial<SafetySosAlertFacts> = {}): SafetySosAlertFacts {
  return {
    lifecycleState: "cancel_window_open",
    version: 1,
    postedByMembershipId: SARAH,
    postedAt: "2026-07-31T11:00:00.000Z",
    cancelWindowExpiredAt: "2026-07-31T11:00:05.000Z",
    cancelStatus: "not_cancelled",
    lastKnownVisitId: null,
    linkedIncidentId: null,
    ...over,
  };
}

function scheduleFacts(over: Partial<SafetyCheckInScheduleFacts> = {}): SafetyCheckInScheduleFacts {
  return {
    scheduleId: "sched-1",
    state: "proposed",
    kind: "mid_visit",
    expectedAt: "2026-07-31T14:00:00.000Z",
    windowMinutes: 5,
    clinicianMembershipId: SARAH,
    visitId: "visit-1",
    overdueDetectedAt: null,
    escalatedAt: null,
    ...over,
  };
}

function kinds(effects: ReadonlyArray<SafetySideEffect>): readonly string[] {
  return effects.map((e) => e.kind);
}

function events(effects: ReadonlyArray<SafetySideEffect>): readonly string[] {
  return effects.filter((e) => e.kind === "outbox").map((e) => (e as { event: string }).event);
}

// ── §2.2.2 the SOS machine ────────────────────────────────────────────────────────────────────────────

describe("§2.2.2 SOS transition table", () => {
  it("agrees with `SAFETY_SOS_TERMINAL_STATES` — no edge leaves a terminal state", () => {
    for (const terminal of SAFETY_SOS_TERMINAL_STATES) {
      expect(SAFETY_SOS_EDGES.some((e) => e.from === terminal)).toBe(false);
      expect(availableSosCommands(terminal)).toEqual([]);
      expectCode(() => resolveSosEdge(terminal, "acknowledge"), "SOS_TERMINAL");
    }
  });

  it("has no (from, command) pair with two targets — a duplicate key silently picks the first", () => {
    const seen = new Set<string>();
    for (const edge of SAFETY_SOS_EDGES) {
      const key = `${edge.from}::${edge.command}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("accepts `acknowledge` from EVERY pre-acknowledged open state, not only the two §2.2.2 draws", () => {
    const acknowledgeable: readonly SafetySosLifecycleState[] = [
      "acknowledging",
      "escalation_tier_1",
      "escalation_tier_2",
      "escalation_tier_3",
      "emergency_terminus",
    ];
    for (const from of acknowledgeable) {
      expect(resolveSosEdge(from, "acknowledge").to).toBe("acknowledged");
    }
  });

  it("refuses a command that has no edge from the state", () => {
    expectCode(() => resolveSosEdge("acknowledging", "resolve"), "SOS_INVALID_STATE_TRANSITION");
    expectCode(() => resolveSosEdge("acknowledged", "escalate"), "SOS_INVALID_STATE_TRANSITION");
  });

  it("refuses a stale write with the spec's own 409 code, not the platform 412", () => {
    expectCode(() => assertSosVersion(3, 2), "STALE_LIFECYCLE_STATE");
    expect(() => assertSosVersion(2, 2)).not.toThrow();
  });
});

describe("§2.2.2 / D5 the press", () => {
  it("fans out AT THE PRESS — the alert is emitted before the cancel window closes", () => {
    const effects = raiseSosEffects({
      at: "2026-07-31T11:00:00.000Z",
      deviceAttested: true,
      coordinatesCaptured: true,
      pressesInLastHour: 1,
    });
    expect(events(effects)).toContain("m20.safety.sos_alert_raised");
    expect(effects.some((e) => e.kind === "alert")).toBe(true);
    // The history row records the state the row is actually written in.
    const history = effects.find((e) => e.kind === "sos_state_history");
    expect(history).toMatchObject({ from: null, to: "cancel_window_open" });
  });

  it("lands a D15 offline-synced press in `raised` so `openCancelWindow` can move it", () => {
    const effects = raiseSosEffects({
      at: "2026-07-31T11:00:00.000Z",
      deviceAttested: true,
      coordinatesCaptured: true,
      pressesInLastHour: 1,
      offlineSync: true,
    });
    expect(effects.find((e) => e.kind === "sos_state_history")).toMatchObject({ to: "raised" });
  });

  it("records an unattested device and a declined-coordinates press WITHOUT gating either", () => {
    const effects = raiseSosEffects({
      at: "2026-07-31T11:00:00.000Z",
      deviceAttested: false,
      coordinatesCaptured: false,
      pressesInLastHour: 1,
    });
    expect(events(effects)).toContain("m20.safety.sos_alert_raised");
    expect(events(effects)).toContain("m20.safety.device_attestation_anomaly");
  });

  it("flags §8.3 press volume above the threshold and still fans the press out", () => {
    const effects = raiseSosEffects({
      at: "2026-07-31T11:00:00.000Z",
      deviceAttested: true,
      coordinatesCaptured: true,
      pressesInLastHour: 11,
    });
    expect(events(effects)).toContain("m20.safety.sos_anomaly_volume");
    expect(events(effects)).toContain("m20.safety.sos_alert_raised");
  });
});

describe("D5 / §7.4 the cancel", () => {
  it("cancels on a passing biometric and clears the recipients' surface", () => {
    const decision = cancelSos({
      alert: alertFacts(),
      by: SARAH,
      at: "2026-07-31T11:00:03.000Z",
      biometricRequired: true,
      biometricResult: "passed",
    });
    expect(decision.kind).toBe("cancelled");
    if (decision.kind !== "cancelled") return;
    expect(decision.transition.to).toBe("cancelled_in_window");
    expect(decision.transition.effects).toContainEqual({
      kind: "set_cancel_status",
      status: "cancelled_in_window",
      biometricResult: "passed",
      attemptedAt: "2026-07-31T11:00:03.000Z",
    });
    expect(events(decision.transition.effects)).toContain("m20.safety.sos_alert_acknowledged");
  });

  it("§7.4 alternative outcome — a FAILED biometric does NOT move the lifecycle", () => {
    const decision = cancelSos({
      alert: alertFacts(),
      by: SARAH,
      at: "2026-07-31T11:00:03.000Z",
      biometricRequired: true,
      biometricResult: "failed",
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") return;
    // No history row: the state does not move, and `m20_ssash_no_self` would refuse a from===to row.
    expect(kinds(decision.effects)).not.toContain("sos_state_history");
    expect(decision.effects).toContainEqual({
      kind: "set_cancel_status",
      status: "cancel_attempted_but_rejected",
      biometricResult: "failed",
      attemptedAt: "2026-07-31T11:00:03.000Z",
    });
    expect(events(decision.effects)).toContain("m20.safety.sos_alert_cancel_attempted_rejected");
  });

  it("treats a missing biometric as a rejection when the tenant requires one", () => {
    const decision = cancelSos({
      alert: alertFacts(),
      by: SARAH,
      at: "2026-07-31T11:00:03.000Z",
      biometricRequired: true,
      biometricResult: null,
    });
    expect(decision.kind).toBe("rejected");
  });

  it("records `not_required` — NOT `passed` — when the tenant does not require a biometric", () => {
    const decision = cancelSos({
      alert: alertFacts(),
      by: SARAH,
      at: "2026-07-31T11:00:03.000Z",
      biometricRequired: false,
      biometricResult: null,
    });
    expect(decision.kind).toBe("cancelled");
    if (decision.kind !== "cancelled") return;
    expect(decision.transition.effects).toContainEqual(
      expect.objectContaining({ kind: "set_cancel_status", biometricResult: "not_required" }),
    );
  });

  it("refuses a cancel after the window with §2.2.2's verbatim code", () => {
    expectCode(
      () =>
        cancelSos({
          alert: alertFacts(),
          by: SARAH,
          at: "2026-07-31T11:00:06.000Z",
          biometricRequired: true,
          biometricResult: "passed",
        }),
      "CANCEL_WINDOW_EXPIRED",
    );
  });

  it("refuses a cancel by anybody but the raiser — a supervisor stands it down by acknowledging", () => {
    expectCode(
      () =>
        cancelSos({
          alert: alertFacts(),
          by: MARIA,
          at: "2026-07-31T11:00:03.000Z",
          biometricRequired: true,
          biometricResult: "passed",
        }),
      "CANCEL_NOT_BY_RAISER",
    );
  });

  it("checks the window BEFORE the raiser, so a hostile actor learns nothing from the order", () => {
    expectCode(
      () =>
        cancelSos({
          alert: alertFacts(),
          by: MARIA,
          at: "2026-07-31T11:01:00.000Z",
          biometricRequired: true,
          biometricResult: "passed",
        }),
      "CANCEL_WINDOW_EXPIRED",
    );
  });

  it("will not expire the cancel window early", () => {
    expectCode(
      () => expireCancelWindow({ alert: alertFacts(), at: "2026-07-31T11:00:02.000Z" }),
      "SOS_INVALID_STATE_TRANSITION",
    );
    expect(expireCancelWindow({ alert: alertFacts(), at: "2026-07-31T11:00:05.000Z" }).to).toBe(
      "acknowledging",
    );
  });
});

describe("§2.2.2 the escalation ladder and its terminus", () => {
  it("walks acknowledging → tier_1 → tier_2 → tier_3 → emergency_terminus", () => {
    let state: SafetySosLifecycleState = "acknowledging";
    const walked: SafetySosLifecycleState[] = [];
    for (let i = 0; i < 4; i += 1) {
      const t = escalateSos({
        alert: alertFacts({ lifecycleState: state }),
        reasonCode: "sla_breach",
        at: "2026-07-31T11:05:00.000Z",
      });
      state = t.to;
      walked.push(state);
    }
    expect(walked).toEqual([
      "escalation_tier_1",
      "escalation_tier_2",
      "escalation_tier_3",
      "emergency_terminus",
    ]);
  });

  it("carries §2.2.2's terminus quartet — dial, PSAP, ops page, and the critical event", () => {
    const t = escalateSos({
      alert: alertFacts({ lifecycleState: "escalation_tier_3" }),
      reasonCode: "sla_breach",
      at: "2026-07-31T11:10:00.000Z",
      emergencyContactConsent: true,
    });
    expect(kinds(t.effects)).toContain("dial_emergency_contact");
    expect(kinds(t.effects)).toContain("surface_psap_number");
    expect(kinds(t.effects)).toContain("page_wardenx_ops");
    expect(events(t.effects)).toContain("m20.safety.sos_terminus_reached");
  });

  it("reaches the terminus even with no emergency contact to dial, and says so", () => {
    const t = escalateSos({
      alert: alertFacts({ lifecycleState: "escalation_tier_3" }),
      reasonCode: "sla_breach",
      at: "2026-07-31T11:10:00.000Z",
      emergencyContactConsent: false,
    });
    expect(t.to).toBe("emergency_terminus");
    expect(t.effects).toContainEqual({ kind: "dial_emergency_contact", consentPresent: false });
  });

  it("marks a watchdog advance as a SYSTEM act and a manual one as a person's", () => {
    const auto = escalateSos({
      alert: alertFacts({ lifecycleState: "acknowledging" }),
      reasonCode: "sla_breach",
      at: "2026-07-31T11:05:00.000Z",
    });
    const manual = escalateSos({
      alert: alertFacts({ lifecycleState: "acknowledging" }),
      reasonCode: "manual",
      at: "2026-07-31T11:05:00.000Z",
    });
    expect(auto.effects).toContainEqual(expect.objectContaining({ systemActor: true }));
    expect(manual.effects).toContainEqual(expect.objectContaining({ systemActor: false }));
  });

  it("re-pages the terminus WITHOUT a state-history row (`m20_ssash_no_self` would refuse one)", () => {
    const effects = repageTerminus({
      alert: alertFacts({ lifecycleState: "emergency_terminus" }),
      loopIteration: 3,
      emergencyContactConsent: true,
    });
    expect(kinds(effects)).not.toContain("sos_state_history");
    expect(events(effects)).toContain("m20.safety.sos_terminus_reached");
    expect(kinds(effects)).toContain("page_wardenx_ops");
  });

  it("refuses to re-page an alert that is not in the terminus", () => {
    expectCode(
      () =>
        repageTerminus({
          alert: alertFacts({ lifecycleState: "escalation_tier_3" }),
          loopIteration: 1,
          emergencyContactConsent: true,
        }),
      "SOS_INVALID_STATE_TRANSITION",
    );
  });

  it("numbers the loop from 1 for the first RE-page (the entry itself is 0)", () => {
    const entered = "2026-07-31T11:10:00.000Z";
    expect(
      terminusLoopIteration({ terminusEnteredAt: entered, nowIso: entered, loopSeconds: 300 }),
    ).toBe(0);
    expect(
      terminusLoopIteration({
        terminusEnteredAt: entered,
        nowIso: "2026-07-31T11:15:00.000Z",
        loopSeconds: 300,
      }),
    ).toBe(1);
    expect(
      terminusLoopIteration({
        terminusEnteredAt: entered,
        nowIso: "2026-07-31T11:26:00.000Z",
        loopSeconds: 300,
      }),
    ).toBe(3);
  });
});

describe("§2.2.2 acknowledgment → resolution", () => {
  it("stamps the acknowledger and the instant (`m20_ssa_ack_stamped`)", () => {
    const t = acknowledgeSos({
      alert: alertFacts({ lifecycleState: "escalation_tier_1" }),
      by: MARIA,
      at: "2026-07-31T11:06:00.000Z",
    });
    expect(t.to).toBe("acknowledged");
    expect(t.effects).toContainEqual({
      kind: "set_actor",
      field: "acknowledged_by_membership_id",
      membershipId: MARIA,
    });
    expect(events(t.effects)).toContain("m20.safety.sos_alert_acknowledged");
  });

  it("requires an outcome AND a narrative to resolve", () => {
    const resolving = alertFacts({ lifecycleState: "resolving" });
    expectCode(
      () =>
        resolveSos({
          alert: resolving,
          by: MARIA,
          outcome: null,
          resolutionNarrative: "dispatched",
          at: "2026-07-31T11:30:00.000Z",
        }),
      "SOS_OUTCOME_REQUIRED",
    );
    expectCode(
      () =>
        resolveSos({
          alert: resolving,
          by: MARIA,
          outcome: "clinician_safe_continued",
          resolutionNarrative: "   ",
          at: "2026-07-31T11:30:00.000Z",
        }),
      "SOS_RESOLUTION_NARRATIVE_REQUIRED",
    );
  });

  it("§7.5 — `visit_cancelled` asks M17 through the outbox and needs a visit to name", () => {
    expectCode(
      () =>
        resolveSos({
          alert: alertFacts({ lifecycleState: "resolving", lastKnownVisitId: null }),
          by: MARIA,
          outcome: "visit_cancelled",
          resolutionNarrative: "Backup RN dispatched; visit cut short.",
          at: "2026-07-31T22:52:00.000Z",
        }),
      "SOS_VISIT_CONTEXT_REQUIRED",
    );

    const t = resolveSos({
      alert: alertFacts({ lifecycleState: "resolving", lastKnownVisitId: "visit-9" }),
      by: MARIA,
      outcome: "visit_cancelled",
      resolutionNarrative: "Backup RN dispatched; visit cut short.",
      at: "2026-07-31T22:52:00.000Z",
    });
    expect(t.to).toBe("resolved");
    expect(t.effects).toContainEqual({ kind: "request_visit_cancellation", visitId: "visit-9" });
    expect(events(t.effects)).toContain("m20.safety.visit_cancellation_requested");
    expect(events(t.effects)).toContain("m20.safety.sos_alert_resolved");
  });

  it("refuses `incident_opened` without the incident it names (`m20_ssa_incident_linked`)", () => {
    expectCode(
      () =>
        openIncidentFromSos({
          alert: alertFacts({ lifecycleState: "resolving" }),
          incidentId: null,
        }),
      "SOS_INCIDENT_LINK_REQUIRED",
    );
    expect(
      openIncidentFromSos({
        alert: alertFacts({ lifecycleState: "resolving" }),
        incidentId: "inc-1",
      }).to,
    ).toBe("incident_opened");
  });

  it("keeps `beginResolution` a distinct step so §4.3 can measure to the acknowledgment", () => {
    expect(beginSosResolution(alertFacts({ lifecycleState: "acknowledged" })).to).toBe("resolving");
  });
});

// ── §4.8 the SLA watchdog ─────────────────────────────────────────────────────────────────────────────

describe("§4.8 `m20.sos-sla-watchdog.cron`", () => {
  const base = {
    policy: POLICY,
    emergencyContactConsent: true,
  };

  it("maps each state to the dwell the pinned policy gives it", () => {
    expect(sosTierDwellSeconds("acknowledging", POLICY)).toBe(POLICY.sosTier1SlaSeconds);
    expect(sosTierDwellSeconds("escalation_tier_1", POLICY)).toBe(POLICY.sosTier2SlaSeconds);
    expect(sosTierDwellSeconds("escalation_tier_2", POLICY)).toBe(POLICY.sosTier3SlaSeconds);
    // No tier-4 knob exists — tier 3 governs both the terminus entry and the terminus loop.
    expect(sosTierDwellSeconds("escalation_tier_3", POLICY)).toBe(POLICY.sosTier3SlaSeconds);
    expect(sosTierDwellSeconds("emergency_terminus", POLICY)).toBe(POLICY.sosTier3SlaSeconds);
    // A human is on it; no timer.
    expect(sosTierDwellSeconds("acknowledged", POLICY)).toBeNull();
    expect(sosTierDwellSeconds("resolving", POLICY)).toBeNull();
  });

  it("does nothing before the dwell elapses and reports when it will", () => {
    const decision = decideSosWatchdog({
      ...base,
      alert: alertFacts({ lifecycleState: "acknowledging" }),
      stateEnteredAt: "2026-07-31T11:00:05.000Z",
      nowIso: "2026-07-31T11:00:30.000Z",
    });
    expect(decision.kind).toBe("none");
    if (decision.kind !== "none") return;
    expect(decision.nextDueAt).toBe("2026-07-31T11:01:05.000Z");
  });

  it("advances the rung once the dwell elapses", () => {
    const decision = decideSosWatchdog({
      ...base,
      alert: alertFacts({ lifecycleState: "acknowledging" }),
      stateEnteredAt: "2026-07-31T11:00:05.000Z",
      nowIso: "2026-07-31T11:01:06.000Z",
    });
    expect(decision.kind).toBe("escalate");
    if (decision.kind !== "escalate") return;
    expect(decision.transition.to).toBe("escalation_tier_1");
  });

  it("loops the terminus instead of transitioning it", () => {
    const decision = decideSosWatchdog({
      ...base,
      alert: alertFacts({ lifecycleState: "emergency_terminus" }),
      stateEnteredAt: "2026-07-31T11:10:00.000Z",
      terminusEnteredAt: "2026-07-31T11:10:00.000Z",
      nowIso: "2026-07-31T11:15:30.000Z",
    });
    expect(decision.kind).toBe("terminus_repage");
    if (decision.kind !== "terminus_repage") return;
    expect(decision.loopIteration).toBe(1);
    expect(kinds(decision.effects)).not.toContain("sos_state_history");
  });

  it("sweeps a cancel window the delayed job never closed — the state the SLA index cannot see", () => {
    const decision = decideSosWatchdog({
      ...base,
      alert: alertFacts({ lifecycleState: "cancel_window_open" }),
      stateEnteredAt: "2026-07-31T11:00:00.000Z",
      nowIso: "2026-07-31T11:02:00.000Z",
    });
    expect(decision.kind).toBe("expire_cancel_window");
    if (decision.kind !== "expire_cancel_window") return;
    expect(decision.transition.to).toBe("acknowledging");
  });

  it("leaves an open cancel window alone while it is still open", () => {
    const decision = decideSosWatchdog({
      ...base,
      alert: alertFacts({ lifecycleState: "cancel_window_open" }),
      stateEnteredAt: "2026-07-31T11:00:00.000Z",
      nowIso: "2026-07-31T11:00:02.000Z",
    });
    expect(decision).toEqual({ kind: "none", nextDueAt: "2026-07-31T11:00:05.000Z" });
  });

  it("stays quiet once a human has acknowledged", () => {
    for (const state of ["acknowledged", "resolving"] as const) {
      const decision = decideSosWatchdog({
        ...base,
        alert: alertFacts({ lifecycleState: state }),
        stateEnteredAt: "2026-07-31T11:00:05.000Z",
        nowIso: "2026-07-31T13:00:00.000Z",
      });
      expect(decision).toEqual({ kind: "none", nextDueAt: null });
    }
  });
});

// ── D4 / §7.3 the overdue rungs ───────────────────────────────────────────────────────────────────────

describe("D4 / §7.3 overdue escalation", () => {
  it("maps minutes past `expected_at` onto the four policy rungs", () => {
    expect(overdueTierFor(2, POLICY)).toBe("none");
    expect(overdueTierFor(5, POLICY)).toBe("gentle_reminder");
    expect(overdueTierFor(15, POLICY)).toBe("supervisor_alert");
    expect(overdueTierFor(30, POLICY)).toBe("escalation");
    expect(overdueTierFor(60, POLICY)).toBe("sos_equivalent");
    expect(overdueTierFor(600, POLICY)).toBe("sos_equivalent");
  });

  it("takes the MORE urgent rung when a tenant collapses two thresholds onto one minute", () => {
    const collapsed = { ...POLICY, supervisorAlertMinutes: 5, gentleReminderMinutes: 5 };
    expect(overdueTierFor(5, collapsed)).toBe("supervisor_alert");
  });

  it("renders `reminder` for the prompted-but-not-yet-late window", () => {
    expect(overdueBadgeFor({ minutesOverdue: -1, windowMinutes: 5, tier: "none" })).toBe("on_time");
    expect(overdueBadgeFor({ minutesOverdue: 2, windowMinutes: 5, tier: "none" })).toBe("reminder");
    expect(overdueBadgeFor({ minutesOverdue: 6, windowMinutes: 5, tier: "gentle_reminder" })).toBe(
      "overdue",
    );
    expect(
      overdueBadgeFor({ minutesOverdue: 16, windowMinutes: 5, tier: "supervisor_alert" }),
    ).toBe("escalated");
  });

  it("does nothing while the fulfilment window is still open", () => {
    const decision = decideOverdueCheckIn({
      schedule: scheduleFacts(),
      policy: POLICY,
      nowIso: "2026-07-31T14:03:00.000Z",
      afterHours: false,
    });
    expect(decision.kind).toBe("none");
    if (decision.kind !== "none") return;
    expect(decision.reason).toBe("within_window");
    expect(decision.nextDueAt).toBe("2026-07-31T14:05:00.000Z");
  });

  it("§7.3 at 14:05 — flips to `overdue` and warns the subscribed supervisors", () => {
    const decision = decideOverdueCheckIn({
      schedule: scheduleFacts(),
      policy: POLICY,
      nowIso: "2026-07-31T14:05:00.000Z",
      afterHours: false,
    });
    expect(decision.kind).toBe("advance");
    if (decision.kind !== "advance") return;
    expect(decision.tier).toBe("gentle_reminder");
    // The STORED state is `overdue` — §7.3's `escalation_tier_1` is not a `safety_check_in_state` member.
    expect(decision.toState).toBe("overdue");
    expect(events(decision.effects)).toContain("m20.safety.check_in_overdue");
    expect(decision.sosEquivalent).toBe(false);
  });

  it("§7.3 at 14:15 — escalates to `escalated` at critical", () => {
    const decision = decideOverdueCheckIn({
      schedule: scheduleFacts({ state: "overdue", overdueDetectedAt: "2026-07-31T14:05:00.000Z" }),
      policy: POLICY,
      nowIso: "2026-07-31T14:15:00.000Z",
      afterHours: false,
    });
    expect(decision.kind).toBe("advance");
    if (decision.kind !== "advance") return;
    expect(decision.tier).toBe("supervisor_alert");
    expect(decision.toState).toBe("escalated");
    expect(events(decision.effects)).toContain("m20.safety.check_in_escalated");
  });

  it("fires each rung EXACTLY ONCE — the rung is reconstructed from `escalated_at`", () => {
    // A tick one minute after the supervisor-alert rung fired: nothing new is due.
    const quiet = decideOverdueCheckIn({
      schedule: scheduleFacts({
        state: "escalated",
        overdueDetectedAt: "2026-07-31T14:05:00.000Z",
        escalatedAt: "2026-07-31T14:15:00.000Z",
      }),
      policy: POLICY,
      nowIso: "2026-07-31T14:16:00.000Z",
      afterHours: false,
    });
    expect(quiet.kind).toBe("none");
    if (quiet.kind !== "none") return;
    expect(quiet.reason).toBe("rung_already_fired");
    expect(quiet.nextDueAt).toBe("2026-07-31T14:30:00.000Z");

    // The 30-minute rung IS a new one.
    const next = decideOverdueCheckIn({
      schedule: scheduleFacts({
        state: "escalated",
        overdueDetectedAt: "2026-07-31T14:05:00.000Z",
        escalatedAt: "2026-07-31T14:15:00.000Z",
      }),
      policy: POLICY,
      nowIso: "2026-07-31T14:30:00.000Z",
      afterHours: false,
    });
    expect(next.kind).toBe("advance");
    if (next.kind !== "advance") return;
    expect(next.tier).toBe("escalation");
  });

  it("§7.3 at 15:00 — the top rung is SOS-equivalent and mints no `safety_sos_alert` row", () => {
    const decision = decideOverdueCheckIn({
      schedule: scheduleFacts({
        state: "escalated",
        overdueDetectedAt: "2026-07-31T14:05:00.000Z",
        escalatedAt: "2026-07-31T14:30:00.000Z",
      }),
      policy: POLICY,
      nowIso: "2026-07-31T15:00:00.000Z",
      afterHours: true,
    });
    expect(decision.kind).toBe("advance");
    if (decision.kind !== "advance") return;
    expect(decision.tier).toBe("sos_equivalent");
    expect(decision.sosEquivalent).toBe(true);
    expect(decision.afterHours).toBe(true);
    expect(events(decision.effects)).toEqual(["m20.safety.check_in_escalated"]);
  });

  it("stamps `overdue_detected_at` on a schedule that skipped straight past the gentle rung", () => {
    const decision = decideOverdueCheckIn({
      schedule: scheduleFacts({ windowMinutes: 20 }),
      policy: POLICY,
      nowIso: "2026-07-31T14:20:00.000Z",
      afterHours: false,
    });
    expect(decision.kind).toBe("advance");
    if (decision.kind !== "advance") return;
    expect(decision.toState).toBe("escalated");
    expect(decision.effects).toContainEqual({
      kind: "set_timestamp",
      field: "overdue_detected_at",
      at: "2026-07-31T14:20:00.000Z",
    });
  });

  it("treats a schedule fulfilled between the scan and the decision as a race, not a fault", () => {
    const decision = decideOverdueCheckIn({
      schedule: scheduleFacts({ state: "recorded" }),
      policy: POLICY,
      nowIso: "2026-07-31T14:20:00.000Z",
      afterHours: false,
    });
    expect(decision.kind).toBe("none");
    if (decision.kind !== "none") return;
    expect(decision.reason).toBe("not_actionable");
    // …but the manual escalate route refuses it loudly.
    expectCode(() => assertScheduleActionable("recorded"), "OVERDUE_SCHEDULE_NOT_ACTIONABLE");
    expect(() => assertScheduleActionable("proposed")).not.toThrow();
  });
});

// ── D6 / §7.9 / §8.7 the continuous-location stream ───────────────────────────────────────────────────

describe("D6 / §8.7 continuous-location gates", () => {
  const enabled: SafetyPolicyEffectiveDto = { ...POLICY, sosContinuousLocationEnabled: true };
  const consent: SafetyStreamConsentFacts = {
    status: "granted",
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
  };
  const streamBase = {
    lifecycleState: "acknowledging" as SafetySosLifecycleState,
    policy: enabled,
    consent,
    sosPostedAt: "2026-07-31T11:00:00.000Z",
    lastSampleAt: null,
    nowIso: "2026-07-31T11:00:30.000Z",
  };

  it("streams over a STRICT SUBSET of the open states, so no sample can violate the 0111 trigger", () => {
    for (const state of SAFETY_SOS_STREAMING_STATES) {
      expect(SAFETY_SOS_OPEN_STATES as readonly string[]).toContain(state);
    }
    // The two excluded open states are the pre-fan-out ones: a cancelled press leaves no location trail.
    expect(SAFETY_SOS_STREAMING_STATES as readonly string[]).not.toContain("raised");
    expect(SAFETY_SOS_STREAMING_STATES as readonly string[]).not.toContain("cancel_window_open");
    // …and the two the spec's own sentence omits but its worked sequence requires.
    expect(SAFETY_SOS_STREAMING_STATES as readonly string[]).toContain("acknowledged");
    expect(SAFETY_SOS_STREAMING_STATES as readonly string[]).toContain("emergency_terminus");
  });

  it("stops when the TENANT has not opted in, whatever the clinician consented to", () => {
    expect(decideLocationStreamSample({ ...streamBase, policy: POLICY })).toEqual({
      kind: "stop",
      reason: "tenant_policy_disabled",
    });
  });

  it("stops when the CLINICIAN has not consented, whatever the tenant enabled", () => {
    expect(decideLocationStreamSample({ ...streamBase, consent: null })).toEqual({
      kind: "stop",
      reason: "consent_inactive",
    });
    expect(
      decideLocationStreamSample({
        ...streamBase,
        consent: { ...consent, status: "revoked" },
      }),
    ).toEqual({ kind: "stop", reason: "consent_inactive" });
  });

  it("treats an elapsed `expiresAt` as inactive even while `status` still reads `granted`", () => {
    const stale: SafetyStreamConsentFacts = {
      status: "granted",
      grantedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    expect(isStreamConsentActive(stale, "2026-07-31T11:00:00.000Z")).toBe(false);
    expect(isStreamConsentActive(consent, "2026-07-31T11:00:00.000Z")).toBe(true);
    expect(isStreamConsentActive(null, "2026-07-31T11:00:00.000Z")).toBe(false);
  });

  it("stops the moment the alert leaves the streaming set", () => {
    expect(decideLocationStreamSample({ ...streamBase, lifecycleState: "resolved" })).toEqual({
      kind: "stop",
      reason: "sos_no_longer_active",
    });
    expect(
      decideLocationStreamSample({ ...streamBase, lifecycleState: "cancel_window_open" }),
    ).toEqual({ kind: "stop", reason: "sos_no_longer_active" });
  });

  it("§8.7 — sunsets at the cap measured from the PRESS, not from the first sample", () => {
    expect(
      decideLocationStreamSample({ ...streamBase, nowIso: "2026-07-31T15:00:01.000Z" }),
    ).toEqual({ kind: "stop", reason: "max_duration_reached" });
  });

  it("samples on the policy cadence and waits between samples", () => {
    expect(decideLocationStreamSample(streamBase)).toMatchObject({ kind: "sample" });
    expect(
      decideLocationStreamSample({
        ...streamBase,
        lastSampleAt: "2026-07-31T11:00:20.000Z",
        nowIso: "2026-07-31T11:00:30.000Z",
      }),
    ).toEqual({ kind: "wait", nextSampleAt: "2026-07-31T11:00:50.000Z" });
    expect(
      decideLocationStreamSample({
        ...streamBase,
        lastSampleAt: "2026-07-31T11:00:20.000Z",
        nowIso: "2026-07-31T11:00:55.000Z",
      }),
    ).toMatchObject({ kind: "sample" });
  });

  it("refuses a client-pushed sample with the same four gates", () => {
    expectCode(
      () => assertStreamSampleWritable({ ...streamBase, policy: POLICY }),
      "SOS_STREAM_POLICY_DISABLED",
    );
    expectCode(
      () => assertStreamSampleWritable({ ...streamBase, consent: null }),
      "SOS_STREAM_CONSENT_MISSING",
    );
    expectCode(
      () => assertStreamSampleWritable({ ...streamBase, lifecycleState: "resolved" }),
      "SOS_STREAM_NOT_ACTIVE",
    );
    expectCode(
      () => assertStreamSampleWritable({ ...streamBase, nowIso: "2026-07-31T16:00:00.000Z" }),
      "SOS_STREAM_MAX_DURATION_REACHED",
    );
    expect(() => assertStreamSampleWritable(streamBase)).not.toThrow();
  });
});

// ── §7.8 the coverage-gap watchdog ────────────────────────────────────────────────────────────────────

describe("§7.8 / D8 coverage-gap watchdog", () => {
  const PATRICIA = "mem-patricia" as MembershipId;

  function subject(over: Partial<SafetyCoverageSubjectFacts> = {}): SafetyCoverageSubjectFacts {
    return {
      membershipId: PATRICIA,
      locationIds: ["loc-a"],
      providerEntityId: "pe-1",
      isFieldEligible: true,
      hasInactiveSubscriptions: false,
      ...over,
    };
  }
  function subscription(over: Partial<SafetySubscriptionFacts> = {}): SafetySubscriptionFacts {
    return {
      supervisorMembershipId: MARIA,
      scopeKind: "location",
      clinicianMembershipId: null,
      locationId: "loc-a",
      providerEntityId: null,
      alertKinds: ["sos", "overdue"],
      isVacationForwarding: false,
      vacationForwardToMembershipId: null,
      ...over,
    };
  }
  const activeSupervisors = new Set<MembershipId>([MARIA]);

  it("§7.8 — a newly-provisioned clinician nobody subscribed to is a `no_subscription` gap", () => {
    expect(
      coverageGapFor({
        subject: subject(),
        activeSubscriptions: [],
        activeSupervisorMembershipIds: activeSupervisors,
      }),
    ).toEqual({ clinicianMembershipId: PATRICIA, reason: "no_subscription" });
  });

  it("distinguishes 'nobody ever subscribed' from 'the supervisor left'", () => {
    expect(
      coverageGapFor({
        subject: subject({ hasInactiveSubscriptions: true }),
        activeSubscriptions: [],
        activeSupervisorMembershipIds: activeSupervisors,
      }),
    ).toEqual({ clinicianMembershipId: PATRICIA, reason: "all_subscriptions_deactivated" });
  });

  it("covers a clinician through each of D8's four layers", () => {
    const s = subject();
    expect(subscriptionCovers(subscription(), s)).toBe(true);
    expect(
      subscriptionCovers(
        subscription({ scopeKind: "explicit", locationId: null, clinicianMembershipId: PATRICIA }),
        s,
      ),
    ).toBe(true);
    expect(
      subscriptionCovers(
        subscription({ scopeKind: "provider_entity", locationId: null, providerEntityId: "pe-1" }),
        s,
      ),
    ).toBe(true);
    expect(subscriptionCovers(subscription({ scopeKind: "role", locationId: null }), s)).toBe(true);
  });

  it("does not count a row that pages on everything EXCEPT `sos`", () => {
    expect(
      subscriptionCovers(subscription({ alertKinds: ["overdue", "incident"] }), subject()),
    ).toBe(false);
    expect(
      coverageGapFor({
        subject: subject(),
        activeSubscriptions: [subscription({ alertKinds: ["overdue"] })],
        activeSupervisorMembershipIds: activeSupervisors,
      }),
    ).toEqual({ clinicianMembershipId: PATRICIA, reason: "no_subscription" });
  });

  it("covers a traveling clinician through ANY of her locations", () => {
    expect(
      subscriptionCovers(
        subscription({ locationId: "loc-b" }),
        subject({ locationIds: ["loc-a", "loc-b"] }),
      ),
    ).toBe(true);
    expect(subscriptionCovers(subscription({ locationId: "loc-z" }), subject())).toBe(false);
  });

  it("reports the worst case — a complete-looking row that forwards to nobody on duty", () => {
    expect(
      coverageGapFor({
        subject: subject(),
        activeSubscriptions: [
          subscription({
            isVacationForwarding: true,
            vacationForwardToMembershipId: "mem-gone" as MembershipId,
          }),
        ],
        activeSupervisorMembershipIds: activeSupervisors,
      }),
    ).toEqual({ clinicianMembershipId: PATRICIA, reason: "vacation_forwards_unresolved" });
  });

  it("clears the gap once a covering row reaches an on-duty supervisor", () => {
    expect(
      coverageGapFor({
        subject: subject(),
        activeSubscriptions: [subscription()],
        activeSupervisorMembershipIds: activeSupervisors,
      }),
    ).toBeNull();
  });

  it("does not ask the question about a clinician who is not field-eligible", () => {
    expect(
      coverageGapFor({
        subject: subject({ isFieldEligible: false }),
        activeSubscriptions: [],
        activeSupervisorMembershipIds: activeSupervisors,
      }),
    ).toBeNull();
  });

  it("scans a whole org deterministically", () => {
    const gaps = detectCoverageGaps({
      subjects: [
        subject({ membershipId: "mem-z" as MembershipId }),
        subject({ membershipId: "mem-a" as MembershipId }),
        subject({ membershipId: "mem-covered" as MembershipId, locationIds: ["loc-a"] }),
      ],
      activeSubscriptions: [
        subscription({
          scopeKind: "explicit",
          locationId: null,
          clinicianMembershipId: "mem-covered" as MembershipId,
        }),
      ],
      activeSupervisorMembershipIds: activeSupervisors,
    });
    expect(gaps.map((g) => g.clinicianMembershipId)).toEqual(["mem-a", "mem-z"]);
  });
});

// ── §2.2.4 the policy resolver + editor ───────────────────────────────────────────────────────────────

describe("§2.2.4 / D4 policy", () => {
  it("merges the platform floor UNDER a version row that omits a knob", () => {
    const merged = mergeEffectivePolicy(ORG, {
      versionId: "spv-2",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveTo: null,
      supervisorAlertMinutes: 10,
    });
    expect(merged.supervisorAlertMinutes).toBe(10);
    expect(merged.escalationMinutes).toBe(SAFETY_POLICY_FLOOR.escalationMinutes);
    expect(merged.versionId).toBe("spv-2");
  });

  it("seeds a tenant's first version from the floor verbatim", () => {
    expect(safetyPolicyFloorSeed()).toMatchObject({
      midVisitCadenceMinutes: SAFETY_POLICY_FLOOR.midVisitCadenceMinutes,
      sosCancelRequiresBiometric: true,
      sosContinuousLocationEnabled: false,
    });
  });

  it("names every knob that left its band, not just the first", () => {
    const violations = policyBoundViolations({
      midVisitCadenceMinutes: 480,
      supervisorAlertMinutes: 45,
      sosCancelWindowSeconds: 2,
    });
    expect(violations.map((v) => v.field).sort()).toEqual([
      "midVisitCadenceMinutes",
      "sosCancelWindowSeconds",
      "supervisorAlertMinutes",
    ]);
  });

  it("refuses the 8-hour cadence §2.2.4 argues about by name", () => {
    expectCode(
      () =>
        assertPolicyEditValid({
          current: POLICY,
          patch: { midVisitCadenceMinutes: 480 },
          editReason: "Tenant asked for a lighter check-in cadence on long visits.",
        }),
      "POLICY_OUT_OF_BOUNDS",
    );
  });

  it("refuses a patch that inverts the ladder using knobs it never mentions", () => {
    expectCode(
      () =>
        assertPolicyEditValid({
          current: POLICY,
          patch: { supervisorAlertMinutes: 12, escalationMinutes: 8 },
          editReason: "Compliance asked for a faster escalation after the March incident review.",
        }),
      "POLICY_LADDER_INVALID",
    );
  });

  it("requires a real edit reason", () => {
    expectCode(
      () =>
        assertPolicyEditValid({
          current: POLICY,
          patch: { supervisorAlertMinutes: 10 },
          editReason: "tweak",
        }),
      "POLICY_EDIT_REASON_REQUIRED",
    );
  });

  it("accepts a tighten and reports its direction per knob", () => {
    const patch = { supervisorAlertMinutes: 10, sosCancelWindowSeconds: 10 };
    expect(() =>
      assertPolicyEditValid({
        current: POLICY,
        patch,
        editReason: "Post-incident review: alert supervisors sooner and give a longer undo window.",
      }),
    ).not.toThrow();
    // A SHORTER overdue threshold and a LONGER cancel window are both TIGHTER (§2.2.4).
    expect(policyThresholdDiffs(POLICY, patch)).toEqual([
      { field: "supervisorAlertMinutes", direction: "tighten" },
      { field: "sosCancelWindowSeconds", direction: "tighten" },
    ]);
  });

  it("D14 — reads the after-hours window as a wrap around midnight, not a range", () => {
    const utc = "UTC";
    const at2230 = "2026-07-31T22:30:00.000Z" as IsoInstant;
    const at1100 = "2026-07-31T11:00:00.000Z" as IsoInstant;
    const at0300 = "2026-07-31T03:00:00.000Z" as IsoInstant;
    expect(isAfterHours(POLICY, at2230, utc)).toBe(true);
    expect(isAfterHours(POLICY, at0300, utc)).toBe(true);
    expect(isAfterHours(POLICY, at1100, utc)).toBe(false);
  });

  it("resolves the hour in the ORG's zone, not the server's", () => {
    // 2026-07-31T02:00Z is 19:00 the previous day in Los Angeles — after hours there, business hours in UTC.
    const at = "2026-07-31T02:00:00.000Z" as IsoInstant;
    expect(isAfterHours(POLICY, at, "UTC")).toBe(true);
    expect(isAfterHours(POLICY, "2026-07-31T09:00:00.000Z" as IsoInstant, "UTC")).toBe(false);
    expect(
      isAfterHours(POLICY, "2026-07-31T09:00:00.000Z" as IsoInstant, "America/Los_Angeles"),
    ).toBe(true);
  });

  it("reads a degenerate window as always-after-hours, never as never", () => {
    expect(
      isAfterHours(
        { afterHoursStartHour: 8, afterHoursEndHour: 8 },
        "2026-07-31T11:00:00.000Z",
        "UTC",
      ),
    ).toBe(true);
  });
});
