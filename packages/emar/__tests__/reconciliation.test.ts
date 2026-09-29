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
  const MELATONIN = {
    drugName: "Melatonin",
    strength: "3 mg",
    doseForm: "tablet",
    route: "oral",
    medClass: "standard",
  } as const;

  it("carry_forward of a caregiver-reported line mints a draft with the real supplied content", () => {
    const r = planReconciliationDecision({
      lineKind: "caregiver_reported",
      decisionKind: "carry_forward",
      medicationDetails: MELATONIN,
    });
    expect(r.draftOrderRequested).toEqual({
      lineKind: "caregiver_reported",
      medicationOrderDraftPayload: MELATONIN,
    });
    expect(r.discontinueRequested).toBeNull();
    expect(r.statusAfter).toBe("in_progress");
  });
  it("carry_forward of an already-active M12 order emits no event (it stays active)", () => {
    const r = planReconciliationDecision({
      lineKind: "m12_active",
      decisionKind: "carry_forward",
      medicationOrderId: "ord-1",
    });
    expect(r.draftOrderRequested).toBeNull();
    expect(r.discontinueRequested).toBeNull();
  });
  it("carry_forward / new_order of an m12_medhx line is refused — no medhx projection exists", () => {
    for (const decisionKind of ["carry_forward", "new_order"] as const) {
      expect(() =>
        planReconciliationDecision({
          lineKind: "m12_medhx",
          decisionKind,
          medicationDetails: MELATONIN,
        }),
      ).toThrow(expect.objectContaining({ code: "RECONCILIATION_MEDHX_UNAVAILABLE" }));
    }
  });
  it("carry_forward / new_order of a non-active line with no supplied content is refused, not fabricated", () => {
    expect(() =>
      planReconciliationDecision({ lineKind: "caregiver_reported", decisionKind: "carry_forward" }),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_MEDICATION_DETAILS_REQUIRED" }));
    expect(() =>
      planReconciliationDecision({ lineKind: "caregiver_reported", decisionKind: "new_order" }),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_MEDICATION_DETAILS_REQUIRED" }));
  });
  it("a controlled-substance decision requires deaSchedule; a non-controlled decision must omit it", () => {
    expect(() =>
      planReconciliationDecision({
        lineKind: "caregiver_reported",
        decisionKind: "new_order",
        medicationDetails: { ...MELATONIN, medClass: "controlled_substance" },
      }),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_MEDICATION_DETAILS_REQUIRED" }));
    const r = planReconciliationDecision({
      lineKind: "caregiver_reported",
      decisionKind: "new_order",
      medicationDetails: {
        ...MELATONIN,
        drugName: "Oxycodone",
        medClass: "controlled_substance",
        deaSchedule: "II",
      },
    });
    expect(r.draftOrderRequested?.medicationOrderDraftPayload.deaSchedule).toBe("II");
  });
  it("new_order (a newly identified caregiver-reported med) mints a draft", () => {
    const r = planReconciliationDecision({
      lineKind: "caregiver_reported",
      decisionKind: "new_order",
      medicationDetails: MELATONIN,
    });
    expect(r.draftOrderRequested?.medicationOrderDraftPayload).toEqual(MELATONIN);
  });
  it("new_order on an already-active order is a contradiction → RECONCILIATION_DECISION_INVALID", () => {
    expect(() =>
      planReconciliationDecision({
        lineKind: "m12_active",
        decisionKind: "new_order",
        medicationOrderId: "ord-1",
      }),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_DECISION_INVALID" }));
  });
  it("discontinue of an active order emits discontinue_requested with the back-link", () => {
    const r = planReconciliationDecision({
      lineKind: "m12_active",
      decisionKind: "discontinue",
      medicationOrderId: "ord-2",
    });
    expect(r.discontinueRequested).toEqual({ medicationOrderId: "ord-2" });
  });
  it("discontinue of a non-active (medhx) line documents only — no order to stop (metformin/atorvastatin)", () => {
    const r = planReconciliationDecision({
      lineKind: "m12_medhx",
      decisionKind: "discontinue",
      medicationOrderId: "medhx-2",
    });
    expect(r.discontinueRequested).toBeNull();
    expect(r.draftOrderRequested).toBeNull();
  });
  it("hold and document_only emit nothing", () => {
    for (const decisionKind of ["hold", "document_only"] as const) {
      const r = planReconciliationDecision({
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
