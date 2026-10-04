// apps/backend/src/modules/22-documents/extraction/review-workspace.ts — the server half of the DocLens
// side-by-side review screen (§5.1 INTAKE.ReviewSideBySide; F-237).
//
//   listQueue        the intake work queue: batches with their pipeline status, SUD state and candidate
//                    counts (no values).
//   getWorkspace     ONE batch for review: page geometry + classification, every candidate with its
//                    DEK-decrypted value, box, risk tier, stage-5 outcome and SUD tag, the open review and
//                    its decisions, and the decrypted SUD evidence. PHI — the route read-audits it.
//   renderPage       one page image (docling-worker /render), for the overlay. PHI — read-audited.
//   resolveSud       W4 step 6: a licensed reviewer confirms or rejects a detection; the event to M5 is
//                    published in the same transaction as the batch update.
//
// Every query runs under `withOrgContext` (RLS); a batch of another tenant is a 404. Values are decrypted
// here and only here, for the person reviewing them — never logged, never put on an outbox payload.
import { type DbClient, schema } from "@wardenx/db";
import { type IntakeDocumentType, findExtractionField } from "@wardenx/intake-extraction";
import { withOrgContext } from "@wardenx/tenancy";
import {
  DOCLENS_M5_WRITEBACK_FIELDS,
  DegradedError,
  type IntakeSudResolvedPayload,
  M22_INTAKE_SUD_CONFIRMED_EVENT,
  M22_INTAKE_SUD_REJECTED_EVENT,
  NotFoundError,
  WardenXError,
} from "@wardenx/types";
import { and, desc, eq, inArray } from "drizzle-orm";
import { deriveTenantBucket } from "../lifecycle/storage";
import { type CursorPage, paginate } from "../routes/concurrency";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import type { DoclingClient } from "./docling-client";
import { VISION_VERIFIED_RISK_LEVELS } from "./intake-job";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const BATCH = schema.intakeUploadBatches;
const DOC = schema.documents;
const DV = schema.documentVersions;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;
const ER = schema.extractionReviews;
const ED = schema.extractionDecisions;

/** The §5.1 classifier floor the screen highlights (a page below it needs a human label). */
const LOW_CONFIDENCE = 0.75;
const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

export type SudStatus = "not_detected" | "detected" | "confirmed" | "rejected";
export type VisionStatus = "not_required" | "verified" | "disagreed" | "unverified";

export interface ReviewQueueItem {
  readonly id: string;
  readonly createdAt: string;
  readonly status: string;
  readonly sourceChannel: string;
  readonly patientId: string | null;
  readonly patientName: string | null;
  readonly sudStatus: SudStatus;
  readonly candidates: {
    readonly total: number;
    readonly lowConfidence: number;
    readonly highRisk: number;
    readonly visionDisagreed: number;
  };
  readonly review: {
    readonly id: string;
    readonly status: string;
    readonly decided: number;
  } | null;
}

export interface WorkspaceCandidate {
  readonly id: string;
  readonly jobId: string;
  readonly documentType: string;
  readonly fieldPath: string;
  readonly description: string | null;
  readonly riskLevel: "low" | "medium" | "high";
  readonly confidence: number;
  /** The extracted value, decrypted for the reviewer. `null` only if the server holds no key. */
  readonly value: string | null;
  readonly page: number;
  readonly bbox: readonly [number, number, number, number];
  readonly vision: { readonly status: VisionStatus; readonly observedValue: string | null };
  readonly sudDetected: boolean;
  /** F-235 allowlist + low risk: what completion would write to the chart (after approval). */
  readonly writebackTarget: boolean;
  readonly decision: {
    readonly id: string;
    readonly decision: string;
    readonly editedValue: string | null;
    readonly reason: string | null;
    readonly partOfBulkApprove: boolean;
    readonly decidedAt: string;
  } | null;
}

export interface ReviewWorkspace {
  readonly batch: {
    readonly id: string;
    readonly status: string;
    readonly sourceChannel: string;
    readonly uploadedAt: string;
    readonly documentId: string;
    readonly patientId: string | null;
    readonly patientName: string | null;
  };
  readonly sud: {
    readonly status: SudStatus;
    readonly detectorRef: string | null;
    readonly resolvedAt: string | null;
    readonly resolvedByMembershipId: string | null;
    readonly indicators: readonly {
      readonly page: number;
      readonly category: string;
      readonly ruleId: string;
      readonly term: string;
      readonly bbox: readonly [number, number, number, number];
    }[];
  };
  readonly pages: readonly {
    readonly page: number;
    readonly width: number;
    readonly height: number;
    readonly documentType: string | null;
    readonly confidence: number | null;
    readonly needsHumanClassification: boolean;
  }[];
  readonly jobs: readonly {
    readonly id: string;
    readonly documentType: string;
    readonly status: string;
    readonly pageFrom: number;
    readonly pageTo: number;
    readonly failureReason: string | null;
  }[];
  readonly review: {
    readonly id: string;
    readonly status: string;
    readonly reviewerMembershipId: string;
    readonly isMine: boolean;
  } | null;
  readonly candidates: readonly WorkspaceCandidate[];
}

export interface ReviewWorkspaceDeps {
  readonly db: DbClient;
  readonly cipher?: CandidateValueCipher;
  readonly outbox?: ExtractionOutboxPort;
  readonly docling?: DoclingClient;
  readonly presignSource?: (args: {
    organizationId: string;
    bucket: string;
    objectKey: string;
  }) => Promise<string>;
  /** "Last, First" for the header, via M5's PatientReader seam. Absent/failed ⇒ null. */
  readonly patientName?: (organizationId: string, patientId: string) => Promise<string | null>;
}

export interface ReviewWorkspaceService {
  listQueue(
    organizationId: string,
    q: { view: "open" | "done"; cursor?: string; limit?: number },
  ): Promise<CursorPage<ReviewQueueItem>>;
  getWorkspace(
    organizationId: string,
    batchId: string,
    viewerMembershipId: string,
  ): Promise<ReviewWorkspace>;
  renderPage(
    organizationId: string,
    batchId: string,
    page: number,
    correlationId: string,
  ): Promise<{ png: Uint8Array; pageWidth: number; pageHeight: number }>;
  resolveSud(
    organizationId: string,
    actor: { userId: string; membershipId: string },
    batchId: string,
    outcome: "confirmed" | "rejected",
    reason: string | null,
  ): Promise<{ batchId: string; sudStatus: SudStatus }>;
}

const OPEN_STATUSES = [
  "uploaded",
  "docling_complete",
  "classifier_complete",
  "extraction_complete",
  "in_review",
  "parse_failed",
] as const;
const DONE_STATUSES = ["writeback_complete", "discarded"] as const;

export function visionStatusOf(row: {
  riskLevel: string;
  visionVerified: boolean;
  visionDisagreement: string | null;
}): VisionStatus {
  if (!VISION_VERIFIED_RISK_LEVELS.has(row.riskLevel)) return "not_required";
  if (row.visionVerified) return "verified";
  if (row.visionDisagreement !== null) return "disagreed";
  return "unverified";
}

export function createReviewWorkspaceService(deps: ReviewWorkspaceDeps): ReviewWorkspaceService {
  const read = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, { organizationId, userId: "" }, (tx) => fn(tx as DbClient));
  const nameOf = async (organizationId: string, patientId: string | null) => {
    if (!patientId || !deps.patientName) return null;
    try {
      return await deps.patientName(organizationId, patientId);
    } catch {
      return null;
    }
  };
  const decrypt = async (organizationId: string, envelope: string | null) => {
    if (envelope === null || !deps.cipher) return null;
    return deps.cipher.decrypt(organizationId, envelope);
  };

  return {
    async listQueue(organizationId, q) {
      const rows = await read(organizationId, async (tx) => {
        const batches = await tx
          .select({
            id: BATCH.id,
            status: BATCH.status,
            sourceChannel: BATCH.sourceChannel,
            patientId: BATCH.patientId,
            sudStatus: BATCH.sudStatus,
            uploadedAt: BATCH.uploadedAt,
          })
          .from(BATCH)
          .where(inArray(BATCH.status, [...(q.view === "open" ? OPEN_STATUSES : DONE_STATUSES)]))
          .orderBy(desc(BATCH.uploadedAt), desc(BATCH.id))
          .limit(500);
        if (batches.length === 0) return [];
        const ids = batches.map((b) => b.id);
        const cands = await tx
          .select({
            batchId: CP.intakeUploadBatchId,
            riskLevel: EC.riskLevel,
            confidence: EC.confidence,
            visionDisagreement: EC.visionDisagreement,
          })
          .from(EC)
          .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
          .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
          .where(inArray(CP.intakeUploadBatchId, ids));
        const reviews = await tx
          .select({
            id: ER.id,
            batchId: ER.intakeUploadBatchId,
            status: ER.status,
            openedAt: ER.openedAt,
          })
          .from(ER)
          .where(inArray(ER.intakeUploadBatchId, ids))
          .orderBy(desc(ER.openedAt));
        const decisions = reviews.length
          ? await tx
              .select({ reviewId: ED.extractionReviewId })
              .from(ED)
              .where(
                inArray(
                  ED.extractionReviewId,
                  reviews.map((r) => r.id),
                ),
              )
          : [];
        return batches.map((b) => {
          const mine = cands.filter((c) => c.batchId === b.id);
          const review = reviews.find((r) => r.batchId === b.id) ?? null;
          return {
            b,
            counts: {
              total: mine.length,
              lowConfidence: mine.filter((c) => Number(c.confidence) < LOW_CONFIDENCE).length,
              highRisk: mine.filter((c) => c.riskLevel === "high").length,
              visionDisagreed: mine.filter((c) => c.visionDisagreement !== null).length,
            },
            review: review
              ? {
                  id: review.id,
                  status: String(review.status),
                  decided: decisions.filter((d) => d.reviewId === review.id).length,
                }
              : null,
          };
        });
      });
      const items: ReviewQueueItem[] = [];
      for (const r of rows) {
        items.push({
          id: r.b.id,
          createdAt: iso(r.b.uploadedAt) as string,
          status: String(r.b.status),
          sourceChannel: r.b.sourceChannel,
          patientId: r.b.patientId,
          patientName: await nameOf(organizationId, r.b.patientId),
          sudStatus: r.b.sudStatus,
          candidates: r.counts,
          review: r.review,
        });
      }
      return paginate(items, q.cursor, q.limit);
    },

    async getWorkspace(organizationId, batchId, viewerMembershipId) {
      const loaded = await read(organizationId, async (tx) => {
        const [b] = await tx.select().from(BATCH).where(eq(BATCH.id, batchId)).limit(1);
        if (!b) throw new NotFoundError("intake batch");
        const pages = await tx
          .select()
          .from(CP)
          .where(eq(CP.intakeUploadBatchId, batchId))
          .orderBy(CP.pageRangeStart);
        const pageIds = pages.map((p) => p.id);
        const jobs = pageIds.length
          ? await tx.select().from(EJ).where(inArray(EJ.classifiedPageId, pageIds))
          : [];
        const jobIds = jobs.map((j) => j.id);
        const cands = jobIds.length
          ? await tx.select().from(EC).where(inArray(EC.extractionJobId, jobIds))
          : [];
        const [review] = await tx
          .select()
          .from(ER)
          .where(eq(ER.intakeUploadBatchId, batchId))
          .orderBy(desc(ER.openedAt))
          .limit(1);
        const decisions = review
          ? await tx.select().from(ED).where(eq(ED.extractionReviewId, review.id))
          : [];
        return { b, pages, jobs, cands, review, decisions };
      });
      const { b, pages, jobs, cands, review, decisions } = loaded;

      const geometry = (Array.isArray(b.pageGeometry) ? b.pageGeometry : []) as {
        page: number;
        width: number;
        height: number;
      }[];
      const pageRows = geometry.map((g) => {
        const cp = pages.find((p) => p.pageRangeStart <= g.page && p.pageRangeEnd >= g.page);
        const confidence = cp ? Number(cp.confidence) : null;
        return {
          page: g.page,
          width: g.width,
          height: g.height,
          documentType: cp ? String(cp.documentType) : null,
          confidence,
          needsHumanClassification:
            !cp ||
            (!cp.humanConfirmed &&
              (cp.documentType === "unknown" || (confidence ?? 0) < LOW_CONFIDENCE)),
        };
      });

      const jobById = new Map(jobs.map((j) => [j.id, j]));
      const pageOfJob = (jobId: string) => {
        const j = jobById.get(jobId);
        return j ? pages.find((p) => p.id === j.classifiedPageId) : undefined;
      };
      const candidates: WorkspaceCandidate[] = [];
      for (const c of cands) {
        const job = jobById.get(c.extractionJobId);
        const docType = String(job?.documentType ?? "unknown");
        const spec =
          docType === "unknown"
            ? undefined
            : findExtractionField(docType as IntakeDocumentType, c.fieldPath);
        const box = c.sourceBoundingBox as { x1: number; y1: number; x2: number; y2: number };
        const d = decisions.find((x) => x.extractionCandidateId === c.id);
        const disagreement = await decrypt(organizationId, c.visionDisagreement);
        candidates.push({
          id: c.id,
          jobId: c.extractionJobId,
          documentType: docType,
          fieldPath: c.fieldPath,
          description: spec?.description ?? null,
          riskLevel: c.riskLevel,
          confidence: Number(c.confidence),
          value: c.valueCipher ? await decrypt(organizationId, c.valueCipher) : c.valueText,
          page: c.sourcePage,
          bbox: [box.x1, box.y1, box.x2, box.y2],
          vision: {
            status: visionStatusOf(c),
            observedValue: disagreement
              ? ((JSON.parse(disagreement) as { observedValue?: string }).observedValue ?? null)
              : null,
          },
          sudDetected: c.sudDetected,
          writebackTarget:
            Object.hasOwn(DOCLENS_M5_WRITEBACK_FIELDS, c.fieldPath) && c.riskLevel === "low",
          decision: d
            ? {
                id: d.id,
                decision: String(d.decision),
                editedValue: d.editedValue,
                reason: d.reason,
                partOfBulkApprove: d.partOfBulkApprove,
                decidedAt: iso(d.decidedAt) as string,
              }
            : null,
        });
      }
      candidates.sort(
        (x, y) =>
          x.page - y.page || x.bbox[1] - y.bbox[1] || x.fieldPath.localeCompare(y.fieldPath),
      );

      const evidence = await decrypt(organizationId, b.sudEvidenceCipher);
      return {
        batch: {
          id: b.id,
          status: String(b.status),
          sourceChannel: b.sourceChannel,
          uploadedAt: iso(b.uploadedAt) as string,
          documentId: b.initialDocumentId,
          patientId: b.patientId,
          patientName: await nameOf(organizationId, b.patientId),
        },
        sud: {
          status: b.sudStatus,
          detectorRef: b.sudDetectorRef,
          resolvedAt: iso(b.sudResolvedAt),
          resolvedByMembershipId: b.sudResolvedByMembershipId,
          indicators: evidence
            ? (JSON.parse(evidence) as ReviewWorkspace["sud"]["indicators"])
            : [],
        },
        pages: pageRows,
        jobs: jobs.map((j) => {
          const cp = pageOfJob(j.id);
          return {
            id: j.id,
            documentType: String(j.documentType),
            status: String(j.status),
            pageFrom: cp?.pageRangeStart ?? 0,
            pageTo: cp?.pageRangeEnd ?? 0,
            failureReason: j.failureReason,
          };
        }),
        review: review
          ? {
              id: review.id,
              status: String(review.status),
              reviewerMembershipId: review.reviewerMembershipId,
              isMine: review.reviewerMembershipId === viewerMembershipId,
            }
          : null,
        candidates,
      };
    },

    async renderPage(organizationId, batchId, page, correlationId) {
      if (!deps.docling || !deps.presignSource) {
        throw new DegradedError("doclens-render", "no docling-worker / object store is configured");
      }
      const source = await read(organizationId, async (tx) => {
        const [row] = await tx
          .select({ objectKey: DV.minioObjectKey, geometry: BATCH.pageGeometry })
          .from(BATCH)
          .innerJoin(DOC, eq(DOC.id, BATCH.initialDocumentId))
          .innerJoin(DV, eq(DV.id, DOC.activeVersionId))
          .where(eq(BATCH.id, batchId))
          .limit(1);
        return row ?? null;
      });
      if (!source) throw new NotFoundError("intake batch");
      const geometry = (Array.isArray(source.geometry) ? source.geometry : []) as {
        page: number;
      }[];
      if (!geometry.some((g) => g.page === page)) throw new NotFoundError("page");
      const url = await deps.presignSource({
        organizationId,
        bucket: deriveTenantBucket(organizationId),
        objectKey: source.objectKey,
      });
      return deps.docling.render({
        organizationId,
        jobId: batchId,
        sourceUrl: url,
        correlationId,
        page,
        scale: 2,
      });
    },

    async resolveSud(organizationId, actor, batchId, outcome, reason) {
      if (outcome === "rejected" && !reason) {
        throw new WardenXError(
          "SUD_REJECTION_REASON_REQUIRED",
          "rejecting a SUD detection as a false positive needs a reason",
          422,
        );
      }
      return withOrgContext(deps.db, { organizationId, userId: actor.userId }, async (scoped) => {
        const tx = scoped as DbClient;
        const [b] = await tx
          .select({ id: BATCH.id, patientId: BATCH.patientId, sudStatus: BATCH.sudStatus })
          .from(BATCH)
          .where(eq(BATCH.id, batchId))
          .for("update");
        if (!b) throw new NotFoundError("intake batch");
        // Idempotent: the same resolution again is a no-op (a double click, a retried request).
        if (b.sudStatus === outcome) return { batchId, sudStatus: b.sudStatus };
        if (b.sudStatus !== "detected") {
          throw new WardenXError(
            "SUD_NOT_PENDING",
            `this batch's SUD state is '${b.sudStatus}'; only a pending detection can be resolved`,
            409,
          );
        }
        if (!deps.outbox) {
          throw new DegradedError(
            "doclens-sud",
            "no outbox is bound for the M5 privacy-flag event",
          );
        }
        const now = new Date();
        await tx
          .update(BATCH)
          .set({
            sudStatus: outcome,
            sudResolvedByMembershipId: actor.membershipId,
            sudResolvedAt: now,
            sudResolutionReason: reason,
          })
          .where(and(eq(BATCH.id, batchId), eq(BATCH.sudStatus, "detected")));
        const payload: IntakeSudResolvedPayload = {
          intakeBatchId: batchId,
          patientId: b.patientId,
          resolvedByMembershipId: actor.membershipId,
        };
        await deps.outbox.publish(tx, {
          eventName:
            outcome === "confirmed"
              ? M22_INTAKE_SUD_CONFIRMED_EVENT
              : M22_INTAKE_SUD_REJECTED_EVENT,
          payload: { ...payload, organizationId, resolvedAt: now.toISOString() },
          organizationId,
          aggregateKind: "intake_upload_batch",
          aggregateId: batchId,
        });
        return { batchId, sudStatus: outcome };
      });
    },
  };
}
