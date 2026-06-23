// apps/backend/__tests__/document-eraser.test.ts — M22-T10 (§3.7 / §8.6 / §7.14 W14; D12).
//
// The `documents` DataEraser orchestration: lock the patient, evaluate each retention-elapsed candidate against the
// pure §7.14 D12 destruction policy, destroy the non-held / non-SUD documents (tombstone + cascade + MinIO/DEK
// shred), SKIP the legal-hold ones, REFUSE the `compliance_42cfr_part2` (SUD) ones during the patient's lifetime,
// and report the deleted-row tally. No DB / MinIO — the store is the in-memory slice double.
import { describe, expect, it } from "vitest";
import {
  type DocumentEraseCandidate,
  createInMemoryDocumentEraseStore,
  eraseDocumentRecord,
} from "../src/modules/22-documents/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";

const candidate = (id: string, over: Partial<DocumentEraseCandidate> = {}): DocumentEraseCandidate => ({
  documentId: id,
  retentionClass: "clinical_record",
  hasActiveLegalHold: false,
  ...over,
});

describe("M22 documents eraser (§3.7 / §8.6 / §7.14 W14, D12)", () => {
  it("locks the patient, then destroys the non-held / non-SUD documents and tallies the cascade", async () => {
    const { store, locked } = createInMemoryDocumentEraseStore({
      candidates: [candidate("a"), candidate("b")],
      perDocument: { versionsDeleted: 2, tagsDeleted: 1, legalHoldsDeleted: 0, formFillsDeleted: 1, minioObjectsShredded: 3 },
    });

    const { erased, counts } = await eraseDocumentRecord(ORG, PATIENT, store);

    expect(locked).toEqual([PATIENT]); // the per-patient advisory lock fired exactly once
    expect(erased).toBe(2); // both documents tombstoned
    expect(counts.documentsTombstoned).toBe(2);
    expect(counts.versionsDeleted).toBe(4);
    expect(counts.tagsDeleted).toBe(2);
    expect(counts.formFillsDeleted).toBe(2);
    expect(counts.minioObjectsShredded).toBe(6);
    expect(counts.legalHoldSkips).toBe(0);
    expect(counts.sudRefusals).toBe(0);
  });

  it("SKIPS a legal-hold document (D12 wins first) — never tombstoned", async () => {
    const { store } = createInMemoryDocumentEraseStore({
      candidates: [candidate("held", { hasActiveLegalHold: true }), candidate("free")],
    });

    const { erased, counts } = await eraseDocumentRecord(ORG, PATIENT, store);

    expect(erased).toBe(1); // only the free document
    expect(counts.legalHoldSkips).toBe(1);
    expect(counts.documentsTombstoned).toBe(1);
  });

  it("REFUSES a compliance_42cfr_part2 (SUD) document during the patient's lifetime (D23 → M4 eraseAuditRows)", async () => {
    const { store } = createInMemoryDocumentEraseStore({
      candidates: [candidate("sud", { retentionClass: "compliance_42cfr_part2" }), candidate("clinical")],
    });

    const { erased, counts } = await eraseDocumentRecord(ORG, PATIENT, store);

    expect(erased).toBe(1); // only the clinical document
    expect(counts.sudRefusals).toBe(1);
    expect(counts.legalHoldSkips).toBe(0);
  });

  it("legal hold outranks the SUD refusal when both apply (decideDestruction order)", async () => {
    const { store } = createInMemoryDocumentEraseStore({
      candidates: [candidate("sud-held", { retentionClass: "compliance_42cfr_part2", hasActiveLegalHold: true })],
    });

    const { erased, counts } = await eraseDocumentRecord(ORG, PATIENT, store);

    expect(erased).toBe(0);
    expect(counts.legalHoldSkips).toBe(1);
    expect(counts.sudRefusals).toBe(0);
  });

  it("is idempotent — a second erase finds nothing left to destroy", async () => {
    const { store } = createInMemoryDocumentEraseStore({ candidates: [candidate("a")] });

    const first = await eraseDocumentRecord(ORG, PATIENT, store);
    const second = await eraseDocumentRecord(ORG, PATIENT, store);

    expect(first.erased).toBe(1);
    expect(second.erased).toBe(0);
  });
});
