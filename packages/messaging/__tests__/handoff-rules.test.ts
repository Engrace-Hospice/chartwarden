// WP 3.5 - the pure handoff rules: the per-item transition table, the derived handoff outcome, the policy-capped
// deadline, who may do what, and the offer shape limits.
import type { HandoffItemState } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_MAX_ITEMS,
  HANDOFF_MAX_PATIENTS,
  allowedHandoffActions,
  closeOutcome,
  effectiveDeadline,
  handoffRole,
  isPastDeadline,
  nextItemState,
  unacceptedCount,
  validateOfferShape,
} from "../src/handoffs/handoff-rules";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const P1 = "00000000-0000-4000-8000-0000000000a1";
const P2 = "00000000-0000-4000-8000-0000000000a2";
const R = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("nextItemState", () => {
  it.each([
    ["pending", "accept", "accepted"],
    ["pending", "decline", "declined"],
    ["pending", "cancel", "cancelled"],
    ["pending", "expire", "expired"],
  ] as const)("%s + %s -> %s", (from, action, to) => {
    expect(nextItemState(from, action)).toBe(to);
  });

  it.each(["accepted", "declined", "expired", "cancelled"] as const)(
    "a %s item never moves again",
    (from) => {
      for (const action of ["accept", "decline", "cancel", "expire"] as const)
        expect(nextItemState(from, action)).toBeNull();
    },
  );
});

describe("closeOutcome", () => {
  const out = (...s: HandoffItemState[]) => closeOutcome(s);

  it("stays open while any item is pending", () => {
    expect(out("accepted", "pending")).toEqual({ kind: "open" });
    expect(out("pending")).toEqual({ kind: "open" });
  });
  it("is accepted when at least one item was accepted and none is pending", () => {
    expect(out("accepted", "declined")).toEqual({
      kind: "closed",
      state: "accepted",
      reason: "all_resolved",
    });
    expect(out("accepted")).toMatchObject({ state: "accepted" });
  });
  it("is declined when nothing was accepted", () => {
    expect(out("declined", "declined")).toEqual({
      kind: "closed",
      state: "declined",
      reason: "all_resolved",
    });
    expect(out("declined", "expired")).toMatchObject({ state: "declined" });
  });
  it("counts the unaccepted items (declined or expired) for the supervisor alert", () => {
    expect(unacceptedCount(["accepted", "declined", "expired", "cancelled", "pending"])).toBe(2);
  });
});

describe("deadline", () => {
  const h = { offeredAt: NOW, expiresAt: at(240) };

  it("is the stored expires_at when the policy is no tighter", () => {
    expect(effectiveDeadline(h, 240).getTime()).toBe(at(240).getTime());
  });
  it("a lowered policy tightens an in-flight offer", () => {
    expect(effectiveDeadline(h, 60).getTime()).toBe(at(60).getTime());
  });
  it("a hand-edited longer row cannot loosen the policy", () => {
    const edited = { offeredAt: NOW, expiresAt: at(2000) };
    expect(effectiveDeadline(edited, 240).getTime()).toBe(at(240).getTime());
  });
  it("is past the deadline exactly at the deadline", () => {
    expect(isPastDeadline(h, 240, at(239))).toBe(false);
    expect(isPastDeadline(h, 240, at(240))).toBe(true);
    expect(isPastDeadline(h, 30, at(30))).toBe(true);
  });
});

describe("handoffRole and allowedHandoffActions", () => {
  const offered = { state: "offered" as const, offeredAt: NOW, expiresAt: at(240) };
  const h = { ...offered, fromUserId: "from", toUserId: "to" };

  it("names the participant, else none", () => {
    expect(handoffRole(h, "from")).toBe("sender");
    expect(handoffRole(h, "to")).toBe("recipient");
    expect(handoffRole(h, "x")).toBe("none");
  });
  it("the recipient may accept and decline an open handoff; the sender may cancel", () => {
    expect(allowedHandoffActions(offered, "recipient", at(10), 240)).toEqual(["accept", "decline"]);
    expect(allowedHandoffActions(offered, "sender", at(10), 240)).toEqual(["cancel"]);
    expect(allowedHandoffActions(offered, "none", at(10), 240)).toEqual([]);
  });
  it("offers nothing to the recipient once the deadline passed, but the sender may still withdraw", () => {
    expect(allowedHandoffActions(offered, "recipient", at(241), 240)).toEqual([]);
    expect(allowedHandoffActions(offered, "sender", at(241), 240)).toEqual(["cancel"]);
  });
  it("offers nothing on a closed handoff", () => {
    for (const state of ["accepted", "declined", "expired", "cancelled"] as const) {
      expect(allowedHandoffActions({ ...offered, state }, "recipient", at(1), 240)).toEqual([]);
      expect(allowedHandoffActions({ ...offered, state }, "sender", at(1), 240)).toEqual([]);
    }
  });
});

describe("validateOfferShape", () => {
  const item = (kind: "patient" | "visit", patient: string, ref: string) => ({
    kind,
    patient_id: patient,
    ref_id: ref,
  });

  it("accepts a patient anchor and a visit", () => {
    expect(validateOfferShape([item("patient", P1, P1), item("visit", P1, R(1))])).toBeNull();
  });
  it("requires at least one item", () => {
    expect(validateOfferShape([])).toBe("HANDOFF_ITEMS_REQUIRED");
  });
  it("refuses duplicates and a patient anchor that points elsewhere", () => {
    expect(validateOfferShape([item("visit", P1, R(1)), item("visit", P1, R(1))])).toBe(
      "HANDOFF_ITEM_INVALID",
    );
    expect(validateOfferShape([item("patient", P1, P2)])).toBe("HANDOFF_ITEM_INVALID");
  });
  it("refuses an unknown kind", () => {
    expect(validateOfferShape([{ kind: "note" as never, patient_id: P1, ref_id: R(1) }])).toBe(
      "HANDOFF_ITEM_INVALID",
    );
  });
  it("caps items", () => {
    const many = Array.from({ length: HANDOFF_MAX_ITEMS + 1 }, (_, i) =>
      item("visit", P1, R(i + 10)),
    );
    expect(validateOfferShape(many)).toBe("HANDOFF_TOO_MANY_ITEMS");
  });
  it("caps patients", () => {
    const many = Array.from({ length: HANDOFF_MAX_PATIENTS + 1 }, (_, i) =>
      item("patient", R(i + 10), R(i + 10)),
    );
    expect(validateOfferShape(many)).toBe("HANDOFF_TOO_MANY_ITEMS");
  });
});
