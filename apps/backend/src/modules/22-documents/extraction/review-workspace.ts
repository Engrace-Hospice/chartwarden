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
import {
  type IdentityStatus,
  type IntakeDocumentType,
  findExtractionField,
  worstIdentity,
} from "@wardenx/intake-extraction";
import { withOrgContext } from "@wardenx/tenancy";
import {
  DOCLENS_M5_WRITEBACK_FIELDS,
  DegradedError,
  type IntakeSudResolvedPayload,
  M22_INTAKE_SUD_CONFIRMED_EVENT,
  M22_INTAKE_SUD_REJECTED_EVENT,
  NotFoundError,
  ChartWardenError,
} from "@wardenx/types";
import { and, desc, eq, inArray } from "drizzle-orm";
import { deriveTenantBucket } from "../lifecycle/storage";
import {
  type RecordsRequestConflictView,
  markReceivedOnArrival,
  recordsRequestConflicts,
} from "../records-request/inbound-match";
import { type CursorPage, paginate } from "../routes/concurrency";
import {
  type BatchIdentityStatus,
  type IdentityTargetPorts,
  otherBatchHoldsSudFlag,
  publishSudFlagMove,
  refreshBatchIdentity,
} from "./batch-identity";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import type { DoclingClient } from "./docling-client";
import { VISION_VERIFIED_RISK_LEVELS } from "./intake-job";
import {
  type SudContentAccess,
  type SudStatus,
  assertSudPageReadable,
  redactSudWorkspace,
  resolveSudContentAccess,
} from "./sud-content-gate";
import type { ExtractionOutboxPort } from "./writeback-commit-db";

const BATCH = schema.intakeUploadBatches;
const DOC = schema.documents;
const DV = schema.documentVersions;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;
const ER = schema.extractionReviews;
const ED = schema.extractionDecisions;
const RELINK = schema.intakeBatchRelinks;
const RR = schema.intakeRecordsRequests;

/** The §5.1 classifier floor the screen highlights (a page below it needs a human label). */
const LOW_CONFIDENCE = 0.75;
const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

export type { SudStatus };
export type VisionStatus = "not_required" | "verified" | "disagreed" | "unverified";

export interface ReviewQueueItem {
  readonly id: string;
  readonly createdAt: string;
  readonly status: string;
  readonly sourceChannel: string;
  readonly patientId: string | null;
  readonly patientName: string | null;
  readonly sudStatus: SudStatus;
  /** F-238 — a records-request code on the fax names another referral / patient (null = none). */
  readonly recordsRequestConflict: RecordsRequestConflictView | null;
  /**
   * F-238 — the batch's size, so two batches received the same day can be told apart: the last
   * classified page, and the documents the splitter found (re-sent duplicates excluded). Null until
   * the batch has been classified. Counts only — no content.
   */
  readonly pageCount: number | null;
  readonly documentCount: number | null;
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
  /** F-238 — the coding checks on a `diagnoses[n].icd10` candidate (decrypted); empty otherwise. */
  readonly codingFlags: readonly {
    readonly kind: string;
    readonly code: string;
    readonly suggest: readonly string[];
    readonly detail: string;
  }[];
  /** F-235 allowlist + low risk: what completion would write to the chart (after approval). */
  readonly writebackTarget: boolean;
  /** GAP-067 — a SUD-detected candidate whose value / evidence was withheld from THIS viewer. */
  readonly redacted: boolean;
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
    readonly referralId: string | null;
    readonly identityStatus: BatchIdentityStatus | null;
    /** F-238 — a records-request code on the fax names another referral / patient (null = none). */
    readonly recordsRequestConflict: RecordsRequestConflictView | null;
  };
  readonly sud: {
    readonly status: SudStatus;
    readonly detectorRef: string | null;
    readonly resolvedAt: string | null;
    readonly resolvedByMembershipId: string | null;
    /** GAP-067 — the SUD evidence and SUD-candidate values were withheld from THIS viewer. */
    readonly contentRedacted: boolean;
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
  /** F-238 — the documents the fax splitter found, in page order. */
  readonly documents: readonly {
    readonly pageFrom: number;
    readonly pageTo: number;
    readonly documentType: string;
    readonly title: string | null;
    readonly date: string | null;
    readonly duplicateOfPage: number | null;
    readonly boundary: string | null;
    readonly identity: {
      readonly status: "match" | "possible" | "mismatch" | "unverified" | null;
      readonly disagreeing: readonly string[];
      readonly resolution: "same_patient" | "other_patient" | null;
    };
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
  /** F-238 — the identity check's M5/M6 lookups + the caller's referral visibility (relink). */
  readonly identity?: {
    readonly ports: IdentityTargetPorts;
    readonly canAccessReferral: (
      organizationId: string,
      userId: string,
      referralId: string,
    ) => Promise<boolean>;
  };
}

export type IdentityResolution = "same_patient" | "other_patient";

export interface ReviewWorkspaceService {
  listQueue(
    organizationId: string,
    q: {
      view: "open" | "done";
      cursor?: string;
      limit?: number;
      /** Narrow to one patient's batches (the admission privacy dialog's "which fax flagged this"). */
      patientId?: string;
      sudStatus?: SudStatus;
    },
  ): Promise<CursorPage<ReviewQueueItem>>;
  /**
   * `sudAccess` is the caller's Part 2 need-to-know decision (GAP-067). OMITTED MEANS DENIED: SUD-detected
   * values and the SUD evidence come back redacted.
   */
  getWorkspace(
    organizationId: string,
    batchId: string,
    viewerMembershipId: string,
    sudAccess?: SudContentAccess,
  ): Promise<ReviewWorkspace>;
  /** A page of a Part 2 batch is a 403 unless `sudAccess` allows it (omitted ⇒ denied). */
  renderPage(
    organizationId: string,
    batchId: string,
    page: number,
    correlationId: string,
    sudAccess?: SudContentAccess,
  ): Promise<{ png: Uint8Array; pageWidth: number; pageHeight: number }>;
  resolveSud(
    organizationId: string,
    actor: { userId: string; membershipId: string },
    batchId: string,
    outcome: "confirmed" | "rejected",
    reason: string | null,
  ): Promise<{ batchId: string; sudStatus: SudStatus }>;
  /** F-238 — a reviewer's answer for one flagged document (`pageFrom` names it). */
  resolveIdentity(
    organizationId: string,
    actor: { userId: string; membershipId: string },
    batchId: string,
    pageFrom: number,
    resolution: IdentityResolution,
    reason: string,
  ): Promise<{
    batchId: string;
    pageFrom: number;
    resolution: IdentityResolution;
    identityStatus: BatchIdentityStatus;
  }>;
  /** F-238 — move a misfiled batch to another patient / referral before its review completes. */
  relink(
    organizationId: string,
    actor: { userId: string; membershipId: string },
    batchId: string,
    to: { patientId: string | null; referralId: string | null; reason: string },
    correlationId: string,
  ): Promise<{
    batchId: string;
    patientId: string | null;
    referralId: string | null;
    identityStatus: BatchIdentityStatus;
  }>;
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
            conflictId: BATCH.recordsRequestConflictId,
            conflictKind: BATCH.recordsRequestConflictKind,
          })
          .from(BATCH)
          .where(
            and(
              inArray(BATCH.status, [...(q.view === "open" ? OPEN_STATUSES : DONE_STATUSES)]),
              q.patientId ? eq(BATCH.patientId, q.patientId) : undefined,
              q.sudStatus ? eq(BATCH.sudStatus, q.sudStatus) : undefined,
            ),
          )
          .orderBy(desc(BATCH.uploadedAt), desc(BATCH.id))
          .limit(500);
        if (batches.length === 0) return [];
        const ids = batches.map((b) => b.id);
        const conflicts = await recordsRequestConflicts(tx, batches);
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
        const segments = await tx
          .select({
            batchId: CP.intakeUploadBatchId,
            pageRangeEnd: CP.pageRangeEnd,
            duplicateOfPage: CP.duplicateOfPage,
          })
          .from(CP)
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
          const segs = segments.filter((p) => p.batchId === b.id);
          return {
            b,
            conflict: conflicts.get(b.id) ?? null,
            pageCount: segs.length ? Math.max(...segs.map((p) => p.pageRangeEnd)) : null,
            documentCount: segs.length
              ? segs.filter((p) => p.duplicateOfPage === null).length
              : null,
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
          recordsRequestConflict: r.conflict,
          pageCount: r.pageCount,
          documentCount: r.documentCount,
          candidates: r.counts,
          review: r.review,
        });
      }
      return paginate(items, q.cursor, q.limit);
    },

    async getWorkspace(organizationId, batchId, viewerMembershipId, sudAccess) {
      // F-238 — records filed against a referral adopt its patient once M6 has resolved one, and are
      // re-checked against that patient (M22 writes only its own rows here).
      if (deps.identity && deps.cipher) {
        const identity = deps.identity;
        const cipher = deps.cipher;
        await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
          const tx = scoped as DbClient;
          const [b] = await tx
            .select({ patientId: BATCH.patientId, referralId: BATCH.referralId })
            .from(BATCH)
            .where(eq(BATCH.id, batchId))
            .limit(1);
          if (b && b.patientId === null && b.referralId !== null) {
            const subject = await identity.ports.referral?.(organizationId, b.referralId);
            if (subject?.patientId) {
              await refreshBatchIdentity(
                tx,
                { cipher, ports: identity.ports, ...(deps.outbox ? { outbox: deps.outbox } : {}) },
                organizationId,
                batchId,
              );
            }
          }
        });
      }
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
        const conflict =
          (
            await recordsRequestConflicts(tx, [
              {
                id: b.id,
                conflictId: b.recordsRequestConflictId,
                conflictKind: b.recordsRequestConflictKind,
              },
            ])
          ).get(b.id) ?? null;
        return { b, pages, jobs, cands, review, decisions, conflict };
      });
      const { b, pages, jobs, cands, review, decisions, conflict } = loaded;
      // GAP-067 — decided BEFORE any decryption, so a denied viewer's request never holds Part 2 plaintext.
      const sudAllowed = await resolveSudContentAccess(sudAccess, {
        sudStatus: b.sudStatus,
        patientId: b.patientId,
      });

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
        const withheld = !sudAllowed && c.sudDetected;
        const disagreement = withheld ? null : await decrypt(organizationId, c.visionDisagreement);
        const flagsJson = withheld ? null : await decrypt(organizationId, c.codingFlagsCipher);
        candidates.push({
          id: c.id,
          jobId: c.extractionJobId,
          documentType: docType,
          fieldPath: c.fieldPath,
          description: spec?.description ?? null,
          riskLevel: c.riskLevel,
          confidence: Number(c.confidence),
          value: withheld
            ? null
            : c.valueCipher
              ? await decrypt(organizationId, c.valueCipher)
              : c.valueText,
          page: c.sourcePage,
          bbox: [box.x1, box.y1, box.x2, box.y2],
          vision: {
            status: visionStatusOf(c),
            observedValue: disagreement
              ? ((JSON.parse(disagreement) as { observedValue?: string }).observedValue ?? null)
              : null,
          },
          sudDetected: c.sudDetected,
          codingFlags: flagsJson
            ? (JSON.parse(flagsJson) as WorkspaceCandidate["codingFlags"]).map((f) => ({
                kind: f.kind,
                code: f.code,
                suggest: [...f.suggest],
                detail: f.detail,
              }))
            : [],
          writebackTarget:
            Object.hasOwn(DOCLENS_M5_WRITEBACK_FIELDS, c.fieldPath) && c.riskLevel === "low",
          redacted: false,
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

      const evidence = sudAllowed ? await decrypt(organizationId, b.sudEvidenceCipher) : null;
      const workspace: ReviewWorkspace = {
        batch: {
          id: b.id,
          status: String(b.status),
          sourceChannel: b.sourceChannel,
          uploadedAt: iso(b.uploadedAt) as string,
          documentId: b.initialDocumentId,
          patientId: b.patientId,
          patientName: await nameOf(organizationId, b.patientId),
          referralId: b.referralId,
          identityStatus: (b.identityStatus ?? null) as BatchIdentityStatus | null,
          recordsRequestConflict: conflict,
        },
        sud: {
          status: b.sudStatus,
          detectorRef: b.sudDetectorRef,
          resolvedAt: iso(b.sudResolvedAt),
          resolvedByMembershipId: b.sudResolvedByMembershipId,
          contentRedacted: false,
          indicators: evidence
            ? (JSON.parse(evidence) as ReviewWorkspace["sud"]["indicators"])
            : [],
        },
        pages: pageRows,
        documents: pages.map((p) => ({
          pageFrom: p.pageRangeStart,
          pageTo: p.pageRangeEnd,
          documentType: String(p.documentType),
          title: p.documentTitle,
          date: p.documentDate ? String(p.documentDate) : null,
          duplicateOfPage: p.duplicateOfPage,
          boundary: p.segmentBoundary,
          identity: {
            status: (p.identityStatus ??
              null) as ReviewWorkspace["documents"][number]["identity"]["status"],
            disagreeing: p.identityDisagreeing ?? [],
            resolution: (p.identityResolution ?? null) as IdentityResolution | null,
          },
        })),
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
      // The redactor stamps `redacted` / `contentRedacted` and drops what the skipped decryption left behind
      // (decision text is plaintext on the decision row, not encrypted with the candidate).
      return sudAllowed ? workspace : redactSudWorkspace(workspace);
    },

    async renderPage(organizationId, batchId, page, correlationId, sudAccess) {
      const source = await read(organizationId, async (tx) => {
        const [row] = await tx
          .select({
            objectKey: DV.minioObjectKey,
            geometry: BATCH.pageGeometry,
            sudStatus: BATCH.sudStatus,
            patientId: BATCH.patientId,
          })
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
      // GAP-067 — the image is the whole source page, Part 2 content included. Refused BEFORE a presign or a
      // docling call, so a denied viewer costs the object store nothing and never holds a URL.
      assertSudPageReadable(
        source.sudStatus,
        await resolveSudContentAccess(sudAccess, {
          sudStatus: source.sudStatus,
          patientId: source.patientId,
        }),
      );
      if (!deps.docling || !deps.presignSource) {
        throw new DegradedError("doclens-render", "no docling-worker / object store is configured");
      }
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
        throw new ChartWardenError(
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
          throw new ChartWardenError(
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
          // A rejection retires the patient's DocLens flag only when no other batch of theirs still
          // carries a live detection (the same rule as a move).
          ...(outcome === "rejected" && b.patientId
            ? { patientRetainsFlag: await otherBatchHoldsSudFlag(tx, b.patientId, batchId) }
            : {}),
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

    async resolveIdentity(organizationId, actor, batchId, pageFrom, resolution, reason) {
      return withOrgContext(deps.db, { organizationId, userId: actor.userId }, async (scoped) => {
        const tx = scoped as DbClient;
        const [b] = await tx
          .select({ id: BATCH.id, status: BATCH.status })
          .from(BATCH)
          .where(eq(BATCH.id, batchId))
          .for("update");
        if (!b) throw new NotFoundError("intake batch");
        if (b.status === "writeback_complete" || b.status === "discarded") {
          throw new ChartWardenError(
            "BATCH_CLOSED",
            `this batch is ${b.status}; its documents can no longer be re-assigned`,
            409,
          );
        }
        const [doc] = await tx
          .select({
            id: CP.id,
            status: CP.identityStatus,
            resolution: CP.identityResolution,
          })
          .from(CP)
          .where(and(eq(CP.intakeUploadBatchId, batchId), eq(CP.pageRangeStart, pageFrom)))
          .limit(1);
        if (!doc) throw new NotFoundError("document in this fax");
        if (doc.status === null) {
          throw new ChartWardenError(
            "IDENTITY_NOT_CHECKED",
            "this document has no identity check to resolve (the batch has no patient or referral yet)",
            409,
          );
        }
        if (doc.resolution !== resolution) {
          await tx
            .update(CP)
            .set({
              identityResolution: resolution,
              identityResolvedByMembershipId: actor.membershipId,
              identityResolvedAt: new Date(),
              identityResolutionReason: reason,
            })
            .where(eq(CP.id, doc.id));
        }
        const identityStatus = await recomputeBatchIdentity(tx, batchId);
        return { batchId, pageFrom, resolution, identityStatus };
      });
    },

    async relink(organizationId, actor, batchId, to, correlationId) {
      const identity = deps.identity;
      if (!identity || !deps.cipher) {
        throw new DegradedError("doclens-relink", "the patient/referral lookups are not bound");
      }
      if (!to.patientId && !to.referralId) {
        throw new ChartWardenError(
          "RELINK_TARGET_REQUIRED",
          "name the patient and/or the referral this fax belongs to",
          422,
        );
      }
      // The referral must be one the caller can see; it fixes the patient once M6 has resolved it.
      let patientId = to.patientId;
      if (to.referralId) {
        if (!(await identity.canAccessReferral(organizationId, actor.userId, to.referralId))) {
          throw new NotFoundError("referral");
        }
        const subject = await identity.ports.referral?.(organizationId, to.referralId);
        if (!subject) throw new NotFoundError("referral");
        if (subject.patientId && patientId && subject.patientId !== patientId) {
          throw new ChartWardenError(
            "REFERRAL_PATIENT_CONFLICT",
            "this referral is resolved to a different patient than the one named",
            409,
          );
        }
        patientId = patientId ?? subject.patientId;
      }
      if (patientId && !(await identity.ports.patient(organizationId, patientId))) {
        throw new NotFoundError("patient");
      }
      const cipher = deps.cipher;
      return withOrgContext(deps.db, { organizationId, userId: actor.userId }, async (scoped) => {
        const tx = scoped as DbClient;
        const [b] = await tx
          .select({
            id: BATCH.id,
            status: BATCH.status,
            patientId: BATCH.patientId,
            referralId: BATCH.referralId,
            documentId: BATCH.initialDocumentId,
            sudStatus: BATCH.sudStatus,
            recordsRequestId: BATCH.recordsRequestId,
            conflictId: BATCH.recordsRequestConflictId,
          })
          .from(BATCH)
          .where(eq(BATCH.id, batchId))
          .for("update");
        if (!b) throw new NotFoundError("intake batch");
        if (b.status === "writeback_complete" || b.status === "discarded") {
          throw new ChartWardenError(
            "BATCH_CLOSED",
            `this batch is ${b.status}; what it wrote is corrected on the chart, not by moving the fax`,
            409,
          );
        }
        const [completed] = await tx
          .select({ id: ER.id })
          .from(ER)
          .where(and(eq(ER.intakeUploadBatchId, batchId), eq(ER.status, "complete")))
          .limit(1);
        if (completed) {
          throw new ChartWardenError("BATCH_CLOSED", "this batch's review is already complete", 409);
        }
        const referralId = to.referralId ?? b.referralId;
        if (patientId === b.patientId && referralId === b.referralId) {
          const [cur] = await tx
            .select({ s: BATCH.identityStatus })
            .from(BATCH)
            .where(eq(BATCH.id, batchId));
          return {
            batchId,
            patientId,
            referralId,
            identityStatus: (cur?.s ?? "no_target") as BatchIdentityStatus,
          };
        }
        await tx.update(BATCH).set({ patientId, referralId }).where(eq(BATCH.id, batchId));
        // F-238 — the fax carried a records-request code for another referral: moving it THERE resolves
        // the conflict — the batch now answers that request (which counts as received).
        if (b.conflictId && !b.recordsRequestId && referralId) {
          const [req] = await tx
            .select({ referralId: RR.referralId, status: RR.status })
            .from(RR)
            .where(eq(RR.id, b.conflictId))
            .limit(1);
          if (req && req.referralId === referralId && req.status !== "cancelled") {
            await tx
              .update(BATCH)
              .set({
                recordsRequestId: b.conflictId,
                recordsRequestConflictId: null,
                recordsRequestConflictKind: null,
              })
              .where(eq(BATCH.id, batchId));
            await markReceivedOnArrival(tx, b.conflictId, new Date());
          }
        }
        // A Part 2 detection put a privacy flag on the previous patient (M5): it moves with the fax, in
        // this transaction — never left on the wrong person, never missing on the right one.
        await publishSudFlagMove(tx, deps.outbox, organizationId, {
          batchId,
          sudStatus: b.sudStatus,
          fromPatientId: b.patientId,
          toPatientId: patientId,
          movedByMembershipId: actor.membershipId,
        });
        // The filed source document follows its batch (M22 owns both rows).
        await tx.update(DOC).set({ patientId }).where(eq(DOC.id, b.documentId));
        await tx.insert(RELINK).values({
          organizationId,
          patientId,
          intakeUploadBatchId: batchId,
          fromPatientId: b.patientId,
          fromReferralId: b.referralId,
          toReferralId: referralId,
          reason: to.reason,
          relinkedByMembershipId: actor.membershipId,
          correlationId,
        });
        // Earlier resolutions confirmed a different person: forget them and check again.
        const r = await refreshBatchIdentity(
          tx,
          { cipher, ports: identity.ports, ...(deps.outbox ? { outbox: deps.outbox } : {}) },
          organizationId,
          batchId,
          { clearResolutions: true },
        );
        return { batchId, patientId, referralId, identityStatus: r.status };
      });
    },
  };
}

/** The batch's identity: the worst verdict among documents nobody has resolved (re-sent copies excluded). */
async function recomputeBatchIdentity(tx: DbClient, batchId: string): Promise<BatchIdentityStatus> {
  const docs = await tx
    .select({
      status: CP.identityStatus,
      resolution: CP.identityResolution,
      dup: CP.duplicateOfPage,
    })
    .from(CP)
    .where(eq(CP.intakeUploadBatchId, batchId));
  const open = docs
    .filter((d) => d.dup === null && d.resolution === null && d.status !== null)
    .map((d) => d.status as IdentityStatus);
  const [b] = await tx.select({ s: BATCH.identityStatus }).from(BATCH).where(eq(BATCH.id, batchId));
  const status: BatchIdentityStatus =
    b?.s === "no_target" ? "no_target" : (worstIdentity(open) ?? "match");
  await tx.update(BATCH).set({ identityStatus: status }).where(eq(BATCH.id, batchId));
  return status;
}
