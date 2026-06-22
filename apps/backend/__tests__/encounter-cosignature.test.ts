// apps/backend/__tests__/encounter-cosignature.test.ts — M8-T06 (§2.4 D3 cosignature workflow).
//
// The pure cosignature-request domain: the §2.4 state machine (legal-graph + enumerated guards + the
// §2.8 side-effect lists) and the 12h/24h/48h SLA clock. No DB — the routed/now instants, the cosigner
// RN eligibility and the supervisor flag are injected. Walks the §7.2 (24h cosignature) and §7.3 (48h
// hard cap + supervisor release) acceptance scenarios end-to-end over the pure machine + clock.
import { describe, expect, it } from "vitest";
import {
  COSIGNATURE_GRAPH,
  COSIGNATURE_SLA_HOURS,
  addHours,
  computeCosignatureSlaDeadlines,
  decideCosignatureSlaStage,
  hoursBetween,
  planCosignatureCreation,
  transitionCosignature,
  type CosignatureState,
} from "../src/modules/08-encounters/cosignature/index";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/index";

/** Pull the outbox event names off a side-effect list (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

/** Pull the set-timestamp field names off a side-effect list (test helper). */
function timestampFields(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "set_timestamp"; field: string } => e.kind === "set_timestamp")
    .map((e) => e.field);
}

/** Assert that `fn` throws an EncounterStateError with the given §2.4/§2.7 code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected EncounterStateError(${code}) but nothing threw`);
  } catch (err) {
    expect(err).toBeInstanceOf(EncounterStateError);
    expect((err as EncounterStateError).code).toBe(code);
  }
}

const SUP = "11111111-1111-1111-1111-111111111111";

describe("M8-T06 §2.4 cosignature SLA clock", () => {
  const ROUTED = "2026-06-21T08:00:00.000Z";

  it("computes the 12h/24h/48h boundary instants from routedAt", () => {
    const d = computeCosignatureSlaDeadlines(ROUTED);
    expect(d.overdueAt).toBe("2026-06-21T20:00:00.000Z"); // +12h
    expect(d.escalateAt).toBe("2026-06-22T08:00:00.000Z"); // +24h
    expect(d.hardCapAt).toBe("2026-06-23T08:00:00.000Z"); // +48h
  });

  it("addHours / hoursBetween are inverse and DST-agnostic (UTC math)", () => {
    expect(hoursBetween(ROUTED, addHours(ROUTED, 48))).toBe(48);
    expect(hoursBetween(ROUTED, ROUTED)).toBe(0);
  });

  it("decides the un-reached SLA stage by elapsed time AND status (idempotent)", () => {
    const at = (h: number, status: CosignatureState) =>
      decideCosignatureSlaStage({
        routedAtInstant: ROUTED,
        asOfInstant: addHours(ROUTED, h),
        currentStatus: status,
      });
    expect(at(0, "routed")).toBe("none");
    expect(at(11.9, "routed")).toBe("none");
    expect(at(12, "routed")).toBe("overdue"); // soft alert window, no state change
    expect(at(23.9, "acknowledged")).toBe("overdue");
    expect(at(24, "routed")).toBe("escalate");
    expect(at(24, "escalated")).toBe("none"); // already escalated → not re-fired
    expect(at(48, "escalated")).toBe("hard_cap");
    expect(at(48, "routed")).toBe("hard_cap");
  });

  it("never sweeps a terminal / locked / released request", () => {
    for (const status of ["pending", "hard_cap_reached", "supervisor_released", "signed"] as const) {
      expect(
        decideCosignatureSlaStage({ routedAtInstant: ROUTED, asOfInstant: addHours(ROUTED, 72), currentStatus: status }),
      ).toBe("none");
    }
  });

  it("the thresholds are the locked D3 values", () => {
    expect(COSIGNATURE_SLA_HOURS).toEqual({ overdue: 12, escalate: 24, hardCap: 48 });
  });
});

describe("M8-T06 §2.4 cosignature-request state machine", () => {
  it("a routed request is created with the routed timestamp + audit (no double-routed outbox)", () => {
    const effects = planCosignatureCreation("2026-06-21");
    expect(timestampFields(effects)).toEqual(["routed_at"]);
    // `m8.encounter.cosignature_routed` is emitted by the opening encounter transition, not here.
    expect(outboxEvents(effects)).toEqual([]);
  });

  it("the legal §2.4 graph: sign while routed/acknowledged/escalated, but NOT from hard_cap_reached", () => {
    expect(COSIGNATURE_GRAPH.routed).toContain("sign");
    expect(COSIGNATURE_GRAPH.acknowledged).toContain("sign");
    expect(COSIGNATURE_GRAPH.escalated).toContain("sign");
    expect(COSIGNATURE_GRAPH.hard_cap_reached).not.toContain("sign");
    expect(COSIGNATURE_GRAPH.hard_cap_reached).toEqual(["release"]);
    expect(COSIGNATURE_GRAPH.supervisor_released).toEqual(["sign"]);
    expect(COSIGNATURE_GRAPH.signed).toEqual([]);
  });

  it("acknowledge stamps acknowledged_at without an outbox", () => {
    const t = transitionCosignature("routed", { type: "acknowledge", at: "2026-06-21" });
    expect(t.to).toBe("acknowledged");
    expect(timestampFields(t.effects)).toEqual(["acknowledged_at"]);
    expect(outboxEvents(t.effects)).toEqual([]);
  });

  it("escalate flips to escalated and emits cosignature_escalated", () => {
    const t = transitionCosignature("routed", { type: "escalate", supervisorMembershipId: SUP, at: "2026-06-22" });
    expect(t.to).toBe("escalated");
    expect(outboxEvents(t.effects)).toEqual(["m8.encounter.cosignature_escalated"]);
  });

  it("reachHardCap flips to hard_cap_reached and emits the critical event", () => {
    const t = transitionCosignature("escalated", { type: "reachHardCap", supervisorMembershipId: SUP, at: "2026-06-23" });
    expect(t.to).toBe("hard_cap_reached");
    expect(outboxEvents(t.effects)).toEqual(["m8.encounter.cosignature_hard_cap_reached"]);
  });

  it("an event from a state that does not accept it is ILLEGAL_TRANSITION", () => {
    expectCode(() => transitionCosignature("signed", { type: "acknowledge", at: "2026-06-21" }), "ILLEGAL_TRANSITION");
    expectCode(
      () => transitionCosignature("routed", { type: "release", isSupervisor: true, reason: "x".repeat(40), at: "2026-06-23" }),
      "ILLEGAL_TRANSITION",
    );
  });
});

describe("M8-T06 §7.2 — LPN routine visit with 24-hour cosignature", () => {
  it("routed → acknowledged → signed; encounter cosign handled separately (no cosigned outbox here)", () => {
    const ack = transitionCosignature("routed", { type: "acknowledge", at: "2026-06-21" });
    expect(ack.to).toBe("acknowledged");
    const signed = transitionCosignature(ack.to, { type: "sign", isQualifiedRn: true, at: "2026-06-21" });
    expect(signed.to).toBe("signed");
    expect(timestampFields(signed.effects)).toEqual(["signed_at"]);
    // The `m8.encounter.cosigned` outbox is the encounter machine's recordCosignature, not the request.
    expect(outboxEvents(signed.effects)).toEqual([]);
  });

  it("a non-RN cosignature attempt is rejected NOT_COSIGN_ELIGIBLE", () => {
    expectCode(
      () => transitionCosignature("acknowledged", { type: "sign", isQualifiedRn: false, at: "2026-06-21" }),
      "NOT_COSIGN_ELIGIBLE",
    );
  });
});

describe("M8-T06 §7.3 — 48-hour hard cap and supervisor release", () => {
  const ROUTED = "2026-06-21T08:00:00.000Z";

  it("full walk: routed → escalate(24h) → hard_cap(48h) → supervisor_released → RN sign → signed", () => {
    let state: CosignatureState = "routed";

    // T+12h: soft alert (no state change) — driven by the SLA clock decision.
    expect(decideCosignatureSlaStage({ routedAtInstant: ROUTED, asOfInstant: addHours(ROUTED, 12), currentStatus: state })).toBe(
      "overdue",
    );

    // T+24h: escalation.
    expect(decideCosignatureSlaStage({ routedAtInstant: ROUTED, asOfInstant: addHours(ROUTED, 24), currentStatus: state })).toBe(
      "escalate",
    );
    const esc = transitionCosignature(state, { type: "escalate", supervisorMembershipId: SUP, at: "2026-06-22" });
    state = esc.to;
    expect(state).toBe("escalated");

    // T+48h: hard cap; encounter locked.
    expect(decideCosignatureSlaStage({ routedAtInstant: ROUTED, asOfInstant: addHours(ROUTED, 48), currentStatus: state })).toBe(
      "hard_cap",
    );
    const cap = transitionCosignature(state, { type: "reachHardCap", supervisorMembershipId: SUP, at: "2026-06-23" });
    state = cap.to;
    expect(state).toBe("hard_cap_reached");

    // Locked: a qualified RN cannot sign until a supervisor releases.
    expectCode(() => transitionCosignature(state, { type: "sign", isQualifiedRn: true, at: "2026-06-23" }), "COSIGNATURE_LOCKED");

    // Supervisor releases with a documented reason ≥ 40 chars.
    const rel = transitionCosignature(state, {
      type: "release",
      isSupervisor: true,
      reason: "Cosigner OOO; RN case manager reassigned for review.",
      at: "2026-06-23",
    });
    state = rel.to;
    expect(state).toBe("supervisor_released");
    expect(rel.effects.some((e) => e.kind === "set_field" && e.field === "supervisor_released_reason")).toBe(true);

    // Release does NOT cosign — an actual RN signature is still required.
    const signed = transitionCosignature(state, { type: "sign", isQualifiedRn: true, at: "2026-06-23" });
    expect(signed.to).toBe("signed");
  });

  it("only a supervisor may release", () => {
    expectCode(
      () =>
        transitionCosignature("hard_cap_reached", {
          type: "release",
          isSupervisor: false,
          reason: "x".repeat(40),
          at: "2026-06-23",
        }),
      "SUPERVISOR_RELEASE_NOT_PERMITTED",
    );
  });

  it("the supervisor release reason must be ≥ 40 characters", () => {
    expectCode(
      () =>
        transitionCosignature("hard_cap_reached", {
          type: "release",
          isSupervisor: true,
          reason: "too short",
          at: "2026-06-23",
        }),
      "SUPERVISOR_RELEASE_REASON_TOO_SHORT",
    );
  });
});
