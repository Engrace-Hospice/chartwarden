// @wardenx/intake-extraction — the §7.1 W1 DocLens pipeline orchestrator (M22-T08).
//
// The 8-stage intake pipeline as a PURE async orchestration over the injected {@link DocLensCapabilities} + the
// §3.1 schema library + the discrepancy detector + the SUD flagger:
//
//   upload → docling → classify → extract → verify → discrepancy → review → writeback
//
// This function runs the FIRST SIX stages (through discrepancy) and TERMINATES at candidates ready for human
// review. It NEVER auto-commits — the architecture's "DocLens proposes, never auto-commits" hard rule (AI
// Governance v0.2 §7.3.2). The review + writeback stages are human-driven (the reviewer's per-field decisions →
// `m22.extraction.commit_requested` → each target module's draft-create consumer), owned by the backend service.
//
// Fail-safe capability handling (§2.2.6 / W1 AC):
//   • docling deny at the START → `awaiting_capability` (job sits queued; ops re-enables; no auto-retry).
//   • classifier / extractor / vision deny AFTER docling succeeded → `stalled` (capability dropped mid-pipeline).
// In Phase 1 (`documents.doclens` OFF) every capability is a deny-stub, so an invoked pipeline returns
// `awaiting_capability` at the docling stage — and the route gate returns 503 before the pipeline is ever invoked.

import type {
  BoundingBox,
  CapabilityProvenance,
  DocLensCapabilities,
  DoclingPage,
} from "../adapters/seams";
import { isCapabilityAvailable } from "../adapters/seams";
import { type ChartValue, type Discrepancy, detectDiscrepancies } from "../discrepancy/detector";
import { resolveExtractionSchema } from "../schemas/library";
import { type SudFlag, flagSud } from "../sud-detection/flagger";
import type {
  ClassifiedPageDocType,
  ExtractionCandidateCodeSystem,
  ExtractionCandidateFieldKind,
  ExtractionCandidateRiskLevel,
} from "@wardenx/types";

/** The single tenant-config classifier confidence floor (§2.3, F19 — default 0.75). Pages below it are flagged
 * for human confirmation; the pipeline never auto-confirms a low-confidence page's doc type. */
export const CLASSIFIER_CONFIDENCE_FLOOR = 0.75;

/** A pipeline-resolved candidate: the raw M32 candidate enriched with its §3.1 risk level + vision verdict. */
export interface PipelineCandidate {
  readonly candidateId: string;
  readonly jobId: string;
  readonly docType: ClassifiedPageDocType;
  readonly fieldPath: string;
  readonly fieldKind: ExtractionCandidateFieldKind;
  readonly value: string;
  readonly codeSystem: ExtractionCandidateCodeSystem;
  readonly code: string | null;
  readonly confidence: number;
  readonly sourcePage: number;
  readonly sourceBoundingBox: BoundingBox;
  readonly riskLevel: ExtractionCandidateRiskLevel;
  /** Vision-verifier verdict for HIGH-risk fields (null = not routed to vision / not yet verified). */
  readonly visionAgrees: boolean | null;
  readonly visionDisagreement: string | null;
}

/** A contiguous run of same-doc-type pages → one extraction job (W1 step 5). */
export interface ExtractionJobPlan {
  readonly jobId: string;
  readonly docType: ClassifiedPageDocType;
  readonly pageNumbers: readonly number[];
}

/** The batch the orchestrator runs over (the §3.3 `intake_upload_batch` projection). */
export interface IntakeBatchInput {
  readonly batchId: string;
  /** The tenant-scoped opaque object key of the uploaded `original.pdf` (no PHI, §2.2.2 / D11). */
  readonly objectKey: string;
  readonly pageCount: number;
  /** Current chart values for chart-existing discrepancy detection (fetched via M22's reader seams). */
  readonly chartValues?: readonly ChartValue[];
}

export interface OrchestratorDeps {
  readonly capabilities: DocLensCapabilities;
  /** Mint a stable id for a job/candidate (injected so the orchestrator is RNG-free + testable). */
  readonly mintId: (prefix: "job" | "cand") => string;
}

/** The terminal outcome of an orchestrator run. */
export type IntakePipelineOutcome =
  | {
      readonly kind: "ready_for_review";
      readonly batchStatus: "extraction_complete";
      readonly classifiedPages: readonly { pageNumber: number; documentType: ClassifiedPageDocType; confidence: number; needsHumanConfirm: boolean }[];
      readonly parseFailedPages: readonly number[];
      readonly jobs: readonly ExtractionJobPlan[];
      readonly candidates: readonly PipelineCandidate[];
      readonly discrepancies: readonly Discrepancy[];
      readonly sudFlags: readonly SudFlag[];
      readonly provenance: readonly CapabilityProvenance[];
    }
  | { readonly kind: "parse_failed"; readonly batchStatus: "parse_failed"; readonly parseFailedPages: readonly number[] }
  | { readonly kind: "awaiting_capability"; readonly stage: "docling"; readonly missingCapability: "DoclingParser" }
  | {
      readonly kind: "stalled";
      readonly stage: "classify" | "extract" | "verify";
      readonly missingCapability: "DocLensClassifier" | "DocLensExtractor" | "DocLensVisionVerifier";
    };

/** Group classified pages into contiguous same-doc-type runs (`unknown` pages start no job — W1 step 5). */
function planJobs(
  pages: readonly { pageNumber: number; documentType: ClassifiedPageDocType }[],
  mintId: OrchestratorDeps["mintId"],
): ExtractionJobPlan[] {
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const jobs: ExtractionJobPlan[] = [];
  let current: { docType: ClassifiedPageDocType; pages: number[] } | null = null;
  for (const p of ordered) {
    if (p.documentType === "unknown") {
      current = null; // an unknown page breaks the run; it is human-classified, not extracted.
      continue;
    }
    if (current && current.docType === p.documentType) {
      current.pages.push(p.pageNumber);
    } else {
      current = { docType: p.documentType, pages: [p.pageNumber] };
      jobs.push({ jobId: mintId("job"), docType: p.documentType, pageNumbers: current.pages });
    }
  }
  // The push above captured the array by reference, so trailing pages are already included.
  return jobs;
}

/** Run the §7.1 W1 pipeline through discrepancy detection, terminating at human-review-ready candidates. */
export async function runIntakePipeline(
  batch: IntakeBatchInput,
  deps: OrchestratorDeps,
): Promise<IntakePipelineOutcome> {
  const { capabilities: caps, mintId } = deps;

  // ── Stage 1: docling layout extraction (uploaded → docling_complete) ──────────────────────────────────
  const parsed = await caps.parser.parse({
    batchId: batch.batchId,
    objectKey: batch.objectKey,
    pageCount: batch.pageCount,
  });
  if (!isCapabilityAvailable(parsed)) {
    return { kind: "awaiting_capability", stage: "docling", missingCapability: "DoclingParser" };
  }
  const pages: readonly DoclingPage[] = parsed.value.pages;
  const parseFailedPages = pages.filter((p) => p.parseError !== null).map((p) => p.pageNumber);
  const okPages = pages.filter((p) => p.parseError === null);
  // All pages failed → terminal parse_failed (W1 AC); a per-page failure just skips that page and continues.
  if (okPages.length === 0) {
    return { kind: "parse_failed", batchStatus: "parse_failed", parseFailedPages };
  }

  // ── Stage 2: per-page classification (docling_complete → classifier_complete) ─────────────────────────
  const classified = await caps.classifier.classifyPages({
    batchId: batch.batchId,
    pages: okPages.map((p) => ({ pageNumber: p.pageNumber, text: p.text })),
  });
  if (!isCapabilityAvailable(classified)) {
    return { kind: "stalled", stage: "classify", missingCapability: "DocLensClassifier" };
  }
  const provenance: CapabilityProvenance[] = [classified.value.provenance];
  const classifiedPages = classified.value.pages.map((p) => ({
    pageNumber: p.pageNumber,
    documentType: p.documentType,
    confidence: p.confidence,
    needsHumanConfirm: p.confidence < CLASSIFIER_CONFIDENCE_FLOOR,
  }));

  // ── Stage 3: plan extraction jobs from contiguous same-type runs (skip low-confidence/unknown) ────────
  const confidentPages = classifiedPages.filter((p) => !p.needsHumanConfirm);
  const jobs = planJobs(confidentPages, mintId);
  const pageTextByNumber = new Map(okPages.map((p) => [p.pageNumber, p.text]));

  // ── Stage 4 + 5: extract per job, then verify HIGH-risk fields via vision ─────────────────────────────
  const candidates: PipelineCandidate[] = [];
  for (const job of jobs) {
    const schema = resolveExtractionSchema(job.docType);
    if (!schema) continue;
    const text = job.pageNumbers.map((n) => pageTextByNumber.get(n) ?? "").join("\n");
    const extracted = await caps.extractor.extract({
      jobId: job.jobId,
      docType: job.docType,
      pageNumbers: job.pageNumbers,
      text,
    });
    if (!isCapabilityAvailable(extracted)) {
      return { kind: "stalled", stage: "extract", missingCapability: "DocLensExtractor" };
    }
    provenance.push(extracted.value.provenance);

    const jobCandidates: PipelineCandidate[] = [];
    for (const raw of extracted.value.candidates) {
      // §2.3 NOT NULL — a candidate without page + bounding box is rejected (never persisted).
      if (raw.sourcePage <= 0 || !raw.sourceBoundingBox) continue;
      const riskLevel = schema.fields.find((field) => field.fieldPath === raw.fieldPath)?.riskLevel ?? "medium";
      jobCandidates.push({
        candidateId: mintId("cand"),
        jobId: job.jobId,
        docType: job.docType,
        fieldPath: raw.fieldPath,
        fieldKind: raw.fieldKind,
        value: raw.value,
        codeSystem: raw.codeSystem,
        code: raw.code,
        confidence: raw.confidence,
        sourcePage: raw.sourcePage,
        sourceBoundingBox: raw.sourceBoundingBox,
        riskLevel,
        visionAgrees: null,
        visionDisagreement: null,
      });
    }

    // Vision verification for HIGH-risk fields only (§2.2.6).
    const highRisk = jobCandidates.filter((c) => c.riskLevel === "high");
    if (highRisk.length > 0) {
      const verified = await caps.visionVerifier.verify({
        jobId: job.jobId,
        candidates: highRisk.map((c) => ({
          fieldPath: c.fieldPath,
          fieldKind: c.fieldKind,
          value: c.value,
          codeSystem: c.codeSystem,
          code: c.code,
          confidence: c.confidence,
          sourcePage: c.sourcePage,
          sourceBoundingBox: c.sourceBoundingBox,
        })),
      });
      if (!isCapabilityAvailable(verified)) {
        return { kind: "stalled", stage: "verify", missingCapability: "DocLensVisionVerifier" };
      }
      provenance.push(verified.value.provenance);
      const verdictByField = new Map(verified.value.verdicts.map((v) => [v.fieldPath, v]));
      const verifiedCandidates = jobCandidates.map((c) => {
        const verdict = verdictByField.get(c.fieldPath);
        if (c.riskLevel === "high" && verdict) {
          return { ...c, visionAgrees: verdict.agrees, visionDisagreement: verdict.disagreement };
        }
        return c;
      });
      candidates.push(...verifiedCandidates);
    } else {
      candidates.push(...jobCandidates);
    }
  }

  // ── Stage 6: discrepancy detection (cross-source + chart-existing) ────────────────────────────────────
  const discrepancies = detectDiscrepancies({
    candidates: candidates.map((c) => ({
      candidateId: c.candidateId,
      fieldPath: c.fieldPath,
      value: c.value,
      sourcePage: c.sourcePage,
    })),
    chartValues: batch.chartValues ?? [],
  });

  // ── §7.4 W4: rule-based SUD flagging (always runs — defense in depth, independent of the M32 AI detector) ─
  const sudFlags = flagSud({
    candidates: candidates.map((c) => ({ fieldPath: c.fieldPath, value: c.value, code: c.code, sourcePage: c.sourcePage })),
    pages: okPages.map((p) => ({ pageNumber: p.pageNumber, text: p.text })),
  });

  // TERMINATE at human review (never auto-commit). Status = extraction_complete; jobs are ready_for_review.
  return {
    kind: "ready_for_review",
    batchStatus: "extraction_complete",
    classifiedPages,
    parseFailedPages,
    jobs,
    candidates,
    discrepancies,
    sudFlags,
    provenance,
  };
}
