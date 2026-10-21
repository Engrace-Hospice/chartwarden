// @chartwarden/intake-extraction — §7.1 W1 the DocLens extraction PIPELINE as pure domain logic.
//
// The canonical "happy path" (D4, D5): classify pages → extract candidate fields → flag discrepancies →
// build the review session → record per-field decisions → emit chart-writeback intents with provenance.
// Every stage is a PURE function over injected facts (the M32 capability result, the current chart values
// fetched via reader seams, the reviewer's decisions). NO db / app / network import — the impure edges
// (the M32 capability seam, the reader seams, the outbox dispatcher) are injected by the backend service.
//
// The whole pipeline is built-not-active in Phase 1: the backend gates EVERY entry point behind the
// `documents.doclens` feature flag (default OFF → routes return 503 EXTRACTION_DISABLED). When the flag is
// injected ON (over a fake M32), these functions run end-to-end — that is exactly what the §7 tests exercise.

import type {
  ChartTargetModule,
  ExtractionCandidateRiskLevel,
  ExtractionDecisionKind,
  ExtractionDiscrepancyKind,
  ExtractionJobStatus,
} from "@chartwarden/types";
import type {
  ClassifiedPageResult,
  DocLensCapabilityPort,
  ExtractedCandidate,
  VisionVerificationResult,
} from "./capability";

/** §2.3 — the default classifier confidence floor; pages below it route to human classification (single
 * tenant-config constant; the slice pins the spec default 0.75). */
export const DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR = 0.75;

// ── Stage 1: classify ──────────────────────────────────────────────────────────────────────────────────

/** A classified page annotated with whether it cleared the confidence floor (§7.1 W1 step 4). */
export interface ClassifiedPage extends ClassifiedPageResult {
  /** True when `confidence < floor` (or type is `unknown`) → flagged for human classification. */
  readonly needsHumanClassification: boolean;
}

/** §7.1 W1 step 4 — annotate classifier verdicts against the tenant confidence floor. Pure. */
export function classifyPages(
  pages: readonly ClassifiedPageResult[],
  floor: number = DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
): readonly ClassifiedPage[] {
  return pages.map((p) => ({
    ...p,
    needsHumanClassification: p.documentType === "unknown" || p.confidence < floor,
  }));
}

/** A contiguous run of same-document-type pages → one `extraction_job` (§7.1 W1 step 5). */
export interface PageRun {
  readonly documentType: ClassifiedPage["documentType"];
  readonly pageNumbers: readonly number[];
}

/** §7.1 W1 step 5 — group classified pages into contiguous same-type runs (skipping `unknown`/needs-human
 * pages, which do not yet form an extraction job). Pure. */
export function groupContiguousRuns(pages: readonly ClassifiedPage[]): readonly PageRun[] {
  const runs: { type: ClassifiedPage["documentType"]; nums: number[] }[] = [];
  let current: { type: ClassifiedPage["documentType"]; nums: number[] } | null = null;
  for (const p of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    if (p.needsHumanClassification || p.documentType === "unknown") {
      current = null;
      continue;
    }
    if (current && current.type === p.documentType) {
      current.nums.push(p.pageNumber);
    } else {
      current = { type: p.documentType, nums: [p.pageNumber] };
      runs.push(current);
    }
  }
  return runs.map((r) => ({ documentType: r.type, pageNumbers: [...r.nums] }));
}

// ── Stage 2: extract (+ HIGH-risk vision verification) ───────────────────────────────────────────────────

/** A candidate enriched with its vision-verification verdict when the field is HIGH-risk (D4). */
export interface PipelineCandidate extends ExtractedCandidate {
  /** Vision verdict for HIGH-risk fields; `null` for low/medium (no vision pass). */
  readonly visionVerified: boolean | null;
}

/** §7.1 W1 step 5 — merge extractor candidates with the HIGH-risk vision-verification verdicts. Pure. */
export function mergeVisionVerification(
  candidates: readonly ExtractedCandidate[],
  verifications: readonly VisionVerificationResult[],
): readonly PipelineCandidate[] {
  const byField = new Map(verifications.map((v) => [v.fieldPath, v]));
  return candidates.map((c) => ({
    ...c,
    visionVerified: c.riskLevel === "high" ? (byField.get(c.fieldPath)?.verified ?? false) : null,
  }));
}

// ── Stage 3: discrepancy detection ───────────────────────────────────────────────────────────────────────

/** The current chart value for a candidate field, fetched via the owning module's reader seam (§7.1 W1 step
 * 6). `null` ⇒ no existing chart value ⇒ no chart-existing discrepancy. */
export interface ChartValue {
  readonly fieldPath: string;
  readonly value: string | null;
  readonly targetModule: ChartTargetModule;
}

/** A detected disagreement between a candidate and the current chart value (§3.3 `extraction_discrepancy`). */
export interface Discrepancy {
  readonly fieldPath: string;
  readonly kind: ExtractionDiscrepancyKind;
  readonly extractedValue: string;
  readonly chartValue: string;
}

/** §7.1 W1 step 6 — compute chart-existing discrepancies: a candidate whose value differs from the current
 * chart value for the same field path. Pure (chart values are injected, fetched via reader seams). */
export function detectDiscrepancies(
  candidates: readonly PipelineCandidate[],
  chartValues: readonly ChartValue[],
): readonly Discrepancy[] {
  const byField = new Map(chartValues.map((c) => [c.fieldPath, c]));
  const out: Discrepancy[] = [];
  for (const cand of candidates) {
    const chart = byField.get(cand.fieldPath);
    if (chart && chart.value !== null && chart.value !== cand.value) {
      out.push({
        fieldPath: cand.fieldPath,
        kind: "chart_existing",
        extractedValue: cand.value,
        chartValue: chart.value,
      });
    }
  }
  return out;
}

// ── Stage 4: review session ──────────────────────────────────────────────────────────────────────────────

/** The assembled review session for one batch (§7.1 W1 steps 7–8 / §2.2.7). */
export interface ReviewSession {
  readonly batchId: string;
  readonly candidates: readonly PipelineCandidate[];
  readonly discrepancies: readonly Discrepancy[];
  /** D4 — "Approve all" is rendered ONLY when no candidate in scope is HIGH-risk. */
  readonly bulkApproveAllowed: boolean;
  /** §7.4 W4 / D8 — any candidate carries potential SUD content ⇒ the SUD banner shows. */
  readonly sudDetected: boolean;
}

/** §7.1 W1 step 8 — assemble the review session, deriving the D4 bulk-approve gate and the W4 SUD banner. Pure. */
export function buildReviewSession(
  batchId: string,
  candidates: readonly PipelineCandidate[],
  discrepancies: readonly Discrepancy[],
): ReviewSession {
  return {
    batchId,
    candidates,
    discrepancies,
    bulkApproveAllowed: candidates.every((c) => c.riskLevel !== "high"),
    sudDetected: candidates.some((c) => c.sudDetected),
  };
}

// ── Stage 5: decisions → chart-writeback intents ─────────────────────────────────────────────────────────

/** One reviewer decision over a candidate field (§7.1 W1 step 9 / §3.3 `extraction_decision`). */
export interface ReviewerDecision {
  readonly fieldPath: string;
  readonly decision: ExtractionDecisionKind;
  /** The reviewer's edited value when `decision='approve_with_edit'`; else the extracted value stands. */
  readonly editedValue?: string;
}

/** A per-target-aggregate chart-writeback intent (§7.1 W1 step 11 — `m22.extraction.commit_requested`). */
export interface CommitIntent {
  readonly fieldPath: string;
  readonly targetModule: ChartTargetModule;
  readonly value: string;
  readonly riskLevel: ExtractionCandidateRiskLevel;
}

/** §7.1 W1 step 11 — the commit plan: only APPROVED (or approve-with-edit) candidates become writeback
 * intents; rejected candidates persist for audit but emit no intent (W1 AC). D4: HIGH-risk fields can never
 * be bulk-approved — that gate lives in {@link buildReviewSession}; here each decision is explicit. Pure. */
export function planCommitIntents(
  candidates: readonly PipelineCandidate[],
  chartTargets: readonly ChartValue[],
  decisions: readonly ReviewerDecision[],
): readonly CommitIntent[] {
  const targetByField = new Map(chartTargets.map((c) => [c.fieldPath, c.targetModule]));
  const candByField = new Map(candidates.map((c) => [c.fieldPath, c]));
  const out: CommitIntent[] = [];
  for (const d of decisions) {
    if (d.decision === "reject") continue;
    const cand = candByField.get(d.fieldPath);
    const target = targetByField.get(d.fieldPath);
    if (!cand || !target) continue;
    out.push({
      fieldPath: d.fieldPath,
      targetModule: target,
      value:
        d.decision === "approve_with_edit" && d.editedValue !== undefined
          ? d.editedValue
          : cand.value,
      riskLevel: cand.riskLevel,
    });
  }
  return out;
}

// ── Stage 6: provenance ──────────────────────────────────────────────────────────────────────────────────

/** A provenance record linking a committed chart row back to its source (§3.3 `extraction_provenance`,
 * §7.1 W1 step 12 — the 90-day audit "where did this come from?" answer). */
export interface ProvenanceRecord {
  readonly jobId: string;
  readonly fieldPath: string;
  readonly targetModule: ChartTargetModule;
  readonly sourceDocumentId: string;
  readonly sourcePageNumber: number;
  readonly decision: ExtractionDecisionKind;
}

/** §7.1 W1 step 12 — build the provenance rows for the committed intents. Pure. */
export function buildProvenance(
  jobId: string,
  sourceDocumentId: string,
  candidates: readonly PipelineCandidate[],
  decisions: readonly ReviewerDecision[],
  intents: readonly CommitIntent[],
): readonly ProvenanceRecord[] {
  const candByField = new Map(candidates.map((c) => [c.fieldPath, c]));
  const decisionByField = new Map(decisions.map((d) => [d.fieldPath, d.decision]));
  const committedFields = new Set(intents.map((i) => i.fieldPath));
  const out: ProvenanceRecord[] = [];
  for (const intent of intents) {
    if (!committedFields.has(intent.fieldPath)) continue;
    const cand = candByField.get(intent.fieldPath);
    if (!cand) continue;
    out.push({
      jobId,
      fieldPath: intent.fieldPath,
      targetModule: intent.targetModule,
      sourceDocumentId,
      sourcePageNumber: cand.sourcePageNumber,
      decision: decisionByField.get(intent.fieldPath) ?? "approve",
    });
  }
  return out;
}

// ── End-to-end orchestration (pure over the injected capability) ─────────────────────────────────────────

/** The terminal outcome of running the extract+verify+discrepancy stages over the M32 capability. When the
 * capability is unavailable (denied or dropped mid-flight) the job lands `stalled` and produces no review
 * session (W1 AC) — ops is paged, no auto-retry. */
export type PipelineRunResult =
  | {
      readonly status: Extract<ExtractionJobStatus, "ready_for_review">;
      readonly classifiedPages: readonly ClassifiedPage[];
      readonly review: ReviewSession;
    }
  | {
      readonly status: Extract<ExtractionJobStatus, "stalled">;
      readonly reason: string;
    };

/** Inputs to run one batch through classify → extract → verify → discrepancy → review (W1 steps 4–8). The
 * chart values are injected (fetched via reader seams upstream); the capability is the M32 seam. */
export interface PipelineRunInput {
  readonly organizationId: string;
  readonly batchId: string;
  readonly jobId: string;
  readonly pageCount: number;
  readonly chartValues: readonly ChartValue[];
  readonly confidenceFloor?: number;
}

/**
 * §7.1 W1 steps 4–8 — drive one batch through the DocLens pipeline over the injected M32 capability. Any
 * capability arm reporting `unavailable` short-circuits to `stalled` (W1 AC; ops paged, no auto-retry). This
 * is async ONLY because the capability seam is async; all the domain transforms above are pure & sync.
 */
export async function runExtractionPipeline(
  capability: DocLensCapabilityPort,
  input: PipelineRunInput,
): Promise<PipelineRunResult> {
  const classifyRes = await capability.classifyPages({
    organizationId: input.organizationId,
    batchId: input.batchId,
    pageCount: input.pageCount,
  });
  if (classifyRes.status !== "ok") return { status: "stalled", reason: classifyRes.reason };

  const classified = classifyPages(classifyRes.value, input.confidenceFloor);
  const runs = groupContiguousRuns(classified);

  const allCandidates: PipelineCandidate[] = [];
  for (const run of runs) {
    const extractRes = await capability.extract({
      organizationId: input.organizationId,
      jobId: input.jobId,
      documentType: run.documentType,
      pageNumbers: run.pageNumbers,
    });
    if (extractRes.status !== "ok") return { status: "stalled", reason: extractRes.reason };

    const highRisk = extractRes.value.filter((c) => c.riskLevel === "high");
    let verifications: readonly VisionVerificationResult[] = [];
    if (highRisk.length > 0) {
      const verifyRes = await capability.verify({
        organizationId: input.organizationId,
        jobId: input.jobId,
        candidates: highRisk,
      });
      if (verifyRes.status !== "ok") return { status: "stalled", reason: verifyRes.reason };
      verifications = verifyRes.value;
    }
    allCandidates.push(...mergeVisionVerification(extractRes.value, verifications));
  }

  const discrepancies = detectDiscrepancies(allCandidates, input.chartValues);
  const review = buildReviewSession(input.batchId, allCandidates, discrepancies);
  return { status: "ready_for_review", classifiedPages: classified, review };
}
