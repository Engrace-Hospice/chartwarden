// packages/intake-extraction/__tests__/doclens-pipeline.test.ts — M22-T08.
//
// Proves the DocLens Pillar-3 logic built behind the `documents.doclens` flag (§7.1 W1 / §7.4 W4 / §8.5):
//   • the §3.1 11-schema library (risk levels + writeback targets);
//   • the §7.1 W1 orchestrator happy path (classify → extract → vision-verify high-risk → discrepancy → SUD),
//     terminating at human-review-ready candidates (NEVER auto-committing);
//   • the §2.2.6 fail-safe states — `awaiting_capability` (docling deny at start), `stalled` (capability dropped
//     mid-pipeline), and `parse_failed` (all pages fail docling), plus per-page continue;
//   • the cross-source / chart-existing discrepancy detector and the rule-based SUD flagger.
import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_CONFIDENCE_FLOOR,
  type DocLensCapabilities,
  EXTRACTION_SCHEMAS,
  type IntakeBatchInput,
  type RawCandidate,
  denyStubDocLensCapabilities,
  detectDiscrepancies,
  fieldRiskLevel,
  flagSud,
  hasSudContent,
  resolveExtractionSchema,
  runIntakePipeline,
} from "../src/index";

let seq = 0;
const mintId = (prefix: "job" | "cand") => `${prefix}-${String(++seq).padStart(4, "0")}`;
const reset = () => {
  seq = 0;
};

const bbox = { x0: 1, y0: 2, x1: 3, y1: 4 };

/** A working capability set: docling parses N pages, classifier labels them, extractor + vision agree. */
function workingCaps(over: Partial<DocLensCapabilities> = {}): DocLensCapabilities {
  return {
    parser: {
      async parse({ pageCount }) {
        const pages = Array.from({ length: pageCount }, (_, i) => ({
          pageNumber: i + 1,
          text: `page ${i + 1} text`,
          imageObjectKey: `img-${i + 1}`,
          parseError: null as null,
        }));
        return { available: true, value: { pages } };
      },
    },
    classifier: {
      async classifyPages({ pages }) {
        return {
          available: true,
          value: {
            pages: pages.map((p) => ({ pageNumber: p.pageNumber, documentType: "med_recon" as const, confidence: 0.95 })),
            provenance: { capabilityId: "doclens/classify", capabilityVersion: "v1", modelVersion: "haiku-2026" },
          },
        };
      },
    },
    extractor: {
      async extract({ jobId }) {
        const candidates: RawCandidate[] = [
          { fieldPath: "medications[].rxnorm", fieldKind: "code", value: "methadone 5mg", codeSystem: "rxnorm", code: "6813", confidence: 0.92, sourcePage: 1, sourceBoundingBox: bbox },
          { fieldPath: "medications[].dose", fieldKind: "measurement", value: "5 mg", codeSystem: "none", code: null, confidence: 0.6, sourcePage: 1, sourceBoundingBox: bbox },
        ];
        return {
          available: true,
          value: { candidates, provenance: { capabilityId: `doclens/extract:${jobId}`, capabilityVersion: "v2", modelVersion: "langextract-2026" } },
        };
      },
    },
    visionVerifier: {
      async verify({ candidates }) {
        return {
          available: true,
          value: {
            verdicts: candidates.map((c) => ({ fieldPath: c.fieldPath, agrees: true, disagreement: null, confidence: 0.99 })),
            provenance: { capabilityId: "doclens/vision", capabilityVersion: "v1", modelVersion: "opus-2026" },
          },
        };
      },
    },
    sudDetector: denyStubDocLensCapabilities.sudDetector,
    ...over,
  };
}

const batch: IntakeBatchInput = { batchId: "b1", objectKey: "tenant-x/intake/b1/original.pdf", pageCount: 2 };

describe("M22-T08 — §3.1 extraction schema library", () => {
  it("declares 11 schemas; high-risk medication/dose fields gate per-field-only review", () => {
    expect(Object.keys(EXTRACTION_SCHEMAS)).toHaveLength(11);
    expect(resolveExtractionSchema("unknown")).toBeNull();
    expect(fieldRiskLevel("med_recon", "medications[].rxnorm")).toBe("high");
    expect(fieldRiskLevel("med_recon", "medications[].dose")).toBe("high");
    // an undeclared field fails toward the more-restrictive `medium` (no silent low-risk bulk-approve).
    expect(fieldRiskLevel("med_recon", "nonexistent.field")).toBe("medium");
  });
});

describe("M22-T08 — §7.1 W1 orchestrator", () => {
  it("runs classify→extract→vision→discrepancy and terminates ready_for_review (never auto-commits)", async () => {
    reset();
    const out = await runIntakePipeline({ ...batch, chartValues: [{ fieldPath: "medications[].dose", value: "10 mg" }] }, { capabilities: workingCaps(), mintId });
    expect(out.kind).toBe("ready_for_review");
    if (out.kind !== "ready_for_review") return;
    expect(out.batchStatus).toBe("extraction_complete"); // NOT "committed" — humans commit, not the pipeline
    expect(out.jobs).toHaveLength(1); // two contiguous med_recon pages → one job
    expect(out.candidates).toHaveLength(2);
    // high-risk fields routed through vision; the verdict is attached.
    const rxnorm = out.candidates.find((c) => c.fieldPath === "medications[].rxnorm");
    expect(rxnorm?.riskLevel).toBe("high");
    expect(rxnorm?.visionAgrees).toBe(true);
    // chart-existing discrepancy on dose (extracted "5 mg" vs chart "10 mg").
    expect(out.discrepancies.some((d) => d.kind === "chart_existing" && d.fieldPath === "medications[].dose")).toBe(true);
    // SUD flagged ("methadone" in the rxnorm value) — defense-in-depth flagger runs regardless of M32.
    expect(hasSudContent(out.sudFlags)).toBe(true);
    expect(out.sudFlags.some((f) => f.sudKind === "opioid_use_disorder")).toBe(true);
    // §8.5 provenance recorded for classifier + extractor + vision.
    expect(out.provenance.length).toBeGreaterThanOrEqual(3);
  });

  it("returns awaiting_capability when docling is deny-stubbed (Phase 1)", async () => {
    reset();
    const out = await runIntakePipeline(batch, { capabilities: denyStubDocLensCapabilities, mintId });
    expect(out).toEqual({ kind: "awaiting_capability", stage: "docling", missingCapability: "DoclingParser" });
  });

  it("returns stalled when the extractor drops mid-pipeline (after docling+classify succeed)", async () => {
    reset();
    const caps = workingCaps({ extractor: { async extract() { return { available: false, reason: "circuit_open" }; } } });
    const out = await runIntakePipeline(batch, { capabilities: caps, mintId });
    expect(out).toEqual({ kind: "stalled", stage: "extract", missingCapability: "DocLensExtractor" });
  });

  it("returns stalled when the vision verifier drops on a high-risk field", async () => {
    reset();
    const caps = workingCaps({ visionVerifier: { async verify() { return { available: false, reason: "capability_unavailable" }; } } });
    const out = await runIntakePipeline(batch, { capabilities: caps, mintId });
    expect(out).toEqual({ kind: "stalled", stage: "verify", missingCapability: "DocLensVisionVerifier" });
  });

  it("marks parse_failed only when ALL pages fail docling; a single bad page is skipped and continues", async () => {
    reset();
    // one of two pages fails → continue with the good page (W1 AC).
    const oneBad = workingCaps({
      parser: {
        async parse() {
          return { available: true, value: { pages: [
            { pageNumber: 1, text: "", imageObjectKey: null, parseError: "docling_parse_failed" as const },
            { pageNumber: 2, text: "page 2", imageObjectKey: "i2", parseError: null },
          ] } };
        },
      },
    });
    const cont = await runIntakePipeline(batch, { capabilities: oneBad, mintId });
    expect(cont.kind).toBe("ready_for_review");
    if (cont.kind === "ready_for_review") expect(cont.parseFailedPages).toEqual([1]);

    // ALL pages fail → terminal parse_failed.
    reset();
    const allBad = workingCaps({
      parser: {
        async parse() {
          return { available: true, value: { pages: [
            { pageNumber: 1, text: "", imageObjectKey: null, parseError: "docling_parse_failed" as const },
          ] } };
        },
      },
    });
    const fail = await runIntakePipeline({ ...batch, pageCount: 1 }, { capabilities: allBad, mintId });
    expect(fail.kind).toBe("parse_failed");
  });

  it("flags low-confidence pages for human confirmation and does not extract them", async () => {
    reset();
    const lowConf = workingCaps({
      classifier: {
        async classifyPages({ pages }) {
          return { available: true, value: {
            pages: pages.map((p) => ({ pageNumber: p.pageNumber, documentType: "med_recon" as const, confidence: 0.5 })),
            provenance: { capabilityId: "c", capabilityVersion: "v1", modelVersion: "m" },
          } };
        },
      },
    });
    const out = await runIntakePipeline(batch, { capabilities: lowConf, mintId });
    expect(out.kind).toBe("ready_for_review");
    if (out.kind !== "ready_for_review") return;
    expect(CLASSIFIER_CONFIDENCE_FLOOR).toBe(0.75);
    expect(out.classifiedPages.every((p) => p.needsHumanConfirm)).toBe(true);
    expect(out.jobs).toHaveLength(0); // nothing confident enough to extract
    expect(out.candidates).toHaveLength(0);
  });
});

describe("M22-T08 — discrepancy detector", () => {
  it("detects cross_source (same field, two values) and chart_existing (vs current chart)", () => {
    const out = detectDiscrepancies({
      candidates: [
        { candidateId: "a", fieldPath: "allergies[].substance", value: "penicillin", sourcePage: 1 },
        { candidateId: "b", fieldPath: "allergies[].substance", value: "penicillin (anaphylaxis)", sourcePage: 4 },
        { candidateId: "c", fieldPath: "codeStatus", value: "DNR", sourcePage: 2 },
      ],
      chartValues: [{ fieldPath: "codeStatus", value: "Full Code" }],
    });
    expect(out.find((d) => d.kind === "cross_source")?.fieldPath).toBe("allergies[].substance");
    const chart = out.find((d) => d.kind === "chart_existing");
    expect(chart?.fieldPath).toBe("codeStatus");
    expect(chart?.chartExistingValue).toBe("Full Code");
  });

  it("reports nothing when candidates agree and match the chart", () => {
    const out = detectDiscrepancies({
      candidates: [{ candidateId: "a", fieldPath: "f", value: "v", sourcePage: 1 }],
      chartValues: [{ fieldPath: "f", value: "v" }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("M22-T08 — §7.4 W4 SUD flagger", () => {
  it("flags MAT medications, ICD-10 F-codes, and SUD terminology; clean text raises nothing", () => {
    const meds = flagSud({ candidates: [{ fieldPath: "medications[].rxnorm", value: "Suboxone 8mg", code: null, sourcePage: 3 }], pages: [] });
    expect(meds.some((f) => f.signalFamily === "medication" && f.sudKind === "opioid_use_disorder")).toBe(true);

    const icd = flagSud({ candidates: [], pages: [{ pageNumber: 2, text: "Dx: F11.20 opioid dependence" }] });
    expect(icd.some((f) => f.signalFamily === "icd10")).toBe(true);
    expect(icd.some((f) => f.signalFamily === "terminology")).toBe(false); // "opioid dependence" is not a listed term

    const term = flagSud({ candidates: [], pages: [{ pageNumber: 1, text: "history of opioid use disorder" }] });
    expect(term.some((f) => f.signalFamily === "terminology")).toBe(true);

    expect(flagSud({ candidates: [{ fieldPath: "f", value: "lisinopril 10mg", code: null, sourcePage: 1 }], pages: [] })).toHaveLength(0);
  });
});

describe("M22-T08 — M32 deny-stubs (§8.5)", () => {
  it("every capability refuses with capability_unavailable", async () => {
    expect(await denyStubDocLensCapabilities.parser.parse({ batchId: "b", objectKey: "k", pageCount: 1 })).toEqual({ available: false, reason: "capability_unavailable" });
    expect(await denyStubDocLensCapabilities.classifier.classifyPages({ batchId: "b", pages: [] })).toEqual({ available: false, reason: "capability_unavailable" });
    expect(await denyStubDocLensCapabilities.extractor.extract({ jobId: "j", docType: "med_recon", pageNumbers: [1], text: "" })).toEqual({ available: false, reason: "capability_unavailable" });
    expect(await denyStubDocLensCapabilities.visionVerifier.verify({ jobId: "j", candidates: [] })).toEqual({ available: false, reason: "capability_unavailable" });
    expect(await denyStubDocLensCapabilities.sudDetector.detect({ candidates: [], pages: [] })).toEqual({ available: false, reason: "capability_unavailable" });
  });
});
