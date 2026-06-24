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
import type { DataEraser } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";

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

/** Register M22's REAL `documents` eraser over the Phase-0 deny-stub (M22-T10; before validateErasers()). */
export function registerDocumentErasers(deps: DocumentEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryDocumentEraseStore().store;
  registerEraser("documents", createDocumentEraser(store));
}
