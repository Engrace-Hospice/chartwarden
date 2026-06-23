// apps/backend/src/modules/22-documents/services/eraser.ts — M22-T10 the `documents` data eraser (§3.7 / §8.6 /
// §7.14 W14; D12; M4 destruction-cert workflow).
//
// M22 owns the destruction callback for a patient's document subtree. Under an M4 destruction certificate it
// (1) acquires a per-patient advisory lock so a concurrent write cannot interleave with the destruction, then
// (2) walks every `document` carrying the patient's id whose retention has elapsed (`created_at < retentionAsOf`),
// and for each applies the PURE §7.14 D12 {@link decideDestruction} policy:
//   • `destroy` — version-aware MinIO object deletion (all object versions + delete markers per DR-019 /
//     ARCH-085 DEK-shred), cryptographic-shred the per-tenant DEK for the `byte_payload_cipher` columns, tombstone
//     the `document` row (status='destroyed_tombstone', active_version_id=NULL — the row + retention_class +
//     aggregate_type/id survive for FK integrity), and cascade-delete `document_version` / `document_tag` /
//     `document_legal_hold` rows plus any `form_fill` whose `result_document_id` is being destroyed.
//   • `skip_legal_hold` — the document is under an active `document_legal_hold`; it (and, for intake, the whole
//     associated batch) is preserved. M4 audit captures the skip with hold metadata (§8.6).
//   • `skip_compliance_42cfr_part2` — a SUD-class document is passed through to M4's `eraseAuditRows`, which
//     REFUSES destruction during the patient's lifetime (M4 v0.3 D8); the eraser skips it and reports the refusal.
//
// What SURVIVES (§3.7 / ADR-0013): `document_access_log` rows younger than the §164.528 disclosure-accounting
// retention floor are NEVER cascade-deleted — they are disclosure-accounting inputs and must be preserved.
//
// Registers the REAL eraser over the Phase-0 deny-stub (`documents` is in REQUIRED_ERASERS); the composition
// root's wireModuleErasers() invokes it AFTER wireErasers() (deny-stubs) and before validateErasers(), so a real
// eraser stands over its stub. (The `intake_extraction` data class, §3.7's second eraser, is M22-local — not in
// the boot REQUIRED_ERASERS contract — and its DocLens-byproduct pathway lands with the M32 DocLens wiring.)
import type { DataEraser, DocumentRetentionClass } from "@wardenx/types";
import { registerEraser } from "../../../bootstrap/index";
import { decideDestruction } from "../domain/index";

/** The per-table counts a `documents` destruction removed (recorded on the destruction cert, §3.7 / §8.6). */
export interface DocumentEraseCounts {
  /** `document` rows tombstoned (status='destroyed_tombstone', active_version_id=NULL; row preserved for FK). */
  readonly documentsTombstoned: number;
  /** `document_version` rows cascade-deleted across the tombstoned documents. */
  readonly versionsDeleted: number;
  /** `document_tag` rows cascade-deleted across the tombstoned documents. */
  readonly tagsDeleted: number;
  /** `document_legal_hold` rows cascade-deleted across the tombstoned documents (a released-then-destroyed doc). */
  readonly legalHoldsDeleted: number;
  /** `form_fill` rows cascade-deleted whose `result_document_id` was destroyed. */
  readonly formFillsDeleted: number;
  /** MinIO object versions + delete markers shredded (version-aware S3 DeleteObjects; DR-019 / ARCH-085). */
  readonly minioObjectsShredded: number;
  /** Documents SKIPPED because they were under an active legal hold (D12; `m22.eraser.legal_hold_skip`). */
  readonly legalHoldSkips: number;
  /** `compliance_42cfr_part2` documents REFUSED during the patient's lifetime (M4 `eraseAuditRows`, D23). */
  readonly sudRefusals: number;
}

/** A candidate document in the patient subtree the eraser evaluates against the §7.14 D12 destruction policy. */
export interface DocumentEraseCandidate {
  readonly documentId: string;
  readonly retentionClass: DocumentRetentionClass;
  readonly hasActiveLegalHold: boolean;
}

/** The per-document destroy result the store reports back (the rows + objects a single tombstone removed). */
export interface DocumentDestroyResult {
  readonly versionsDeleted: number;
  readonly tagsDeleted: number;
  readonly legalHoldsDeleted: number;
  readonly formFillsDeleted: number;
  readonly minioObjectsShredded: number;
}

/** Knobs the M4 destruction cert carries into the erase (defaults: erase everything up to now). */
export interface DocumentEraseOptions {
  /** Erase documents older than `retentionAsOf`; defaults to {@link DocumentEraseOptions.now}'s instant. */
  readonly retentionAsOf?: string;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

/** The narrow data port the `documents` eraseFn composes over (Drizzle deletes + MinIO/DEK shred in prod, under RLS). */
export interface DocumentEraseStore {
  /**
   * Acquire a per-patient advisory lock (keyed on patient id) so a concurrent write cannot interleave with the
   * destruction. Released by the surrounding transaction commit in prod; a no-op in the slice.
   */
  lockPatient(organizationId: string, patientId: string): Promise<void>;
  /**
   * List every `document` carrying the patient's id whose retention has elapsed (`created_at < retentionAsOf`),
   * with the two facts the §7.14 D12 policy needs: the retention class and whether an active legal hold exists.
   */
  listDestructionCandidates(
    organizationId: string,
    patientId: string,
    retentionAsOf: string,
  ): Promise<ReadonlyArray<DocumentEraseCandidate>>;
  /**
   * Destroy one document: version-aware MinIO object deletion + DEK shred, tombstone the `document` row, and
   * cascade-delete its `document_version` / `document_tag` / `document_legal_hold` / dependent `form_fill` rows.
   * `document_access_log` rows within the §164.528 accounting floor are NOT deleted (ADR-0013). Returns counts.
   */
  destroyDocument(organizationId: string, documentId: string): Promise<DocumentDestroyResult>;
}

const ZERO_COUNTS: DocumentEraseCounts = {
  documentsTombstoned: 0,
  versionsDeleted: 0,
  tagsDeleted: 0,
  legalHoldsDeleted: 0,
  formFillsDeleted: 0,
  minioObjectsShredded: 0,
  legalHoldSkips: 0,
  sudRefusals: 0,
};

/**
 * Erase a patient's document subtree under a destruction certificate (§3.7 / §8.6): lock the patient, list the
 * retention-elapsed candidates, then for each apply the pure §7.14 D12 {@link decideDestruction} policy — destroy
 * the non-held / non-SUD documents (tombstone + cascade + MinIO/DEK shred), skip the legal-hold ones, and refuse
 * the SUD-class ones. Pure orchestration over the store — no I/O of its own. Returns the deleted-row tally
 * (documents tombstoned; the `document_access_log` accounting floor is preserved, never counted as erased).
 */
export async function eraseDocumentRecord(
  organizationId: string,
  patientId: string,
  store: DocumentEraseStore,
  options: DocumentEraseOptions = {},
): Promise<{ erased: number; counts: DocumentEraseCounts }> {
  const now = options.now ?? (() => new Date().toISOString());
  const retentionAsOf = options.retentionAsOf ?? now();

  await store.lockPatient(organizationId, patientId);

  const candidates = await store.listDestructionCandidates(organizationId, patientId, retentionAsOf);

  const counts: {
    documentsTombstoned: number;
    versionsDeleted: number;
    tagsDeleted: number;
    legalHoldsDeleted: number;
    formFillsDeleted: number;
    minioObjectsShredded: number;
    legalHoldSkips: number;
    sudRefusals: number;
  } = { ...ZERO_COUNTS };

  for (const candidate of candidates) {
    const decision = decideDestruction({
      retentionClass: candidate.retentionClass,
      hasActiveLegalHold: candidate.hasActiveLegalHold,
    });
    if (decision.outcome === "skip_legal_hold") {
      counts.legalHoldSkips += 1;
      continue;
    }
    if (decision.outcome === "skip_compliance_42cfr_part2") {
      counts.sudRefusals += 1;
      continue;
    }
    const r = await store.destroyDocument(organizationId, candidate.documentId);
    counts.documentsTombstoned += 1;
    counts.versionsDeleted += r.versionsDeleted;
    counts.tagsDeleted += r.tagsDeleted;
    counts.legalHoldsDeleted += r.legalHoldsDeleted;
    counts.formFillsDeleted += r.formFillsDeleted;
    counts.minioObjectsShredded += r.minioObjectsShredded;
  }

  return { erased: counts.documentsTombstoned, counts };
}

/** Seed shape for the in-memory {@link DocumentEraseStore} (slice/tests). */
export interface InMemoryDocumentEraseSeed {
  /** The candidates a first erase evaluates (empty by default — a no-op erase that satisfies the boot contract). */
  readonly candidates?: ReadonlyArray<DocumentEraseCandidate>;
  /** Per-document destroy result a `destroy` outcome reports (defaults to one version, no satellites). */
  readonly perDocument?: DocumentDestroyResult;
}

/** An in-memory {@link DocumentEraseStore} for the slice/tests (seeded candidates; idempotent on a second erase). */
export function createInMemoryDocumentEraseStore(seed: InMemoryDocumentEraseSeed = {}): {
  store: DocumentEraseStore;
  locked: string[];
} {
  const candidates = seed.candidates ?? [];
  const perDocument: DocumentDestroyResult = seed.perDocument ?? {
    versionsDeleted: 1,
    tagsDeleted: 0,
    legalHoldsDeleted: 0,
    formFillsDeleted: 0,
    minioObjectsShredded: 1,
  };
  const locked: string[] = [];
  let used = false;
  return {
    locked,
    store: {
      async lockPatient(_org, patientId) {
        locked.push(patientId);
      },
      async listDestructionCandidates() {
        // idempotent: a second erase finds nothing (rows already tombstoned).
        const out = used ? [] : candidates;
        used = true;
        return out;
      },
      async destroyDocument() {
        return perDocument;
      },
    },
  };
}

/** Injected adapter for the M22 `documents` eraser (slice defaults to in-memory). */
export interface DocumentEraserDeps {
  store?: DocumentEraseStore;
  /** Bound from the M4 destruction certificate in prod; the slice keeps the conservative defaults. */
  options?: DocumentEraseOptions;
}

/** Build M22's `documents` DataEraser. `subjectId` is the patient being destroyed (§3.7 / §8.6). */
export function createDocumentEraser(
  store: DocumentEraseStore,
  options: DocumentEraseOptions = {},
): DataEraser {
  return {
    async erase(scope, subjectId) {
      const { erased } = await eraseDocumentRecord(scope.orgId, subjectId, store, options);
      return { erased };
    },
  };
}

/** Register M22's REAL `documents` eraser over the Phase-0 deny-stub (M22-T10; before validateErasers()). */
export function registerDocumentErasers(deps: DocumentEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryDocumentEraseStore().store;
  registerEraser("documents", createDocumentEraser(store, deps.options ?? {}));
}
