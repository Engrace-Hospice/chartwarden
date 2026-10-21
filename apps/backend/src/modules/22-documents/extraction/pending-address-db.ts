// apps/backend/src/modules/22-documents/extraction/pending-address-db.ts — the thin DB reader behind
// GET /api/v1/patients/:patientId/intake-pending-address (F-238).
//
// DocLens often extracts a residence address from a referral packet long before the patient has one in M5:
// the value only reaches the chart once a reviewer approves it AND completes the review (writeback →
// M5's `m22-extraction-writeback` consumer appends it as a home address). The admission screen uses this
// read to point at those reviews instead of showing a bare "no address on file".
//
// COUNTS AND BATCH IDS ONLY. Candidate values are DEK-encrypted PHI (`value_cipher`) and are never read here
// — no value, page or box leaves this query. Scope, under `withOrgContext` (RLS):
//   • batches filed under the patient (`intake_upload_batch.patient_id`) that are still open: not
//     discarded, not a split parent, not parse-failed, and not `writeback_complete`;
//   • whose latest review is not complete (an in-progress review's decisions count; an abandoned one's don't);
//   • address candidates (`patient.address.*`, the M5 writeback allowlist) that are not rejected and not on a
//     document a reviewer marked as ANOTHER patient's (`identity_resolution = 'other_patient'`, which the
//     writeback excludes too).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { DOCLENS_M5_WRITEBACK_FIELDS } from "@chartwarden/types";
import { and, desc, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";

const BATCH = schema.intakeUploadBatches;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;
const ER = schema.extractionReviews;
const ED = schema.extractionDecisions;

/** The extracted field paths that become the M5 residence address on writeback. */
export const DOCLENS_ADDRESS_FIELD_PATHS: readonly string[] = Object.keys(
  DOCLENS_M5_WRITEBACK_FIELDS,
).filter((p) => p.startsWith("patient.address."));

/** Batch states that can never write an address back (closed, or not a reviewable batch). */
const CLOSED_BATCH_STATUSES = [
  "writeback_complete",
  "discarded",
  "split_into_children",
  "parse_failed",
] as const;

/** The most batches the read returns (newest first); `totalBatches` still counts them all. */
export const PENDING_ADDRESS_BATCH_LIMIT = 3;

export interface PendingAddressBatch {
  readonly batchId: string;
  readonly batchStatus: string;
  readonly uploadedAt: string;
  /** `not_started` — no review is open yet; `in_progress` — a reviewer is part-way through. */
  readonly reviewStatus: "not_started" | "in_progress";
  /** Address candidates nobody has decided yet. */
  readonly pendingCount: number;
  /** Address candidates approved (as-is or edited) that wait for the review to be completed. */
  readonly approvedCount: number;
}

export interface PendingAddressResult {
  readonly items: PendingAddressBatch[];
  readonly totalBatches: number;
}

export interface PendingAddressService {
  pendingForPatient(organizationId: string, patientId: string): Promise<PendingAddressResult>;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

export function createPendingAddressService(deps: {
  readonly db: DbClient;
}): PendingAddressService {
  return {
    async pendingForPatient(organizationId, patientId) {
      return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as DbClient;
        const batches = await tx
          .select({ id: BATCH.id, status: BATCH.status, uploadedAt: BATCH.uploadedAt })
          .from(BATCH)
          .where(
            and(
              eq(BATCH.patientId, patientId),
              notInArray(BATCH.status, [...CLOSED_BATCH_STATUSES]),
            ),
          )
          .orderBy(desc(BATCH.uploadedAt));
        if (batches.length === 0) return { items: [], totalBatches: 0 };
        const ids = batches.map((b) => b.id);

        // The latest review per batch decides which decisions count.
        const reviews = await tx
          .select({ id: ER.id, batchId: ER.intakeUploadBatchId, status: ER.status })
          .from(ER)
          .where(inArray(ER.intakeUploadBatchId, ids))
          .orderBy(desc(ER.openedAt));
        const latestReview = new Map<string, { id: string; status: string }>();
        for (const r of reviews) {
          if (!latestReview.has(r.batchId)) latestReview.set(r.batchId, r);
        }

        const cands = await tx
          .select({ id: EC.id, batchId: CP.intakeUploadBatchId })
          .from(EC)
          .innerJoin(EJ, eq(EJ.id, EC.extractionJobId))
          .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
          .where(
            and(
              inArray(CP.intakeUploadBatchId, ids),
              inArray(EC.fieldPath, [...DOCLENS_ADDRESS_FIELD_PATHS]),
              or(isNull(CP.identityResolution), ne(CP.identityResolution, "other_patient")),
            ),
          );
        if (cands.length === 0) return { items: [], totalBatches: 0 };

        const openReviewIds = [...latestReview.values()]
          .filter((r) => r.status === "in_progress")
          .map((r) => r.id);
        const decisions = openReviewIds.length
          ? await tx
              .select({
                candidateId: ED.extractionCandidateId,
                reviewId: ED.extractionReviewId,
                decision: ED.decision,
              })
              .from(ED)
              .where(inArray(ED.extractionReviewId, openReviewIds))
          : [];
        const decisionOf = new Map(decisions.map((d) => [`${d.reviewId}:${d.candidateId}`, d]));

        const items: PendingAddressBatch[] = [];
        for (const b of batches) {
          const review = latestReview.get(b.id);
          if (review?.status === "complete") continue;
          const open = review?.status === "in_progress" ? review : undefined;
          let pendingCount = 0;
          let approvedCount = 0;
          for (const c of cands) {
            if (c.batchId !== b.id) continue;
            const d = open ? decisionOf.get(`${open.id}:${c.id}`) : undefined;
            if (!d) pendingCount++;
            else if (d.decision === "approve" || d.decision === "approve_with_edit")
              approvedCount++;
          }
          if (pendingCount + approvedCount === 0) continue;
          items.push({
            batchId: b.id,
            batchStatus: String(b.status),
            uploadedAt: iso(b.uploadedAt),
            reviewStatus: open ? "in_progress" : "not_started",
            pendingCount,
            approvedCount,
          });
        }
        return { items: items.slice(0, PENDING_ADDRESS_BATCH_LIMIT), totalBatches: items.length };
      });
    },
  };
}
