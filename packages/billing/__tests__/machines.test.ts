import type { ClaimState, ClaimTransitionEvent, NoticeState } from "@wardenx/billing";
import {
  CLAIM_TERMINAL_STATES,
  CLAIM_TRANSITIONS,
  canTransition,
  isTerminal,
  noeMachine,
  notrMachine,
  reduce,
} from "@wardenx/billing";
// @wardenx/billing — M23 §2.2 the three pure lifecycle reducers (claim / noe / notr) pure-domain unit
// tests. Mirrors the M27 `cost-report/__tests__/lifecycle.test.ts` shape: every legal edge in each flat
// transition table must apply, every illegal (state, event) pair must fail CLOSED (the reducer returns the
// UNCHANGED state with an `error` code and NEVER throws), the §2.3 blocking-failure submission guard must
// block when failures remain (and fail-closed when its context value is absent), terminal states
// (REPLACED/VOIDED/ack_rejected; NOE/NOTR ack_accepted/ack_rejected/cancelled) must have no outbound edge,
// and the D14 replacement/void chain + the NOE/NOTR ack paths must transition as specified.
//
// PURE DOMAIN only — no DB, no Fastify, no BullMQ, no clock; no PHI (D13). The reducers are total + side
// effect-free functions of (state, event[, ctx]).
import { describe, expect, it } from "vitest";

// ── claim machine ────────────────────────────────────────────────────────────────────────────────────

const ALL_CLAIM_STATES: readonly ClaimState[] = [
  "draft",
  "validating",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_partial",
  "ack_rejected",
  "paid",
  "partial_paid",
  "denied",
  "replaced",
  "voided",
];

const ALL_CLAIM_EVENTS: readonly ClaimTransitionEvent[] = [
  "begin_validation",
  "validation_failed",
  "validation_passed",
  "overrides_applied",
  "revalidate",
  "submit",
  "submission_failed",
  "ack_999_accepted",
  "ack_999_rejected",
  "ack_277ca_accepted",
  "ack_277ca_rejected",
  "ack_277ca_partial",
  "remittance_paid",
  "remittance_partial_paid",
  "remittance_denied",
  "remittance_recouped",
  "appeal_succeeded",
  "replacement_accepted",
  "void_accepted",
];

// The §2.3 blocking-failure-guarded events: supply a passing guard context for the table-driven legal-edge
// checks (the guard is exercised independently below).
const CLAIM_GUARDED: ReadonlySet<ClaimTransitionEvent> = new Set([
  "validation_passed",
  "overrides_applied",
  "submit",
]);
function claimCtx(event: ClaimTransitionEvent) {
  return CLAIM_GUARDED.has(event) ? { unresolvedBlockingFailures: 0 } : {};
}

describe("CLAIM_TRANSITIONS — every legal edge applies", () => {
  for (const t of CLAIM_TRANSITIONS) {
    it(`${t.from} --${t.event}--> ${t.to}`, () => {
      const ctx = claimCtx(t.event);
      expect(canTransition(t.from, t.event, ctx)).toBe(true);
      const result = reduce(t.from, t.event, ctx);
      expect(result.state).toBe(t.to);
      expect(result.error).toBeUndefined();
    });
  }

  it("the table is non-empty and self-consistent (from/to are valid states)", () => {
    expect(CLAIM_TRANSITIONS.length).toBeGreaterThan(0);
    for (const t of CLAIM_TRANSITIONS) {
      expect(ALL_CLAIM_STATES).toContain(t.from);
      expect(ALL_CLAIM_STATES).toContain(t.to);
      expect(ALL_CLAIM_EVENTS).toContain(t.event);
    }
  });

  it("the canonical happy path draft→…→paid traverses every stage", () => {
    let s: ClaimState = "draft";
    s = reduce(s, "begin_validation").state; // → validating
    expect(s).toBe("validating");
    s = reduce(s, "validation_passed", { unresolvedBlockingFailures: 0 }).state; // → ready
    expect(s).toBe("ready");
    s = reduce(s, "submit", { unresolvedBlockingFailures: 0 }).state; // → submitted
    expect(s).toBe("submitted");
    s = reduce(s, "ack_999_accepted").state; // → ack_pending
    expect(s).toBe("ack_pending");
    s = reduce(s, "ack_277ca_accepted").state; // → ack_accepted
    expect(s).toBe("ack_accepted");
    s = reduce(s, "remittance_paid").state; // → paid
    expect(s).toBe("paid");
  });
});

describe("illegal (state, event) pairs fail CLOSED — never throw", () => {
  const legal = new Set(CLAIM_TRANSITIONS.map((t) => `${t.from}|${t.event}`));

  it("every (state, event) pair NOT in the table is rejected with INVALID_TRANSITION and no state change", () => {
    for (const from of ALL_CLAIM_STATES) {
      for (const event of ALL_CLAIM_EVENTS) {
        if (legal.has(`${from}|${event}`)) continue;
        const ctx = claimCtx(event);
        expect(canTransition(from, event, ctx)).toBe(false);
        let result!: ReturnType<typeof reduce>;
        expect(() => {
          result = reduce(from, event, ctx);
        }).not.toThrow();
        expect(result.error).toBe("INVALID_TRANSITION");
        expect(result.state).toBe(from); // unchanged
      }
    }
  });

  it("a few representative illegal edges", () => {
    expect(reduce("draft", "submit", { unresolvedBlockingFailures: 0 }).error).toBe(
      "INVALID_TRANSITION",
    );
    expect(reduce("submitted", "remittance_paid").error).toBe("INVALID_TRANSITION");
    expect(reduce("draft", "remittance_paid").error).toBe("INVALID_TRANSITION");
    expect(reduce("ack_pending", "submit", { unresolvedBlockingFailures: 0 }).error).toBe(
      "INVALID_TRANSITION",
    );
  });
});

describe("§2.3 blocking-failure submission guard", () => {
  // validation_passed / overrides_applied are legal out of `validating`; submit is legal out of `ready`.
  it("validation_passed advances to ready ONLY with zero unresolved blocking failures", () => {
    expect(reduce("validating", "validation_passed", { unresolvedBlockingFailures: 0 }).state).toBe(
      "ready",
    );
    const blocked = reduce("validating", "validation_passed", { unresolvedBlockingFailures: 2 });
    expect(blocked.state).toBe("validating");
    expect(blocked.error).toBe("GUARD_FAILED");
  });

  it("overrides_applied advances to ready ONLY when all failures are overridden (count 0)", () => {
    expect(reduce("validating", "overrides_applied", { unresolvedBlockingFailures: 0 }).state).toBe(
      "ready",
    );
    expect(reduce("validating", "overrides_applied", { unresolvedBlockingFailures: 1 }).error).toBe(
      "GUARD_FAILED",
    );
  });

  it("submit is blocked from ready when unresolved blocking failures remain", () => {
    expect(reduce("ready", "submit", { unresolvedBlockingFailures: 0 }).state).toBe("submitted");
    expect(reduce("ready", "submit", { unresolvedBlockingFailures: 3 }).error).toBe("GUARD_FAILED");
  });

  it("fails CLOSED when the guard context value is ABSENT (no unresolvedBlockingFailures)", () => {
    expect(canTransition("ready", "submit")).toBe(false);
    expect(reduce("ready", "submit").error).toBe("GUARD_FAILED");
    expect(canTransition("validating", "validation_passed")).toBe(false);
    expect(reduce("validating", "validation_passed").error).toBe("GUARD_FAILED");
  });

  it("non-guarded events ignore the guard context entirely", () => {
    expect(reduce("draft", "begin_validation").state).toBe("validating");
    expect(reduce("validating", "validation_failed").state).toBe("validating"); // self-loop, no guard
    expect(reduce("ready", "revalidate").state).toBe("validating");
  });
});

describe("claim terminal states (§2.2)", () => {
  it("ack_rejected / replaced / voided are the declared terminal set and have no outbound edge", () => {
    expect([...CLAIM_TERMINAL_STATES].sort()).toEqual(["ack_rejected", "replaced", "voided"]);
    for (const state of CLAIM_TERMINAL_STATES) {
      expect(isTerminal(state)).toBe(true);
      for (const event of ALL_CLAIM_EVENTS) {
        expect(reduce(state, event, claimCtx(event)).error).toBe("INVALID_TRANSITION");
      }
    }
  });

  it("paid and denied are NOT machine-terminal — they carry post-payment / appeal edges", () => {
    expect(isTerminal("paid")).toBe(false);
    expect(isTerminal("denied")).toBe(false);
    // denied → paid on a successful M25 appeal + 835 re-post.
    expect(reduce("denied", "appeal_succeeded").state).toBe("paid");
  });

  it("partial_paid is reachable from ack_accepted and carries the same post-payment paths as paid", () => {
    // ack_accepted --remittance_partial_paid--> partial_paid (driven by m25.remittance.claim_partial_paid;
    // M25 deny-stubbed today, the edge is present so the machine is complete and the consumer is a drop-in).
    expect(reduce("ack_accepted", "remittance_partial_paid").state).toBe("partial_paid");
    // partial_paid has the PAID post-payment edges (817 replace / 818 void) plus M25 appeal-to-full-pay.
    expect(reduce("partial_paid", "replacement_accepted").state).toBe("replaced");
    expect(reduce("partial_paid", "void_accepted").state).toBe("voided");
    expect(reduce("partial_paid", "appeal_succeeded").state).toBe("paid");
    // It is a live (non-terminal) state — like paid/denied it has outbound edges, so not in the dead-end set.
    expect(isTerminal("partial_paid")).toBe(false);
    expect(CLAIM_TERMINAL_STATES).not.toContain("partial_paid");
  });
});

describe("D14 replacement / void chain on the ORIGINAL claim", () => {
  it("ack_accepted → replaced (817) / voided (818)", () => {
    expect(reduce("ack_accepted", "replacement_accepted").state).toBe("replaced");
    expect(reduce("ack_accepted", "void_accepted").state).toBe("voided");
  });

  it("ack_partial → replaced (817 corrects the rejected lines)", () => {
    expect(reduce("ack_partial", "replacement_accepted").state).toBe("replaced");
    // a void is NOT modelled from ack_partial.
    expect(reduce("ack_partial", "void_accepted").error).toBe("INVALID_TRANSITION");
  });

  it("paid → replaced (817 post-payment correction) / voided (818 post-payment void)", () => {
    expect(reduce("paid", "replacement_accepted").state).toBe("replaced");
    expect(reduce("paid", "void_accepted").state).toBe("voided");
  });

  it("the §7.11 MAC-portal-outage path regresses submitted → ready (re-queueable)", () => {
    expect(reduce("submitted", "submission_failed").state).toBe("ready");
  });

  it("277CA partial → ack_partial; 999/277CA reject → ack_rejected (terminal)", () => {
    expect(reduce("ack_pending", "ack_277ca_partial").state).toBe("ack_partial");
    expect(reduce("ack_pending", "ack_277ca_rejected").state).toBe("ack_rejected");
    expect(reduce("submitted", "ack_999_rejected").state).toBe("ack_rejected");
  });
});

// ── NOE machine ──────────────────────────────────────────────────────────────────────────────────────

const ALL_NOTICE_STATES: readonly NoticeState[] = [
  "draft",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_rejected",
  "cancelled",
];

const NOE_EVENTS: readonly noeMachine.NoeTransitionEvent[] = [
  "assemble",
  "cancel",
  "submit",
  "ack_999_accepted",
  "ack_999_rejected",
  "ack_277ca_accepted",
  "ack_277ca_rejected",
];

function noeCtx(event: noeMachine.NoeTransitionEvent) {
  return event === "cancel" ? { electionReversed: true } : {};
}

describe("NOE_TRANSITIONS — every legal edge applies", () => {
  for (const t of noeMachine.NOE_TRANSITIONS) {
    it(`noe ${t.from} --${t.event}--> ${t.to}`, () => {
      const ctx = noeCtx(t.event);
      expect(noeMachine.canTransition(t.from, t.event, ctx)).toBe(true);
      const result = noeMachine.reduce(t.from, t.event, ctx);
      expect(result.state).toBe(t.to);
      expect(result.error).toBeUndefined();
    });
  }

  it("the NOE ack path: draft→ready→submitted→ack_pending→ack_accepted", () => {
    let s: NoticeState = "draft";
    s = noeMachine.reduce(s, "assemble").state;
    expect(s).toBe("ready");
    s = noeMachine.reduce(s, "submit").state;
    expect(s).toBe("submitted");
    s = noeMachine.reduce(s, "ack_999_accepted").state;
    expect(s).toBe("ack_pending");
    s = noeMachine.reduce(s, "ack_277ca_accepted").state;
    expect(s).toBe("ack_accepted");
    expect(noeMachine.isTerminal(s)).toBe(true);
  });

  it("the NOE reject paths land in ack_rejected (999 reject and 277CA reject)", () => {
    expect(noeMachine.reduce("submitted", "ack_999_rejected").state).toBe("ack_rejected");
    expect(noeMachine.reduce("ack_pending", "ack_277ca_rejected").state).toBe("ack_rejected");
  });
});

describe("NOE cancel guard (pre-submission election reversal)", () => {
  it("cancel is permitted from draft/ready ONLY when the m6 election was reversed", () => {
    expect(noeMachine.reduce("draft", "cancel", { electionReversed: true }).state).toBe(
      "cancelled",
    );
    expect(noeMachine.reduce("ready", "cancel", { electionReversed: true }).state).toBe(
      "cancelled",
    );
  });

  it("cancel is blocked (GUARD_FAILED) when the election was not reversed", () => {
    expect(noeMachine.reduce("draft", "cancel", { electionReversed: false }).error).toBe(
      "GUARD_FAILED",
    );
  });

  it("cancel fails CLOSED when the guard fact is absent", () => {
    expect(noeMachine.canTransition("ready", "cancel")).toBe(false);
    expect(noeMachine.reduce("ready", "cancel").error).toBe("GUARD_FAILED");
  });
});

describe("NOE illegal pairs fail CLOSED + terminal states", () => {
  const legal = new Set(noeMachine.NOE_TRANSITIONS.map((t) => `${t.from}|${t.event}`));
  it("every (state, event) pair not in the table is INVALID_TRANSITION with no state change", () => {
    for (const from of ALL_NOTICE_STATES) {
      for (const event of NOE_EVENTS) {
        if (legal.has(`${from}|${event}`)) continue;
        const ctx = noeCtx(event);
        expect(noeMachine.canTransition(from, event, ctx)).toBe(false);
        const result = noeMachine.reduce(from, event, ctx);
        expect(result.error).toBe("INVALID_TRANSITION");
        expect(result.state).toBe(from);
      }
    }
  });

  it("ack_accepted / ack_rejected / cancelled are terminal", () => {
    expect([...noeMachine.NOE_TERMINAL_STATES].sort()).toEqual([
      "ack_accepted",
      "ack_rejected",
      "cancelled",
    ]);
    for (const state of noeMachine.NOE_TERMINAL_STATES) {
      expect(noeMachine.isTerminal(state)).toBe(true);
    }
  });
});

// ── NOTR machine ─────────────────────────────────────────────────────────────────────────────────────

const NOTR_EVENTS: readonly notrMachine.NotrTransitionEvent[] = [
  "assemble",
  "cancel",
  "submit",
  "ack_999_accepted",
  "ack_999_rejected",
  "ack_277ca_accepted",
  "ack_277ca_rejected",
];

function notrCtx(event: notrMachine.NotrTransitionEvent) {
  return event === "cancel" ? { terminatingEventReversed: true } : {};
}

describe("NOTR_TRANSITIONS — every legal edge applies", () => {
  for (const t of notrMachine.NOTR_TRANSITIONS) {
    it(`notr ${t.from} --${t.event}--> ${t.to}`, () => {
      const ctx = notrCtx(t.event);
      expect(notrMachine.canTransition(t.from, t.event, ctx)).toBe(true);
      const result = notrMachine.reduce(t.from, t.event, ctx);
      expect(result.state).toBe(t.to);
      expect(result.error).toBeUndefined();
    });
  }

  it("the NOTR ack path: draft→ready→submitted→ack_pending→ack_accepted", () => {
    let s: NoticeState = "draft";
    s = notrMachine.reduce(s, "assemble").state;
    s = notrMachine.reduce(s, "submit").state;
    s = notrMachine.reduce(s, "ack_999_accepted").state;
    s = notrMachine.reduce(s, "ack_277ca_accepted").state;
    expect(s).toBe("ack_accepted");
    expect(notrMachine.isTerminal(s)).toBe(true);
  });

  it("the NOTR 999-reject edge lands in ack_rejected (file-header note: not stranded in submitted)", () => {
    expect(notrMachine.reduce("submitted", "ack_999_rejected").state).toBe("ack_rejected");
    expect(notrMachine.reduce("ack_pending", "ack_277ca_rejected").state).toBe("ack_rejected");
  });
});

describe("NOTR auto-cancel guard (terminating m6 event reversal)", () => {
  it("cancel is permitted from draft/ready ONLY when the terminating event was reversed", () => {
    expect(notrMachine.reduce("draft", "cancel", { terminatingEventReversed: true }).state).toBe(
      "cancelled",
    );
    expect(notrMachine.reduce("ready", "cancel", { terminatingEventReversed: true }).state).toBe(
      "cancelled",
    );
  });

  it("cancel is blocked / fails CLOSED otherwise", () => {
    expect(notrMachine.reduce("draft", "cancel", { terminatingEventReversed: false }).error).toBe(
      "GUARD_FAILED",
    );
    expect(notrMachine.reduce("ready", "cancel").error).toBe("GUARD_FAILED");
  });
});

describe("NOTR illegal pairs fail CLOSED + terminal states", () => {
  const legal = new Set(notrMachine.NOTR_TRANSITIONS.map((t) => `${t.from}|${t.event}`));
  it("every (state, event) pair not in the table is INVALID_TRANSITION with no state change", () => {
    for (const from of ALL_NOTICE_STATES) {
      for (const event of NOTR_EVENTS) {
        if (legal.has(`${from}|${event}`)) continue;
        const ctx = notrCtx(event);
        expect(notrMachine.canTransition(from, event, ctx)).toBe(false);
        const result = notrMachine.reduce(from, event, ctx);
        expect(result.error).toBe("INVALID_TRANSITION");
        expect(result.state).toBe(from);
      }
    }
  });

  it("ack_accepted / ack_rejected / cancelled are terminal", () => {
    expect([...notrMachine.NOTR_TERMINAL_STATES].sort()).toEqual([
      "ack_accepted",
      "ack_rejected",
      "cancelled",
    ]);
    for (const state of notrMachine.NOTR_TERMINAL_STATES) {
      expect(notrMachine.isTerminal(state)).toBe(true);
    }
  });
});
