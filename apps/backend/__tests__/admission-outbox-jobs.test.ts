// apps/backend/__tests__/admission-outbox-jobs.test.ts — M6-T10 (§4.4 outbox contract + §4.3 jobs).
// Locks the full `m6.*` event catalog (naming/ownership/consumers, the same invariants arch:gaps
// enforces) against the §4.4 name list, and the two pure compliance-window scans (recompute +
// window-alert) for status promotion + idempotency.
import { Value } from "@sinclair/typebox/value";
import { M6_EVENT_NAMES } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  CLOSING_SOON_LEAD_MS,
  type ComplianceWindowSnapshot,
  M6_JOB_SCHEDULES,
  M6_OUTBOX_EVENTS,
  M6_QUEUES,
  jobIdempotencyKey,
  planRecomputeWindows,
  planWindowAlert,
  promoteWindowStatus,
} from "../src/modules/06-admission/index";

describe("M6 outbox event contract (§4.4)", () => {
  it("publishes exactly the §4.4 taxonomy (M6_EVENT_NAMES), no more, no less", () => {
    const published = M6_OUTBOX_EVENTS.map((e) => e.eventName).sort();
    expect(published).toEqual([...M6_EVENT_NAMES].sort());
  });

  it("every event is owned by m6, namespaced under its own prefix, and outbox-only", () => {
    for (const e of M6_OUTBOX_EVENTS) {
      expect(e.moduleOwner).toBe("m6");
      expect(e.eventName.startsWith("m6.")).toBe(true);
      expect(e.eventName).toMatch(/^m\d+\.[a-z0-9_]+\.[a-z0-9_.]+$/);
      expect(e.isOutboxOnly).toBe(true); // §4.7: M6 exposes no Socket.IO
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it("declares only real module-id consumers in `mN` form", () => {
    for (const e of M6_OUTBOX_EVENTS) {
      for (const c of e.declaredConsumers) {
        expect(c).toMatch(/^m\d+$/);
      }
    }
  });

  it("has no duplicate event names (catalog is collision-free)", () => {
    const names = M6_OUTBOX_EVENTS.map((e) => e.eventName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the broad activation fan-out reaches the chain modules", () => {
    const activated = M6_OUTBOX_EVENTS.find((e) => e.eventName === "m6.admission.activated");
    expect(activated?.declaredConsumers).toEqual(
      expect.arrayContaining(["m5", "m7", "m8", "m10", "m23"]),
    );
    // m36 used to be asserted here. It is not an outbox consumer and never was — its alert intake is
    // the synchronous `AlertEmitter` seam — and declaring it kept this event deferred forever (#103).
    // The relationship is still recorded, in the field that describes the mechanism it actually uses.
    expect(activated?.seamConsumers).toEqual(expect.arrayContaining(["m33", "m36"]));
    expect(activated?.declaredConsumers).not.toContain("m36");
    // F-131 (#248) — m26 dropped: M26's cap math reads M6 via a build-time `ElectionPeriodReader` PULL,
    // never a push subscription to admission activation.
    expect(activated?.declaredConsumers).not.toContain("m26");
    // F-134 (#248) — m16 dropped: an admission ACTIVATION carries no fact M16's bereavement program
    // (which starts at death, not admission) needs; M16's own §4.5 outbox-subscriptions table never
    // named this event.
    expect(activated?.declaredConsumers).not.toContain("m16");
  });

  it("applier-reused events carry the optional provenance `source` marker", () => {
    for (const name of [
      "m6.discharge.created",
      "m6.discharge.death",
      "m6.compliance.window.opened",
    ]) {
      const e = M6_OUTBOX_EVENTS.find((x) => x.eventName === name)!;
      // optional → present without source validates; with the marker validates too.
      const base =
        name === "m6.discharge.death"
          ? { dischargeEventId: "d1", admissionId: "a1", dischargeDate: "2026-01-01" }
          : name === "m6.discharge.created"
            ? {
                dischargeEventId: "d1",
                admissionId: "a1",
                reason: "death",
                dischargeDate: "2026-01-01",
                requiresMedicalDirectorCosign: false,
                // F-100 — the chart M22 files the rendered discharge summary against.
                patientId: "p1",
              }
            : {
                complianceWindowId: "w1",
                admissionId: "a1",
                windowType: "care_plan_5d",
                dueAt: "2026-01-01",
                severity: "info",
              };
      expect(Value.Check(e.payloadSchema, base)).toBe(true);
      expect(Value.Check(e.payloadSchema, { ...base, source: "m29_proposal_accept" })).toBe(true);
    }
  });

  it("rejects payloads missing required keys", () => {
    const overdue = M6_OUTBOX_EVENTS.find((e) => e.eventName === "m6.compliance.window.overdue")!;
    expect(
      Value.Check(overdue.payloadSchema, { complianceWindowId: "w1", severity: "alert" }),
    ).toBe(true);
    expect(Value.Check(overdue.payloadSchema, { complianceWindowId: "w1" })).toBe(false);
  });
});

describe("M6 job catalog (§4.3)", () => {
  it("namespaces every queue under m6 and schedules the cron/repeatable jobs", () => {
    for (const q of Object.values(M6_QUEUES)) expect(q.startsWith("m6.")).toBe(true);
    expect(M6_JOB_SCHEDULES.recertDueNotify).toBe("0 6 * * *");
    expect(M6_JOB_SCHEDULES.f2fDueNotify).toBe("0 6 * * *");
    expect(M6_JOB_SCHEDULES.windowAlert).toBe("*/15 * * * *");
  });

  it("idempotency key is stable on (admissionId, eventType, payloadHash)", () => {
    const k = { admissionId: "a1", eventType: "recompute_windows", payloadHash: "abc" };
    expect(jobIdempotencyKey(k)).toBe("a1:recompute_windows:abc");
    expect(jobIdempotencyKey(k)).toBe(jobIdempotencyKey(k));
  });
});

const NOW = new Date("2026-06-21T12:00:00.000Z");
function win(over: Partial<ComplianceWindowSnapshot>): ComplianceWindowSnapshot {
  return {
    complianceWindowId: "w1",
    admissionId: "a1",
    windowType: "care_plan_5d",
    status: "open",
    severity: "warning",
    dueAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}

describe("compliance-window status promotion (§3 window-scanner)", () => {
  it("stays open when far from due", () => {
    expect(promoteWindowStatus(win({ dueAt: "2026-07-01T00:00:00.000Z" }), NOW)).toBe("open");
  });

  it("flips to closing_soon within the lead window", () => {
    const due = new Date(NOW.getTime() + CLOSING_SOON_LEAD_MS - 1).toISOString();
    expect(promoteWindowStatus(win({ dueAt: due }), NOW)).toBe("closing_soon");
  });

  it("flips to overdue at/after due", () => {
    expect(promoteWindowStatus(win({ dueAt: "2026-06-20T00:00:00.000Z" }), NOW)).toBe("overdue");
  });

  it("closed is terminal", () => {
    expect(
      promoteWindowStatus(win({ status: "closed", dueAt: "2026-06-20T00:00:00.000Z" }), NOW),
    ).toBe("closed");
  });
});

describe("admission.window_alert scan (§4.3)", () => {
  it("emits m6.compliance.window.overdue only on the edge into overdue", () => {
    const plan = planWindowAlert(
      [
        win({ complianceWindowId: "w-open", dueAt: "2026-07-30T00:00:00.000Z" }),
        win({
          complianceWindowId: "w-newly-overdue",
          status: "open",
          dueAt: "2026-06-20T00:00:00.000Z",
        }),
        win({
          complianceWindowId: "w-already-overdue",
          status: "overdue",
          dueAt: "2026-06-20T00:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toEqual({
      eventName: "m6.compliance.window.overdue",
      payload: { complianceWindowId: "w-newly-overdue", severity: "alert" },
    });
  });

  it("is idempotent — a second run over the persisted statuses emits nothing", () => {
    const afterFirst = win({ status: "overdue", dueAt: "2026-06-20T00:00:00.000Z" });
    expect(planWindowAlert([afterFirst], NOW).events).toHaveLength(0);
  });
});

describe("admission.recompute_windows scan (§4.3)", () => {
  it("recomputes only the target admission's windows and emits no events", () => {
    const plan = planRecomputeWindows(
      "a1",
      [
        win({ complianceWindowId: "w1", admissionId: "a1", dueAt: "2026-06-20T00:00:00.000Z" }),
        win({ complianceWindowId: "w2", admissionId: "a2", dueAt: "2026-06-20T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(plan.transitions.map((t) => t.complianceWindowId)).toEqual(["w1"]);
    expect(plan.transitions[0]?.toStatus).toBe("overdue");
    expect(plan.transitions[0]?.changed).toBe(true);
    expect(plan.events).toHaveLength(0);
  });

  it("is idempotent — recomputing the persisted statuses reports no change", () => {
    const plan = planRecomputeWindows(
      "a1",
      [win({ status: "overdue", dueAt: "2026-06-20T00:00:00.000Z" })],
      NOW,
    );
    expect(plan.transitions[0]?.changed).toBe(false);
  });
});
