// @wardenx/idg — §1.1 / D8 action-item lifecycle + carry-forward + auto-close — M14-T03.
import { describe, expect, it } from "vitest";
import {
  ACTION_ITEM_GRAPH,
  CARRY_FORWARD_COMPLIANCE_THRESHOLD,
  outboxEvents,
  planActionItemCreate,
  planCarryForward,
  transitionActionItem,
} from "../src/lifecycle";

describe("§1.1 / D8 transition graph", () => {
  it("genesis emits action_item.created + DM-to-assignee alert", () => {
    const e = planActionItemCreate();
    expect(outboxEvents(e)).toEqual(["m14.action_item.created"]);
    expect(e).toContainEqual({ kind: "alert", alert: "m14.action_item.created" });
  });

  it("closed states accept no events", () => {
    expect(ACTION_ITEM_GRAPH.completed).toEqual([]);
    expect(ACTION_ITEM_GRAPH.cancelled).toEqual([]);
    expect(ACTION_ITEM_GRAPH.auto_closed).toEqual([]);
  });

  it("start → in_progress → complete", () => {
    expect(transitionActionItem("open", { type: "start" }).to).toBe("in_progress");
    const c = transitionActionItem("in_progress", { type: "complete" });
    expect(c.to).toBe("completed");
    expect(c.effects).toContainEqual({ kind: "set_timestamp", field: "completed_at" });
    expect(outboxEvents(c.effects)).toEqual(["m14.action_item.status_changed"]);
  });

  it("rejects an off-graph event (409 ILLEGAL_ACTION_ITEM_TRANSITION)", () => {
    expect(() => transitionActionItem("completed", { type: "start" })).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_ACTION_ITEM_TRANSITION", statusCode: 409 }),
    );
  });
});

describe("§4.5 D8 auto-close", () => {
  it("auto-closes an open item against the absorbing artifact", () => {
    const t = transitionActionItem("open", {
      type: "autoClose",
      linkedKind: "order",
      linkedArtifactId: "ord-1",
      isSystemActor: true,
    });
    expect(t.to).toBe("auto_closed");
    expect(t.effects).toContainEqual({ kind: "confirm_linked_artifact" });
    expect(outboxEvents(t.effects)).toEqual(["m14.action_item.auto_closed"]);
  });

  it("a re-auto-close raises the specific 409 ACTION_ITEM_AUTO_CLOSED", () => {
    expect(() =>
      transitionActionItem("auto_closed", {
        type: "autoClose",
        linkedKind: "order",
        linkedArtifactId: "ord-1",
        isSystemActor: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "ACTION_ITEM_AUTO_CLOSED", statusCode: 409 }));
  });

  it("refuses a human-actor auto-close", () => {
    expect(() =>
      transitionActionItem("open", {
        type: "autoClose",
        linkedKind: "encounter",
        linkedArtifactId: "e1",
        isSystemActor: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_ACTION_ITEM_TRANSITION" }));
  });
});

describe("§2.7 D8 carry-forward", () => {
  it("increments the count and emits carry_forward (no compliance alert below threshold)", () => {
    const r = planCarryForward({ priorCarryForwardCount: 0, isOpenAndOverdue: true });
    expect(r.newCarryForwardCount).toBe(1);
    expect(r.isComplianceAlert).toBe(false);
    expect(outboxEvents(r.effects)).toEqual(["m14.action_item.carry_forward"]);
  });

  it("emits the critical Compliance alert when the count CROSSES the threshold (2 → 3)", () => {
    const r = planCarryForward({
      priorCarryForwardCount: CARRY_FORWARD_COMPLIANCE_THRESHOLD - 1,
      isOpenAndOverdue: true,
    });
    expect(r.newCarryForwardCount).toBe(CARRY_FORWARD_COMPLIANCE_THRESHOLD);
    expect(r.isComplianceAlert).toBe(true);
    expect(r.effects).toContainEqual({
      kind: "alert",
      alert: "m14.action_item.carry_forward.compliance",
    });
  });

  it("does NOT re-alert on later carries once at/above the threshold (alert on the crossing only)", () => {
    for (const prior of [3, 4, 7]) {
      const r = planCarryForward({ priorCarryForwardCount: prior, isOpenAndOverdue: true });
      expect(r.isComplianceAlert).toBe(false);
      expect(r.effects).not.toContainEqual({
        kind: "alert",
        alert: "m14.action_item.carry_forward.compliance",
      });
    }
  });

  it("refuses carry-forward of an item that is not open + overdue", () => {
    expect(() =>
      planCarryForward({ priorCarryForwardCount: 0, isOpenAndOverdue: false }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_ACTION_ITEM_TRANSITION" }));
  });
});
