// apps/backend/src/modules/22-documents/extraction/intake-job.ts — the DocLens intake JOB: one uploaded
// batch through stages 2–4 of §7.1 W1, persisted for review (F-236, ADR-0048).
//
//   source document (MinIO) ──presigned GET──▶ docling-worker  (stage 2: OCR + layout + boxes)
//     ──per page──▶ M32 DocLensClassifier                       (stage 3: document type)
//     ──per same-type run──▶ M32 DocLensExtractor               (stage 4: value + verbatim quote + page)
//     ──▶ groundQuote against Docling's text                    (the box is always Docling's)
//     ──▶ classified_page / extraction_job / extraction_candidate (value DEK-encrypted)
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
import { type DbClient, schema } from "@wardenx/db";
import {
  type ClassifiedPage,
  DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
  type IntakeDocumentType,
  classifyPages,
  findExtractionField,
  findExtractionSchema,
  groundQuote,
  groupContiguousRuns,
} from "@wardenx/intake-extraction";
import { withOrgContext } from "@wardenx/tenancy";
import type { ClassifiedPageDocType } from "@wardenx/types";
import { eq } from "drizzle-orm";
import { deriveTenantBucket } from "../lifecycle/storage";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import { type DoclingClient, type DoclingPage, DoclingParseError } from "./docling-client";

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
  readonly confidenceFloor?: number;
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
    };

const SCHEMA_KEY = "doclens_v1";
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
      .select({ status: BATCH.status, documentId: BATCH.initialDocumentId })
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
      ? { kind: "ok" as const, documentId: b.documentId, objectKey: d.objectKey }
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
  try {
    const url = await deps.presignSource({
      organizationId: org,
      bucket: deriveTenantBucket(org),
      objectKey: source.objectKey,
    });
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
  await setBatch("docling_complete");

  // ── 3. classify each page ────────────────────────────────────────────────────────────────────────
  const refusals: string[] = [];
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
  let anyAwaiting = false;

  // Pages that need a human (unknown / below the floor) still get a classified_page row, so the
  // reviewer sees them; they form no extraction job.
  for (const page of classified.filter((c) => c.needsHumanClassification)) {
    await inOrg((tx) =>
      tx.insert(CP).values({
        organizationId: org,
        intakeUploadBatchId: job.batchId,
        sourceDocumentId: source.documentId,
        pageRangeStart: page.pageNumber,
        pageRangeEnd: page.pageNumber,
        documentType: page.documentType,
        confidence: page.confidence.toFixed(3),
        classifierModelVersionRef: classifierRef.get(page.pageNumber) ?? "refused",
      }),
    );
  }

  for (const run of groupContiguousRuns(classified)) {
    const runPages = pages.filter((p) => run.pageNumbers.includes(p.page));
    const runConfidence = Math.min(
      ...classified.filter((c) => run.pageNumbers.includes(c.pageNumber)).map((c) => c.confidence),
    );
    const docType = run.documentType as IntakeDocumentType;
    const schemaFields = findExtractionSchema(docType)?.fields ?? [];
    const pageId = await inOrg(async (tx) => {
      const [row] = await tx
        .insert(CP)
        .values({
          organizationId: org,
          intakeUploadBatchId: job.batchId,
          sourceDocumentId: source.documentId,
          pageRangeStart: Math.min(...run.pageNumbers),
          pageRangeEnd: Math.max(...run.pageNumbers),
          documentType: docType,
          confidence: runConfidence.toFixed(3),
          classifierModelVersionRef: classifierRef.get(run.pageNumbers[0] as number) ?? "refused",
        })
        .returning({ id: CP.id });
      return (row as { id: string }).id;
    });

    const result = await deps.extractor().extract({
      organizationId: org,
      actorUserId: job.actorUserId,
      documentId: source.documentId,
      documentType: docType,
      extractedText: "",
      schemaKey: SCHEMA_KEY,
      fieldSpecs: schemaFields.map((f) => ({ fieldPath: f.fieldPath, description: f.description })),
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
    }> = [];
    for (const [fieldPath, f] of Object.entries(result.fields)) {
      const spec = findExtractionField(docType, fieldPath);
      if (!spec) {
        drop("field_not_in_schema");
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
      accepted.push({
        fieldPath,
        riskLevel: spec.riskLevel,
        value: f.value,
        confidence: f.confidence,
        page: g.page,
        bbox: g.bbox,
      });
    }

    const encrypted = await Promise.all(accepted.map((a) => deps.cipher.encrypt(org, a.value)));
    await inOrg(async (tx) => {
      const [ej] = await tx
        .insert(EJ)
        .values({
          organizationId: org,
          classifiedPageId: pageId,
          documentType: docType,
          status: "ready_for_review",
          extractorModelVersionRef: extractorRef,
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
          // Vision verification (stage 5) and the SUD detector are not run in this build: a high-risk
          // value is therefore NOT vision-verified, and says so.
          visionVerified: false,
          sudDetected: false,
        });
      }
    });
    candidates += accepted.length;
  }

  await setBatch(anyAwaiting && candidates === 0 ? "classifier_complete" : "extraction_complete");
  return {
    outcome: anyAwaiting && candidates === 0 ? "awaiting_capability" : "extracted",
    pages: pages.length,
    jobs,
    candidates,
    dropped,
    refusals,
  };
}
