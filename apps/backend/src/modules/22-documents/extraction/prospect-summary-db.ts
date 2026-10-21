// apps/backend/src/modules/22-documents/extraction/prospect-summary-db.ts — the thin DB reader behind
// GET /api/v1/intake/uploads/:id/summary (F-238 prospect summary). Loads ONE batch's documents, candidates and
// the COMPLETED review's decisions under `withOrgContext` (RLS — another tenant's batch is a 404), DEK-decrypts
// only what the summary can show (values of approved candidates, the coding checks on approved codes, the
// SUD evidence pages), and hands them to the pure `buildProspectSummary`. Decrypted values are returned to the
// caller (PHI — the route read-audits it) and never logged.
//
// Available only once the review is complete (409 REVIEW_NOT_COMPLETE before): approvals can still change
// while a review is open, and a summary built to be copied out of the screen must not present a picture the
// reviewer has not finished attesting.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  DegradedError,
  type DocLensBatchSudStatus,
  NotFoundError,
  ChartWardenError,
} from "@chartwarden/types";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CandidateValueCipher } from "./candidate-value-cipher";
import {
  type ProspectSummary,
  type SummaryCodingFlagInput,
  type SummaryDecision,
  type SummaryFactInput,
  buildProspectSummary,
} from "./prospect-summary";

const BATCH = schema.intakeUploadBatches;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;
const EC = schema.extractionCandidates;
const ER = schema.extractionReviews;
const ED = schema.extractionDecisions;

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

export interface ProspectSummaryDeps {
  readonly db: DbClient;
  readonly cipher?: CandidateValueCipher;
  /** "Last, First" of the patient the batch is filed under, via M5's PatientReader. Absent/failed ⇒ null. */
  readonly patientName?: (organizationId: string, patientId: string) => Promise<string | null>;
}

export interface ProspectSummaryService {
  getSummary(organizationId: string, batchId: string): Promise<ProspectSummary>;
  /**
   * The summaries of every COMPLETED review of a batch filed under this patient, newest review first (the
   * referral packet, then the older records requested later) — for the patient chart's overview.
   */
  listForPatient(
    organizationId: string,
    patientId: string,
    limit?: number,
  ): Promise<{ items: ProspectSummary[] }>;
}

/** The most summaries the patient read returns (newest first). */
export const PATIENT_SUMMARY_LIMIT = 20;

export function createProspectSummaryService(deps: ProspectSummaryDeps): ProspectSummaryService {
  const service: ProspectSummaryService = {
    async listForPatient(organizationId, patientId, limit = PATIENT_SUMMARY_LIMIT) {
      const rows = await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) =>
        (scoped as DbClient)
          .select({ batchId: BATCH.id, closedAt: ER.closedAt })
          .from(BATCH)
          .innerJoin(ER, eq(ER.intakeUploadBatchId, BATCH.id))
          .where(and(eq(BATCH.patientId, patientId), eq(ER.status, "complete")))
          .orderBy(desc(ER.closedAt)),
      );
      const batchIds = [...new Set(rows.map((r) => r.batchId))].slice(
        0,
        Math.max(1, Math.min(limit, PATIENT_SUMMARY_LIMIT)),
      );
      const items: ProspectSummary[] = [];
      for (const id of batchIds) items.push(await service.getSummary(organizationId, id));
      return { items };
    },

    async getSummary(organizationId, batchId) {
      const loaded = await withOrgContext(
        deps.db,
        { organizationId, userId: "" },
        async (scoped) => {
          const tx = scoped as DbClient;
          const [b] = await tx.select().from(BATCH).where(eq(BATCH.id, batchId)).limit(1);
          if (!b) throw new NotFoundError("intake batch");
          const [review] = await tx
            .select()
            .from(ER)
            .where(and(eq(ER.intakeUploadBatchId, batchId), eq(ER.status, "complete")))
            .orderBy(desc(ER.closedAt))
            .limit(1);
          if (!review) {
            throw new ChartWardenError(
              "REVIEW_NOT_COMPLETE",
              "the prospect summary is built from reviewer-approved values and is available once the review is complete",
              409,
            );
          }
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
          const decisions = await tx.select().from(ED).where(eq(ED.extractionReviewId, review.id));
          return { b, review, pages, jobs, cands, decisions };
        },
      );
      const { b, review, pages, jobs, cands, decisions } = loaded;

      const cipher = deps.cipher;
      const decrypt = async (envelope: string | null): Promise<string | null> => {
        if (envelope === null) return null;
        if (!cipher) {
          throw new DegradedError(
            "prospect-summary",
            "no tenant-DEK cipher is bound for extraction candidate values; the summary cannot be built",
          );
        }
        return cipher.decrypt(organizationId, envelope);
      };

      const pageById = new Map(pages.map((p) => [p.id, p]));
      const jobById = new Map(jobs.map((j) => [j.id, j]));
      const decisionByCandidate = new Map(decisions.map((d) => [d.extractionCandidateId, d]));

      const facts: SummaryFactInput[] = [];
      for (const c of cands) {
        const job = jobById.get(c.extractionJobId);
        const doc = job ? pageById.get(job.classifiedPageId) : undefined;
        if (!doc) continue;
        const d = decisionByCandidate.get(c.id);
        const decision = (d ? String(d.decision) : null) as SummaryDecision | null;
        const approved = decision === "approve" || decision === "approve_with_edit";
        // Decrypt only what an approved candidate can show: its value (as-extracted approvals) and its
        // coding checks. A rejected or undecided candidate's value is never decrypted here.
        const extractedValue =
          decision === "approve"
            ? c.valueCipher
              ? await decrypt(c.valueCipher)
              : c.valueText
            : null;
        const flagsJson = approved ? await decrypt(c.codingFlagsCipher) : null;
        const box = c.sourceBoundingBox as { y1?: number } | null;
        facts.push({
          candidateId: c.id,
          extractionJobId: c.extractionJobId,
          documentPageFrom: doc.pageRangeStart,
          fieldPath: c.fieldPath,
          page: c.sourcePage,
          top: typeof box?.y1 === "number" ? box.y1 : 0,
          sudDetected: c.sudDetected,
          decision,
          extractedValue,
          editedValue: d?.editedValue ?? null,
          editedCode: d?.editedCode ?? null,
          codingFlags: flagsJson
            ? (JSON.parse(flagsJson) as SummaryCodingFlagInput[]).map((f) => ({
                kind: String(f.kind),
                code: String(f.code),
                detail: typeof f.detail === "string" ? f.detail : "",
              }))
            : [],
        });
      }

      const evidence = await decrypt(b.sudEvidenceCipher);
      const sudPages = evidence
        ? [...new Set((JSON.parse(evidence) as Array<{ page: number }>).map((i) => i.page))]
        : [];

      let patientName: string | null = null;
      if (b.patientId && deps.patientName) {
        try {
          patientName = await deps.patientName(organizationId, b.patientId);
        } catch {
          patientName = null;
        }
      }

      return buildProspectSummary({
        batch: {
          id: b.id,
          uploadedAt: iso(b.uploadedAt) as string,
          sourceChannel: b.sourceChannel,
          patientId: b.patientId,
          patientName,
          referralId: b.referralId,
          sudStatus: b.sudStatus as DocLensBatchSudStatus,
        },
        review: { id: review.id, completedAt: iso(review.closedAt) },
        documents: pages.map((p) => ({
          pageFrom: p.pageRangeStart,
          pageTo: p.pageRangeEnd,
          documentType: String(p.documentType),
          title: p.documentTitle,
          date: p.documentDate ? String(p.documentDate) : null,
          duplicateOfPage: p.duplicateOfPage,
          identityResolution:
            p.identityResolution === "other_patient" || p.identityResolution === "same_patient"
              ? p.identityResolution
              : null,
        })),
        sudPages,
        facts,
      });
    },
  };
  return service;
}
