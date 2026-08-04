// @wardenx/dosespot — §2.7 D9 refill-inbox workflow (M12-T04). Pure-domain unit tests.
import { describe, expect, it } from "vitest";
import {
  // SLA
  DEFAULT_REFILL_SLA_POLICY,
  // machine
  REFILL_REQUEST_GRAPH,
  REFILL_SLA_CRITICAL_FLOOR_HOURS,
  REFILL_SLA_WARN_FLOOR_HOURS,
  type RefillRequestEvent,
  // controlled-substance rules
  SCHEDULE_REFILL_MAX,
  assertRefillAuthorizedCount,
  buildRefillMintFacts,
  classifyRefillSlaStage,
  computeHoursPending,
  maxRefillsForSchedule,
  planRefillReceipt,
  planRefillSlaAlert,
  transitionRefillRequest,
  validateControlledRefillMaxOverride,
  validateRefillSlaPolicy,
} from "../src/refill";

const REFILL_ID = "rf-1";
const SOURCE_ORDER_ID = "mo-src-1";

const approve = (
  over: Partial<Extract<RefillRequestEvent, { type: "approve" }>> = {},
): RefillRequestEvent => ({
  type: "approve",
  actorInScope: true,
  sourceOrderActive: true,
  deaSchedule: null,
  refillsAuthorized: 1,
  responseChannel: "electronic_via_dosespot",
  ...over,
});

// ── §2.7 receipt (factory) ────────────────────────────────────────────────────────────────────────────
describe("§2.7 planRefillReceipt", () => {
  it("emits audit + received outbox + received M36 alert", () => {
    const effects = planRefillReceipt();
    expect(effects).toEqual([
      { kind: "audit" },
      { kind: "outbox", event: "m12.refill_request_received" },
      { kind: "alert", alert: "refill_request.received" },
    ]);
  });
});

// ── §2.7 transition graph ─────────────────────────────────────────────────────────────────────────────
describe("§2.7 REFILL_REQUEST_GRAPH", () => {
  it("only pending is non-terminal", () => {
    expect(REFILL_REQUEST_GRAPH.pending).toEqual(["approve", "deny", "expire"]);
    expect(REFILL_REQUEST_GRAPH.approved).toEqual([]);
    expect(REFILL_REQUEST_GRAPH.denied).toEqual([]);
    expect(REFILL_REQUEST_GRAPH.expired).toEqual([]);
  });

  it("rejects an event from a terminal status (409)", () => {
    expect(() => transitionRefillRequest("approved", REFILL_ID, approve())).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_REFILL_TRANSITION", statusCode: 409 }),
    );
    expect(() =>
      transitionRefillRequest("denied", REFILL_ID, { type: "expire", isSystemActor: true }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_REFILL_TRANSITION" }));
  });
});

// ── §2.7 approve (mint new prescription) ──────────────────────────────────────────────────────────────
describe("§2.7 transitionRefillRequest approve", () => {
  it("mints a new medication_order, sets resulting order, responds to DoseSpot, emits approved", () => {
    const t = transitionRefillRequest("pending", REFILL_ID, approve());
    expect(t.to).toBe("approved");
    expect(t.effects).toEqual([
      { kind: "mint_medication_order", derivedFromRefillId: REFILL_ID, refillsAuthorized: 1 },
      { kind: "set_resulting_order" },
      { kind: "set_timestamp", field: "approved_at" },
      { kind: "audit" },
      { kind: "respond_to_dosespot", outcome: "approved", channel: "electronic_via_dosespot" },
      { kind: "outbox", event: "m12.refill_request_approved" },
    ]);
  });

  it("blocks an actor out of inbox scope (403)", () => {
    expect(() =>
      transitionRefillRequest("pending", REFILL_ID, approve({ actorInScope: false })),
    ).toThrowError(expect.objectContaining({ code: "REFILL_ACTOR_NOT_IN_SCOPE", statusCode: 403 }));
  });

  it("blocks a refill of a non-active source order (409)", () => {
    expect(() =>
      transitionRefillRequest("pending", REFILL_ID, approve({ sourceOrderActive: false })),
    ).toThrowError(
      expect.objectContaining({ code: "REFILL_SOURCE_ORDER_NOT_ACTIVE", statusCode: 409 }),
    );
  });

  it("blocks a Schedule II refill (non-refillable, 422)", () => {
    expect(() =>
      transitionRefillRequest(
        "pending",
        REFILL_ID,
        approve({ deaSchedule: "II", refillsAuthorized: 1 }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "REFILL_SCHEDULE_II_NON_REFILLABLE", statusCode: 422 }),
    );
  });

  it("permits a Schedule IV refill within the ≤5 ceiling", () => {
    const t = transitionRefillRequest(
      "pending",
      REFILL_ID,
      approve({ deaSchedule: "IV", refillsAuthorized: 5 }),
    );
    expect(t.to).toBe("approved");
  });

  it("blocks a Schedule IV refill above the ≤5 ceiling (422)", () => {
    expect(() =>
      transitionRefillRequest(
        "pending",
        REFILL_ID,
        approve({ deaSchedule: "IV", refillsAuthorized: 6 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "REFILL_EXCEEDS_SCHEDULE_MAX" }));
  });

  it("honours a tenant tighten-only override below the schedule ceiling", () => {
    expect(() =>
      transitionRefillRequest(
        "pending",
        REFILL_ID,
        approve({ deaSchedule: "IV", refillsAuthorized: 3, tenantMaxOverride: 2 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "REFILL_EXCEEDS_SCHEDULE_MAX" }));
  });
});

// ── §2.7 deny ─────────────────────────────────────────────────────────────────────────────────────────
describe("§2.7 transitionRefillRequest deny", () => {
  const deny = (over = {}): RefillRequestEvent => ({
    type: "deny",
    actorInScope: true,
    denialReasonPresent: true,
    responseChannel: "electronic_via_dosespot",
    ...over,
  });

  it("responds to DoseSpot with denial + emits denied (no mint)", () => {
    const t = transitionRefillRequest("pending", REFILL_ID, deny());
    expect(t.to).toBe("denied");
    expect(t.effects).toEqual([
      { kind: "set_timestamp", field: "denied_at" },
      { kind: "audit" },
      { kind: "respond_to_dosespot", outcome: "denied", channel: "electronic_via_dosespot" },
      { kind: "outbox", event: "m12.refill_request_denied" },
    ]);
    expect(t.effects.some((e) => e.kind === "mint_medication_order")).toBe(false);
  });

  it("requires a denial reason (422)", () => {
    expect(() =>
      transitionRefillRequest("pending", REFILL_ID, deny({ denialReasonPresent: false })),
    ).toThrowError(
      expect.objectContaining({ code: "REFILL_DENIAL_REASON_REQUIRED", statusCode: 422 }),
    );
  });

  it("blocks an actor out of inbox scope (403)", () => {
    expect(() =>
      transitionRefillRequest("pending", REFILL_ID, deny({ actorInScope: false })),
    ).toThrowError(expect.objectContaining({ code: "REFILL_ACTOR_NOT_IN_SCOPE" }));
  });
});

// ── §2.7 expire (system actor) ────────────────────────────────────────────────────────────────────────
describe("§2.7 transitionRefillRequest expire", () => {
  it("expires on a system actor (no new order, no DoseSpot response)", () => {
    const t = transitionRefillRequest("pending", REFILL_ID, {
      type: "expire",
      isSystemActor: true,
    });
    expect(t.to).toBe("expired");
    expect(t.effects).toEqual([{ kind: "set_timestamp", field: "expired_at" }, { kind: "audit" }]);
  });

  it("rejects a human-actor expire (403)", () => {
    expect(() =>
      transitionRefillRequest("pending", REFILL_ID, { type: "expire", isSystemActor: false }),
    ).toThrowError(expect.objectContaining({ code: "REFILL_NOT_SYSTEM_ACTOR", statusCode: 403 }));
  });
});

// ── §2.7 mint facts ───────────────────────────────────────────────────────────────────────────────────
describe("§2.7 buildRefillMintFacts", () => {
  it("a refill is a new prescription, never a replacement (replaces=null)", () => {
    expect(buildRefillMintFacts(REFILL_ID, SOURCE_ORDER_ID, 2)).toEqual({
      derivedFromRefillId: REFILL_ID,
      sourceMedicationOrderId: SOURCE_ORDER_ID,
      replacesMedicationOrderId: null,
      refillsAuthorized: 2,
    });
  });
});

// ── §1.4 controlled-substance refill rules ────────────────────────────────────────────────────────────
describe("§1.4 controlled-substance refill rules", () => {
  it("the platform-floor matrix: II=0, III/IV/V=5", () => {
    expect(SCHEDULE_REFILL_MAX).toEqual({ II: 0, III: 5, IV: 5, V: 5 });
  });

  it("non-controlled orders are not capped by schedule (null)", () => {
    expect(maxRefillsForSchedule(null)).toBeNull();
    expect(() => assertRefillAuthorizedCount(null, 99)).not.toThrow();
  });

  it("takes the stricter of floor and tenant override", () => {
    expect(maxRefillsForSchedule("IV", 2)).toBe(2);
    expect(maxRefillsForSchedule("IV", 99)).toBe(5); // never loosens above the floor
  });

  it("rejects a negative / non-integer authorized count (422)", () => {
    expect(() => assertRefillAuthorizedCount("IV", -1)).toThrowError(
      expect.objectContaining({ code: "REFILL_EXCEEDS_SCHEDULE_MAX" }),
    );
  });

  it("validateControlledRefillMaxOverride is tighten-only", () => {
    expect(() => validateControlledRefillMaxOverride("IV", 3)).not.toThrow();
    expect(() => validateControlledRefillMaxOverride("IV", 6)).toThrowError(
      expect.objectContaining({ code: "REFILL_CONTROLLED_MAX_EXCEEDS_FLOOR" }),
    );
    expect(() => validateControlledRefillMaxOverride("IV", -1)).toThrowError(
      expect.objectContaining({ code: "REFILL_CONTROLLED_MAX_OUT_OF_RANGE" }),
    );
  });
});

// ── §2.7 SLA clock ────────────────────────────────────────────────────────────────────────────────────
describe("§2.7 refill SLA clock", () => {
  it("the platform default is 48h warn / 72h critical", () => {
    expect(DEFAULT_REFILL_SLA_POLICY).toEqual({ warnHours: 48, criticalHours: 72 });
    expect(REFILL_SLA_WARN_FLOOR_HOURS).toBe(48);
    expect(REFILL_SLA_CRITICAL_FLOOR_HOURS).toBe(72);
  });

  it("computeHoursPending floors to whole hours and never goes negative", () => {
    expect(computeHoursPending("2026-06-22T00:00:00.000Z", "2026-06-24T01:30:00.000Z")).toBe(49);
    expect(computeHoursPending("2026-06-22T00:00:00.000Z", "2026-06-21T00:00:00.000Z")).toBe(0);
  });

  it("classifies stages against the policy", () => {
    expect(classifyRefillSlaStage(47)).toBe("none");
    expect(classifyRefillSlaStage(48)).toBe("warn");
    expect(classifyRefillSlaStage(71)).toBe("warn");
    expect(classifyRefillSlaStage(72)).toBe("critical");
  });

  it("respects a tightened tenant policy", () => {
    expect(classifyRefillSlaStage(24, { warnHours: 12, criticalHours: 24 })).toBe("critical");
  });

  it("plans the outbox + typed alert per stage", () => {
    expect(planRefillSlaAlert("none")).toEqual([]);
    expect(planRefillSlaAlert("warn")).toEqual([
      { kind: "outbox", event: "m12.refill_request_sla_warn" },
      { kind: "alert", alert: "refill_request.sla_warn" },
    ]);
    expect(planRefillSlaAlert("critical")).toEqual([
      { kind: "outbox", event: "m12.refill_request_sla_critical" },
      { kind: "alert", alert: "refill_request.sla_critical" },
    ]);
  });

  it("validateRefillSlaPolicy is tighten-only and ordered", () => {
    expect(() => validateRefillSlaPolicy({ warnHours: 24, criticalHours: 48 })).not.toThrow();
    expect(() => validateRefillSlaPolicy({ warnHours: 48, criticalHours: 96 })).toThrowError(
      expect.objectContaining({ code: "REFILL_SLA_EXCEEDS_FLOOR" }),
    );
    expect(() => validateRefillSlaPolicy({ warnHours: 50, criticalHours: 60 })).toThrowError(
      expect.objectContaining({ code: "REFILL_SLA_EXCEEDS_FLOOR" }),
    );
    expect(() => validateRefillSlaPolicy({ warnHours: 60, criticalHours: 48 })).toThrowError(
      expect.objectContaining({ code: "REFILL_SLA_HOURS_OUT_OF_RANGE" }),
    );
  });
});
