// @wardenx/emar — §2.8 D17 medication-reconciliation worksheet — M13-T06.
import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_DUE_WARNING_HOURS,
  RECONCILIATION_DUE_WINDOW_HOURS,
  type ReconciliationCompletedDecision,
  type ReconciliationFinalizeInput,
  type ReconciliationTriggerEnvelope,
  buildReconciliationWorksheet,
  evaluateReconciliationTimeliness,
  finalizeReconciliationWorksheet,
  planReconciliationDecision,
  reconciliationDueAt,
} from "../src/reconciliation";

const TRIGGER: ReconciliationTriggerEnvelope = {
  worksheetId: "ws-1",
  patientId: "pat-1",
  admissionId: "adm-1",
  triggerKind: "admission",
  triggerOutboxEventId: "evt-m6-adm-activated-1",
  triggeredAt: "2026-06-22T10:30:00.000Z", // W-EMAR-08: admission activated at 1030
};

describe("§2.8 reconciliationDueAt", () => {
  it("admission is the CoP 5-calendar-day (120h) deadline — W-EMAR-08 dueAt = 1030 + 5d", () => {
    expect(reconciliationDueAt("admission", TRIGGER.triggeredAt)).toBe("2026-06-27T10:30:00.000Z");
    expect(RECONCILIATION_DUE_WINDOW_HOURS.admission).toBe(120);
  });
  it("discharge is the 24h disposition window — W-EMAR-09 dueAt + 24h", () => {
    expect(reconciliationDueAt("discharge", "2026-06-22T04:10:00.000Z")).toBe(
      "2026-06-23T04:10:00.000Z",
    );
  });
});

describe("§2.8 D17 buildReconciliationWorksheet", () => {
  it("opens the worksheet in 'pending' with the computed due_at and the opened signal", () => {
    const plan = buildReconciliationWorksheet(TRIGGER);
    expect(plan.worksheet.status).toBe("pending");
    expect(plan.worksheet.dueAt).toBe("2026-06-27T10:30:00.000Z");
    expect(plan.worksheet.triggerOutboxEventId).toBe("evt-m6-adm-activated-1");
    expect(plan.openedSignal).toEqual({
      worksheetId: "ws-1",
      patientId: "pat-1",
      admissionId: "adm-1",
      triggerKind: "admission",
      triggeredAt: TRIGGER.triggeredAt,
      dueAt: "2026-06-27T10:30:00.000Z",
    });
  });
});

describe("§2.8 D17 planReconciliationDecision", () => {
  it("carry_forward of a non-active (medhx) line mints a draft order", () => {
    const r = planReconciliationDecision("ws-1", {
      lineId: "ln-lisinopril",
      lineKind: "m12_medhx",
      decisionKind: "carry_forward",
      medicationOrderId: "medhx-1",
    });
    expect(r.draftOrderRequested).toEqual({
      worksheetId: "ws-1",
      lineId: "ln-lisinopril",
      lineKind: "m12_medhx",
      fromMedicationOrderId: "medhx-1",
    });
    expect(r.discontinueRequested).toBeNull();
    expect(r.statusAfter).toBe("in_progress");
  });
  it("carry_forward of an already-active M12 order emits no event (it stays active)", () => {
    const r = planReconciliationDecision("ws-1", {
      lineId: "ln-x",
      lineKind: "m12_active",
      decisionKind: "carry_forward",
      medicationOrderId: "ord-1",
    });
    expect(r.draftOrderRequested).toBeNull();
    expect(r.discontinueRequested).toBeNull();
  });
  it("new_order (caregiver-reported melatonin) mints a draft", () => {
    const r = planReconciliationDecision("ws-1", {
      lineId: "ln-melatonin",
      lineKind: "caregiver_reported",
      decisionKind: "new_order",
    });
    expect(r.draftOrderRequested?.lineId).toBe("ln-melatonin");
  });
  it("new_order on an already-active order is a contradiction → RECONCILIATION_DECISION_INVALID", () => {
    expect(() =>
      planReconciliationDecision("ws-1", {
        lineId: "ln-x",
        lineKind: "m12_active",
        decisionKind: "new_order",
        medicationOrderId: "ord-1",
      }),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_DECISION_INVALID" }));
  });
  it("discontinue of an active order emits discontinue_requested with the back-link", () => {
    const r = planReconciliationDecision("ws-1", {
      lineId: "ln-y",
      lineKind: "m12_active",
      decisionKind: "discontinue",
      medicationOrderId: "ord-2",
    });
    expect(r.discontinueRequested).toEqual({
      worksheetId: "ws-1",
      lineId: "ln-y",
      medicationOrderId: "ord-2",
    });
  });
  it("discontinue of a non-active (medhx) line documents only — no order to stop (metformin/atorvastatin)", () => {
    const r = planReconciliationDecision("ws-1", {
      lineId: "ln-metformin",
      lineKind: "m12_medhx",
      decisionKind: "discontinue",
      medicationOrderId: "medhx-2",
    });
    expect(r.discontinueRequested).toBeNull();
    expect(r.draftOrderRequested).toBeNull();
  });
  it("hold and document_only emit nothing", () => {
    for (const decisionKind of ["hold", "document_only"] as const) {
      const r = planReconciliationDecision("ws-1", {
        lineId: "ln-z",
        lineKind: "m12_active",
        decisionKind,
        medicationOrderId: "ord-3",
      });
      expect(r.draftOrderRequested).toBeNull();
      expect(r.discontinueRequested).toBeNull();
    }
  });
});

describe("§2.8 D17 finalizeReconciliationWorksheet", () => {
  const BASE: ReconciliationFinalizeInput = {
    worksheetId: "ws-1",
    status: "in_progress",
    triggerKind: "admission",
    patientId: "pat-1",
    admissionId: "adm-1",
    lineCount: 9,
    decidedLineCount: 9,
    finalizedByMembershipId: "rn-1",
    finalizedAt: "2026-06-22T13:20:00.000Z", // W-EMAR-08: RN finalizes at 1320
  };
  const DECISIONS: ReconciliationCompletedDecision[] = [
    { lineId: "ln-lisinopril", kind: "carry_forward", medicationOrderId: "ord-new-1" },
    { lineId: "ln-metformin", kind: "discontinue", medicationOrderId: null },
  ];

  it("finalizes when every line is decided and emits the completed signal with the decisions", () => {
    const plan = finalizeReconciliationWorksheet(BASE, DECISIONS);
    expect(plan.statusAfter).toBe("finalized");
    expect(plan.finalizedAt).toBe("2026-06-22T13:20:00.000Z");
    expect(plan.completedSignal.decisions).toEqual(DECISIONS);
    expect(plan.completedSignal.finalizedByMembershipId).toBe("rn-1");
  });
  it("rejects finalization while a line is undecided → RECONCILIATION_NOT_FINALIZABLE", () => {
    expect(() =>
      finalizeReconciliationWorksheet({ ...BASE, decidedLineCount: 8 }, DECISIONS),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_NOT_FINALIZABLE" }));
  });
  it("rejects re-finalizing a terminal worksheet → ILLEGAL_RECONCILIATION_TRANSITION", () => {
    for (const status of ["finalized", "voided"] as const) {
      expect(() => finalizeReconciliationWorksheet({ ...BASE, status }, DECISIONS)).toThrow(
        expect.objectContaining({ code: "ILLEGAL_RECONCILIATION_TRANSITION" }),
      );
    }
  });
});

describe("§2.8 evaluateReconciliationTimeliness", () => {
  const WS = {
    worksheetId: "ws-1",
    admissionId: "adm-1",
    triggerKind: "admission" as const,
    dueAt: "2026-06-27T10:30:00.000Z",
  };
  it("is on_time well before the deadline", () => {
    const r = evaluateReconciliationTimeliness(WS, "2026-06-23T10:30:00.000Z");
    expect(r.state).toBe("on_time");
    expect(r.dueAtWarning).toBeNull();
    expect(r.overdue).toBeNull();
  });
  it("warns inside the 24h pre-deadline window (W-EMAR-08 edge: 4-day mark)", () => {
    const r = evaluateReconciliationTimeliness(WS, "2026-06-26T10:30:00.000Z"); // exactly 24h before
    expect(r.state).toBe("due_soon");
    expect(r.dueAtWarning?.worksheetId).toBe("ws-1");
    expect(RECONCILIATION_DUE_WARNING_HOURS).toBe(24);
  });
  it("is overdue at/after the deadline (W-EMAR-08 edge: 5-day mark)", () => {
    const r = evaluateReconciliationTimeliness(WS, "2026-06-27T10:30:00.000Z");
    expect(r.state).toBe("overdue");
    expect(r.overdue?.dueAt).toBe(WS.dueAt);
    expect(r.dueAtWarning).toBeNull();
  });
});
