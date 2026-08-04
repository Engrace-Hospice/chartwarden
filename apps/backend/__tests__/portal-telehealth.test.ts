// apps/backend/__tests__/portal-telehealth.test.ts — M31-T05 telehealth domain-core tests.
//
// Covers the PURE §7.2–§7.4 / D8 / D9 / D14 cores: the visit lifecycle state machine (happy path §7.2 +
// aborted path §7.3 + reconcile), the audio-only Tier-3 fallback planner (§7.3 / §6.4 / D14), the two-party
// recording-consent gate (§7.4 / D9), and the §3.8 state matrix. No IO — every fact is injected.
import { describe, expect, it } from "vitest";
import {
  AUDIO_ONLY_ATTEMPT_FLOOR,
  BREAKER_OPEN_RESCHEDULE_MS,
  TELEHEALTH_TRANSITIONS,
  TWO_PARTY_RECORDING_STATES,
  TelehealthStateError,
  assertRecordingConsent,
  assertTelehealthTransition,
  canTransitionTelehealth,
  deriveEndReason,
  endStateFor,
  evaluateAudioOnlyFallback,
  evaluateRecordingConsent,
  foldParticipantJoin,
  isTelehealthActive,
  isTelehealthEnded,
  isTelehealthTerminal,
  isTwoPartyRecordingState,
  resolveAttemptThreshold,
} from "../src/modules/31-portal/telehealth/index";

describe("telehealth visit lifecycle (§7.2 happy path, §7.3 aborted, D8)", () => {
  it("walks the §7.2 happy path room_minted → *_joined → in_progress → ended_clean → reconciled", () => {
    const s = "room_minted" as const;
    const a = foldParticipantJoin(s, "clinician"); // clinician-first
    expect(a).toBe("clinician_joined");
    const b = foldParticipantJoin(a, "patient"); // patient joins → both present
    expect(b).toBe("in_progress");
    assertTelehealthTransition(b, "ended_clean");
    assertTelehealthTransition("ended_clean", "reconciled");
    expect(isTelehealthTerminal("reconciled")).toBe(true);
  });

  it("supports patient-first join order too (waiting room)", () => {
    expect(foldParticipantJoin("room_minted", "patient")).toBe("patient_joined");
    expect(foldParticipantJoin("patient_joined", "clinician")).toBe("in_progress");
  });

  it("is idempotent on a same-party re-join and a re-join once in_progress", () => {
    expect(foldParticipantJoin("patient_joined", "patient")).toBe("patient_joined");
    expect(foldParticipantJoin("clinician_joined", "clinician")).toBe("clinician_joined");
    expect(foldParticipantJoin("in_progress", "patient")).toBe("in_progress");
  });

  it("refuses an illegal transition and a join onto an ended visit (409)", () => {
    expect(canTransitionTelehealth("reconciled", "in_progress")).toBe(false);
    try {
      assertTelehealthTransition("reconciled", "in_progress");
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(TelehealthStateError);
      expect((e as TelehealthStateError).code).toBe("TELEHEALTH_INVALID_TRANSITION");
      expect((e as TelehealthStateError).statusCode).toBe(409);
    }
    expect(() => foldParticipantJoin("ended_clean", "patient")).toThrowError(TelehealthStateError);
  });

  it("classifies ended / active states and end reasons", () => {
    expect(isTelehealthEnded("ended_aborted")).toBe(true);
    expect(isTelehealthEnded("in_progress")).toBe(false);
    expect(isTelehealthActive("in_progress")).toBe(true);
    expect(isTelehealthActive("room_minted")).toBe(false);
    expect(endStateFor(true)).toBe("ended_clean");
    expect(endStateFor(false)).toBe("ended_aborted");
    // §7.3 negative path — patient dropped mid-call.
    expect(
      deriveEndReason({ clean: false, patientPresentAtEnd: false, clinicianPresentAtEnd: true }),
    ).toBe("patient_dropped");
    expect(
      deriveEndReason({ clean: false, patientPresentAtEnd: true, clinicianPresentAtEnd: false }),
    ).toBe("clinician_dropped");
    expect(
      deriveEndReason({ clean: false, patientPresentAtEnd: false, clinicianPresentAtEnd: false }),
    ).toBe("both_dropped");
    expect(
      deriveEndReason({
        clean: false,
        patientPresentAtEnd: true,
        clinicianPresentAtEnd: true,
        vendorOutage: true,
      }),
    ).toBe("vendor_outage");
    expect(
      deriveEndReason({ clean: true, patientPresentAtEnd: false, clinicianPresentAtEnd: false }),
    ).toBe("clean");
  });

  it("reconciled is a terminal state with no outbound transitions", () => {
    expect(TELEHEALTH_TRANSITIONS.reconciled).toHaveLength(0);
  });
});

describe("audio-only Tier-3 fallback planner (§7.3 / §6.4 / D14)", () => {
  const NOW = Date.parse("2026-08-02T12:00:00.000Z");

  it("keeps trying video below the attempt floor, then offers audio-only at the floor (§6.4 default 2)", () => {
    expect(
      evaluateAudioOnlyFallback({ failedConnectAttempts: 1, breakerOpenedAtMs: null, nowMs: NOW })
        .plan,
    ).toBe("continue");
    expect(
      evaluateAudioOnlyFallback({ failedConnectAttempts: 2, breakerOpenedAtMs: null, nowMs: NOW })
        .plan,
    ).toBe("offer_audio_only");
    expect(AUDIO_ONLY_ATTEMPT_FLOOR).toBe(2);
  });

  it("lets a tenant TIGHTEN the threshold to 1 but never raise it above the platform floor", () => {
    expect(
      evaluateAudioOnlyFallback({
        failedConnectAttempts: 1,
        breakerOpenedAtMs: null,
        nowMs: NOW,
        tenantAttemptThreshold: 1,
      }).plan,
    ).toBe("offer_audio_only");
    expect(resolveAttemptThreshold(1)).toBe(1);
    expect(resolveAttemptThreshold(5)).toBe(AUDIO_ONLY_ATTEMPT_FLOOR); // clamped down
    expect(resolveAttemptThreshold(0)).toBe(1); // clamped up to 1
  });

  it("reschedules to in-person once the vendor circuit is open past the 5-minute ceiling (D14)", () => {
    const openedAt = NOW - (BREAKER_OPEN_RESCHEDULE_MS + 1);
    expect(
      evaluateAudioOnlyFallback({
        failedConnectAttempts: 5,
        breakerOpenedAtMs: openedAt,
        nowMs: NOW,
      }).plan,
    ).toBe("reschedule_in_person");
    // Just under the ceiling with enough attempts → still only audio-only, not reschedule.
    const recentlyOpened = NOW - (BREAKER_OPEN_RESCHEDULE_MS - 1);
    expect(
      evaluateAudioOnlyFallback({
        failedConnectAttempts: 5,
        breakerOpenedAtMs: recentlyOpened,
        nowMs: NOW,
      }).plan,
    ).toBe("offer_audio_only");
  });
});

describe("two-party recording-consent gate (§7.4 / D9 / §3.8)", () => {
  it("matches the §3.8 14-state matrix and fails CLOSED on an unknown residence", () => {
    expect(TWO_PARTY_RECORDING_STATES.size).toBe(14);
    expect(isTwoPartyRecordingState("CA")).toBe(true);
    expect(isTwoPartyRecordingState("ca")).toBe(true); // case-insensitive
    expect(isTwoPartyRecordingState("TX")).toBe(false); // one-party default
    expect(isTwoPartyRecordingState(null)).toBe(true); // fail closed
    expect(isTwoPartyRecordingState("")).toBe(true); // fail closed
  });

  it("lets a tenant TIGHTEN a one-party state into two-party (opt-in), never loosen", () => {
    expect(isTwoPartyRecordingState("TX", ["TX"])).toBe(true); // opt-in tighten
    expect(isTwoPartyRecordingState("CA", [])).toBe(true); // platform floor unaffected by empty opt-in
  });

  it("denies recording when a two-party-state participant lacks an active consent (§7.4)", () => {
    const verdict = evaluateRecordingConsent([
      { participantRef: "acct-1", stateCode: "CA", hasActiveRecordingConsent: false },
      { participantRef: "staff-1", stateCode: "TX", hasActiveRecordingConsent: false },
    ]);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blockingParticipantRefs).toEqual(["acct-1"]); // TX (one-party) does not block
    expect(verdict.blockingStates).toEqual(["CA"]);
  });

  it("allows recording when every two-party-state participant has consent (§7.4 step 1)", () => {
    const verdict = evaluateRecordingConsent([
      { participantRef: "acct-1", stateCode: "CA", hasActiveRecordingConsent: true },
      { participantRef: "staff-1", stateCode: "WA", hasActiveRecordingConsent: true },
    ]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.blockingParticipantRefs).toHaveLength(0);
    expect(() =>
      assertRecordingConsent([
        { participantRef: "acct-1", stateCode: "CA", hasActiveRecordingConsent: true },
      ]),
    ).not.toThrow();
  });

  it("assertRecordingConsent throws TELEHEALTH_RECORDING_CONSENT_ABSENT (403) when denied", () => {
    try {
      assertRecordingConsent([
        { participantRef: "acct-1", stateCode: "IL", hasActiveRecordingConsent: false },
      ]);
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(TelehealthStateError);
      expect((e as TelehealthStateError).code).toBe("TELEHEALTH_RECORDING_CONSENT_ABSENT");
      expect((e as TelehealthStateError).statusCode).toBe(403);
    }
  });
});
