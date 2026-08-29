// apps/backend/__tests__/emar-workflow-acceptance.test.ts — M13-T11 the §5 workflow-acceptance suite (the
// FINAL M13 task). One scenario per the plan-named §5 workflows — W-EMAR-02 (PRN administration + effectiveness
// reassessment trigger), W-EMAR-04 (comfort-kit drawdown + replenishment), W-EMAR-05 (caregiver-attested
// administration + cosign), W-EMAR-08 (medication reconciliation at admission), W-EMAR-09 (discharge cascade +
// comfort-kit return), W-EMAR-10 (IV continuous session: start → titrate → stop), W-EMAR-11 (five-rights catch:
// wrong route) — exercised end-to-end over the in-memory `EmarRouteService` (the same backend the §4.1 routes
// compose over, M13-T08) plus the pure `@wardenx/emar` machines the comfort-kit / IV-session / discharge-cascade
// / reconciliation-trigger paths drive. Deterministic: no infra, injected clock.
//
// The route-auth handshake (§4.6/§4.7) + the wire status codes live in emar-routes.test.ts; each pure machine
// has its own unit suite under packages/emar/__tests__. This asserts the WORKFLOW outcomes (state transitions,
// the §4.4 outbox emissions, the PRN-reassessment trigger, the kit drawdown threshold crossing, the caregiver
// cosign handshake, the reconciliation finalize gate, the IV start→titrate→stop sequence, the five-rights catch)
// and the §9.3 security guarantees the service layer owns (controlled-witness requirement, M12 D6 block,
// five-rights, non-leaking cross-tenant 404). The RLS layer-independence (§9.4) lives in rls-isolation.live
// (the M13 block).
import {
  type CascadeScheduledDose,
  type ComfortKitDeployedEnvelope,
  type IvSegment,
  type KitDrawdownState,
  type ReconciliationTriggerEnvelope,
  applyKitDrawdown,
  assertIvSegmentLegal,
  buildComfortKitDeployment,
  buildReconciliationWorksheet,
  checkPrnInterval,
  composeIvSession,
  evaluateReturnOverdue,
  planDischargeCascade,
  planIvSegment,
} from "@wardenx/emar";
import { describe, expect, it } from "vitest";
import { createInMemoryEmarBackend } from "../src/modules/13-emar/index";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const ORDER = "00000000-0000-4000-8000-0000000000a1";
const RN_USER = "rn_1";
const RN_MEM = "00000000-0000-4000-8000-0000000000c1";
const WITNESS_USER = "rn_2";
const WITNESS_MEM = "00000000-0000-4000-8000-0000000000c2";
const NOW = "2026-06-22T14:35:00.000Z";

function eventNames(events: ReadonlyArray<{ eventName: string }>): string[] {
  return events.map((e) => e.eventName);
}

describe("M13-T11 §5 workflow acceptance", () => {
  it("W-EMAR-02 — controlled PRN administration mints the effectiveness-reassessment trigger", async () => {
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      memberships: [
        {
          userId: WITNESS_USER,
          membershipId: WITNESS_MEM,
          organizationId: ORG,
          discipline: "rn_case_manager",
        },
        {
          userId: RN_USER,
          membershipId: RN_MEM,
          organizationId: ORG,
          discipline: "rn_case_manager",
        },
      ],
    });

    // Schedule-II sublingual morphine → a witness attestation must be obtained before the controlled commit.
    const { token, expiresInSeconds } = await svc.mintWitnessToken(ORG, WITNESS_USER, {
      patientId: PATIENT,
      medicationOrderId: ORDER,
      administeringClinicianMembershipId: RN_MEM,
    });
    expect(expiresInSeconds).toBe(60);

    const adm = await svc.recordAdministration(ORG, RN_USER, {
      medicationOrderId: ORDER,
      medClass: "controlled_substance",
      mode: "single_dose",
      administeredAt: NOW,
      witnessToken: token,
      prn: {
        triggeringPrnReason: "Patient reports pain 7/10 right shoulder",
        requestedByKind: "clinician",
      },
    });
    expect(adm.status).toBe("committed");
    expect(adm.isControlledSubstance).toBe(true);
    expect(adm.witnessMembershipId).toBe(WITNESS_MEM);

    const names = eventNames(svc.drainEvents());
    expect(names).toContain("m13.administration.recorded");
    expect(names).toContain("m13.administration.controlled_witnessed"); // D7 witness chain
    expect(names).toContain("m13.prn_administration_recorded"); // → M9 reassessment cue
  });

  it("W-EMAR-02 edge — a second PRN dose 20 min later trips the minimum-interval gate", () => {
    // The §2.4 D3 interval check (pure): most-recent PRN was 20 min ago, minimum is 60 → violation echoing both.
    const r = checkPrnInterval({
      minimumIntervalMinutes: 60,
      lastAdministeredAt: NOW,
      requestedAdministeredAt: "2026-06-22T14:55:00.000Z",
    });
    expect(r).toEqual({ ok: false, currentDeltaMinutes: 20, minimumIntervalMinutes: 60 });
  });

  it("W-EMAR-04 — comfort-kit drawdown crosses the replenishment threshold and escalates to urgent", () => {
    // Deploy the kit (§2.7): one drawdown per content line, remaining=expected, 25% default threshold.
    const envelope: ComfortKitDeployedEnvelope = {
      deploymentId: "dep-1",
      patientId: PATIENT,
      admissionId: ADMISSION,
      deployedAtIso: "2026-06-22T09:30:00.000Z",
      deployedByMembershipId: RN_MEM,
      contents: [
        {
          medicationOrderId: ORDER,
          expectedQuantity: 20,
          expectedUnit: "mL",
          lotNumber: "LOT-A",
          expirationDate: "2027-01-01",
          isControlled: true,
        },
      ],
    };
    const plan = buildComfortKitDeployment(envelope);
    const planned = plan.drawdowns[0]!;
    expect(planned.remainingQuantity).toBe(20);
    expect(planned.replenishmentThreshold).toBe(5); // 25% of 20

    // `buildComfortKitDeployment` returns the DEPLOYMENT plan (`KitDrawdownInit`), and `applyKitDrawdown`
    // decrements the PERSISTED row (`KitDrawdownState`) — different shapes: the state keys the deployment
    // as `deploymentId` and carries the `drugName` the replenishment signal names. The suite used to hand
    // the plan item straight in, so every drawdown below ran with an undefined deployment id and drug.
    const morphine: KitDrawdownState = {
      deploymentId: planned.comfortKitDeploymentId,
      medicationOrderId: planned.medicationOrderId,
      remainingQuantity: planned.remainingQuantity,
      expectedQuantity: planned.expectedQuantity,
      expectedUnit: planned.expectedUnit,
      replenishmentThreshold: planned.replenishmentThreshold,
      lotNumber: planned.lotNumber,
      drugName: "morphine sulfate",
    };

    // Above threshold → no signal; at/below threshold → routine; ≤10% (or ≥3 PRN/24h) → urgent.
    expect(applyKitDrawdown(morphine, { administeredAmount: 1 }).replenishmentSignal).toBeNull();
    const crossing = applyKitDrawdown(
      { ...morphine, remainingQuantity: 6 },
      { administeredAmount: 1 },
    );
    expect(crossing.belowThreshold).toBe(true);
    expect(crossing.replenishmentSignal?.urgencyKind).toBe("routine");
    const urgent = applyKitDrawdown(
      { ...morphine, remainingQuantity: 6 },
      { administeredAmount: 1, recentPrnCount24h: 3 },
    );
    expect(urgent.replenishmentSignal?.urgencyKind).toBe("urgent"); // burn-rate escalation

    // Edge — a decrement past zero is refused (the RN records from a non-kit source instead).
    expect(() => applyKitDrawdown(morphine, { administeredAmount: 25 })).toThrowError(
      expect.objectContaining({ code: "KIT_INSUFFICIENT_QUANTITY", statusCode: 422 }),
    );
  });

  it("W-EMAR-05 — caregiver-attested administration enters the cosign queue, then RN acknowledges", async () => {
    const svc = createInMemoryEmarBackend({ now: () => NOW });
    const recorded = await svc.recordCaregiverAttested(ORG, {
      patientId: PATIENT,
      medicationOrderId: ORDER,
      administeredAt: "2026-06-22T02:45:00.000Z",
      caregiverSessionId: "00000000-0000-4000-8000-0000000000d1",
      route: "SL",
      doseAmount: 5,
      doseUnit: "mg",
    });
    expect(recorded.actorKind).toBe("caregiver_attested");
    expect(recorded.requiresRnReview).toBe(true); // awaiting cosign
    expect(recorded.status).toBe("pending_caregiver_review");
    expect(eventNames(svc.drainEvents())).toContain(
      "m13.administration.recorded_caregiver_attested",
    );

    // RN reviews the entry at the next session and acknowledges → committed, review flag cleared.
    const acked = await svc.acknowledgeCaregiver(ORG, RN_USER, recorded.id);
    expect(acked.requiresRnReview).toBe(false);
    expect(acked.status).toBe("committed");
    expect(eventNames(svc.drainEvents())).toContain("m13.caregiver_administration.acknowledged");
  });

  it("W-EMAR-05 edge — the RN disputes the caregiver entry instead of acknowledging", async () => {
    const svc = createInMemoryEmarBackend({ now: () => NOW });
    const recorded = await svc.recordCaregiverAttested(ORG, {
      patientId: PATIENT,
      medicationOrderId: ORDER,
      administeredAt: "2026-06-22T02:45:00.000Z",
      caregiverSessionId: "00000000-0000-4000-8000-0000000000d1",
      route: "SL",
      doseAmount: 5,
      doseUnit: "mg",
    });
    svc.drainEvents();
    const disputed = await svc.disputeCaregiver(
      ORG,
      RN_USER,
      recorded.id,
      "Bottle should read 5 mL less but is full",
    );
    expect(disputed.requiresRnReview).toBe(false);
    expect(eventNames(svc.drainEvents())).toContain("m13.caregiver_administration.disputed");
  });

  it("W-EMAR-08 — admission reconciliation: trigger opens the worksheet, per-line decisions, finalize", async () => {
    // The m6.admission.activated consumer opens the worksheet with the CoP 5-day (120h) due window (pure).
    const trigger: ReconciliationTriggerEnvelope = {
      worksheetId: "ws-1",
      patientId: PATIENT,
      admissionId: ADMISSION,
      triggerKind: "admission",
      triggerOutboxEventId: "evt-m6-adm-activated-1",
      triggeredAt: "2026-06-22T10:30:00.000Z",
    };
    const opened = buildReconciliationWorksheet(trigger);
    expect(opened.worksheet.status).toBe("pending");
    expect(opened.worksheet.dueAt).toBe("2026-06-27T10:30:00.000Z"); // 1030 + 5 calendar days

    // The RN works each of the three lines; carry_forward/discontinue raise the M12 handshakes, document_only doesn't.
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      worksheets: [
        {
          id: "ws-1",
          organizationId: ORG,
          patientId: PATIENT,
          admissionId: ADMISSION,
          triggerKind: "admission",
          lineCount: 3,
        },
      ],
    });
    await svc.recordDecision(ORG, RN_USER, "ws-1", {
      lineKind: "m12_medhx",
      sourceId: "hist_1",
      decision: "carry_forward",
    });
    await svc.recordDecision(ORG, RN_USER, "ws-1", {
      lineKind: "m12_medhx",
      sourceId: "hist_2",
      decision: "discontinue",
    });
    const partial = await svc.recordDecision(ORG, RN_USER, "ws-1", {
      lineKind: "caregiver_reported",
      sourceId: "hist_3",
      decision: "document_only",
    });
    expect(partial.decisions).toHaveLength(3);
    const decisionEvents = eventNames(svc.drainEvents());
    expect(decisionEvents).toContain("m13.reconciliation.draft_order_requested"); // carry_forward → M12 draft
    expect(decisionEvents).toContain("m13.reconciliation.discontinue_requested"); // discontinue → M12

    const finalized = await svc.finalizeReconciliation(ORG, RN_USER, "ws-1");
    expect(finalized.status).toBe("finalized");
    const finalEvents = eventNames(svc.drainEvents());
    expect(finalEvents).toContain("m13.reconciliation.completed"); // → M30 timeliness
    expect(finalEvents).toContain("m13.reconciliation.document_requested"); // → M22 PDF
  });

  it("W-EMAR-08 edge — finalize is refused while any line is still undecided", async () => {
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      worksheets: [
        {
          id: "ws-2",
          organizationId: ORG,
          patientId: PATIENT,
          admissionId: ADMISSION,
          triggerKind: "admission",
          lineCount: 2,
        },
      ],
    });
    await svc.recordDecision(ORG, RN_USER, "ws-2", {
      lineKind: "m12_medhx",
      sourceId: "hist_1",
      decision: "carry_forward",
    });
    await expect(svc.finalizeReconciliation(ORG, RN_USER, "ws-2")).rejects.toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED", statusCode: 422 }),
    );
  });

  it("W-EMAR-09 — death discharge cancels only FUTURE pending doses and requires the kit's return", async () => {
    const dischargeAt = "2026-06-22T04:10:00.000Z";
    const doses: CascadeScheduledDose[] = [
      {
        scheduledDoseId: "sd-past-pending",
        medicationOrderId: ORDER,
        dueAt: "2026-06-22T00:00:00.000Z",
        status: "pending",
      },
      {
        scheduledDoseId: "sd-fut-1",
        medicationOrderId: ORDER,
        dueAt: "2026-06-22T08:00:00.000Z",
        status: "pending",
      },
      {
        scheduledDoseId: "sd-fut-2",
        medicationOrderId: ORDER,
        dueAt: "2026-06-22T12:00:00.000Z",
        status: "pending",
      },
    ];
    const plan = planDischargeCascade({
      patientId: PATIENT,
      admissionId: ADMISSION,
      dischargeAt,
      sourceEventId: "evt-discharge-1",
      source: "admission_discharged",
      scheduledDoses: doses,
      activeDeployments: [
        { deploymentId: "dep-1", disposalStatus: "deployed", returnRequiredAt: null },
      ],
    });
    expect(plan.cancellations.map((c) => c.scheduledDoseId).sort()).toEqual([
      "sd-fut-1",
      "sd-fut-2",
    ]); // past untouched
    expect(plan.returnRequired).toHaveLength(1);
    expect(plan.returnRequired[0]!.deploymentId).toBe("dep-1");

    // The bereavement-visit RN documents the kit return via the manual route → comfort_kit.returned.
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      deployments: [
        { id: "dep-1", organizationId: ORG, patientId: PATIENT, admissionId: ADMISSION },
      ],
    });
    const returned = await svc.acknowledgeReturn(ORG, RN_USER, "dep-1");
    expect(returned.disposalStatus).toBe("returned");
    expect(eventNames(svc.drainEvents())).toContain("m13.comfort_kit.returned");

    // Edge — a kit whose return was required on 2026-05-01 is unreturned past the 30-day window as of NOW.
    const overdue = evaluateReturnOverdue("dep-2", "2026-05-01T00:00:00.000Z", NOW);
    expect(overdue.overdue).toBe(true);
    expect(overdue.signal?.deploymentId).toBe("dep-2");
  });

  it("W-EMAR-10 — IV continuous session: start → titrate (in bounds) → stop, then compose the projection", () => {
    const policy = { minRate: 0.5, maxRate: 10 }; // the §2.11 morphine-drip bounds

    const start = planIvSegment("none", { mode: "iv_continuous_start", isControlled: true });
    expect(start).toMatchObject({
      nextState: "running",
      mintsSession: true,
      requiresWitness: true,
    });
    const titrate = planIvSegment("running", {
      mode: "iv_continuous_rate_change",
      isControlled: true,
      newRate: 3,
      policy,
    });
    expect(titrate.nextState).toBe("running");
    const stop = planIvSegment("running", {
      mode: "iv_continuous_stop",
      isControlled: true,
      wastageAmount: 87,
    });
    expect(stop).toMatchObject({
      nextState: "stopped",
      requiresWitness: true,
      hasControlledWastage: true,
    });

    // The seam projection composes the 3-row sequence into one closed session with effectivePeriod start/end.
    const segments: IvSegment[] = [
      {
        mode: "iv_continuous_start",
        administeredAt: "2026-06-22T00:00:00.000Z",
        rate: 2,
        rateUnit: "mg/hr",
      },
      {
        mode: "iv_continuous_rate_change",
        administeredAt: "2026-06-22T06:00:00.000Z",
        rate: 3,
        rateUnit: "mg/hr",
      },
      { mode: "iv_continuous_stop", administeredAt: "2026-06-22T20:00:00.000Z" },
    ];
    const proj = composeIvSession("iv-1", ORDER, segments, null);
    expect(proj.startedAt).toBe("2026-06-22T00:00:00.000Z");
    expect(proj.endedAt).toBe("2026-06-22T20:00:00.000Z");
    expect(proj.state).toBe("stopped");
    expect(proj.segments).toHaveLength(3);

    // Edge — an out-of-range titration and an out-of-sequence segment are both rejected.
    expect(() =>
      planIvSegment("running", {
        mode: "iv_continuous_rate_change",
        isControlled: true,
        newRate: 12,
        policy,
      }),
    ).toThrowError(expect.objectContaining({ code: "IV_RATE_OUT_OF_RANGE" }));
    expect(() => assertIvSegmentLegal("none", "iv_continuous_stop")).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_IV_SESSION_TRANSITION" }),
    );
  });

  it("W-EMAR-11 — five-rights catch: a wrong-route administration is blocked, then corrected and committed", async () => {
    // The seeded M12 order is for oral haloperidol; the RN mis-clicks route=IM.
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      orders: [
        {
          medicationOrderId: ORDER,
          patientId: PATIENT,
          route: "PO",
          doseAmount: 0.5,
          doseUnit: "mg",
        },
      ],
    });
    await expect(
      svc.recordAdministration(ORG, RN_USER, {
        medicationOrderId: ORDER,
        medClass: "standard",
        mode: "single_dose",
        administeredAt: NOW,
        route: "IM",
        doseAmount: 0.5,
        doseUnit: "mg",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "FIVE_RIGHTS_VIOLATION", statusCode: 422 }),
    );

    // The RN corrects the route to PO and resubmits → commits.
    const fixed = await svc.recordAdministration(ORG, RN_USER, {
      medicationOrderId: ORDER,
      medClass: "standard",
      mode: "single_dose",
      administeredAt: NOW,
      route: "PO",
      doseAmount: 0.5,
      doseUnit: "mg",
    });
    expect(fixed.status).toBe("committed");
    expect(eventNames(svc.drainEvents())).toContain("m13.administration.recorded");
  });
});

describe("M13-T11 §9.3 security & authorization (controlled-witness, M12 D6 block, non-leaking cross-tenant)", () => {
  it("a controlled-substance administration without a witness attestation is rejected", async () => {
    const svc = createInMemoryEmarBackend({ now: () => NOW });
    await expect(
      svc.recordAdministration(ORG, RN_USER, {
        medicationOrderId: ORDER,
        medClass: "controlled_substance",
        mode: "single_dose",
        administeredAt: NOW,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", statusCode: 422 }));
  });

  it("D6 — an administration against a discontinued M12 order is blocked, no DB write", async () => {
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      orders: [
        {
          medicationOrderId: ORDER,
          patientId: PATIENT,
          route: "PO",
          administerable: false,
          blockedReasons: ["discontinued"],
        },
      ],
    });
    await expect(
      svc.recordAdministration(ORG, RN_USER, {
        medicationOrderId: ORDER,
        medClass: "standard",
        mode: "single_dose",
        administeredAt: NOW,
        route: "PO",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "ADMINISTRATION_BLOCKED", statusCode: 422 }),
    );
    expect(await svc.listAdministrations(ORG, { patient: PATIENT })).toEqual([]);
  });

  it("an administration recorded in org_a is invisible to org_b (non-leaking NotFound + empty list)", async () => {
    const svc = createInMemoryEmarBackend({
      now: () => NOW,
      administrations: [
        {
          id: "adm-x",
          organizationId: ORG,
          patientId: PATIENT,
          admissionId: ADMISSION,
          medicationOrderId: ORDER,
        },
      ],
    });
    await expect(svc.getAdministration(ORG_B, "adm-x")).rejects.toThrow();
    expect(await svc.listAdministrations(ORG_B, { patient: PATIENT })).toEqual([]);
  });
});
