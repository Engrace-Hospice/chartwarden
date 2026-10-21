import { type DbClient, schema } from "@chartwarden/db";
import {
  type ClassifiedPage,
  type CodeOnPage,
  type CodingFlag,
  DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
  type GroundedDiagnosis,
  type IntakeDocumentType,
  SUD_RULESET_VERSION,
  type SudIndicator,
  type SudIndicatorCategory,
  attachCodesToDiagnoses,
  classifyPages,
  detectSudIndicators,
  dominantSudCategory,
  findCodeTokens,
  findExtractionField,
  findExtractionSchema,
  groundQuote,
  resolveCodeTokens,
  runCodingChecks,
  splitPacket,
} from "@chartwarden/intake-extraction";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type ClassifiedPageDocType,
  DegradedError,
  type IntakeSudDetectedPayload,
  M22_INTAKE_SUD_DETECTED_EVENT,
} from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { deriveTenantBucket } from "../lifecycle/storage";
import {
  type RecordsRequestMatchSummary,
  matchInboundRecordsRequest,
} from "../records-request/inbound-match";
// apps/backend/src/modules/22-documents/extraction/intake-job.ts — the DocLens intake JOB: one uploaded
// batch through stages 2–4 of §7.1 W1, persisted for review (F-236, ADR-0048).
//
//   source document (MinIO) ──presigned GET──▶ docling-worker  (stage 2: OCR + layout + boxes)
//     ──per page──▶ M32 DocLensClassifier                       (stage 3: document type)
//     ──per same-type run──▶ M32 DocLensExtractor               (stage 4: value + verbatim quote + page)
//     ──▶ groundQuote against Docling's text                    (the box is always Docling's)
//     ──▶ high/medium-risk values: docling /render crop ──▶ M32 DocLensVisionVerifier (stage 5, F-237)
//     ──▶ classified_page / extraction_job / extraction_candidate (value DEK-encrypted)
//   every page ──▶ SUD rules (+ optional M32 DocLensSudDetector, grounded) (§7.4 W4, F-237)
//     ──▶ batch `sud_status` + encrypted evidence + `m22.intake.sud_detected`, atomic with completion
//
// Stage 5 never shows the model the extracted value: it asks the model to READ the field from a crop of
// the page and compares the reading here (alphanumerics only). A match sets `vision_verified`; a mismatch
// stores the model's reading encrypted in `vision_disagreement`; a refusal or an illegible crop leaves the
// value unverified, which the review UI says out loud.
//
// SUD detection runs whatever the AI posture: the rules need no capability. Every candidate on a page
// with an indicator is tagged `sud_detected` (the page is Part 2-bearing content; the F-235 planner
// excludes it from writeback until a reviewer rejects the detection as a false positive).
//
// What it never does:
//   · trust the model for a box, a page, a risk tier or a field path. Box/page come from grounding; tier
//     and path from the schema registry (`findExtractionField`). A path the schema does not declare, or a
//     quote that does not ground, is DROPPED and counted — never stored.
//   · store a value in the clear. `value_cipher` only (the F-235 commit decrypts server-side).
//   · write back to the chart. That is the reviewer's act (F-235's route 23).
//   · read M32 code: the seams are reached opaquely through the M1 registry (M22 deps stay [1, 5]).
//
// A refused AI call (ai.full off, lifecycle, opt-in, budget, no template, no healthy backend …) is not an
// error to retry blindly: the affected job is marked `awaiting_capability` and the summary carries the
// refusal detail. A Docling outage IS retried (thrown). An unparseable source marks the batch
// `parse_failed`. Re-running a batch that already produced jobs is a no-op (idempotent on status).
import {
  type BatchIdentityStatus,
  type IdentityTargetPorts,
  refreshBatchIdentity,
} from "./batch-identity";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import type { CodingTerminologyAdapter } from "./coding-terminology";
import { type DoclingClient, type DoclingPage, DoclingParseError } from "./docling-client";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const BATCH = schema.intakeUploadBatches;
const DOC = schema.documents;
const DV = schema.documentVersions;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;

/** The structural slices of M32's DocLens seams this job calls (M22 has no M32 edge). */
type SeamRefusal = { readonly available: false; readonly detail?: string };
export interface DocLensClassifierPort {
  classify(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    extractedText: string;
    pageCount: number;
    pageNumber?: number;
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly documentType: string;
        readonly confidence: number;
      }
    | SeamRefusal
  >;
}
export interface DocLensExtractorPort {
  extract(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    documentType: string;
    extractedText: string;
    schemaKey: string;
    fieldSpecs: readonly { fieldPath: string; description: string }[];
    pages: readonly { page: number; text: string }[];
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly fields: Readonly<
          Record<
            string,
            {
              readonly value: unknown;
              readonly confidence: number;
              readonly sourceQuote?: { readonly page: number; readonly text: string };
            }
          >
        >;
      }
    | SeamRefusal
  >;
}

/** F-237 — M32's stage-5 seam, `field_value` mode only (structural). */
export interface DocLensVisionVerifierPort {
  verify(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    verificationKey: "field_value";
    images: readonly { pageNumber: number; mediaType: "image/png"; dataBase64: string }[];
    field: { fieldPath: string; description: string };
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly verdict: "pass" | "fail" | "uncertain";
        readonly observedValue?: string;
        readonly observedValues?: readonly string[];
      }
    | SeamRefusal
  >;
}

/** F-237 — M32's SUD detector seam (structural). Its quotes are GROUNDED here before they count. */
export interface DocLensSudDetectorPort {
  detect(input: {
    organizationId: string;
    actorUserId: string;
    documentId: string;
    extractedText: string;
    pages: readonly { page: number; text: string }[];
  }): Promise<
    | {
        readonly available: true;
        readonly invocationId: string;
        readonly indicators: readonly {
          readonly pageNumber: number;
          readonly snippet: string;
          readonly category: string;
        }[];
      }
    | SeamRefusal
  >;
}

export interface DocLensIntakeDeps {
  readonly db: DbClient;
  readonly docling: DoclingClient;
  readonly presignSource: (args: {
    organizationId: string;
    bucket: string;
    objectKey: string;
  }) => Promise<string>;
  readonly cipher: CandidateValueCipher;
  readonly classifier: () => DocLensClassifierPort;
  readonly extractor: () => DocLensExtractorPort;
  /** F-237 — stage 5. Absent ⇒ high/medium-risk values stay unverified (and say so). */
  readonly visionVerifier?: () => DocLensVisionVerifierPort;
  /** F-237 — the optional model pass of SUD detection. Absent ⇒ the rules alone. */
  readonly sudDetector?: () => DocLensSudDetectorPort;
  /** F-237 — publishes `m22.intake.sud_detected`. Required the moment a batch has an indicator. */
  readonly outbox?: ExtractionOutboxPort;
  readonly confidenceFloor?: number;
  /**
   * F-238 — ICD-10-CM for the code scanner + coding checks (M38). Absent, or no release loaded ⇒ codes are
   * neither scanned nor checked, and the summary says so (`coding.status`).
   */
  readonly codingTerminology?: () => CodingTerminologyAdapter;
  /** F-238 — M5 patient / M6 referral lookups for the per-document identity check (absent ⇒ not run). */
  readonly identityTargets?: IdentityTargetPorts;
}

/** F-237 — the risk tiers stage 5 re-reads from the page (medications/allergies + name/DOB). */
export const VISION_VERIFIED_RISK_LEVELS: ReadonlySet<string> = new Set(["high", "medium"]);
/**
 * Context around a value's box, in page units (points). Wide horizontally (the label beside the value),
 * TIGHT vertically: a list's neighbouring entries sit ~20pt apart on a fax, and a crop that shows three
 * medication lines lets the model read the wrong one — the first E2E run did exactly that (F-237).
 */
const CROP_PAD_X = 48;
const CROP_PAD_Y = 6;
const CROP_SCALE = 3;

/**
 * Does the model's independent reading agree with the extracted value? Alphanumerics only, lower-cased
 * (OCR spacing and punctuation are not disagreements); one containing the other counts when they are of
 * comparable length ("Penicillin" vs "penicillin." agrees; "Penicillin" vs "Penicillin — anaphylaxis"
 * does not, and the reviewer sees the longer reading).
 */
const alnum = (s: string): string => s.toLowerCase().replace(/[^0-9a-z]/g, "");

/** The reading most like the extracted value (bigram overlap) — what the reviewer is shown on a mismatch. */
export function closestReading(extracted: string, readings: readonly string[]): string {
  const grams = (s: string) => {
    const a = alnum(s);
    const out = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) out.add(a.slice(i, i + 2));
    return out;
  };
  const target = grams(extracted);
  let best = readings[0] as string;
  let bestScore = -1;
  for (const r of readings) {
    const g = grams(r);
    let shared = 0;
    for (const x of g) if (target.has(x)) shared += 1;
    const score = (2 * shared) / (g.size + target.size || 1);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export function visionReadingAgrees(extracted: string, observed: string): boolean {
  const a = alnum(extracted);
  const b = alnum(observed);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.includes(short) && short.length / long.length >= 0.6;
}

export interface DocLensIntakeJob {
  readonly organizationId: string;
  readonly batchId: string;
  /** The user whose request started the run — the AI ledger's actor (M32 resolves the membership). */
  readonly actorUserId: string;
  readonly correlationId: string;
}

export type DocLensIntakeSummary =
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "parse_failed"; readonly reason: string }
  | {
      readonly outcome: "extracted" | "awaiting_capability";
      readonly pages: number;
      readonly jobs: number;
      readonly candidates: number;
      readonly dropped: Readonly<Record<string, number>>;
      readonly refusals: readonly string[];
      /** F-237 — counts only. */
      readonly vision: {
        readonly verified: number;
        readonly disagreed: number;
        readonly unverified: number;
      };
      readonly sud: { readonly indicators: number; readonly pages: readonly number[] };
      /** F-238 — the batch's worst per-document identity verdict, or why none was computed. */
      readonly identity: BatchIdentityStatus | "not_configured";
      /** F-238 — the records-request code match (a `conflict` outcome is a warning for staff). */
      readonly recordsRequest: RecordsRequestMatchSummary;
      /** F-238 — the splitter's documents and the coding checks (counts only). */
      readonly documents: number;
      readonly coding: {
        readonly status: "checked" | "icd10cm_not_loaded" | "not_configured";
        readonly codes: number;
        readonly repaired: number;
        readonly flags: number;
        readonly unreadable: number;
      };
    };

const SCHEMA_KEY = "doclens_v1";

/** F-238 — a document's label for a diagnosis, normalised to the four the review and writeback know. */
function normaliseRole(v: string): string {
  const s = v.toLowerCase();
  if (/princip|primary/.test(s)) return "principal";
  if (/second|other|additional/.test(s)) return "secondary";
  if (/hist|past|resolv|prior/.test(s)) return "history";
  return "unspecified";
}
const pageText = (p: DoclingPage): string => p.blocks.map((b) => b.text).join("\n");

export async function runDocLensIntake(
  deps: DocLensIntakeDeps,
  job: DocLensIntakeJob,
): Promise<DocLensIntakeSummary> {
  const org = job.organizationId;
  const inOrg = <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, { organizationId: org, userId: "" }, (tx) => fn(tx as DbClient));

  // ── 1. the batch and its filed source document ─────────────────────────────────────────────────────
  const source = await inOrg(async (tx) => {
    const [b] = await tx
      .select({
        status: BATCH.status,
        documentId: BATCH.initialDocumentId,
        patientId: BATCH.patientId,
      })
      .from(BATCH)
      .where(eq(BATCH.id, job.batchId))
      .limit(1);
    if (!b) return { kind: "missing" as const };
    if (b.status !== "uploaded" && b.status !== "docling_complete") {
      return { kind: "done" as const, status: b.status };
    }
    const [d] = await tx
      .select({ objectKey: DV.minioObjectKey })
      .from(DOC)
      .innerJoin(DV, eq(DV.id, DOC.activeVersionId))
      .where(eq(DOC.id, b.documentId))
      .limit(1);
    return d
      ? {
          kind: "ok" as const,
          documentId: b.documentId,
          objectKey: d.objectKey,
          patientId: b.patientId,
        }
      : { kind: "unfiled" as const, documentId: b.documentId };
  });
  if (source.kind === "missing") return { outcome: "skipped", reason: "batch_not_found" };
  if (source.kind === "done")
    return { outcome: "skipped", reason: `batch_already_${source.status}` };
  const setBatch = (
    status: "docling_complete" | "classifier_complete" | "extraction_complete" | "parse_failed",
  ) =>
    inOrg((tx) =>
      tx
        .update(BATCH)
        .set({ status })
        .where(eq(BATCH.id, job.batchId))
        .then(() => undefined),
    );
  if (source.kind === "unfiled") {
    await setBatch("parse_failed");
    return { outcome: "parse_failed", reason: "source_document_has_no_filed_version" };
  }

  // ── 2. Docling ───────────────────────────────────────────────────────────────────────────────────
  let pages: readonly DoclingPage[];
  const presign = () =>
    deps.presignSource({
      organizationId: org,
      bucket: deriveTenantBucket(org),
      objectKey: source.objectKey,
    });
  try {
    const url = await presign();
    pages = (
      await deps.docling.parse({
        organizationId: org,
        jobId: job.batchId,
        sourceUrl: url,
        correlationId: job.correlationId,
      })
    ).pages;
  } catch (err) {
    if (err instanceof DoclingParseError && err.kind !== "unavailable") {
      await setBatch("parse_failed");
      return { outcome: "parse_failed", reason: err.kind };
    }
    throw err; // worker unavailable / storage error ⇒ BullMQ retries
  }
  await inOrg((tx) =>
    tx
      .update(BATCH)
      .set({
        status: "docling_complete",
        pageGeometry: pages.map((p) => ({ page: p.page, width: p.width, height: p.height })),
      })
      .where(eq(BATCH.id, job.batchId))
      .then(() => undefined),
  );

  // ── 2a. F-238: records returned for an outbound request? The cover sheet's code on the first pages (or
  // the e-mail subject in source metadata) files an unfiled batch under the request's referral. Runs
  // BEFORE the identity check (step 6), which then compares the documents against that prospect. A batch
  // already filed elsewhere is never moved: the summary carries the warning instead.
  const recordsRequest = await inOrg((tx) =>
    matchInboundRecordsRequest(tx, {
      organizationId: org,
      batchId: job.batchId,
      pageTexts: pages.map(pageText),
    }),
  );

  // ── 2b. SUD detection over every page (§7.4 W4 step 1) — rules always, the model when it may run ──
  const sudIndicators: SudIndicator[] = detectSudIndicators(pages);
  const sudRefs = [SUD_RULESET_VERSION];
  const refusalsEarly: string[] = [];
  if (deps.sudDetector) {
    const r = await deps.sudDetector().detect({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: source.documentId,
      extractedText: "",
      pages: pages.map((p) => ({ page: p.page, text: pageText(p) })),
    });
    if (!r.available) {
      refusalsEarly.push(`sud_detect: ${r.detail ?? "refused"}`);
    } else {
      sudRefs.push(`ai_invocation:${r.invocationId}`);
      for (const i of r.indicators) {
        // A model indicator counts only when its quote is really on the page it names.
        const g = groundQuote(pages, { page: i.pageNumber, quote: i.snippet, value: i.snippet });
        if (!g.grounded) continue;
        sudIndicators.push({
          page: g.page,
          category: (SUD_CATEGORIES.has(i.category)
            ? i.category
            : "social_history") as SudIndicatorCategory,
          ruleId: `ai:${i.category}`,
          term: i.snippet,
          bbox: g.bbox,
        });
      }
    }
  }
  const sudPages = new Set(sudIndicators.map((i) => i.page));

  // ── 3. classify each page ────────────────────────────────────────────────────────────────────────
  const refusals: string[] = [...refusalsEarly];
  const classified: ClassifiedPage[] = [];
  const classifierRef = new Map<number, string>();
  for (const p of pages) {
    const r = await deps.classifier().classify({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: source.documentId,
      extractedText: pageText(p),
      pageCount: pages.length,
      pageNumber: p.page,
    });
    if (!r.available) {
      refusals.push(`classify p${p.page}: ${r.detail ?? "refused"}`);
      classified.push(
        ...classifyPages(
          [{ pageNumber: p.page, documentType: "unknown", confidence: 0 }],
          deps.confidenceFloor,
        ),
      );
      classifierRef.set(p.page, "refused");
      continue;
    }
    classified.push(
      ...classifyPages(
        [
          {
            pageNumber: p.page,
            documentType: r.documentType as ClassifiedPageDocType,
            confidence: r.confidence,
          },
        ],
        deps.confidenceFloor ?? DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
      ),
    );
    classifierRef.set(p.page, `ai_invocation:${r.invocationId}`);
  }

  // ── 4. extract each contiguous same-type run, ground, persist ───────────────────────────────────
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  let jobs = 0;
  let candidates = 0;
  let sudCandidates = 0;
  let anyAwaiting = false;
  const vision = { verified: 0, disagreed: 0, unverified: 0 };

  // ── 3b. split the fax into the documents inside it (F-238) ──────────────────────────────────────
  const segments = splitPacket(pages, classified);
  const segmentOf = (page: number) => segments.find((s) => s.pageNumbers.includes(page));

  // ── 3c. read the ICD-10-CM codes off the pages and check them (F-238) — deterministic, no model ──────
  // Codes come from the page, never from the extractor (AI Governance §2.1.1). Re-sent pages are skipped
  // so a duplicate never reads as a second, conflicting document.
  let scannedCodes: CodeOnPage[] = [];
  let codingFlags: CodingFlag[] = [];
  let codingStatus: "checked" | "icd10cm_not_loaded" | "not_configured" = "not_configured";
  const terminology = deps.codingTerminology?.();
  if (terminology) {
    if (!(await terminology.isLoaded())) {
      codingStatus = "icd10cm_not_loaded";
    } else {
      codingStatus = "checked";
      const original = pages.filter((p) => segmentOf(p.page)?.duplicateOfPage == null);
      const resolved = await resolveCodeTokens(findCodeTokens(original), terminology);
      scannedCodes = resolved.map((c) => ({
        ...c,
        blockBox: (original.find((p) => p.page === c.page)?.blocks[c.blockIndex]?.bbox ?? [
          0, 0, 0, 0,
        ]) as readonly [number, number, number, number],
      }));
      codingFlags = await runCodingChecks(
        {
          referenceDate: new Date().toISOString().slice(0, 10),
          pageText: new Map(original.map((p) => [p.page, pageText(p)])),
          codes: scannedCodes.map((c) => ({
            ...c,
            documentDate: segmentOf(c.page)?.documentDate ?? null,
            documentKey: segmentOf(c.page)?.pageNumbers[0] ?? c.page,
          })),
        },
        terminology,
      );
    }
  }

  for (const seg of segments) {
    const segmentRow = {
      organizationId: org,
      intakeUploadBatchId: job.batchId,
      sourceDocumentId: source.documentId,
      pageRangeStart: Math.min(...seg.pageNumbers),
      pageRangeEnd: Math.max(...seg.pageNumbers),
      documentType: seg.documentType,
      confidence: seg.confidence.toFixed(3),
      classifierModelVersionRef: classifierRef.get(seg.pageNumbers[0] as number) ?? "refused",
      documentTitle: seg.title,
      documentDate: seg.documentDate,
      duplicateOfPage: seg.duplicateOfPage,
      segmentBoundary: seg.boundary,
    };
    // A re-sent page, or a document that needs a human to classify it, gets its classified_page row (the
    // reviewer sees it) but no extraction job.
    if (seg.duplicateOfPage !== null || seg.needsHumanClassification) {
      await inOrg((tx) => tx.insert(CP).values(segmentRow));
      continue;
    }
    const run = seg;
    const runPages = pages.filter((p) => run.pageNumbers.includes(p.page));
    const docType = run.documentType as IntakeDocumentType;
    const schemaFields = findExtractionSchema(docType)?.fields ?? [];
    const pageId = await inOrg(async (tx) => {
      const [row] = await tx.insert(CP).values(segmentRow).returning({ id: CP.id });
      return (row as { id: string }).id;
    });

    const result = await deps.extractor().extract({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: source.documentId,
      documentType: docType,
      extractedText: "",
      schemaKey: SCHEMA_KEY,
      // `page_scan` fields (ICD-10-CM codes) are never asked of a model.
      fieldSpecs: schemaFields
        .filter((f) => f.source !== "page_scan")
        .map((f) => ({ fieldPath: f.fieldPath, description: f.description })),
      pages: runPages.map((p) => ({ page: p.page, text: pageText(p) })),
    });
    jobs += 1;
    if (!result.available) {
      anyAwaiting = true;
      refusals.push(
        `extract ${docType} p${run.pageNumbers.join(",")}: ${result.detail ?? "refused"}`,
      );
      await inOrg((tx) =>
        tx.insert(EJ).values({
          organizationId: org,
          classifiedPageId: pageId,
          documentType: docType,
          status: "awaiting_capability",
          extractorModelVersionRef: "refused",
          failureReason: (result.detail ?? "refused").slice(0, 500),
          correlationId: job.correlationId,
        }),
      );
      continue;
    }

    const extractorRef = `ai_invocation:${result.invocationId}`;
    const accepted: Array<{
      fieldPath: string;
      riskLevel: "low" | "medium" | "high";
      value: string;
      confidence: number;
      page: number;
      bbox: readonly [number, number, number, number];
      codingFlags?: readonly CodingFlag[];
    }> = [];
    // F-238 — diagnoses are collected, then joined with the page-scanned codes below.
    const dxWording: GroundedDiagnosis[] = [];
    const dxRoles = new Map<number, string>();
    for (const [fieldPath, f] of Object.entries(result.fields)) {
      const spec = findExtractionField(docType, fieldPath);
      if (!spec) {
        drop("field_not_in_schema");
        continue;
      }
      if (spec.source === "page_scan") {
        drop("model_supplied_code"); // a code is only ever what the page says
        continue;
      }
      const dx = /^diagnoses\[(\d+)\]\.(description|role)$/.exec(fieldPath);
      if (dx?.[2] === "role") {
        // The role is the document's LABEL for a diagnosis, not a quotable value; it rides on its
        // description's grounding and is normalised to the four labels.
        if (typeof f.value === "string") dxRoles.set(Number(dx[1]), normaliseRole(f.value));
        continue;
      }
      if (typeof f.value !== "string" || !f.sourceQuote) {
        drop("no_quote");
        continue;
      }
      const g = groundQuote(runPages, {
        page: f.sourceQuote.page,
        quote: f.sourceQuote.text,
        value: f.value,
      });
      if (!g.grounded) {
        drop(g.reason);
        continue;
      }
      if (dx) {
        dxWording.push({
          index: Number(dx[1]),
          description: f.value,
          role: null,
          page: g.page,
          bbox: g.bbox,
          confidence: f.confidence,
        });
        continue;
      }
      accepted.push({
        fieldPath,
        riskLevel: spec.riskLevel,
        value: f.value,
        confidence: f.confidence,
        page: g.page,
        bbox: g.bbox,
      });
    }
    if (findExtractionField(docType, "diagnoses[0].description")) {
      for (const d of attachCodesToDiagnoses({
        diagnoses: dxWording.map((d) => ({ ...d, role: dxRoles.get(d.index) ?? null })),
        codes: scannedCodes.filter((c) => c.code !== null && run.pageNumbers.includes(c.page)),
        flags: codingFlags,
      })) {
        const spec = findExtractionField(docType, d.fieldPath);
        if (!spec) continue;
        accepted.push({
          fieldPath: d.fieldPath,
          riskLevel: spec.riskLevel,
          value: d.value,
          confidence: d.confidence,
          page: d.page,
          bbox: d.bbox,
          ...(d.codingFlags ? { codingFlags: d.codingFlags } : {}),
        });
      }
    }

    // ── 5. stage 5: re-read each high/medium-risk value from a crop of its page (F-237) ─────────────
    const checks = await Promise.all(
      accepted.map(async (a) => {
        if (!VISION_VERIFIED_RISK_LEVELS.has(a.riskLevel)) return { kind: "not_required" as const };
        if (!deps.visionVerifier) return { kind: "unverified" as const };
        return verifyByVision(a, docType);
      }),
    );
    for (const c of checks) {
      if (c.kind === "verified") vision.verified += 1;
      else if (c.kind === "disagreed") vision.disagreed += 1;
      else if (c.kind === "unverified") vision.unverified += 1;
    }
    const visionRef = checks.find((c) => "invocationId" in c && c.invocationId);
    const encrypted = await Promise.all(accepted.map((a) => deps.cipher.encrypt(org, a.value)));
    const flagCiphers = await Promise.all(
      accepted.map((a) =>
        a.codingFlags?.length ? deps.cipher.encrypt(org, JSON.stringify(a.codingFlags)) : null,
      ),
    );
    const disagreements = await Promise.all(
      checks.map((c) =>
        c.kind === "disagreed"
          ? deps.cipher.encrypt(org, JSON.stringify({ observedValue: c.observedValue }))
          : null,
      ),
    );
    await inOrg(async (tx) => {
      const [ej] = await tx
        .insert(EJ)
        .values({
          organizationId: org,
          classifiedPageId: pageId,
          documentType: docType,
          status: "ready_for_review",
          extractorModelVersionRef: extractorRef,
          visionVerifierModelVersionRef:
            visionRef && "invocationId" in visionRef
              ? `ai_invocation:${visionRef.invocationId}`
              : null,
          aggregateConfidence: accepted.length
            ? (accepted.reduce((s, a) => s + a.confidence, 0) / accepted.length).toFixed(3)
            : null,
          correlationId: job.correlationId,
          completedAt: new Date(),
        })
        .returning({ id: EJ.id });
      const jobId = (ej as { id: string }).id;
      for (const [i, a] of accepted.entries()) {
        await tx.insert(EC).values({
          organizationId: org,
          extractionJobId: jobId,
          fieldPath: a.fieldPath,
          fieldKind: "text",
          riskLevel: a.riskLevel,
          valueCipher: encrypted[i] as string,
          confidence: a.confidence.toFixed(3),
          sourcePage: a.page,
          sourceBoundingBox: { x1: a.bbox[0], y1: a.bbox[1], x2: a.bbox[2], y2: a.bbox[3] },
          visionVerified: checks[i]?.kind === "verified",
          visionDisagreement: disagreements[i] ?? null,
          sudDetected: sudPages.has(a.page),
          codingFlagsCipher: flagCiphers[i] ?? null,
        });
      }
    });
    candidates += accepted.length;
    sudCandidates += accepted.filter((a) => sudPages.has(a.page)).length;
  }

  // ── 6. completion + the W4 SUD record, in ONE transaction (status, evidence, event) ──────────────
  const finalStatus =
    anyAwaiting && candidates === 0 ? "classifier_complete" : "extraction_complete";
  const sudEvidence =
    sudIndicators.length > 0
      ? await deps.cipher.encrypt(
          org,
          JSON.stringify(
            sudIndicators.map((i) => ({
              page: i.page,
              category: i.category,
              ruleId: i.ruleId,
              term: i.term,
              bbox: i.bbox,
            })),
          ),
        )
      : null;
  if (sudEvidence !== null && !deps.outbox) {
    // A detection M5 never hears about is a Part 2 flag that silently does not exist. Retry instead.
    throw new DegradedError("doclens-intake", "SUD indicators found but no outbox is bound");
  }
  await inOrg(async (tx) => {
    const updated = await tx
      .update(BATCH)
      .set({
        status: finalStatus,
        sudDetectorRef: sudRefs.join("+"),
        ...(sudEvidence !== null
          ? { sudStatus: "detected" as const, sudEvidenceCipher: sudEvidence }
          : {}),
      })
      .where(and(eq(BATCH.id, job.batchId), eq(BATCH.sudStatus, "not_detected")))
      .returning({ id: BATCH.id });
    if (sudEvidence === null || updated.length === 0) {
      if (updated.length === 0) {
        // Already resolved/detected by an earlier run: keep that state, just finish the batch.
        await tx.update(BATCH).set({ status: finalStatus }).where(eq(BATCH.id, job.batchId));
      }
      return;
    }
    // The batch's patient NOW: a records-request match (step 2a) may have filed it since `source` was read.
    const [filed] = await tx
      .select({ patientId: BATCH.patientId })
      .from(BATCH)
      .where(eq(BATCH.id, job.batchId));
    const payload: IntakeSudDetectedPayload = {
      intakeBatchId: job.batchId,
      patientId: filed?.patientId ?? null,
      candidateCount: sudCandidates,
      suggestedSudKind: dominantSudCategory(sudIndicators),
      pages: [...sudPages].sort((x, y) => x - y),
    };
    await (deps.outbox as ExtractionOutboxPort).publish(tx, {
      eventName: M22_INTAKE_SUD_DETECTED_EVENT,
      payload: { ...payload, organizationId: org },
      organizationId: org,
      aggregateKind: "intake_upload_batch",
      aggregateId: job.batchId,
    });
  });
  // ── 6. F-238: is every document about the patient (or referral) this fax is filed under? ───────────
  const identity = deps.identityTargets
    ? (
        await inOrg((tx) =>
          refreshBatchIdentity(
            tx,
            {
              cipher: deps.cipher,
              ports: deps.identityTargets as IdentityTargetPorts,
              ...(deps.outbox ? { outbox: deps.outbox } : {}),
            },
            org,
            job.batchId,
          ),
        )
      ).status
    : ("not_configured" as const);
  return {
    outcome: anyAwaiting && candidates === 0 ? "awaiting_capability" : "extracted",
    pages: pages.length,
    jobs,
    candidates,
    dropped,
    refusals,
    vision,
    sud: { indicators: sudIndicators.length, pages: [...sudPages].sort((x, y) => x - y) },
    identity,
    recordsRequest,
    documents: segments.length,
    coding: {
      status: codingStatus,
      codes: scannedCodes.filter((c) => c.code !== null).length,
      repaired: scannedCodes.filter((c) => c.repaired).length,
      flags: codingFlags.length,
      unreadable: codingFlags.filter((f) => f.kind === "unreadable_code").length,
    },
  };

  /** Stage 5 for one value: render a padded crop of its box and ask the model to read the field. */
  async function verifyByVision(
    a: {
      fieldPath: string;
      value: string;
      page: number;
      bbox: readonly [number, number, number, number];
    },
    docType: IntakeDocumentType,
  ): Promise<
    | { kind: "verified"; invocationId: string }
    | { kind: "disagreed"; invocationId: string; observedValue: string }
    | { kind: "unverified"; invocationId?: string }
  > {
    const spec = findExtractionField(docType, a.fieldPath);
    const geometry = pages.find((p) => p.page === a.page);
    if (!spec || !geometry || !deps.visionVerifier) return { kind: "unverified" };
    let png: Uint8Array;
    try {
      png = (
        await deps.docling.render({
          organizationId: org,
          jobId: job.batchId,
          sourceUrl: await presign(),
          correlationId: job.correlationId,
          page: a.page,
          scale: CROP_SCALE,
          crop: [
            Math.max(0, a.bbox[0] - CROP_PAD_X),
            Math.max(0, a.bbox[1] - CROP_PAD_Y),
            Math.min(geometry.width, a.bbox[2] + CROP_PAD_X),
            Math.min(geometry.height, a.bbox[3] + CROP_PAD_Y),
          ],
        })
      ).png;
    } catch {
      return { kind: "unverified" }; // a render failure costs the check, never the extraction
    }
    const r = await deps.visionVerifier().verify({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: (source as { documentId: string }).documentId,
      verificationKey: "field_value",
      images: [
        {
          pageNumber: a.page,
          mediaType: "image/png",
          dataBase64: Buffer.from(png).toString("base64"),
        },
      ],
      field: { fieldPath: a.fieldPath, description: spec.description },
    });
    if (!r.available) {
      refusals.push(`vision ${a.fieldPath}: ${r.detail ?? "refused"}`);
      return { kind: "unverified" };
    }
    const readings = r.observedValues?.length
      ? r.observedValues
      : r.observedValue
        ? [r.observedValue]
        : [];
    if (r.verdict !== "pass" || readings.length === 0) {
      return { kind: "unverified", invocationId: r.invocationId };
    }
    return readings.some((o) => visionReadingAgrees(a.value, o))
      ? { kind: "verified", invocationId: r.invocationId }
      : {
          kind: "disagreed",
          invocationId: r.invocationId,
          observedValue: closestReading(a.value, readings),
        };
  }
}

const SUD_CATEGORIES: ReadonlySet<string> = new Set([
  "medication",
  "diagnosis",
  "social_history",
  "treatment_setting",
]);
