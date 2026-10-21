import {
  // mortality machine + auto-creator
  type DischargeDeathEvent,
  // incident
  INCIDENT_CORRECTIVE_ACTION_MIN_CHARS,
  type IncidentEvent,
  IncidentStateError,
  MORTALITY_DEFAULT_COMPLETION_DAYS,
  MortalityReviewStateError,
  QAPI_PIP_SUSPEND_REASON_MIN_CHARS,
  // qapi
  QAPI_PROJECT_ABANDON_REASON_MIN_CHARS,
  // sra
  SRA_REOPEN_REASON_MIN_CHARS,
  SRA_STEP_UP_GATED_EVENTS,
  assertPipClosureCosign,
  assertSraClosureCosign,
  buildMortalityReviewFromDeath,
  transitionIncident,
  transitionMortalityReview,
  transitionQapiPip,
  transitionQapiProject,
  transitionSraCycle,
} from "@wardenx/quality";
// @wardenx/quality — M30 §2.2 PURE lifecycle-reducer unit tests (§7.3 / §7.4 / §7.5 / §7.6 / §7.13 / §7.15).
//
// Proves the four pure state machines + the mortality auto-creator enforce their §2.2 graphs and guards:
//   - incident (§7.5): the seven-state machine + the M30-F03 resolver≠assignee two-person control;
//   - mortality_review (§7.6/§7.13): pending→in_progress→completed + the W-M30-27 deferred-clock and
//     W-M30-28 SUD-decedent Part-2 promotion of the auto-creator;
//   - QAPI project + PIP (§7.3): the lifecycle reducers + the V-11 two-person co-sign (closer≠charterer);
//   - SRA (§7.4/§7.15): open→in_progress→closed + the V-12 two-person co-sign + the W-M30-30 step-up marker.
//
// PURE: no DB / Valkey / BullMQ — every reducer is `(state, event) → state(+effects)` and every guard fact
// is injected on the event (the M33 `refresh.test.ts` / M30 `measure-registrations.test.ts` idiom). Each
// test asserts an OBSERVABLE outcome (next state, effect list, or the precise ChartWardenError `code`/status),
// never a tautology.
import { ChartWardenError } from "@wardenx/types";
import { describe, expect, it } from "vitest";

/** Assert `fn` throws a ChartWardenError carrying the exact `code` (+ optional HTTP status). */
function expectWardenError(fn: () => unknown, code: string, status?: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ChartWardenError);
  const err = thrown as ChartWardenError;
  expect(err.code).toBe(code);
  if (status !== undefined) expect(err.statusCode).toBe(status);
}

// =============================================================================
// §7.5 — incident_report seven-state lifecycle + M30-F03 two-person control
// =============================================================================

describe("incident lifecycle machine (§2.2 / §7.5)", () => {
  const submitEvent: Extract<IncidentEvent, { type: "submit" }> = {
    type: "submit",
    kind: "fall",
    severity: "moderate",
    requiredFieldsComplete: true,
    mandatoryReportRequired: false,
    mandatoryReportFlagSet: false,
  };

  it("walks the full happy path draft→…→closed_followup_complete→reopened→under_investigation", () => {
    expect(transitionIncident("draft", submitEvent).to).toBe("submitted");
    expect(
      transitionIncident("submitted", {
        type: "triage",
        kind: "fall",
        assignedToMembershipId: "m-owner",
      }).to,
    ).toBe("triaged");
    expect(transitionIncident("triaged", { type: "beginInvestigation", kind: "fall" }).to).toBe(
      "under_investigation",
    );
    expect(
      transitionIncident("under_investigation", {
        type: "resolve",
        kind: "fall",
        assignedToMembershipId: "m-owner",
        resolvedByMembershipId: "m-reviewer",
      }).to,
    ).toBe("resolved");
    expect(
      transitionIncident("resolved", {
        type: "close",
        kind: "fall",
        severity: "moderate",
        correctiveActionTextLength: INCIDENT_CORRECTIVE_ACTION_MIN_CHARS,
      }).to,
    ).toBe("closed_followup_complete");
    expect(
      transitionIncident("closed_followup_complete", {
        type: "reopen",
        kind: "fall",
        reopenReasonLength: 5,
      }).to,
    ).toBe("reopened");
    expect(transitionIncident("reopened", { type: "resume", kind: "fall" }).to).toBe(
      "under_investigation",
    );
  });

  it("rejects an event not accepted from the current state (ILLEGAL_INCIDENT_TRANSITION, 409)", () => {
    // close is only legal from `resolved`.
    expectWardenError(
      () =>
        transitionIncident("draft", {
          type: "close",
          kind: "fall",
          severity: "minor",
          correctiveActionTextLength: 0,
        }),
      "ILLEGAL_INCIDENT_TRANSITION",
      409,
    );
    // resume only from `reopened`.
    expectWardenError(
      () => transitionIncident("submitted", { type: "resume", kind: "fall" }),
      "ILLEGAL_INCIDENT_TRANSITION",
      409,
    );
  });

  it("M30-F03 / WF-12: resolve throws RESOLVE_SELF_SIGNOFF_FORBIDDEN (403) when resolver === assignee", () => {
    expectWardenError(
      () =>
        transitionIncident("under_investigation", {
          type: "resolve",
          kind: "fall",
          assignedToMembershipId: "same-person",
          resolvedByMembershipId: "same-person",
        }),
      "RESOLVE_SELF_SIGNOFF_FORBIDDEN",
      403,
    );
  });

  it("resolve succeeds when the resolver differs from the assignee (two-person control satisfied)", () => {
    const r = transitionIncident("under_investigation", {
      type: "resolve",
      kind: "fall",
      assignedToMembershipId: "owner",
      resolvedByMembershipId: "verifier",
    });
    expect(r.to).toBe("resolved");
    expect(r.effects).toEqual([{ kind: "audit", severity: "warn" }]);
  });

  it("submit guards required fields (V-14) and the mandatory-report flag (V-15)", () => {
    expectWardenError(
      () => transitionIncident("draft", { ...submitEvent, requiredFieldsComplete: false }),
      "INCIDENT_REQUIRED_FIELDS_INCOMPLETE",
      422,
    );
    // mandatory report required but the flag is not set → blocked.
    expectWardenError(
      () =>
        transitionIncident("draft", {
          ...submitEvent,
          mandatoryReportRequired: true,
          mandatoryReportFlagSet: false,
        }),
      "INCIDENT_MANDATORY_REPORT_FLAG_REQUIRED",
      422,
    );
  });

  it("submit emits the mandatory_report_required outbox event only when required + flag set", () => {
    const plain = transitionIncident("draft", submitEvent);
    expect(plain.effects).toEqual([
      { kind: "audit", severity: "warn" },
      { kind: "outbox", event: "m30.incident.submitted" },
    ]);
    const mandatory = transitionIncident("draft", {
      ...submitEvent,
      kind: "allegation_of_abuse",
      severity: "severe",
      mandatoryReportRequired: true,
      mandatoryReportFlagSet: true,
    });
    // allegation_of_abuse audits at critical; both submitted + mandatory_report_required emit.
    expect(mandatory.effects).toEqual([
      { kind: "audit", severity: "critical" },
      { kind: "outbox", event: "m30.incident.submitted" },
      { kind: "outbox", event: "m30.incident.mandatory_report_required" },
    ]);
  });

  it("triage requires an assignee (INCIDENT_TRIAGE_ASSIGNEE_REQUIRED, 422) and stamps triaged_at", () => {
    expectWardenError(
      () =>
        transitionIncident("submitted", {
          type: "triage",
          kind: "fall",
          assignedToMembershipId: null,
        }),
      "INCIDENT_TRIAGE_ASSIGNEE_REQUIRED",
      422,
    );
    const ok = transitionIncident("submitted", {
      type: "triage",
      kind: "fall",
      assignedToMembershipId: "m1",
    });
    expect(ok.effects).toContainEqual({ kind: "set_timestamp", field: "triaged_at" });
  });

  it("close enforces the ≥40-char corrective-action narrative only for severity ≥ moderate", () => {
    // minor severity → no narrative gate.
    expect(
      transitionIncident("resolved", {
        type: "close",
        kind: "fall",
        severity: "minor",
        correctiveActionTextLength: 0,
      }).to,
    ).toBe("closed_followup_complete");
    // moderate with a too-short narrative → blocked.
    expectWardenError(
      () =>
        transitionIncident("resolved", {
          type: "close",
          kind: "fall",
          severity: "moderate",
          correctiveActionTextLength: INCIDENT_CORRECTIVE_ACTION_MIN_CHARS - 1,
        }),
      "INCIDENT_CORRECTIVE_ACTION_TEXT_REQUIRED",
      422,
    );
  });

  it("reopen requires a reason and ALWAYS audits at severity=critical with the reopened outbox event", () => {
    expectWardenError(
      () =>
        transitionIncident("closed_followup_complete", {
          type: "reopen",
          kind: "fall",
          reopenReasonLength: 0,
        }),
      "INCIDENT_REOPEN_REASON_REQUIRED",
      422,
    );
    const r = transitionIncident("closed_followup_complete", {
      type: "reopen",
      kind: "complaint", // a non-abuse kind still escalates the reopen audit to critical
      reopenReasonLength: 12,
    });
    expect(r.effects).toEqual([
      { kind: "set_timestamp", field: "reopened_at" },
      { kind: "audit", severity: "critical" },
      { kind: "outbox", event: "m30.incident.reopened" },
    ]);
  });
});

// =============================================================================
// §7.6 / §7.13 — mortality_review lifecycle + auto-creator (W-M30-27 / W-M30-28)
// =============================================================================

describe("mortality_review lifecycle machine (§2.2 / §7.6)", () => {
  it("walks pending→in_progress→completed and emits the completed outbox event + completed_at", () => {
    expect(
      transitionMortalityReview("pending", { type: "start", hasAssignedReviewer: true }).to,
    ).toBe("in_progress");
    const done = transitionMortalityReview("in_progress", {
      type: "complete",
      dimensionsComplete: true,
      reviewerSignaturePresent: true,
      externalSourceCosignSatisfied: true,
    });
    expect(done.to).toBe("completed");
    expect(done.effects).toEqual([
      { kind: "set_timestamp", field: "completed_at" },
      { kind: "audit", severity: "info" },
      { kind: "outbox", event: "m30.mortality_review.completed" },
    ]);
  });

  it("start requires an assigned reviewer (MORTALITY_REVIEWER_REQUIRED, 422)", () => {
    expectWardenError(
      () => transitionMortalityReview("pending", { type: "start", hasAssignedReviewer: false }),
      "MORTALITY_REVIEWER_REQUIRED",
      422,
    );
  });

  it("complete guards dimensions, the reviewer signature, and the W-M30-27 external-source cosign", () => {
    const base = {
      type: "complete" as const,
      dimensionsComplete: true,
      reviewerSignaturePresent: true,
      externalSourceCosignSatisfied: true,
    };
    expectWardenError(
      () => transitionMortalityReview("in_progress", { ...base, dimensionsComplete: false }),
      "MORTALITY_DIMENSIONS_INCOMPLETE",
      422,
    );
    expectWardenError(
      () => transitionMortalityReview("in_progress", { ...base, reviewerSignaturePresent: false }),
      "MORTALITY_REVIEWER_SIGNATURE_REQUIRED",
      422,
    );
    // W-M30-27: an external-source death blocks completion until the M6 cosign lands.
    expectWardenError(
      () =>
        transitionMortalityReview("in_progress", { ...base, externalSourceCosignSatisfied: false }),
      "EXTERNAL_SOURCE_COSIGN_PENDING",
      409,
    );
  });

  it("markOverdue is system-actor-only, clock-active-only, and deadline-gated (W-M30-27)", () => {
    const base = {
      type: "markOverdue" as const,
      isSystemActor: true,
      deadlineReached: true,
      completionClockActive: true,
    };
    expect(transitionMortalityReview("pending", base).to).toBe("overdue");
    // a human actor cannot trip the overdue sweep.
    expectWardenError(
      () => transitionMortalityReview("pending", { ...base, isSystemActor: false }),
      "MORTALITY_NOT_SYSTEM_ACTOR",
      403,
    );
    // W-M30-27: a deferred (external-source pre-cosign) clock never goes overdue.
    expectWardenError(
      () => transitionMortalityReview("pending", { ...base, completionClockActive: false }),
      "MORTALITY_COMPLETION_CLOCK_INACTIVE",
      422,
    );
    // the deadline must actually be reached.
    expectWardenError(
      () => transitionMortalityReview("pending", { ...base, deadlineReached: false }),
      "MORTALITY_DEADLINE_NOT_REACHED",
      422,
    );
  });

  it("an overdue review can resume to in_progress or still complete; completed is terminal", () => {
    expect(transitionMortalityReview("overdue", { type: "resume" }).to).toBe("in_progress");
    expect(
      transitionMortalityReview("overdue", {
        type: "complete",
        dimensionsComplete: true,
        reviewerSignaturePresent: true,
        externalSourceCosignSatisfied: true,
      }).to,
    ).toBe("completed");
    // nothing transitions out of `completed`.
    expectWardenError(
      () => transitionMortalityReview("completed", { type: "resume" }),
      "ILLEGAL_MORTALITY_TRANSITION",
      409,
    );
  });
});

describe("mortality auto-creator buildMortalityReviewFromDeath (§7.13 / W-M30-27 / W-M30-28)", () => {
  const deathAt = new Date("2026-01-01T00:00:00Z");
  const baseEvent: DischargeDeathEvent = {
    organizationId: "org-1",
    providerEntityId: "pe-1",
    deceasedPatientId: "pt-1",
    admissionId: "adm-1",
    deathAt,
    eventIdempotencyKey: "evt-1",
  };

  it("creates a pending row anchored on the cross-module FKs + idempotency key, default 30-day target", () => {
    const r = buildMortalityReviewFromDeath(baseEvent);
    expect(r.row.status).toBe("pending");
    expect(r.row.admissionId).toBe("adm-1");
    expect(r.row.deceasedPatientId).toBe("pt-1");
    expect(r.row.createdViaEventIdempotencyKey).toBe("evt-1");
    expect(r.outboxEvents).toEqual(["m30.mortality_review.created"]);
    // default completion target = death + 30 days.
    const expected = new Date(deathAt.getTime() + MORTALITY_DEFAULT_COMPLETION_DAYS * 86_400_000);
    expect(r.row.targetCompletionAt?.getTime()).toBe(expected.getTime());
  });

  it("internal-source death has an ACTIVE completion clock; not Part-2 promoted by default", () => {
    const r = buildMortalityReviewFromDeath(baseEvent);
    expect(r.completionClock.deferred).toBe(false);
    expect(r.completionClock.effectiveTargetCompletionAt).not.toBeNull();
    expect(r.retention).toEqual({ class: "phi", part2Promoted: false });
  });

  it("W-M30-27: an hl7_external death DEFERS the completion clock while still stamping a NOT-NULL target", () => {
    const r = buildMortalityReviewFromDeath({ ...baseEvent, source: "hl7_external" });
    expect(r.completionClock.deferred).toBe(true);
    expect(r.completionClock.effectiveTargetCompletionAt).toBeNull();
    // the NOT-NULL schema column is still provisionally populated.
    expect(r.row.targetCompletionAt).toBeInstanceOf(Date);
  });

  it("W-M30-28: a SUD decedent auto-promotes the retention class to compliance_42cfr_part2", () => {
    const r = buildMortalityReviewFromDeath({ ...baseEvent, decedentHasSud: true });
    expect(r.retention.class).toBe("compliance_42cfr_part2");
    expect(r.retention.part2Promoted).toBe(true);
    expect(r.retention.basis).toMatch(/has_sud/);
  });

  it("W-M30-28 variant (c): a Part-2-tagged chart document also promotes retention", () => {
    const r = buildMortalityReviewFromDeath({ ...baseEvent, hasPart2DocumentInChart: true });
    expect(r.retention.class).toBe("compliance_42cfr_part2");
    expect(r.retention.part2Promoted).toBe(true);
    expect(r.retention.basis).toMatch(/document/);
  });

  it("rejects a tenant completion window that exceeds the 30-day floor or is below 1 day (tighten-only)", () => {
    expectWardenError(
      () => buildMortalityReviewFromDeath({ ...baseEvent, completionTargetDays: 45 }),
      "MORTALITY_TARGET_EXCEEDS_FLOOR",
      422,
    );
    expectWardenError(
      () => buildMortalityReviewFromDeath({ ...baseEvent, completionTargetDays: 0 }),
      "MORTALITY_TARGET_EXCEEDS_FLOOR",
      422,
    );
    // a tightened (≤30) window is accepted.
    const r = buildMortalityReviewFromDeath({ ...baseEvent, completionTargetDays: 14 });
    const expected = new Date(deathAt.getTime() + 14 * 86_400_000);
    expect(r.row.targetCompletionAt?.getTime()).toBe(expected.getTime());
  });
});

// =============================================================================
// §7.3 — QAPI project + PIP lifecycle reducers + V-11 two-person co-sign
// =============================================================================

describe("QAPI project lifecycle machine (§2.2 / §7.3)", () => {
  it("walks proposed→active→corrective_action→completed", () => {
    expect(transitionQapiProject("proposed", { type: "activate" })).toBe("active");
    expect(
      transitionQapiProject("active", { type: "enterCorrectiveAction", rootCauseIdentified: true }),
    ).toBe("corrective_action");
    expect(
      transitionQapiProject("corrective_action", {
        type: "complete",
        outcomeText: "target reached",
        outcomeMeetsTarget: true,
      }),
    ).toBe("completed");
  });

  it("rejects an illegal transition (ILLEGAL_QAPI_PROJECT_TRANSITION, 409)", () => {
    expectWardenError(
      () => transitionQapiProject("completed", { type: "activate" }),
      "ILLEGAL_QAPI_PROJECT_TRANSITION",
      409,
    );
  });

  it("enterCorrectiveAction requires an identified root cause (QAPI_PROJECT_ROOT_CAUSE_REQUIRED, 422)", () => {
    expectWardenError(
      () =>
        transitionQapiProject("active", {
          type: "enterCorrectiveAction",
          rootCauseIdentified: false,
        }),
      "QAPI_PROJECT_ROOT_CAUSE_REQUIRED",
      422,
    );
  });

  it("complete (V-10) requires a documented outcome that meets target", () => {
    expectWardenError(
      () =>
        transitionQapiProject("active", {
          type: "complete",
          outcomeText: "   ",
          outcomeMeetsTarget: true,
        }),
      "QAPI_PROJECT_OUTCOME_REQUIRED",
      422,
    );
    expectWardenError(
      () =>
        transitionQapiProject("active", {
          type: "complete",
          outcomeText: "missed",
          outcomeMeetsTarget: false,
        }),
      "QAPI_PROJECT_OUTCOME_NOT_MET",
      422,
    );
  });

  it("abandon requires a reason ≥ 60 chars; a long-enough reason transitions to abandoned", () => {
    expectWardenError(
      () => transitionQapiProject("proposed", { type: "abandon", reason: "too short" }),
      "QAPI_PROJECT_ABANDON_REASON_TOO_SHORT",
      422,
    );
    expect(
      transitionQapiProject("proposed", {
        type: "abandon",
        reason: "x".repeat(QAPI_PROJECT_ABANDON_REASON_MIN_CHARS),
      }),
    ).toBe("abandoned");
  });
});

describe("QAPI PIP lifecycle machine + V-11 two-person co-sign (§2.2 / §7.3)", () => {
  const goodCosign = {
    qapiCoordinatorMembershipId: "coord-1",
    medicalDirectorMembershipId: "md-1",
    charteredByMembershipId: "charterer-1",
  };

  it("walks chartering→…→measurement→concluded with a valid two-person co-sign", () => {
    expect(transitionQapiPip("chartering", { type: "beginRca" })).toBe("root_cause_analysis");
    expect(
      transitionQapiPip("root_cause_analysis", {
        type: "beginIntervention",
        rootCauseDocumented: true,
      }),
    ).toBe("intervention_in_progress");
    expect(transitionQapiPip("intervention_in_progress", { type: "beginMeasurement" })).toBe(
      "measurement",
    );
    expect(
      transitionQapiPip("measurement", {
        type: "conclude",
        conclusionText: "improvement sustained",
        cosign: goodCosign,
      }),
    ).toBe("concluded");
  });

  it("any active phase can suspend with a ≥60-char reason; a short reason is rejected", () => {
    expect(
      transitionQapiPip("chartering", {
        type: "suspend",
        reason: "y".repeat(QAPI_PIP_SUSPEND_REASON_MIN_CHARS),
      }),
    ).toBe("suspended");
    expectWardenError(
      () => transitionQapiPip("measurement", { type: "suspend", reason: "short" }),
      "QAPI_PIP_SUSPEND_REASON_TOO_SHORT",
      422,
    );
  });

  it("conclude requires a non-empty conclusion narrative (QAPI_PIP_CONCLUSION_REQUIRED, 422)", () => {
    expectWardenError(
      () =>
        transitionQapiPip("measurement", {
          type: "conclude",
          conclusionText: "  ",
          cosign: goodCosign,
        }),
      "QAPI_PIP_CONCLUSION_REQUIRED",
      422,
    );
  });

  it("V-11: the two co-signers must be distinct individuals", () => {
    expectWardenError(
      () =>
        transitionQapiPip("measurement", {
          type: "conclude",
          conclusionText: "ok",
          cosign: { ...goodCosign, medicalDirectorMembershipId: "coord-1" },
        }),
      "PIP_CLOSE_REQUIRES_DISTINCT_COSIGNERS",
      422,
    );
  });

  it("V-11 SoD: a closer (co-signer) may NOT be the PIP's charterer (closer ≠ charterer)", () => {
    expectWardenError(
      () =>
        transitionQapiPip("measurement", {
          type: "conclude",
          conclusionText: "ok",
          cosign: { ...goodCosign, charteredByMembershipId: "md-1" },
        }),
      "PIP_CLOSE_COSIGNER_IS_CHARTERER",
      422,
    );
  });

  it("V-11: an empty co-signer id fails closed (PIP_CLOSE_COSIGN_INCOMPLETE) via the guard helper", () => {
    expectWardenError(
      () => assertPipClosureCosign({ ...goodCosign, qapiCoordinatorMembershipId: "" }),
      "PIP_CLOSE_COSIGN_INCOMPLETE",
      422,
    );
  });
});

// =============================================================================
// §7.4 / §7.15 — SRA cycle lifecycle + V-12 co-sign + W-M30-30 step-up marker
// =============================================================================

describe("SRA cycle lifecycle machine (§2.2 / §7.4 / §7.15)", () => {
  const goodCosign = {
    securityOfficerMembershipId: "so-1",
    complianceOfficerMembershipId: "co-1",
  };

  it("walks chartered→in_progress→review→closed with a valid co-sign + recent step-up", () => {
    expect(transitionSraCycle("chartered", { type: "startAssessment" })).toBe("in_progress");
    expect(transitionSraCycle("in_progress", { type: "submitForReview" })).toBe("review");
    expect(
      transitionSraCycle("review", { type: "close", cosign: goodCosign, recentStepUp: true }),
    ).toBe("closed");
  });

  it("review can return to in_progress; a closed cycle can be reopened then resumed", () => {
    expect(transitionSraCycle("review", { type: "returnToProgress" })).toBe("in_progress");
    expect(
      transitionSraCycle("closed", {
        type: "reopen",
        reason: "z".repeat(SRA_REOPEN_REASON_MIN_CHARS),
        actorIsComplianceOfficer: true,
        recentStepUp: true,
      }),
    ).toBe("reopened");
    expect(transitionSraCycle("reopened", { type: "resumeAfterReopen" })).toBe("in_progress");
  });

  it("rejects an illegal transition (ILLEGAL_SRA_CYCLE_TRANSITION, 409)", () => {
    expectWardenError(
      () => transitionSraCycle("chartered", { type: "submitForReview" }),
      "ILLEGAL_SRA_CYCLE_TRANSITION",
      409,
    );
  });

  it("V-12: close requires both co-signers and they must be distinct individuals", () => {
    expectWardenError(
      () =>
        transitionSraCycle("review", {
          type: "close",
          cosign: { ...goodCosign, complianceOfficerMembershipId: "" },
          recentStepUp: true,
        }),
      "SRA_CLOSE_COSIGN_INCOMPLETE",
      422,
    );
    expectWardenError(
      () =>
        transitionSraCycle("review", {
          type: "close",
          cosign: { securityOfficerMembershipId: "same", complianceOfficerMembershipId: "same" },
          recentStepUp: true,
        }),
      "SRA_CLOSE_REQUIRES_DISTINCT_COSIGNERS",
      422,
    );
  });

  it("W-M30-30: close requires a recent step-up auth (SRA_CLOSE_REQUIRES_RECENT_STEP_UP, 403)", () => {
    expectWardenError(
      () =>
        transitionSraCycle("review", { type: "close", cosign: goodCosign, recentStepUp: false }),
      "SRA_CLOSE_REQUIRES_RECENT_STEP_UP",
      403,
    );
  });

  it("reopen requires the Compliance Officer override, a ≥100-char reason, AND a recent step-up", () => {
    const longReason = "z".repeat(SRA_REOPEN_REASON_MIN_CHARS);
    expectWardenError(
      () =>
        transitionSraCycle("closed", {
          type: "reopen",
          reason: longReason,
          actorIsComplianceOfficer: false,
          recentStepUp: true,
        }),
      "SRA_REOPEN_REQUIRES_COMPLIANCE_OFFICER",
      403,
    );
    expectWardenError(
      () =>
        transitionSraCycle("closed", {
          type: "reopen",
          reason: "too short",
          actorIsComplianceOfficer: true,
          recentStepUp: true,
        }),
      "SRA_REOPEN_REASON_TOO_SHORT",
      422,
    );
    expectWardenError(
      () =>
        transitionSraCycle("closed", {
          type: "reopen",
          reason: longReason,
          actorIsComplianceOfficer: true,
          recentStepUp: false,
        }),
      "SRA_REOPEN_REQUIRES_RECENT_STEP_UP",
      403,
    );
  });

  it("the W-M30-30 step-up marker enumerates exactly the close + reopen transitions", () => {
    expect([...SRA_STEP_UP_GATED_EVENTS]).toEqual(["close", "reopen"]);
  });

  it("assertSraClosureCosign passes for a distinct, fully-populated co-sign (guard helper)", () => {
    expect(() => assertSraClosureCosign(goodCosign)).not.toThrow();
  });
});
