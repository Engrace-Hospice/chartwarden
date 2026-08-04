// apps/backend/__tests__/bereavement-lifecycle.test.ts — M16-T03 (§2.2 plan, §2.3 contact, §2.4 outreach,
// §2.5 validation, §2.6 cascades, §4.3.1 intake, D4 schedule).
//
// The pure M16 bereavement domain core (no DB — every fact is injected) plus the seam-consuming death-fact
// resolver, exercised against registered fake M6 / M5 seams.
import { BEREAVEMENT_CADENCE_FLOOR, OUTREACH_MODALITY_RANK } from "@wardenx/bereavement";
import type { BereavementExternalSourceMetadata } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  type EligibilityIntakeFacts,
  type ResolvedDeathFact,
  decideCosignReceipt,
  decideEligibilityIntake,
  externalSourceMetadataFor,
  localDateOf,
  resolveDeathFact,
} from "../src/modules/16-bereavement/consumers/index";
import {
  BereavementStateError,
  anniversaryMarksForTier,
  checkDeathDateMatchesAdmission,
  checkExternalSourceFirstContactGate,
  checkOutreachDueAt,
  checkOutreachKindAllowed,
  checkPlanWritable,
  checkSourceEncounterBinding,
  checkVersion,
  closeStateForReason,
  createBereavedContact,
  decideConsentRevocationCascade,
  decidePatientOptOutFlip,
  decidePlanCloseOnRoster,
  generateBereavementOutreach,
  generateOutreachSchedule,
  intakeBereavementPlan,
  isPlanClosed,
  planArchivesAt,
  resolveOutreachKind,
  transitionBereavedContact,
  transitionBereavementOutreach,
  transitionBereavementPlan,
} from "../src/modules/16-bereavement/lifecycle/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const ADMISSION = "33333333-3333-3333-3333-333333333333";
const PROVIDER_ENTITY = "44444444-4444-4444-4444-444444444444";
const COUNSELOR = "55555555-5555-5555-5555-555555555555";
const SUPERVISOR = "66666666-6666-6666-6666-666666666666";
const ENCOUNTER = "77777777-7777-7777-7777-777777777777";
const RESOURCE = "88888888-8888-8888-8888-888888888888";

const DEATH_DATE = "2026-03-01";
const DEATH_AT = "2026-03-01T04:20:00.000Z";
const ELIGIBLE_AT = "2026-03-02T15:00:00.000Z";

/**
 * Assert a guard raises the exact §2.5 / §4.2 machine-readable code. `WardenXError.message` is prose for
 * the clinician; the CODE is the contract the UI and the route table key off, so the tests assert on it.
 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BereavementStateError);
    expect((err as BereavementStateError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be raised, but nothing was thrown`);
}

/** The async form (a seam-consuming resolver rejects with the same typed error). */
async function expectRejectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

function effectKinds(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects.map((e) => e.kind);
}

function alerts(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "alert"; alert: string } => e.kind === "alert")
    .map((e) => e.alert);
}

const EXTERNAL_PENDING: BereavementExternalSourceMetadata = {
  sourceProposalId: "prop-1",
  sourceMessageId: "msg-1",
  sourceFacilityMdmId: "fac-1",
  sourceFacilityName: "St. Anywhere",
  ackReceivedAt: DEATH_AT,
  cosignStatus: "pending",
};

// ── §2.2 the plan-root lifecycle ──────────────────────────────────────────────────────────────────────

describe("§2.2 bereavement_plan lifecycle", () => {
  it("intake lands in `eligible` and deliberately emits NO outbox event (D2)", () => {
    const intake = intakeBereavementPlan(DEATH_DATE, null);
    expect(intake.status).toBe("eligible");
    // plan_opened is the public "a plan exists" signal and fires at `active` — announcing `eligible`
    // would have M36 open a channel for a plan a D9 opt-out may skip one transition later.
    expect(outboxEvents(intake.effects)).toEqual([]);
    expect(effectKinds(intake.effects)).toContain("audit");
  });

  it("assignCounselor requires the M40 discipline answer, then moves eligible → initiating", () => {
    expectCode(
      () =>
        transitionBereavementPlan("eligible", {
          type: "assignCounselor",
          counselorUserId: COUNSELOR,
          at: ELIGIBLE_AT,
          counselorCanProvideBereavement: false,
        }),
      "COUNSELOR_NOT_BEREAVEMENT_ELIGIBLE",
    );

    const t = transitionBereavementPlan("eligible", {
      type: "assignCounselor",
      counselorUserId: COUNSELOR,
      at: ELIGIBLE_AT,
      counselorCanProvideBereavement: true,
    });
    expect(t.to).toBe("initiating");
    expect(outboxEvents(t.effects)).toEqual(["m16.bereavement.counselor_assigned"]);
  });

  it("seedRosterAndSchedule refuses an empty roster and an unscored plan", () => {
    const base = {
      type: "seedRosterAndSchedule" as const,
      at: ELIGIBLE_AT,
      archivesAt: planArchivesAt(DEATH_DATE),
      anniversaryMarks: anniversaryMarksForTier("low"),
    };
    expectCode(
      () =>
        transitionBereavementPlan("initiating", {
          ...base,
          contactCount: 0,
          initialRiskScored: true,
        }),
      "ROSTER_EMPTY",
    );
    expectCode(
      () =>
        transitionBereavementPlan("initiating", {
          ...base,
          contactCount: 2,
          initialRiskScored: false,
        }),
      "INITIAL_RISK_SCORE_REQUIRED",
    );

    const t = transitionBereavementPlan("initiating", {
      ...base,
      contactCount: 2,
      initialRiskScored: true,
    });
    expect(t.to).toBe("active");
    expect(outboxEvents(t.effects)).toEqual([
      "m16.bereavement.plan_opened",
      "m16.bereavement.outreach_artifact_requested",
    ]);
    expect(effectKinds(t.effects)).toEqual(
      expect.arrayContaining(["generate_schedule", "seed_anniversary_reminders"]),
    );
  });

  it("skipPerPatientOptOut is legal from `initiating` too (§2.6 extends the §2.2 diagram)", () => {
    for (const from of ["eligible", "initiating"] as const) {
      const t = transitionBereavementPlan(from, {
        type: "skipPerPatientOptOut",
        at: ELIGIBLE_AT,
      });
      expect(t.to).toBe("closed_completed");
      expect(outboxEvents(t.effects)).toEqual([
        "m16.bereavement.plan_skipped_per_patient_opt_out",
      ]);
      // The closure reason is what tells a surveyor the family never refused anything.
      expect(t.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "insert_closure", reason: "patient_opt_out_pre_death" }),
        ]),
      );
    }
  });

  it("pause cancels the forward book; resume regenerates FROM NOW, not from the death date", () => {
    expectCode(
      () =>
        transitionBereavementPlan("active", {
          type: "pausePlan",
          pauseKind: "operational",
          reason: "   ",
          at: ELIGIBLE_AT,
        }),
      "PAUSE_REASON_REQUIRED",
    );

    const paused = transitionBereavementPlan("active", {
      type: "pausePlan",
      pauseKind: "family_request",
      reason: "family asked for a break through the holidays",
      at: ELIGIBLE_AT,
    });
    expect(paused.to).toBe("paused");
    expect(effectKinds(paused.effects)).toContain("cancel_future_outreach");

    const resumed = transitionBereavementPlan("paused", { type: "resumePlan", at: ELIGIBLE_AT });
    expect(resumed.to).toBe("active");
    expect(resumed.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "regenerate_schedule", fromIso: ELIGIBLE_AT }),
      ]),
    );
  });

  it("D6 — closed_declined needs EVERY contact opted out, not merely nobody engageable", () => {
    expectCode(
      () =>
        transitionBereavementPlan("active", {
          type: "closeOnAllContactsOptedOut",
          contactStatuses: ["opted_out", "deceased"],
          at: ELIGIBLE_AT,
        }),
      "NOT_ALL_CONTACTS_OPTED_OUT",
    );
    const t = transitionBereavementPlan("active", {
      type: "closeOnAllContactsOptedOut",
      contactStatuses: ["opted_out", "opted_out"],
      at: ELIGIBLE_AT,
    });
    expect(t.to).toBe("closed_declined");
  });

  it("D7 — a cosign-required early close enforces the 40-char floor + the supervisor; D9 reasons do not", () => {
    expectCode(
      () =>
        transitionBereavementPlan("active", {
          type: "closeEarly",
          reason: "tenant_offboarding",
          narrative: "too short",
          at: ELIGIBLE_AT,
          cosignedByUserId: SUPERVISOR,
        }),
      "EARLY_CLOSE_REASON_TOO_SHORT",
    );
    expectCode(
      () =>
        transitionBereavementPlan("active", {
          type: "closeEarly",
          reason: "tenant_offboarding",
          narrative: "the agency is winding down its hospice license effective next quarter",
          at: ELIGIBLE_AT,
          cosignedByUserId: null,
        }),
      "EARLY_CLOSE_COSIGN_REQUIRED",
    );

    // §2.6 / D9 — the post-creation opt-out close is cosign-EXEMPT and carries no prose floor.
    const d9 = transitionBereavementPlan("active", {
      type: "closeEarly",
      reason: "patient_opt_out_post_creation",
      narrative: "",
      at: ELIGIBLE_AT,
      cosignedByUserId: null,
    });
    expect(d9.to).toBe("closed_early");
    expect(d9.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "insert_closure", cosignRequired: false, closeKind: "cascade" }),
      ]),
    );
  });

  it("closeAt13Months refuses before the window elapses and under an active legal hold", () => {
    expectCode(
      () =>
        transitionBereavementPlan("active", {
          type: "closeAt13Months",
          at: ELIGIBLE_AT,
          windowElapsed: false,
        }),
      "BEREAVEMENT_WINDOW_STILL_OPEN",
    );
    expectCode(
      () =>
        transitionBereavementPlan("active", {
          type: "closeAt13Months",
          at: ELIGIBLE_AT,
          windowElapsed: true,
          legalHoldActive: true,
        }),
      "LEGAL_HOLD_ACTIVE",
    );
    const t = transitionBereavementPlan("paused", {
      type: "closeAt13Months",
      at: ELIGIBLE_AT,
      windowElapsed: true,
    });
    expect(t.to).toBe("closed_completed");
    expect(outboxEvents(t.effects)).toEqual(["m16.bereavement.plan_closed_completed"]);
  });

  it("a redelivered closeAt13Months lands on ILLEGAL_TRANSITION, never a second closure row", () => {
    expectCode(
      () =>
        transitionBereavementPlan("closed_completed", {
          type: "closeAt13Months",
          at: ELIGIBLE_AT,
          windowElapsed: true,
        }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("the legal hold emits NO outbox event and releases back to the closure reason's own state", () => {
    const held = transitionBereavementPlan("closed_declined", {
      type: "legalHoldApplied",
      legalHoldId: "hold-1",
    });
    expect(held.to).toBe("closed_legal_hold_extended");
    // M4 owns the hold-applied event; a second announcement would give consumers two sources of truth.
    expect(outboxEvents(held.effects)).toEqual([]);

    const released = transitionBereavementPlan("closed_legal_hold_extended", {
      type: "legalHoldReleased",
      closureReason: "all_contacts_declined",
    });
    expect(released.to).toBe("closed_declined");
  });

  it("closeStateForReason splits the two D9 opt-out reasons deliberately", () => {
    expect(closeStateForReason("patient_opt_out_pre_death")).toBe("closed_completed");
    expect(closeStateForReason("patient_opt_out_post_creation")).toBe("closed_early");
    expect(closeStateForReason("thirteen_month_completion")).toBe("closed_completed");
    expect(closeStateForReason("all_contacts_declined")).toBe("closed_declined");
  });

  it("D18 — receiveCosign preserves the state and only writes the provenance blob", () => {
    for (const from of ["eligible", "initiating", "active", "paused"] as const) {
      const t = transitionBereavementPlan(from, {
        type: "receiveCosign",
        metadata: { ...EXTERNAL_PENDING, cosignStatus: "cosigned" },
      });
      expect(t.to).toBe(from);
      expect(outboxEvents(t.effects)).toEqual([
        "m16.bereavement.external_source_cosign_received",
      ]);
    }
  });

  it("checkPlanWritable / isPlanClosed treat the legal-hold state as closed", () => {
    expect(isPlanClosed("closed_legal_hold_extended")).toBe(true);
    expect(isPlanClosed("paused")).toBe(false);
    expectCode(() => checkPlanWritable("closed_early"), "PLAN_CLOSED");
    expect(() => checkPlanWritable("active")).not.toThrow();
  });
});

// ── §2.3 the bereaved-contact lifecycle ───────────────────────────────────────────────────────────────

describe("§2.3 bereaved_contact lifecycle", () => {
  it("createContact refuses a relationship M38 does not know", () => {
    expectCode(() => createBereavedContact(false), "RELATIONSHIP_NOT_IN_VALUE_SET");
    expect(createBereavedContact(true).status).toBe("proposed");
  });

  it("confirmContact is consent-gated, and the primary-caregiver path satisfies it (D9)", () => {
    expectCode(
      () =>
        transitionBereavedContact("proposed", {
          type: "confirmContact",
          at: ELIGIBLE_AT,
          hasBereavementOutreachConsent: false,
          isPrimaryCaregiverWithFamilyAccess: false,
        }),
      "BEREAVEMENT_CONSENT_REQUIRED",
    );
    const t = transitionBereavedContact("proposed", {
      type: "confirmContact",
      at: ELIGIBLE_AT,
      hasBereavementOutreachConsent: false,
      isPrimaryCaregiverWithFamilyAccess: true,
    });
    expect(t.to).toBe("active");
    expect(outboxEvents(t.effects)).toEqual(["m16.bereavement.contact_active"]);
    expect(effectKinds(t.effects)).toContain("recompute_risk");
  });

  it("a channel-specific opt-out must name its channels", () => {
    expectCode(
      () =>
        transitionBereavedContact("active", {
          type: "optOut",
          at: ELIGIBLE_AT,
          optOutKind: "channel_specific",
          source: "counselor_recorded",
          reason: "no more phone calls please",
        }),
      "OPT_OUT_CHANNEL_KINDS_REQUIRED",
    );
  });

  it("the M39 revocation cascade raises the §4.10 consent-revoked alert; a portal opt-out does not", () => {
    const cascade = transitionBereavedContact("active", {
      type: "optOut",
      at: ELIGIBLE_AT,
      optOutKind: "full",
      source: "m39_revocation_cascade",
      reason: "consent_revoked_via_m39",
    });
    expect(cascade.to).toBe("opted_out");
    expect(alerts(cascade.effects)).toEqual(["consent_revoked_cascade"]);

    const portal = transitionBereavedContact("active", {
      type: "optOut",
      at: ELIGIBLE_AT,
      optOutKind: "full",
      source: "portal_self_service",
      reason: "no further contact",
    });
    expect(alerts(portal.effects)).toEqual([]);
    expect(effectKinds(portal.effects)).toContain("cancel_future_outreach");
  });

  it("D9 — the 90-day rescind window binds self-service but never a counselor", () => {
    const optedOutAt = "2026-03-01T00:00:00.000Z";
    const day120 = "2026-06-29T00:00:00.000Z";
    expectCode(
      () =>
        transitionBereavedContact("opted_out", {
          type: "rescindOptOut",
          at: day120,
          optedOutAt,
          byCounselor: false,
        }),
      "OPT_OUT_RESCIND_WINDOW_EXPIRED",
    );
    const byCounselor = transitionBereavedContact("opted_out", {
      type: "rescindOptOut",
      at: day120,
      optedOutAt,
      byCounselor: true,
    });
    expect(byCounselor.to).toBe("active");
    expect(effectKinds(byCounselor.effects)).toEqual(
      expect.arrayContaining(["rescind_opt_out", "regenerate_schedule"]),
    );

    const day30 = "2026-03-31T00:00:00.000Z";
    expect(
      transitionBereavedContact("opted_out", {
        type: "rescindOptOut",
        at: day30,
        optedOutAt,
        byCounselor: false,
      }).to,
    ).toBe("active");
  });

  it("markUnreachable enforces the 3-strikes threshold and alerts the counselor", () => {
    expectCode(
      () =>
        transitionBereavedContact("active", {
          type: "markUnreachable",
          at: ELIGIBLE_AT,
          consecutiveNoResponseCount: 2,
        }),
      "UNREACHABLE_THRESHOLD_NOT_MET",
    );
    const t = transitionBereavedContact("active", {
      type: "markUnreachable",
      at: ELIGIBLE_AT,
      consecutiveNoResponseCount: 3,
    });
    expect(t.to).toBe("unreachable");
    expect(alerts(t.effects)).toEqual(["contact_unreachable"]);
  });

  it("markDeceased needs a verified death and is TERMINAL — no way back into the program", () => {
    expectCode(
      () =>
        transitionBereavedContact("active", {
          type: "markDeceased",
          at: ELIGIBLE_AT,
          deathVerified: false,
        }),
      "CONTACT_DEATH_VERIFICATION_REQUIRED",
    );
    const t = transitionBereavedContact("active", {
      type: "markDeceased",
      at: ELIGIBLE_AT,
      deathVerified: true,
    });
    expect(t.to).toBe("deceased");
    expectCode(
      () =>
        transitionBereavedContact("deceased", {
          type: "clinicalReevaluation",
          at: ELIGIBLE_AT,
        }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("§7.7 — a complicated-grief referral must name the M40 resource it routes to", () => {
    expectCode(
      () =>
        transitionBereavedContact("active", {
          type: "flagComplicatedGrief",
          at: ELIGIBLE_AT,
          externalResourceId: null,
        }),
      "EXTERNAL_GRIEF_RESOURCE_REQUIRED",
    );
    const t = transitionBereavedContact("active", {
      type: "flagComplicatedGrief",
      at: ELIGIBLE_AT,
      externalResourceId: RESOURCE,
    });
    expect(t.to).toBe("ineligible_post_review");
    expect(alerts(t.effects)).toEqual(["complicated_grief_referral"]);
    expect(outboxEvents(t.effects)).toEqual(["m16.bereavement.contact_referred_external"]);

    expect(
      transitionBereavedContact("ineligible_post_review", {
        type: "clinicalReevaluation",
        at: ELIGIBLE_AT,
      }).to,
    ).toBe("active");
  });
});

// ── §2.4 the outreach lifecycle + D15 ─────────────────────────────────────────────────────────────────

describe("§2.4 bereavement_outreach lifecycle", () => {
  it("generate emits one outreach_scheduled per row", () => {
    const g = generateBereavementOutreach();
    expect(g.status).toBe("scheduled");
    expect(outboxEvents(g.effects)).toEqual(["m16.bereavement.outreach_scheduled"]);
  });

  it("D15 — only in_person_visit is encounter-backed, and every other kind must NOT be", () => {
    expectCode(() => checkSourceEncounterBinding("in_person_visit", null), "SOURCE_ENCOUNTER_REQUIRED");
    expectCode(
      () => checkSourceEncounterBinding("phone_call", ENCOUNTER),
      "SOURCE_ENCOUNTER_FORBIDDEN",
    );
    expect(() => checkSourceEncounterBinding("in_person_visit", ENCOUNTER)).not.toThrow();
    expect(() => checkSourceEncounterBinding("anniversary_letter", null)).not.toThrow();
  });

  it("completeContact requires a contact log and enforces the D15 binding", () => {
    expectCode(
      () =>
        transitionBereavementOutreach("in_progress", {
          type: "completeContact",
          at: ELIGIBLE_AT,
          kind: "phone_call",
          outcome: "engaged",
          sourceEncounterId: null,
          contactLogCount: 0,
        }),
      "CONTACT_LOG_REQUIRED",
    );
    const t = transitionBereavementOutreach("in_progress", {
      type: "completeContact",
      at: ELIGIBLE_AT,
      kind: "in_person_visit",
      outcome: "engaged",
      sourceEncounterId: ENCOUNTER,
      contactLogCount: 1,
    });
    expect(t.to).toBe("completed");
    expect(outboxEvents(t.effects)).toEqual(["m16.bereavement.outreach_completed"]);
  });

  it("declining ONE touchpoint is not opting out — the forward book is left alone", () => {
    const t = transitionBereavementOutreach("in_progress", {
      type: "contactDeclined",
      at: ELIGIBLE_AT,
    });
    expect(t.to).toBe("declined");
    expect(effectKinds(t.effects)).not.toContain("cancel_future_outreach");
  });

  it("missDeadline fires only past the LATE grace, not merely past due_at", () => {
    const dueAt = "2026-04-01T00:00:00.000Z";
    const lateGraceUntil = "2026-04-08T00:00:00.000Z";
    expectCode(
      () =>
        transitionBereavementOutreach("scheduled", {
          type: "missDeadline",
          at: dueAt,
          lateGraceUntil,
        }),
      "OUTREACH_NOT_YET_OVERDUE",
    );
    const t = transitionBereavementOutreach("scheduled", {
      type: "missDeadline",
      at: "2026-04-09T00:00:00.000Z",
      lateGraceUntil,
    });
    expect(t.to).toBe("missed");
    expect(alerts(t.effects)).toEqual(["outreach_missed"]);
  });

  it("lateAttempt re-opens a missed touchpoint inside the grace and refuses outside it", () => {
    const lateGraceUntil = "2026-04-08T00:00:00.000Z";
    expect(
      transitionBereavementOutreach("missed", {
        type: "lateAttempt",
        at: "2026-04-05T00:00:00.000Z",
        lateGraceUntil,
      }).to,
    ).toBe("in_progress");
    expectCode(
      () =>
        transitionBereavementOutreach("missed", {
          type: "lateAttempt",
          at: "2026-04-20T00:00:00.000Z",
          lateGraceUntil,
        }),
      "LATE_ATTEMPT_GRACE_EXPIRED",
    );
  });

  it("terminal states accept nothing", () => {
    for (const from of ["completed", "declined", "no_response", "cancelled"] as const) {
      expectCode(
        () => transitionBereavementOutreach(from, { type: "startContact", at: ELIGIBLE_AT }),
        "ILLEGAL_TRANSITION",
      );
    }
  });
});

// ── D4 the schedule generator ─────────────────────────────────────────────────────────────────────────

describe("D4 outreach schedule generation", () => {
  it("materializes the tier's cumulative floor anchored on the death DATE", () => {
    const rows = generateOutreachSchedule(DEATH_DATE, { riskTier: "low" });
    expect(rows.map((r) => r.mark)).toEqual([
      "condolence_letter",
      "one_month",
      "three_month",
      "six_month",
      "anniversary",
    ]);
    // day 7 from a 2026-03-01 death.
    expect(rows[0]?.dueAt).toBe("2026-03-08T00:00:00.000Z");
    // The late grace is 7 days past due, and the denormalized anchor is the death instant itself.
    expect(rows[0]?.lateGraceUntil).toBe("2026-03-15T00:00:00.000Z");
    expect(rows[0]?.deathAnchorAt).toBe("2026-03-01T00:00:00.000Z");

    // Cumulative: high keeps moderate's 9-month contact (the D4-over-§7.4 reading from M16-T01).
    const high = generateOutreachSchedule(DEATH_DATE, { riskTier: "high" });
    expect(high.map((r) => r.mark)).toContain("nine_month");
    expect(high.length).toBe(BEREAVEMENT_CADENCE_FLOOR.high.length);
  });

  it("a regeneration is FORWARD-only — a touchpoint whose date passed is gone, not backdated", () => {
    const rows = generateOutreachSchedule(
      DEATH_DATE,
      { riskTier: "low" },
      { fromIso: "2026-05-01T00:00:00.000Z" },
    );
    expect(rows.map((r) => r.mark)).toEqual(["three_month", "six_month", "anniversary"]);
  });

  it("nothing is generated past the §2.5 window + grace ceiling", () => {
    for (const row of generateOutreachSchedule(DEATH_DATE, { riskTier: "complicated" })) {
      const days = (Date.parse(row.dueAt) - Date.parse(`${DEATH_DATE}T00:00:00.000Z`)) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(0);
      expect(days).toBeLessThanOrEqual(396 + 30);
    }
  });

  it("a survivor preference RE-MODALIZES a floor contact — it never drops one", () => {
    const rows = generateOutreachSchedule(DEATH_DATE, {
      riskTier: "low",
      allowedKinds: ["sympathy_letter", "anniversary_letter"],
    });
    // Same five obligations, none lost to the preference.
    expect(rows.length).toBe(BEREAVEMENT_CADENCE_FLOOR.low.length);
    const oneMonth = rows.find((r) => r.mark === "one_month");
    expect(oneMonth?.kind).not.toBe("phone_call");
    expect(oneMonth?.preferenceSubstituted).toBe(true);
  });

  it("resolveOutreachKind prefers the closest allowed kind at-or-above the floor, else the highest", () => {
    // No preference stated → the floor rides through untouched.
    expect(resolveOutreachKind("phone_call", undefined)).toEqual({
      kind: "phone_call",
      substituted: false,
    });
    expect(resolveOutreachKind("phone_call", [])).toEqual({
      kind: "phone_call",
      substituted: false,
    });
    // Allowed contains the floor → no substitution.
    expect(resolveOutreachKind("phone_call", ["email", "phone_call"])).toEqual({
      kind: "phone_call",
      substituted: false,
    });
    // Closest at-or-above.
    const up = resolveOutreachKind("sympathy_card", ["in_person_visit", "phone_call"]);
    expect(up).toEqual({ kind: "phone_call", substituted: true });
    expect(OUTREACH_MODALITY_RANK[up.kind]).toBeGreaterThanOrEqual(
      OUTREACH_MODALITY_RANK.sympathy_card,
    );
    // A family that will only accept LOWER-touch modalities is honored, not overridden upward.
    expect(resolveOutreachKind("in_person_visit", ["email", "portal_message"])).toEqual({
      kind: "email",
      substituted: true,
    });
  });

  it("a tenant cadence that loosens the floor is refused, never silently repaired", () => {
    expectCode(
      () =>
        generateOutreachSchedule(
          DEATH_DATE,
          { riskTier: "low" },
          { tenantItems: [{ mark: "one_month", offsetDays: 30, kind: "phone_call", anniversaryMark: "one_month" }] },
        ),
      "TENANT_CADENCE_LOOSENS_FLOOR",
    );
  });

  it("anniversary marks are derived from the tier's own cadence, not hard-coded", () => {
    expect(anniversaryMarksForTier("low")).toEqual([
      "one_month",
      "three_month",
      "six_month",
      "anniversary",
    ]);
    expect(anniversaryMarksForTier("moderate")).toContain("nine_month_high_risk_only");
    expect(anniversaryMarksForTier("low")).not.toContain("nine_month_high_risk_only");
  });

  it("planArchivesAt is death + 396 days (D4)", () => {
    // 2026-03-01 + 396d — 2027 is not a leap year, so the anniversary lands 2027-03-01 + 31d.
    expect(planArchivesAt(DEATH_DATE)).toBe("2027-04-01T00:00:00.000Z");
  });
});

// ── §2.5 standalone validation ────────────────────────────────────────────────────────────────────────

describe("§2.5 validation", () => {
  it("the death-date cross-check refuses an unresolvable fact and a mismatch", () => {
    expectCode(() => checkDeathDateMatchesAdmission(DEATH_DATE, null), "DEATH_FACT_UNRESOLVED");
    expectCode(
      () => checkDeathDateMatchesAdmission(DEATH_DATE, "2026-03-02"),
      "BEREAVEMENT_DEATH_DATE_MISMATCH",
    );
    expect(() => checkDeathDateMatchesAdmission(DEATH_DATE, DEATH_DATE)).not.toThrow();
  });

  it("due_at must sit inside the window + 30-day grace", () => {
    expect(() => checkOutreachDueAt(DEATH_DATE, "2027-03-01T00:00:00.000Z")).not.toThrow();
    expectCode(
      () => checkOutreachDueAt(DEATH_DATE, "2027-06-01T00:00:00.000Z"),
      "OUTREACH_DUE_AT_OUT_OF_WINDOW",
    );
    expectCode(
      () => checkOutreachDueAt(DEATH_DATE, "2026-02-01T00:00:00.000Z"),
      "OUTREACH_DUE_AT_OUT_OF_WINDOW",
    );
  });

  it("an AD-HOC touchpoint is bound by the survivor's stated kinds (unlike the generator)", () => {
    expect(() => checkOutreachKindAllowed("phone_call", undefined)).not.toThrow();
    expect(() => checkOutreachKindAllowed("phone_call", ["phone_call", "email"])).not.toThrow();
    expectCode(
      () => checkOutreachKindAllowed("in_person_visit", ["phone_call"]),
      "OUTREACH_KIND_NOT_PERMITTED",
    );
  });

  it("D18 — the first-contact gate denies with the spec's exact lower-snake codes", () => {
    const facts = { hasDeathCertificate: false, hasCoordinatorAcknowledgment: false };
    // An internal-clinician-recorded death is never gated.
    expect(() => checkExternalSourceFirstContactGate(null, null, facts)).not.toThrow();
    expectCode(
      () => checkExternalSourceFirstContactGate(EXTERNAL_PENDING, null, facts),
      "external_source_cosign_pending",
    );
    expectCode(
      () =>
        checkExternalSourceFirstContactGate(
          { ...EXTERNAL_PENDING, cosignStatus: "cosigned" },
          { requireDeathCertificateUploaded: true, requireCoordinatorAcknowledgment: false },
          facts,
        ),
      "tenant_gate_death_certificate_missing",
    );
    expect(() =>
      checkExternalSourceFirstContactGate(
        { ...EXTERNAL_PENDING, cosignStatus: "cosigned" },
        null,
        facts,
      ),
    ).not.toThrow();
  });

  it("checkVersion is the §2.5 If-Match 412", () => {
    expect(() => checkVersion(undefined, 3)).not.toThrow();
    expect(() => checkVersion(3, 3)).not.toThrow();
    expectCode(() => checkVersion(2, 3), "STALE_VERSION");
  });
});

// ── §2.6 the cascade deciders ─────────────────────────────────────────────────────────────────────────

describe("§2.6 cascades", () => {
  it("D9 — the patient opt-out flip means three different things depending on when it lands", () => {
    expect(decidePatientOptOutFlip(null, true)).toEqual({ kind: "no_plan" });
    expect(decidePatientOptOutFlip("eligible", true)).toEqual({ kind: "skip" });
    expect(decidePatientOptOutFlip("initiating", true)).toEqual({ kind: "skip" });
    expect(decidePatientOptOutFlip("active", true)).toEqual({ kind: "close_early" });
    expect(decidePatientOptOutFlip("paused", true)).toEqual({ kind: "close_early" });
    expect(decidePatientOptOutFlip("closed_completed", true)).toEqual({ kind: "already_closed" });
    // The flag going back to false does NOT re-open a closed program.
    expect(decidePatientOptOutFlip("closed_early", false)).toEqual({ kind: "no_plan" });
  });

  it("the M39 revocation cascade fires once and is a no-op on a contact that already left", () => {
    expect(
      decideConsentRevocationCascade({
        consentRecordId: "c1",
        contactId: "b1",
        contactStatus: "active",
      }),
    ).toEqual({ kind: "cascade_opt_out", contactId: "b1" });
    expect(
      decideConsentRevocationCascade({
        consentRecordId: "c1",
        contactId: "b1",
        contactStatus: "opted_out",
      }),
    ).toEqual({ kind: "no_op" });
    expect(
      decideConsentRevocationCascade({
        consentRecordId: "c1",
        contactId: null,
        contactStatus: null,
      }),
    ).toEqual({ kind: "no_op" });
  });

  it("the D6 roster evaluation only fires on a live plan", () => {
    expect(decidePlanCloseOnRoster("active", ["opted_out", "opted_out"])).toBe(true);
    expect(decidePlanCloseOnRoster("active", ["opted_out", "unreachable"])).toBe(false);
    expect(decidePlanCloseOnRoster("paused", ["opted_out"])).toBe(false);
    expect(decidePlanCloseOnRoster("active", [])).toBe(false);
  });
});

// ── §4.3.1 the M6 intake (the handshake that closes M6's bereavement outbox) ──────────────────────────

const DEATH_FACT: ResolvedDeathFact = {
  admissionId: ADMISSION,
  patientId: PATIENT,
  providerEntityId: PROVIDER_ENTITY,
  deathAt: DEATH_AT,
  deathDate: DEATH_DATE,
  source: "internal_clinician_recorded",
  cosignStatus: undefined,
  admissionDischargeDate: DEATH_DATE,
};

const PAYLOAD = { admissionId: ADMISSION, patientId: PATIENT, eligibleAt: ELIGIBLE_AT };

function facts(overrides: Partial<EligibilityIntakeFacts> = {}): EligibilityIntakeFacts {
  return { existingPlan: false, deathFact: DEATH_FACT, patientOptOut: null, ...overrides };
}

describe("§4.3.1 m6.bereavement.eligible intake", () => {
  it("opens the plan on the resolved death fact, anchored on the DEATH date not eligibleAt", () => {
    const action = decideEligibilityIntake(PAYLOAD, facts());
    expect(action.kind).toBe("open_plan");
    if (action.kind !== "open_plan") throw new Error("unreachable");
    expect(action.deathDate).toBe(DEATH_DATE);
    // eligibleAt is the day AFTER death here — anchoring on it would shorten the program by a day.
    expect(action.deathDate).not.toBe(localDateOf(ELIGIBLE_AT, "UTC"));
    expect(action.providerEntityId).toBe(PROVIDER_ENTITY);
    expect(action.externalSourceMetadata).toBeNull();
  });

  it("a redelivery for an admission that already has a plan is an idempotent skip", () => {
    expect(decideEligibilityIntake(PAYLOAD, facts({ existingPlan: true }))).toEqual({
      kind: "idempotent_skip",
    });
  });

  it("an EXPLICIT patient opt-out skips before the death fact is even required", () => {
    expect(
      decideEligibilityIntake(PAYLOAD, facts({ patientOptOut: true, deathFact: null })),
    ).toEqual({ kind: "skip_per_patient_opt_out", deathDate: null });
  });

  it("an UNDETERMINED opt-out opens the plan — the §2.6 cascade handles a late flip", () => {
    // Fail-OPEN by design: refusing a grieving family a regulatory service to defend against a race the
    // cascade already covers would be the worse failure. See the consumer's TOCTOU header note.
    expect(decideEligibilityIntake(PAYLOAD, facts({ patientOptOut: null })).kind).toBe("open_plan");
  });

  it("fails CLOSED when no death fact resolves — no plan on a guessed anchor", () => {
    expectCode(
      () => decideEligibilityIntake(PAYLOAD, facts({ deathFact: null })),
      "DEATH_FACT_UNRESOLVED",
    );
  });

  it("§2.5 — M6's two surfaces disagreeing dead-letters rather than opening the program", () => {
    expectCode(
      () =>
        decideEligibilityIntake(
          PAYLOAD,
          facts({ deathFact: { ...DEATH_FACT, admissionDischargeDate: "2026-03-05" } }),
        ),
      "BEREAVEMENT_DEATH_DATE_MISMATCH",
    );
    // A null discharge date is NOT a mismatch: W-DC-01 allows a late filing.
    expect(
      decideEligibilityIntake(
        PAYLOAD,
        facts({ deathFact: { ...DEATH_FACT, admissionDischargeDate: null } }),
      ).kind,
    ).toBe("open_plan");
  });

  it("D16 — an hl7_external death stamps provenance whose cosign defaults to PENDING", () => {
    const external = { ...DEATH_FACT, source: "hl7_external" as const };
    const metadata = externalSourceMetadataFor(external);
    expect(metadata?.cosignStatus).toBe("pending");
    expect(externalSourceMetadataFor(DEATH_FACT)).toBeNull();

    const cosigned = externalSourceMetadataFor({ ...external, cosignStatus: "cosigned" });
    expect(cosigned?.cosignStatus).toBe("cosigned");
  });

  it("D18 — the cosign receipt is idempotent: a redelivery never re-stamps the attestation", () => {
    const first = decideCosignReceipt(EXTERNAL_PENDING, {
      sourceProposalId: "prop-1",
      cosignedAt: "2026-03-03T00:00:00.000Z",
      medicalDirectorMembershipId: SUPERVISOR,
    });
    expect(first.kind).toBe("release_gate");
    if (first.kind !== "release_gate") throw new Error("unreachable");
    expect(first.metadata.cosignStatus).toBe("cosigned");

    // Redelivery against the now-cosigned blob, and a receipt for a different proposal: both no-ops.
    expect(
      decideCosignReceipt(first.metadata, {
        sourceProposalId: "prop-1",
        cosignedAt: "2026-03-09T00:00:00.000Z",
        medicalDirectorMembershipId: SUPERVISOR,
      }).kind,
    ).toBe("no_op");
    expect(
      decideCosignReceipt(EXTERNAL_PENDING, {
        sourceProposalId: "prop-OTHER",
        cosignedAt: "2026-03-03T00:00:00.000Z",
        medicalDirectorMembershipId: SUPERVISOR,
      }).kind,
    ).toBe("no_op");
    // An internal-source plan has nothing to release.
    expect(
      decideCosignReceipt(null, {
        sourceProposalId: "prop-1",
        cosignedAt: "2026-03-03T00:00:00.000Z",
        medicalDirectorMembershipId: SUPERVISOR,
      }).kind,
    ).toBe("no_op");
  });
});

// ── the seam-consuming death-fact resolver ────────────────────────────────────────────────────────────

describe("the M6 death-fact resolver (seam-consuming)", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  function registerFakes(
    decedents: ReadonlyArray<Record<string, unknown>>,
    summary: Record<string, unknown> = {
      admissionId: ADMISSION,
      patientId: PATIENT,
      organizationId: ORG,
      providerEntityId: PROVIDER_ENTITY,
      status: "discharged",
      admissionAt: "2026-01-01",
      activatedAt: "2026-01-02",
      dischargedAt: DEATH_DATE,
      currentElectionPeriodId: null,
      currentLevelOfCare: null,
    },
  ): { periods: Array<{ from: string; to: string }> } {
    const periods: Array<{ from: string; to: string }> = [];
    registerSeam("DeathDischargeReader", {
      listDeathDischargesInPeriod: async (_org: string, period: { from: string; to: string }) => {
        periods.push(period);
        return decedents;
      },
    } as never);
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => summary,
    } as never);
    return { periods };
  }

  it("windows the census scan back from eligibleAt and matches on admissionId", async () => {
    const { periods } = registerFakes([
      { patientId: "other", admissionId: "other-adm", deathAt: DEATH_AT, source: "internal_clinician_recorded" },
      { patientId: PATIENT, admissionId: ADMISSION, deathAt: DEATH_AT, source: "hl7_external", cosignStatus: "pending" },
    ]);

    const fact = await resolveDeathFact(ORG, ADMISSION, ELIGIBLE_AT, "UTC");
    expect(fact?.deathDate).toBe(DEATH_DATE);
    expect(fact?.source).toBe("hl7_external");
    expect(fact?.providerEntityId).toBe(PROVIDER_ENTITY);
    expect(fact?.admissionDischargeDate).toBe(DEATH_DATE);
    // The scan ends at eligibleAt and reaches back the documented lookback (W-DC-01 late filing).
    expect(periods[0]?.to).toBe(ELIGIBLE_AT);
    expect(Date.parse(periods[0]?.from ?? "")).toBeLessThan(Date.parse(DEATH_AT));
  });

  it("returns null when the census has no row for this admission (the caller fails closed)", async () => {
    registerFakes([
      { patientId: "other", admissionId: "other-adm", deathAt: DEATH_AT, source: "internal_clinician_recorded" },
    ]);
    expect(await resolveDeathFact(ORG, ADMISSION, ELIGIBLE_AT, "UTC")).toBeNull();
    expectCode(
      () => decideEligibilityIntake(PAYLOAD, facts({ deathFact: null })),
      "DEATH_FACT_UNRESOLVED",
    );
  });

  it("an unreachable seam propagates — the plan is never written on a swallowed error", async () => {
    registerSeam("DeathDischargeReader", {
      listDeathDischargesInPeriod: async () => {
        throw new BereavementStateError("DEATH_FACT_UNRESOLVED", "seam down");
      },
    } as never);
    await expectRejectCode(
      resolveDeathFact(ORG, ADMISSION, ELIGIBLE_AT, "UTC"),
      "DEATH_FACT_UNRESOLVED",
    );
  });

  it("PARAM-004: death_date is the org's LOCAL calendar date, not a UTC-instant slice", async () => {
    // DEATH_AT = "2026-03-01T04:20:00.000Z" — 04:20 UTC on March 1 is still Feb 28 in every US
    // timezone (8:20pm Feb 28 in Los Angeles, 11:20pm Feb 28 in New York). The old utcDateOf() bug
    // would misdate this death one day LATE for any US-operating org — a real, regulatory-significant
    // error since D4 anchors the 13-month bereavement clock on this exact date.
    registerFakes([
      { patientId: PATIENT, admissionId: ADMISSION, deathAt: DEATH_AT, source: "internal_clinician_recorded" },
    ]);
    const inUtc = await resolveDeathFact(ORG, ADMISSION, ELIGIBLE_AT, "UTC");
    const inLosAngeles = await resolveDeathFact(ORG, ADMISSION, ELIGIBLE_AT, "America/Los_Angeles");
    expect(inUtc?.deathDate).toBe("2026-03-01");
    expect(inLosAngeles?.deathDate).toBe("2026-02-28");
  });
});
