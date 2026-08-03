// apps/backend/src/modules/22-documents/erasers/document-eraser.ts — M22-T10 the `documents` data eraser
// (M22 spec §8.6 / D9 / D12; M4 destruction-cert workflow).
//
// M22 owns the destruction callback for a patient's DOCUMENT record — the rendered/uploaded document
// subtree M22 hangs around the M5 patient spine: `document` + `document_version` (with the DEK-encrypted
// `byte_payload_cipher`), their tags, the `intake_artifact`-class intake subtree (`intake_upload_batch` /
// `classified_page` / `extraction_job` / `extraction_candidate` (with the DEK-encrypted `value_cipher`) /
// `extraction_review` / `extraction_decision`), and the version-aware MinIO objects under
// `tenant-{tenantId}/documents/...` + `.../intake/{batchId}/...`.
//
// Under an M4 destruction certificate it (per §8.6 / W14, D12):
//   1. crypto-erases the document/extraction ciphertext FIRST by destroying the decrypting tenant DEK
//      material — the ciphertext stays in the rows + MinIO but is irrecoverable the instant the key is gone
//      (DEK-first, same ordering as M8's `encounter_record` and M36's `messages` erasers);
//   2. SKIPS any document under an active `document_legal_hold` (and the whole associated intake batch) —
//      the skip + hold metadata is captured by M4 audit, NOT deleted (spec §8.6 "Legal hold interaction");
//   3. version-aware deletes the remaining MinIO objects (all object versions + delete markers per
//      DR-019 / ARCH-085) and row-deletes the document/intake subtree;
//   4. PRESERVES `document_access_log` rows inside the §164.528 disclosure-accounting retention floor
//      (ADR-0013) — those are M4-owned accounting evidence, not document content.
// `compliance_42cfr_part2`-class documents are passed THROUGH to M4's `eraseAuditRows`, which refuses
// destruction during the patient's lifetime — this eraser never force-destroys a Part 2 row.
//
// Registers the REAL eraser over the Phase-0 `documents` deny-stub (`documents` is in REQUIRED_ERASERS); the
// composition root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before
// validateErasers(), so a real eraser stands over its stub (same hook M5/M6/M7/M8/M36 use).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type DataEraser, DegradedError, type OrgId } from "@wardenx/types";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";
import { deriveTenantBucket } from "../lifecycle/storage";
import type { ObjectStorePort } from "../seams/store";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The per-table counts a documents-record destruction removed (recorded on the destruction cert). */
export interface DocumentEraseCounts {
  readonly documents: number;
  readonly documentVersions: number;
  readonly documentTags: number;
  readonly intakeBatches: number;
  readonly classifiedPages: number;
  readonly extractionJobs: number;
  readonly extractionCandidates: number;
  readonly extractionReviews: number;
  readonly extractionDecisions: number;
  /** `extraction_discrepancy` rows deleted (FK child of the intake batch — must go before it). */
  readonly extractionDiscrepancies: number;
  /** `extraction_provenance` rows deleted (FK child of `extraction_decision` — must go before it). */
  readonly extractionProvenance: number;
  /** RELEASED `document_legal_hold` rows deleted with their document (an ACTIVE hold skips the doc). */
  readonly legalHoldReleases: number;
  readonly minioObjects: number;
}

/** The skip report for documents preserved under an active legal hold (captured to M4 audit, §8.6). */
export interface DocumentEraseSkips {
  /** Document ids held back because a `document_legal_hold` is active (and their intake batches). */
  readonly legalHoldDocumentIds: readonly string[];
  /** Document ids passed through to M4's `eraseAuditRows` Part 2 refusal (compliance_42cfr_part2 class). */
  readonly part2DocumentIds: readonly string[];
}

/** The narrow data port the documents eraseFn composes over (Drizzle deletes in prod, under RLS). */
export interface DocumentEraseStore {
  /**
   * Cryptographically erase the document/extraction ciphertext for the patient's documents by destroying
   * the decrypting tenant DEK material (§8.6) — the `document_version.byte_payload_cipher` and
   * `extraction_candidate.value_cipher` bytes stay in place but are irrecoverable. Runs FIRST so a crash
   * mid-erase still leaves the PHI unreadable (same ordering as M8's encounter eraser).
   */
  cryptoEraseDocumentPayloads(organizationId: string, patientId: string): Promise<void>;
  /**
   * Compute which of the patient's documents must be SKIPPED: those under an active `document_legal_hold`
   * (and their intake batches) and those of `compliance_42cfr_part2` class (passed through to M4's
   * `eraseAuditRows` Part 2 refusal). The eraser deletes everything NOT in this set.
   */
  resolveSkips(organizationId: string, patientId: string): Promise<DocumentEraseSkips>;
  /**
   * Version-aware delete the patient's document + intake subtree MinIO objects (all versions + delete
   * markers, DR-019) and row-delete the document/intake rows, EXCLUDING the skipped documents. The
   * `document_access_log` rows inside the §164.528 retention floor are NOT deleted (ADR-0013). Returns the
   * per-table counts.
   */
  eraseDocumentSubtree(
    organizationId: string,
    patientId: string,
    skips: DocumentEraseSkips,
  ): Promise<DocumentEraseCounts>;
}

/**
 * Erase a patient's documents record subtree under a destruction certificate (§8.6 / D9 / D12): crypto-erase
 * the document/extraction ciphertext, resolve the legal-hold + Part 2 skips, version-aware delete the
 * remaining MinIO objects + rows, and report the total removed + the skip set. Pure orchestration over the
 * store — no I/O of its own. DEK-first so the PHI is unreadable the instant the key is gone, even if a later
 * step fails or a legal hold preserves the rows.
 */
export async function eraseDocumentRecord(
  organizationId: string,
  patientId: string,
  store: DocumentEraseStore,
): Promise<{ erased: number; counts: DocumentEraseCounts; skips: DocumentEraseSkips }> {
  await store.cryptoEraseDocumentPayloads(organizationId, patientId);
  const skips = await store.resolveSkips(organizationId, patientId);
  const counts = await store.eraseDocumentSubtree(organizationId, patientId, skips);
  const erased = Object.values(counts).reduce((a, b) => a + b, 0);
  return { erased, counts, skips };
}

/** An in-memory {@link DocumentEraseStore} for the slice/tests (seeded per-table counts + skip set). */
export function createInMemoryDocumentEraseStore(
  seed: Partial<DocumentEraseCounts> = {},
  skips: DocumentEraseSkips = { legalHoldDocumentIds: [], part2DocumentIds: [] },
): {
  store: DocumentEraseStore;
  cryptoErased: string[];
} {
  const zero: DocumentEraseCounts = {
    documents: 0,
    documentVersions: 0,
    documentTags: 0,
    intakeBatches: 0,
    classifiedPages: 0,
    extractionJobs: 0,
    extractionCandidates: 0,
    extractionReviews: 0,
    extractionDecisions: 0,
    extractionDiscrepancies: 0,
    extractionProvenance: 0,
    legalHoldReleases: 0,
    minioObjects: 0,
  };
  const counts: DocumentEraseCounts = { ...zero, ...seed };
  const cryptoErased: string[] = [];
  let used = false;
  return {
    cryptoErased,
    store: {
      async cryptoEraseDocumentPayloads(_org, patientId) {
        cryptoErased.push(patientId);
      },
      async resolveSkips() {
        return skips;
      },
      async eraseDocumentSubtree() {
        // idempotent: a second erase removes nothing (rows + objects already gone).
        const out = used ? zero : counts;
        used = true;
        return out;
      },
    },
  };
}

/** Deps for the Drizzle-backed store (the object-store port is separate IO — see the factory header). */
export interface DrizzleDocumentEraseDeps {
  /**
   * The version-aware MinIO destruction port (D12 / DR-019). ABSENT ⇒ a REFUSING port that throws
   * `DegradedError("document-storage", …)` on first use — M22's object-storage adapter is not wired at
   * the composition root, and faking object deletion would report a destruction that never happened.
   */
  readonly objects?: ObjectStorePort;
}

/** The refusing {@link ObjectStorePort} bound when no MinIO adapter is wired (fail-closed, never a no-op). */
function createRefusingObjectStore(): ObjectStorePort {
  const refuse = (): never => {
    throw new DegradedError(
      "document-storage",
      "no object-storage adapter is bound (M22 MinIO adapter not wired) — cannot version-aware destroy document objects; row destruction is withheld so the object keys are not lost",
    );
  };
  return {
    async putObject() {
      return refuse();
    },
    async presign() {
      return refuse();
    },
    async destroyAllVersions() {
      return refuse();
    },
  };
}

/**
 * The Drizzle-backed {@link DocumentEraseStore}: the REAL §8.6 / D9 / D12 destruction path (TASK-003 /
 * ARCH-007). Every row statement runs inside `withOrgContext`, so RLS scopes the patient's document/intake
 * subtree to the acting org. Counts come from `returning(...)` lengths — rows ACTUALLY removed.
 *
 * CRYPTO-ERASE AS COLUMN SHRED. With only a `DbClient` this store cannot reach the M34 key custodian to
 * destroy the tenant DEK, and shredding the ciphertext bytes themselves is strictly stronger — the PHI is
 * unreadable under ANY key the moment the shred commits (the M8/M16/M31 shred-before-delete posture). The
 * shred nulls `document_version.byte_payload_cipher` + `extraction_candidate.value_cipher` across the
 * WHOLE patient subtree — including legal-hold documents (the orchestrator's stated semantics: the PHI is
 * unreadable "even if a legal hold preserves the rows") — EXCEPT `compliance_42cfr_part2`-class documents,
 * which this eraser never force-destroys (they pass through to M4's Part-2 refusal).
 *
 * THE PATIENT SUBTREE is the union of (a) documents carrying the patient's id and (b) the intake-source
 * documents reachable from the patient's `intake_upload_batch` rows (`initial_document_id` +
 * `classified_page.source_document_id`) — an intake source may still carry `patient_id NULL` from before
 * attachment, and leaving it would leak the uploaded chart.
 *
 * OBJECTS BEFORE ROWS. `eraseDocumentSubtree` destroys the MinIO object versions FIRST and only then
 * row-deletes: if the object port refuses (today's `DegradedError` stub) the erase fails LOUDLY with the
 * rows — and therefore the object keys — intact and retryable; deleting rows first would orphan the
 * objects unfindably. `document_access_log` is never touched (§164.528 disclosure-accounting floor,
 * ADR-0013). An ACTIVE legal hold (doc `status='legal_hold'` or a `document_legal_hold` row with
 * `released_at IS NULL`) skips the document AND its whole intake batch; RELEASED hold rows on deletable
 * docs are deleted with them (FK) and counted as `legalHoldReleases`.
 */
export function createDrizzleDocumentEraseStore(
  db: DbClient,
  deps: DrizzleDocumentEraseDeps = {},
): DocumentEraseStore {
  const objects = deps.objects ?? createRefusingObjectStore();
  const DOC = schema.documents;
  const VER = schema.documentVersions;
  const TAG = schema.documentTags;
  const HOLD = schema.documentLegalHold;
  const BATCH = schema.intakeUploadBatches;
  const PAGE = schema.classifiedPages;
  const JOB = schema.extractionJobs;
  const CAND = schema.extractionCandidates;
  const REVIEW = schema.extractionReviews;
  const DECISION = schema.extractionDecisions;
  const DISCREPANCY = schema.extractionDiscrepancies;
  const PROVENANCE = schema.extractionProvenance;

  const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  const uniq = (ids: readonly string[]): string[] => [...new Set(ids)];

  /** The patient's batch ids (the intake spine every extraction row hangs off). */
  const batchIdsFor = async (tx: Tx, patientId: string): Promise<string[]> =>
    (await tx.select({ id: BATCH.id }).from(BATCH).where(eq(BATCH.patientId, patientId))).map(
      (r) => r.id,
    );

  /**
   * The patient's full document set: direct `patient_id` documents PLUS the intake-source documents
   * reachable from the patient's batches (see the factory header).
   */
  const patientDocIdsFor = async (tx: Tx, patientId: string): Promise<string[]> => {
    const direct = (
      await tx.select({ id: DOC.id }).from(DOC).where(eq(DOC.patientId, patientId))
    ).map((r) => r.id);
    const batchIds = await batchIdsFor(tx, patientId);
    if (batchIds.length === 0) return uniq(direct);
    const initials = (
      await tx
        .select({ id: BATCH.initialDocumentId })
        .from(BATCH)
        .where(inArray(BATCH.id, batchIds))
    ).map((r) => r.id);
    const sources = (
      await tx
        .select({ id: PAGE.sourceDocumentId })
        .from(PAGE)
        .where(inArray(PAGE.intakeUploadBatchId, batchIds))
    ).map((r) => r.id);
    return uniq([...direct, ...initials, ...sources]);
  };

  /** Of `docIds`, those that are `compliance_42cfr_part2`-class (never force-destroyed here). */
  const part2Of = async (tx: Tx, docIds: string[]): Promise<string[]> =>
    docIds.length === 0
      ? []
      : (
          await tx
            .select({ id: DOC.id })
            .from(DOC)
            .where(
              and(inArray(DOC.id, docIds), eq(DOC.retentionClass, "compliance_42cfr_part2")),
            )
        ).map((r) => r.id);

  /** Of `docIds`, those under an ACTIVE legal hold (doc status OR an unreleased hold row, §3.7). */
  const activeHoldOf = async (tx: Tx, docIds: string[]): Promise<string[]> => {
    if (docIds.length === 0) return [];
    const byStatus = (
      await tx
        .select({ id: DOC.id })
        .from(DOC)
        .where(and(inArray(DOC.id, docIds), eq(DOC.status, "legal_hold")))
    ).map((r) => r.id);
    const byHoldRow = (
      await tx
        .select({ id: HOLD.documentId })
        .from(HOLD)
        .where(and(inArray(HOLD.documentId, docIds), isNull(HOLD.releasedAt)))
    ).map((r) => r.id);
    return uniq([...byStatus, ...byHoldRow]);
  };

  /** The batch ids whose subtree touches a skipped document (the whole batch is preserved, §8.6). */
  const skippedBatchIdsFor = async (
    tx: Tx,
    batchIds: string[],
    skippedDocIds: string[],
  ): Promise<string[]> => {
    if (batchIds.length === 0 || skippedDocIds.length === 0) return [];
    const byInitial = (
      await tx
        .select({ id: BATCH.id })
        .from(BATCH)
        .where(and(inArray(BATCH.id, batchIds), inArray(BATCH.initialDocumentId, skippedDocIds)))
    ).map((r) => r.id);
    const bySourcePage = (
      await tx
        .select({ id: PAGE.intakeUploadBatchId })
        .from(PAGE)
        .where(
          and(
            inArray(PAGE.intakeUploadBatchId, batchIds),
            inArray(PAGE.sourceDocumentId, skippedDocIds),
          ),
        )
    ).map((r) => r.id);
    return uniq([...byInitial, ...bySourcePage]);
  };

  return {
    async cryptoEraseDocumentPayloads(organizationId, patientId) {
      await inOrg(organizationId, async (tx) => {
        const docIds = await patientDocIdsFor(tx, patientId);
        if (docIds.length === 0) return;
        const part2 = new Set(await part2Of(tx, docIds));
        const shredDocIds = docIds.filter((id) => !part2.has(id));

        // Shred FIRST (§8.6): both cipher columns are nullable → NULL. Legal-hold docs are INCLUDED
        // (their rows/objects survive the delete pass but the payload is irrecoverable, per the
        // orchestrator's contract); Part-2-class docs are EXCLUDED (never force-destroyed here).
        if (shredDocIds.length > 0) {
          await tx
            .update(VER)
            .set({ bytePayloadCipher: null })
            .where(inArray(VER.documentId, shredDocIds));
        }

        const batchIds = await batchIdsFor(tx, patientId);
        const part2Batches = new Set(
          await skippedBatchIdsFor(tx, batchIds, [...part2]),
        );
        const shredBatchIds = batchIds.filter((id) => !part2Batches.has(id));
        if (shredBatchIds.length === 0) return;
        const pageIds = (
          await tx
            .select({ id: PAGE.id })
            .from(PAGE)
            .where(inArray(PAGE.intakeUploadBatchId, shredBatchIds))
        ).map((r) => r.id);
        if (pageIds.length === 0) return;
        const jobIds = (
          await tx
            .select({ id: JOB.id })
            .from(JOB)
            .where(inArray(JOB.classifiedPageId, pageIds))
        ).map((r) => r.id);
        if (jobIds.length === 0) return;
        await tx
          .update(CAND)
          .set({ valueCipher: null })
          .where(inArray(CAND.extractionJobId, jobIds));
      });
    },

    async resolveSkips(organizationId, patientId) {
      return inOrg(organizationId, async (tx) => {
        const docIds = await patientDocIdsFor(tx, patientId);
        return {
          legalHoldDocumentIds: await activeHoldOf(tx, docIds),
          part2DocumentIds: await part2Of(tx, docIds),
        };
      });
    },

    async eraseDocumentSubtree(organizationId, patientId, skips) {
      const skippedDocIds = uniq([...skips.legalHoldDocumentIds, ...skips.part2DocumentIds]);

      // Phase A (read): resolve the deletable doc/batch sets + the object keys BEFORE any destruction.
      const plan = await inOrg(organizationId, async (tx) => {
        const allDocIds = await patientDocIdsFor(tx, patientId);
        const skipped = new Set(skippedDocIds);
        const docIds = allDocIds.filter((id) => !skipped.has(id));
        const batchIds = await batchIdsFor(tx, patientId);
        const skippedBatches = new Set(await skippedBatchIdsFor(tx, batchIds, skippedDocIds));
        const deletableBatchIds = batchIds.filter((id) => !skippedBatches.has(id));
        const objectKeys =
          docIds.length === 0
            ? []
            : uniq(
                (
                  await tx
                    .select({ key: VER.minioObjectKey })
                    .from(VER)
                    .where(inArray(VER.documentId, docIds))
                ).map((r) => r.key),
              );
        return { docIds, deletableBatchIds, objectKeys };
      });

      // Phase B (objects BEFORE rows, D12/DR-019): a refusing port throws here — LOUDLY, with every row
      // (and thus every object key) still in place, so the erase is retryable once the adapter binds.
      const bucket = deriveTenantBucket(organizationId as OrgId);
      for (const objectKey of plan.objectKeys) {
        await objects.destroyAllVersions({
          bucket,
          objectKey,
          organizationId: organizationId as OrgId,
        });
      }

      // Phase C (rows, FK-safe child→parent order; `document_access_log` untouched — ADR-0013).
      return inOrg(organizationId, async (tx) => {
        const { docIds, deletableBatchIds } = plan;
        const del = async <T>(rows: T[]): Promise<number> => rows.length;

        let classifiedPages = 0;
        let extractionJobs = 0;
        let extractionCandidates = 0;
        let extractionReviews = 0;
        let extractionDecisions = 0;
        let extractionDiscrepancies = 0;
        let extractionProvenance = 0;
        let intakeBatches = 0;

        if (deletableBatchIds.length > 0) {
          const pageIds = (
            await tx
              .select({ id: PAGE.id })
              .from(PAGE)
              .where(inArray(PAGE.intakeUploadBatchId, deletableBatchIds))
          ).map((r) => r.id);
          const jobIds =
            pageIds.length === 0
              ? []
              : (
                  await tx
                    .select({ id: JOB.id })
                    .from(JOB)
                    .where(inArray(JOB.classifiedPageId, pageIds))
                ).map((r) => r.id);
          const reviewIds = (
            await tx
              .select({ id: REVIEW.id })
              .from(REVIEW)
              .where(inArray(REVIEW.intakeUploadBatchId, deletableBatchIds))
          ).map((r) => r.id);
          const decisionIds =
            reviewIds.length === 0
              ? []
              : (
                  await tx
                    .select({ id: DECISION.id })
                    .from(DECISION)
                    .where(inArray(DECISION.extractionReviewId, reviewIds))
                ).map((r) => r.id);

          if (decisionIds.length > 0) {
            extractionProvenance = await del(
              await tx
                .delete(PROVENANCE)
                .where(inArray(PROVENANCE.extractionDecisionId, decisionIds))
                .returning({ id: PROVENANCE.id }),
            );
            extractionDecisions = await del(
              await tx
                .delete(DECISION)
                .where(inArray(DECISION.id, decisionIds))
                .returning({ id: DECISION.id }),
            );
          }
          extractionDiscrepancies = await del(
            await tx
              .delete(DISCREPANCY)
              .where(inArray(DISCREPANCY.intakeUploadBatchId, deletableBatchIds))
              .returning({ id: DISCREPANCY.id }),
          );
          if (reviewIds.length > 0) {
            extractionReviews = await del(
              await tx
                .delete(REVIEW)
                .where(inArray(REVIEW.id, reviewIds))
                .returning({ id: REVIEW.id }),
            );
          }
          if (jobIds.length > 0) {
            extractionCandidates = await del(
              await tx
                .delete(CAND)
                .where(inArray(CAND.extractionJobId, jobIds))
                .returning({ id: CAND.id }),
            );
            extractionJobs = await del(
              await tx
                .delete(JOB)
                .where(inArray(JOB.id, jobIds))
                .returning({ id: JOB.id }),
            );
          }
          if (pageIds.length > 0) {
            classifiedPages = await del(
              await tx
                .delete(PAGE)
                .where(inArray(PAGE.id, pageIds))
                .returning({ id: PAGE.id }),
            );
          }
          intakeBatches = await del(
            await tx
              .delete(BATCH)
              .where(inArray(BATCH.id, deletableBatchIds))
              .returning({ id: BATCH.id }),
          );
        }

        let documentTags = 0;
        let legalHoldReleases = 0;
        let documentVersions = 0;
        let documents = 0;
        if (docIds.length > 0) {
          documentTags = await del(
            await tx
              .delete(TAG)
              .where(inArray(TAG.documentId, docIds))
              .returning({ id: TAG.id }),
          );
          // Only RELEASED hold rows can exist on a deletable doc (an active hold skipped it above).
          legalHoldReleases = await del(
            await tx
              .delete(HOLD)
              .where(inArray(HOLD.documentId, docIds))
              .returning({ id: HOLD.id }),
          );
          documentVersions = await del(
            await tx
              .delete(VER)
              .where(inArray(VER.documentId, docIds))
              .returning({ id: VER.id }),
          );
          documents = await del(
            await tx
              .delete(DOC)
              .where(inArray(DOC.id, docIds))
              .returning({ id: DOC.id }),
          );
        }

        return {
          documents,
          documentVersions,
          documentTags,
          intakeBatches,
          classifiedPages,
          extractionJobs,
          extractionCandidates,
          extractionReviews,
          extractionDecisions,
          extractionDiscrepancies,
          extractionProvenance,
          legalHoldReleases,
          minioObjects: plan.objectKeys.length,
        };
      });
    },
  };
}

/** Injected adapter for the M22 eraser (slice defaults to in-memory). */
export interface DocumentEraserDeps {
  store?: DocumentEraseStore;
}

/** Build M22's `documents` DataEraser. `subjectId` is the patient being destroyed (§8.6 / D9). */
export function createDocumentEraser(store: DocumentEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseDocumentRecord(scope.orgId, subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register M22's REAL `documents` eraser over the Phase-0 deny-stub (M22-T10; before validateErasers()).
 * Prod injects `createDrizzleDocumentEraseStore(db, { objects })` via `deps.store`; without a bound MinIO
 * adapter the Drizzle store's object pass throws `DegradedError` BEFORE any row is deleted (fail-closed,
 * retryable — see the factory header). The in-memory slice store remains the argument-less default.
 */
export function registerDocumentErasers(deps: DocumentEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryDocumentEraseStore().store;
  registerEraser("documents", createDocumentEraser(store));
}
