// apps/backend/__tests__/hope-submission.test.ts — M10-T07 the §4.10 iQIES submission worker loop. The
// pure assemble → submit-readiness → transmit → reconcile → correction-RFA processors that drive the
// `hope:submission` cron pipeline (§7.9 cycle, §7.10 decoupled-from-capture). No live infra — the adapter
// call + MinIO put are the boot-bound driver's only IO; this exercises every pure decision the workers make.
import {
  assembleEnvelopeCanonical,
  buildEnvelopeStorageUri,
  envelopeSha256,
} from "@chartwarden/iqies-client";
import { describe, expect, it } from "vitest";
import {
  type AssemblableAssessment,
  buildSubmissionEnvelope,
  decideSubmitReadiness,
  planAssembleSubmissions,
  planCorrectionRfa,
  planReconcile,
  planTransmitResult,
  submissionPeriodFor,
} from "../src/modules/10-hope/index";

const PE1 = "11111111-1111-4111-8111-111111111111";
const PE2 = "22222222-2222-4222-8222-222222222222";

function assessment(
  over: Partial<AssemblableAssessment> & { assessmentId: string },
): AssemblableAssessment {
  return {
    providerEntityId: PE1,
    submissionPeriod: "2026-Q2",
    rfaKind: "02_huv1",
    signedAt: "2026-06-22T00:00:00.000Z",
    hasActiveSubmissionItem: false,
    iqiesRecordId: null,
    correctsIqiesRecordId: null,
    ...over,
  };
}

describe("planAssembleSubmissions (daily assemble-hope-submission, §4.10)", () => {
  it("groups signed+unsubmitted assessments per (PE, period) and orders items by signedAt", () => {
    const plan = planAssembleSubmissions([
      assessment({ assessmentId: "a2", signedAt: "2026-06-22T02:00:00.000Z" }),
      assessment({ assessmentId: "a1", signedAt: "2026-06-22T01:00:00.000Z" }),
      assessment({ assessmentId: "b1", providerEntityId: PE2 }),
    ]);
    expect(plan.submissions).toHaveLength(2);
    const pe1 = plan.submissions.find((s) => s.providerEntityId === PE1);
    expect(pe1?.items.map((i) => i.hopeAssessmentId)).toEqual(["a1", "a2"]);
    expect(pe1?.itemCount).toBe(2);
    expect(pe1?.event.eventName).toBe("m10.hope.submission_queued");
  });

  it("is idempotent: assessments already on an active item or already accepted are skipped", () => {
    const plan = planAssembleSubmissions([
      assessment({ assessmentId: "a1", hasActiveSubmissionItem: true }),
      assessment({ assessmentId: "a2", iqiesRecordId: "iqies-rec-9" }),
      assessment({ assessmentId: "a3" }),
    ]);
    expect(plan.skippedAssessmentIds).toEqual(["a1", "a2"]);
    expect(plan.submissions).toHaveLength(1);
    expect(plan.submissions[0]?.items.map((i) => i.hopeAssessmentId)).toEqual(["a3"]);
  });

  it("produces no submission for an empty eligible set", () => {
    expect(planAssembleSubmissions([]).submissions).toHaveLength(0);
  });
});

describe("decideSubmitReadiness (iqies-submit-worker CAS + validation, §4.10)", () => {
  it("transmits a queued batch whose items all pass pre-submission validation", () => {
    const r = decideSubmitReadiness({
      status: "queued",
      items: [{ hopeAssessmentId: "a1", hasBlockingError: false }],
    });
    expect(r).toEqual({ action: "transmit", nextStatus: "in_flight" });
  });

  it("rolls a batch back to queued when ANY item has a blocking error (never a partial transmit)", () => {
    const r = decideSubmitReadiness({
      status: "queued",
      items: [
        { hopeAssessmentId: "a1", hasBlockingError: false },
        { hopeAssessmentId: "a2", hasBlockingError: true },
      ],
    });
    expect(r).toEqual({ action: "rollback", nextStatus: "queued", blockingAssessmentIds: ["a2"] });
  });

  it("skips a re-picked in_flight batch (idempotent CAS)", () => {
    expect(decideSubmitReadiness({ status: "in_flight", items: [] })).toEqual({
      action: "skip",
      reason: "not_queued",
    });
  });
});

describe("transmit (envelope assembly + SHA-256 + MinIO key, §4.10)", () => {
  it("threads the @chartwarden/iqies-client envelope through to a transmit-result plan + event", () => {
    const envelope = buildSubmissionEnvelope({
      providerEntityCcn: "123456",
      submissionPeriod: "2026-Q2",
      items: [{ hopeAssessmentId: "a1", rfaKind: "02_huv1", correctsIqiesRecordId: null }],
    });
    const sha = envelopeSha256(assembleEnvelopeCanonical(envelope));
    const uri = buildEnvelopeStorageUri({
      organizationId: "org_a",
      providerEntityId: PE1,
      submissionPeriod: "2026-Q2",
      submissionId: "sub_1",
    });
    const plan = planTransmitResult({
      submissionId: "sub_1",
      iqiesBatchId: "batch-1",
      envelopeStorageUri: uri,
      envelopeSha256: sha,
      transmittedAt: "2026-06-22T02:30:00.000Z",
    });
    expect(plan.nextStatus).toBe("in_flight");
    expect(plan.event.eventName).toBe("m10.hope.submission_transmitted");
    expect(plan.event.payload).toMatchObject({ submissionId: "sub_1", envelopeSha256: sha });
  });
});

describe("planReconcile (iqies-reconcile-worker, §4.10 / §7.9)", () => {
  it("all accepted → accepted + a single submission_accepted event", () => {
    const plan = planReconcile({
      submissionId: "sub_1",
      outcomes: [
        { hopeAssessmentId: "a1", outcome: "accepted", iqiesRecordId: "r1", findings: [] },
        { hopeAssessmentId: "a2", outcome: "accepted", iqiesRecordId: "r2", findings: [] },
      ],
    });
    expect(plan.nextStatus).toBe("accepted");
    expect(plan.acceptedCount).toBe(2);
    expect(plan.findings).toHaveLength(0);
    expect(plan.events.map((e) => e.eventName)).toEqual(["m10.hope.submission_accepted"]);
    expect(plan.itemTransitions[0]).toMatchObject({ itemStatus: "accepted", iqiesRecordId: "r1" });
  });

  it("§7.9 mixed → partially_accepted: 4 accepted / 1 rejected, finding written, both events", () => {
    const plan = planReconcile({
      submissionId: "sub_1",
      outcomes: [
        { hopeAssessmentId: "a1", outcome: "accepted", iqiesRecordId: "r1", findings: [] },
        { hopeAssessmentId: "a2", outcome: "accepted", iqiesRecordId: "r2", findings: [] },
        { hopeAssessmentId: "a3", outcome: "accepted", iqiesRecordId: "r3", findings: [] },
        { hopeAssessmentId: "a4", outcome: "accepted", iqiesRecordId: "r4", findings: [] },
        {
          hopeAssessmentId: "a5",
          outcome: "rejected",
          iqiesRecordId: null,
          findings: [{ ruleId: "cms_hope_v1_section_i", message: "Invalid Section I code" }],
        },
      ],
    });
    expect(plan.nextStatus).toBe("partially_accepted");
    expect(plan.acceptedCount).toBe(4);
    expect(plan.rejectedCount).toBe(1);
    expect(plan.findings).toEqual([
      {
        hopeAssessmentId: "a5",
        ruleId: "cms_hope_v1_section_i",
        severity: "error",
        section: null,
        message: "Invalid Section I code",
      },
    ]);
    expect(plan.events.map((e) => e.eventName)).toEqual([
      "m10.hope.submission_accepted",
      "m10.hope.submission_rejected",
    ]);
  });

  it("all rejected → rejected + only a submission_rejected event with rule-id counts", () => {
    const plan = planReconcile({
      submissionId: "sub_1",
      outcomes: [
        {
          hopeAssessmentId: "a1",
          outcome: "rejected",
          iqiesRecordId: null,
          findings: [{ ruleId: "cms_hope_v1_section_j", message: "bad J code" }],
        },
      ],
    });
    expect(plan.nextStatus).toBe("rejected");
    expect(plan.events.map((e) => e.eventName)).toEqual(["m10.hope.submission_rejected"]);
    expect(plan.events[0]?.payload.findings as Array<{ ruleId: string; count: number }>).toEqual([
      { ruleId: "cms_hope_v1_section_j", count: 1 },
    ]);
  });
});

describe("planCorrectionRfa (submit-correction-rfa, §7.8 / D7)", () => {
  it("queues a Correction RFA when the original was iQIES-accepted", () => {
    expect(
      planCorrectionRfa({
        correctionAssessmentId: "corr_1",
        originalAssessmentId: "orig_1",
        originalIqiesRecordId: "iqies-rec-9",
      }),
    ).toEqual({
      action: "queue_correction",
      correctionAssessmentId: "corr_1",
      originalIqiesRecordId: "iqies-rec-9",
    });
  });

  it("skips (normal assemble handles it) when the original was never submitted", () => {
    expect(
      planCorrectionRfa({
        correctionAssessmentId: "corr_1",
        originalAssessmentId: "orig_1",
        originalIqiesRecordId: null,
      }),
    ).toEqual({ action: "skip", reason: "original_not_submitted" });
  });
});

// ── F-058 (#150) — the batch key ─────────────────────────────────────────────────────────────────────
//
// `hope_submission.submission_period` is the second half of the batch key, and the route that claimed to
// force-assemble computed it as `new Date().toISOString().slice(0, 7)`. Both halves of that were wrong,
// and both are load-bearing.
describe("submissionPeriodFor (F-058)", () => {
  it("anchors on the ASSESSMENT's target date, not on the clock", () => {
    // An Admission timepoint dated 30 March belongs to Q1 however long it sits unsigned. Anchoring on
    // "now" put every assessment into whatever period the operator pressed the button in, which merges
    // quarters and splits one quarter across two batches.
    expect(submissionPeriodFor("2026-03-30T23:59:59.999Z")).toBe("2026-Q1");
    expect(submissionPeriodFor("2026-04-01T00:00:00.000Z")).toBe("2026-Q2");
  });

  it("is QUARTERLY — the grain HQRP submission deadlines and the §1.3 APU signal use", () => {
    // `slice(0, 7)` produced `2026-06`, which nothing that reads a period could parse: the schema's own
    // doc comment, the iQIES-client fixtures and every M10 unit test use `YYYY-Qn`.
    expect(submissionPeriodFor("2026-06-15T00:00:00.000Z")).toBe("2026-Q2");
    expect(submissionPeriodFor("2026-06-15T00:00:00.000Z")).not.toBe("2026-06");
  });

  it("covers all four quarter boundaries", () => {
    expect(submissionPeriodFor("2026-01-01T00:00:00.000Z")).toBe("2026-Q1");
    expect(submissionPeriodFor("2026-06-30T23:59:59.999Z")).toBe("2026-Q2");
    expect(submissionPeriodFor("2026-07-01T00:00:00.000Z")).toBe("2026-Q3");
    expect(submissionPeriodFor("2026-12-31T23:59:59.999Z")).toBe("2026-Q4");
  });

  it("refuses an unparseable date rather than emitting `NaN-QNaN` as a batch key", () => {
    expect(() => submissionPeriodFor("not-a-date")).toThrow(/M10_SUBMISSION_PERIOD_UNPARSEABLE/);
  });
});
