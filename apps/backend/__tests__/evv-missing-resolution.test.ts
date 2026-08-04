// apps/backend/__tests__/evv-missing-resolution.test.ts — M18-T04 (§2.2.4 D6, §7.3, §7.4, §7.10).
//
// The pure `evv_missing_resolution` D6 resolution machine: the five §2.2.4 close paths (clinician self-attest,
// supervisor override, visit-voided, documented-at-encounter, system-checkout-received), each with its §7.3/
// §7.4 guards raising the exact code, the §2.4 declarative side-effect list (audit + status + resolver stamp +
// reason capture + `late_check_resolved` outbox), and the ADR-0008 unresolved-vs-documented classifiers. No
// DB, no clock — the windows + identity facts are injected as resolved data.
import { describe, expect, it } from "vitest";
import {
  CLINICIAN_ATTEST_REASON_MIN,
  DOCUMENTED_MISSING_REASON_MIN,
  type EvvMissingResolutionEvent,
  type EvvMissingResolutionLifecycleState,
  type EvvSideEffect,
  EvvStateError,
  type M18ErrorCode,
  SELF_ATTEST_WINDOW_HOURS,
  SUPERVISOR_OVERRIDE_REASON_MIN,
  SUPERVISOR_OVERRIDE_WINDOW_DAYS,
  isMissingResolutionTerminal,
  missingResolutionBlocksBilling,
  missingResolutionDisposition,
  outboxEvents,
  transitionMissingResolution,
} from "../src/modules/18-evv/domain/index";

/** Assert `fn` throws an {@link EvvStateError} carrying the exact §2.3 `code`. */
function expectCode(fn: () => unknown, code: M18ErrorCode): void {
  expect(fn).toThrow(EvvStateError);
  try {
    fn();
  } catch (e) {
    expect((e as EvvStateError).code).toBe(code);
  }
}

/** The §3.6 resolver/reason effect helpers — collect the effect kinds in order for assertion. */
const kinds = (effects: readonly EvvSideEffect[]): string[] => effects.map((e) => e.kind);
const reasonOf = (effects: readonly EvvSideEffect[]): string | undefined =>
  effects
    .filter(
      (e): e is Extract<EvvSideEffect, { kind: "capture_reason" }> => e.kind === "capture_reason",
    )
    .find((e) => e.field === "resolution_reason")?.value;

const ATTEST_REASON =
  "Visit completed 11:15 AM; forgot to tap checkout before driving to the next visit.";
const OVERRIDE_REASON =
  "RN Mike's phone battery died mid-visit per his report; completion at 14:30 confirmed by family and M8 sign.";

// ── §7.3 clinician self-attest ───────────────────────────────────────────────────────────────────
describe("transitionMissingResolution — §7.3 clinician self-attest", () => {
  const attest = (
    over: Partial<Extract<EvvMissingResolutionEvent, { type: "clinician_attest" }>> = {},
  ) =>
    transitionMissingResolution("open", {
      type: "clinician_attest",
      callerIsAssignedClinician: true,
      hoursSinceCheckIn: 5.5,
      reason: ATTEST_REASON,
      ...over,
    });

  it("closes open → closed_clinician_attested, stamps resolver + reason, emits late_check_resolved", () => {
    const r = attest();
    expect(r.status).toBe("closed_clinician_attested");
    expect(kinds(r.effects)).toEqual([
      "audit",
      "set_resolution_status",
      "stamp_resolver",
      "capture_reason",
      "outbox",
    ]);
    expect(reasonOf(r.effects)).toBe(ATTEST_REASON);
    expect(outboxEvents(r.effects)).toEqual(["m18.evv.late_check_resolved"]);
  });

  it("rejects a non-assigned clinician", () => {
    expectCode(
      () => attest({ callerIsAssignedClinician: false }),
      "EVV_RESOLUTION_NOT_ASSIGNED_CLINICIAN",
    );
  });

  it("rejects a self-attest past the 24h window (→ supervisor override)", () => {
    expectCode(
      () => attest({ hoursSinceCheckIn: SELF_ATTEST_WINDOW_HOURS + 0.1 }),
      "EVV_SELF_ATTEST_WINDOW_EXPIRED",
    );
  });

  it("allows a self-attest exactly at the 24h boundary", () => {
    expect(attest({ hoursSinceCheckIn: SELF_ATTEST_WINDOW_HOURS }).status).toBe(
      "closed_clinician_attested",
    );
  });

  it("rejects a reason below the 40-char floor", () => {
    expectCode(
      () => attest({ reason: "x".repeat(CLINICIAN_ATTEST_REASON_MIN - 1) }),
      "EVV_RESOLUTION_REASON_TOO_SHORT",
    );
  });
});

// ── §7.4 supervisor override ───────────────────────────────────────────────────────────────────────
describe("transitionMissingResolution — §7.4 supervisor override", () => {
  const override = (
    over: Partial<Extract<EvvMissingResolutionEvent, { type: "supervisor_override" }>> = {},
  ) =>
    transitionMissingResolution("open", {
      type: "supervisor_override",
      stepUpVerified: true,
      daysSinceVisit: 2,
      reason: OVERRIDE_REASON,
      ...over,
    });

  it("closes open → closed_supervisor_override with resolver + reason", () => {
    const r = override();
    expect(r.status).toBe("closed_supervisor_override");
    expect(kinds(r.effects)).toContain("stamp_resolver");
    expect(reasonOf(r.effects)).toBe(OVERRIDE_REASON);
    expect(outboxEvents(r.effects)).toEqual(["m18.evv.late_check_resolved"]);
  });

  it("requires fresh step-up auth", () => {
    expectCode(
      () => override({ stepUpVerified: false }),
      "EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED",
    );
  });

  it("rejects an override past the 7d window", () => {
    expectCode(
      () => override({ daysSinceVisit: SUPERVISOR_OVERRIDE_WINDOW_DAYS + 0.1 }),
      "EVV_SUPERVISOR_OVERRIDE_WINDOW_EXPIRED",
    );
  });

  it("rejects a reason below the 60-char floor", () => {
    expectCode(
      () => override({ reason: "x".repeat(SUPERVISOR_OVERRIDE_REASON_MIN - 1) }),
      "EVV_RESOLUTION_REASON_TOO_SHORT",
    );
  });
});

// ── §2.4 visit-voided (system) ───────────────────────────────────────────────────────────────────
describe("transitionMissingResolution — §2.4 visit-voided", () => {
  it("closes open → closed_visit_voided (system-driven; no resolver/reason)", () => {
    const r = transitionMissingResolution("open", {
      type: "void_for_cancelled_visit",
      visitCancelled: true,
      isSystemActor: true,
    });
    expect(r.status).toBe("closed_visit_voided");
    expect(kinds(r.effects)).toEqual(["audit", "set_resolution_status", "outbox"]);
    expect(reasonOf(r.effects)).toBeUndefined();
  });

  it("rejects a human actor", () => {
    expectCode(
      () =>
        transitionMissingResolution("open", {
          type: "void_for_cancelled_visit",
          visitCancelled: true,
          isSystemActor: false,
        }),
      "EVV_RESOLUTION_SYSTEM_ACTOR_REQUIRED",
    );
  });

  it("rejects when the visit is not actually cancelled", () => {
    expectCode(
      () =>
        transitionMissingResolution("open", {
          type: "void_for_cancelled_visit",
          visitCancelled: false,
          isSystemActor: true,
        }),
      "EVV_VISIT_NOT_CANCELLED",
    );
  });
});

// ── §7.10 documented-at-encounter (M8 boundary) ────────────────────────────────────────────────────
describe("transitionMissingResolution — §7.10 documented-at-encounter", () => {
  const ENC_REASON =
    "Phone battery died at 9:50 AM at patient home; visit 10:02–11:18 confirmed by family.";

  it("closes open → closed_documented_at_encounter with the signing clinician + encounter reason", () => {
    const r = transitionMissingResolution("open", {
      type: "document_at_encounter",
      signingMembershipPresent: true,
      encounterEvvMissingReason: ENC_REASON,
    });
    expect(r.status).toBe("closed_documented_at_encounter");
    expect(kinds(r.effects)).toContain("stamp_resolver");
    expect(reasonOf(r.effects)).toBe(ENC_REASON);
  });

  it("requires the signing membership (resolved_by)", () => {
    expectCode(
      () =>
        transitionMissingResolution("open", {
          type: "document_at_encounter",
          signingMembershipPresent: false,
          encounterEvvMissingReason: ENC_REASON,
        }),
      "EVV_RESOLVER_REQUIRED",
    );
  });

  it("rejects an evv_missing_reason below the 20-char M8 D9 floor", () => {
    expectCode(
      () =>
        transitionMissingResolution("open", {
          type: "document_at_encounter",
          signingMembershipPresent: true,
          encounterEvvMissingReason: "x".repeat(DOCUMENTED_MISSING_REASON_MIN - 1),
        }),
      "EVV_DOCUMENTED_MISSING_REASON_TOO_SHORT",
    );
  });
});

// ── §2.4 system-checkout-received (auto-close) ─────────────────────────────────────────────────────
describe("transitionMissingResolution — §2.4 system-checkout-received", () => {
  it("closes open → closed_system_checkout_received (system-driven; not labeled clinician-attested)", () => {
    const r = transitionMissingResolution("open", {
      type: "system_checkout_received",
      isSystemActor: true,
    });
    expect(r.status).toBe("closed_system_checkout_received");
    expect(kinds(r.effects)).toEqual(["audit", "set_resolution_status", "outbox"]);
    expect(outboxEvents(r.effects)).toEqual(["m18.evv.late_check_resolved"]);
  });

  it("rejects a human actor on the auto-close path", () => {
    expectCode(
      () =>
        transitionMissingResolution("open", {
          type: "system_checkout_received",
          isSystemActor: false,
        }),
      "EVV_RESOLUTION_SYSTEM_ACTOR_REQUIRED",
    );
  });
});

// ── §2.2.4 terminal guard (§2.5 If-Match race) ─────────────────────────────────────────────────────
describe("transitionMissingResolution — terminal states", () => {
  const TERMINAL: EvvMissingResolutionLifecycleState[] = [
    "closed_clinician_attested",
    "closed_supervisor_override",
    "closed_visit_voided",
    "closed_documented_at_encounter",
    "closed_system_checkout_received",
  ];

  for (const from of TERMINAL) {
    it(`refuses any further transition from ${from}`, () => {
      expectCode(
        () =>
          transitionMissingResolution(from, {
            type: "clinician_attest",
            callerIsAssignedClinician: true,
            hoursSinceCheckIn: 1,
            reason: ATTEST_REASON,
          }),
        "ILLEGAL_RESOLUTION_TRANSITION",
      );
    });
  }
});

// ── ADR-0008 classifiers — documented_missing allowed, unresolved_missing blocks ───────────────────
describe("ADR-0008 — EVV is never a Medicare claim gate", () => {
  it("only an open row blocks billing; every closed_* state is non-blocking", () => {
    expect(missingResolutionBlocksBilling("open")).toBe(true);
    expect(missingResolutionBlocksBilling("closed_clinician_attested")).toBe(false);
    expect(missingResolutionBlocksBilling("closed_supervisor_override")).toBe(false);
    expect(missingResolutionBlocksBilling("closed_visit_voided")).toBe(false);
    expect(missingResolutionBlocksBilling("closed_documented_at_encounter")).toBe(false);
    expect(missingResolutionBlocksBilling("closed_system_checkout_received")).toBe(false);
  });

  it("classifies open as unresolved_missing and closed as documented_missing", () => {
    expect(missingResolutionDisposition("open")).toBe("unresolved_missing");
    expect(missingResolutionDisposition("closed_documented_at_encounter")).toBe(
      "documented_missing",
    );
    expect(missingResolutionDisposition("closed_clinician_attested")).toBe("documented_missing");
  });

  it("isMissingResolutionTerminal is true only for closed_* states", () => {
    expect(isMissingResolutionTerminal("open")).toBe(false);
    expect(isMissingResolutionTerminal("closed_visit_voided")).toBe(true);
  });
});
