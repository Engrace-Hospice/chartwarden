// apps/backend/__tests__/document-lifecycle.test.ts — M22-T03 (§2.2 document lifecycle).
// The pure M22 document-lifecycle domain: versioning (D2), retention/disposition + legal-hold override
// (D9/D23), the legal-hold place/release + destruction-tombstone machine (D12), the access-log append,
// per-tenant storage key derivation (D1/D11), and the patient-merge redirect-on-fetch (§2.4). No DB —
// every fact is injected.
import { describe, expect, it } from "vitest";
import {
  DocumentStateError,
  type MergeFacts,
  applyPatientMergeCascade,
  applyRetentionChange,
  assertPart2NotMutated,
  assertSha256Immutable,
  deriveDispositionDate,
  deriveObjectKey,
  deriveTenantBucket,
  isDestructionEligible,
  planAccessLog,
  planAddVersion,
  planDestructionForDocument,
  planSignedUrl,
  promoteOnWriteback,
  resolveInsertRetentionClass,
  resolvePatientRedirect,
  transitionDocument,
} from "../src/modules/22-documents/lifecycle/index";

/** Pull the outbox event names out of a side-effect list (test helper). */
function outboxEvents(effects: ReadonlyArray<{ kind: string }>): string[] {
  return effects
    .filter((e): e is { kind: "outbox"; event: string } => e.kind === "outbox")
    .map((e) => e.event);
}

const NOW = "2026-06-23T00:00:00.000Z";

describe("Per-tenant storage (§11 D1 / D11)", () => {
  it("deriveTenantBucket: one bucket per tenant", () => {
    expect(deriveTenantBucket("org-1")).toBe("tenant-org-1");
  });

  it("deriveObjectKey (rendered): opaque, patient-prefixed, no PHI", () => {
    const key = deriveObjectKey({
      kind: "rendered",
      aggregateType: "cti",
      documentId: "doc-1",
      patientId: "pat-1",
      batchId: null,
      shortVersionId: "abc123def456",
    });
    expect(key).toBe("documents/pat-1/cti/doc-1/cti-abc123def456.pdf");
    // opaque by construction — only ids + enum values, never a title/MRN/DOB.
    expect(key).not.toMatch(/title|mrn|dob/i);
  });

  it("deriveObjectKey (intake): batch-prefixed, never under a patient", () => {
    const key = deriveObjectKey({
      kind: "intake",
      aggregateType: "intake_source",
      documentId: "doc-2",
      patientId: null,
      batchId: "batch-9",
      shortVersionId: "tok000000001",
    });
    expect(key).toBe("intake/batch-9/intake_source-tok000000001.pdf");
  });

  it("planSignedUrl: clamps TTL to the platform floor (W10) and never looser", () => {
    const d = planSignedUrl({
      organizationId: "org-1",
      objectKey: "documents/pat-1/cti/doc-1/cti-x.pdf",
      accessKind: "signed_url_issued",
      ttlSeconds: 99999,
    });
    expect(d.ttlSeconds).toBe(300);
    expect(d.bucket).toBe("tenant-org-1");
  });
});

describe("Versioning machine (§2.2.2 / D2)", () => {
  it("v1 is genesis: emits m22.document.created, flips active_version, lands active", () => {
    const t = planAddVersion({
      documentId: "doc-1",
      currentMaxVersion: 0,
      plan: {
        versionId: "ver-1",
        versionNumber: 1,
        isFirstVersion: true,
        isCorrection: false,
        supersedePrior: false,
      },
    });
    expect(t.to).toBe("active");
    expect(t.effects.some((e) => e.kind === "flip_active_version")).toBe(true);
    expect(outboxEvents(t.effects)).toContain("m22.document.created");
  });

  it("v2 emits m22.document.versioned and preserves prior versions (append-only)", () => {
    const t = planAddVersion({
      documentId: "doc-1",
      currentMaxVersion: 1,
      plan: {
        versionId: "ver-2",
        versionNumber: 2,
        isFirstVersion: false,
        isCorrection: true,
        supersedePrior: false,
      },
    });
    expect(outboxEvents(t.effects)).toContain("m22.document.versioned");
    // no destroy/delete of the prior version — only a flip.
    expect(t.effects.some((e) => e.kind === "destroy_objects")).toBe(false);
  });

  it("D21 two-PDF supersede marks the prior document status='superseded'", () => {
    const t = planAddVersion({
      documentId: "doc-1",
      currentMaxVersion: 1,
      plan: {
        versionId: "ver-2",
        versionNumber: 2,
        isFirstVersion: false,
        isCorrection: false,
        supersedePrior: true,
      },
    });
    expect(t.effects.some((e) => e.kind === "set_status" && e.status === "superseded")).toBe(true);
  });

  it("a non-monotonic version number is refused", () => {
    expect(() =>
      planAddVersion({
        documentId: "doc-1",
        currentMaxVersion: 3,
        plan: {
          versionId: "ver-x",
          versionNumber: 3,
          isFirstVersion: false,
          isCorrection: false,
          supersedePrior: false,
        },
      }),
    ).toThrow(DocumentStateError);
  });

  it("sha256 is immutable post-insert", () => {
    expect(() => assertSha256Immutable("aaa", "bbb")).toThrowError(/immutable/i);
    // re-asserting the same hash is a no-op (idempotent integrity re-hash).
    expect(() => assertSha256Immutable("aaa", "aaa")).not.toThrow();
    expect(() => assertSha256Immutable(null, "aaa")).not.toThrow();
  });
});

describe("Retention classes & disposition (§8.6 / D9 / D23)", () => {
  it("compliance disposition = dispositionAt + 7y", () => {
    const v = deriveDispositionDate({
      retentionClass: "compliance",
      dispositionAt: "2020-01-01T00:00:00.000Z",
      legalHoldActive: false,
    });
    const expected = new Date(Date.UTC(2020, 0, 1) + 7 * 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(v.dueAt).toBe(expected);
    expect(v.heldByLegalHold).toBe(false);
  });

  it("intake_artifact disposition = dispositionAt + 30d (no writeback)", () => {
    const v = deriveDispositionDate({
      retentionClass: "intake_artifact",
      dispositionAt: "2026-06-01T00:00:00.000Z",
      legalHoldActive: false,
    });
    expect(v.dueAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("clinical_record / compliance_42cfr_part2 have no day-count disposition date", () => {
    expect(
      deriveDispositionDate({
        retentionClass: "clinical_record",
        dispositionAt: NOW,
        legalHoldActive: false,
      }).dueAt,
    ).toBeNull();
    expect(
      deriveDispositionDate({
        retentionClass: "compliance_42cfr_part2",
        dispositionAt: NOW,
        legalHoldActive: false,
      }).dueAt,
    ).toBeNull();
  });

  it("legal hold OVERRIDES retention: never disposable while held (D12)", () => {
    const v = deriveDispositionDate({
      retentionClass: "intake_artifact",
      dispositionAt: "2020-01-01T00:00:00.000Z",
      legalHoldActive: true,
    });
    expect(v.heldByLegalHold).toBe(true);
    expect(v.dueAt).toBeNull();
    expect(isDestructionEligible({ verdict: v, now: NOW })).toBe(false);
  });

  it("isDestructionEligible: true only past the disposition date", () => {
    const v = deriveDispositionDate({
      retentionClass: "intake_artifact",
      dispositionAt: "2026-06-01T00:00:00.000Z",
      legalHoldActive: false,
    });
    expect(isDestructionEligible({ verdict: v, now: "2026-06-15T00:00:00.000Z" })).toBe(false);
    expect(isDestructionEligible({ verdict: v, now: "2026-08-01T00:00:00.000Z" })).toBe(true);
  });

  it("retention change: clinical_record → compliance is the only legal upgrade", () => {
    expect(applyRetentionChange("clinical_record", "compliance")).toBe("compliance");
    // downgrade refused
    expect(() => applyRetentionChange("compliance", "clinical_record")).toThrow(DocumentStateError);
    // arbitrary change refused
    expect(() => applyRetentionChange("operational", "compliance")).toThrow(DocumentStateError);
    // Part 2 is immutable
    expect(() => applyRetentionChange("compliance_42cfr_part2", "compliance")).toThrowError(
      /immutable/i,
    );
    // idempotent same-class
    expect(applyRetentionChange("compliance", "compliance")).toBe("compliance");
  });

  it("D9 promoteOnWriteback: intake_artifact → clinical_record; others unchanged", () => {
    expect(promoteOnWriteback("intake_artifact")).toBe("clinical_record");
    expect(promoteOnWriteback("compliance")).toBe("compliance");
  });

  it("D23 resolveInsertRetentionClass: SUD/override auto-tags compliance_42cfr_part2", () => {
    expect(
      resolveInsertRetentionClass({
        proposed: "clinical_record",
        labResultSudClass: true,
        doclensSudClass: false,
        partTwoOverride: false,
      }),
    ).toBe("compliance_42cfr_part2");
    expect(
      resolveInsertRetentionClass({
        proposed: "clinical_record",
        labResultSudClass: false,
        doclensSudClass: false,
        partTwoOverride: true,
      }),
    ).toBe("compliance_42cfr_part2");
    // no SUD signal ⇒ proposed class stands.
    expect(
      resolveInsertRetentionClass({
        proposed: "clinical_record",
        labResultSudClass: false,
        doclensSudClass: false,
        partTwoOverride: false,
      }),
    ).toBe("clinical_record");
  });

  it("D23 assertPart2NotMutated: a Part-2 doc cannot be reclassified at insert", () => {
    expect(() => assertPart2NotMutated("clinical_record", "compliance_42cfr_part2")).toThrow(
      DocumentStateError,
    );
    expect(() =>
      assertPart2NotMutated("compliance_42cfr_part2", "compliance_42cfr_part2"),
    ).not.toThrow();
  });
});

describe("Document status machine: legal hold place/release (§2.2.1 / §2.4)", () => {
  it("placeLegalHold: active → legal_hold, inserts hold row, emits applied", () => {
    const t = transitionDocument("active", {
      type: "placeLegalHold",
      legalHoldEventId: "lh-1",
      at: NOW,
    });
    expect(t.to).toBe("legal_hold");
    expect(t.effects.some((e) => e.kind === "insert_legal_hold")).toBe(true);
    expect(outboxEvents(t.effects)).toContain("m22.document.legal_hold_applied");
  });

  it("releaseLegalHold: legal_hold → active, emits released", () => {
    const t = transitionDocument("legal_hold", { type: "releaseLegalHold", at: NOW });
    expect(t.to).toBe("active");
    expect(t.effects.some((e) => e.kind === "release_legal_hold")).toBe(true);
    expect(outboxEvents(t.effects)).toContain("m22.document.legal_hold_released");
  });

  it("placing a hold from legal_hold is an illegal transition", () => {
    try {
      transitionDocument("legal_hold", {
        type: "placeLegalHold",
        legalHoldEventId: "x",
        at: NOW,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentStateError).code).toBe("ILLEGAL_TRANSITION");
    }
  });
});

describe("Document status machine: destruction-tombstone (§2.2.1 / D12)", () => {
  it("tombstone: active → destroyed_tombstone, version-aware destroy + DEK shred + null active", () => {
    const t = transitionDocument("active", {
      type: "tombstone",
      certificateId: "cert-1",
      objectKeys: ["documents/pat-1/cti/doc-1/cti-a.pdf", "documents/pat-1/cti/doc-1/cti-b.pdf"],
      bucket: "tenant-org-1",
      at: NOW,
    });
    expect(t.to).toBe("destroyed_tombstone");
    const destroy = t.effects.find((e) => e.kind === "destroy_objects");
    expect(destroy).toBeDefined();
    expect((destroy as { objectKeys: string[] }).objectKeys.length).toBe(2);
    expect(t.effects.some((e) => e.kind === "shred_dek")).toBe(true);
    expect(t.effects.some((e) => e.kind === "null_active_version")).toBe(true);
    // §164.528: an access-log row is APPENDED for the destruction cert (never a delete).
    expect(t.effects.some((e) => e.kind === "access_log")).toBe(true);
    expect(outboxEvents(t.effects)).toEqual(
      expect.arrayContaining(["m22.document.tombstoned", "m22.eraser.completed"]),
    );
  });

  it("D12: a legally-held document can NEVER be tombstoned", () => {
    try {
      transitionDocument("legal_hold", {
        type: "tombstone",
        certificateId: "cert-1",
        objectKeys: ["k"],
        bucket: "tenant-org-1",
        at: NOW,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentStateError);
      expect((e as DocumentStateError).code).toBe("LEGAL_HOLD_BLOCKS_DESTRUCTION");
    }
  });

  it("tombstoning an already-tombstoned document is refused", () => {
    try {
      transitionDocument("destroyed_tombstone", {
        type: "tombstone",
        certificateId: "c",
        objectKeys: ["k"],
        bucket: "b",
        at: NOW,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentStateError).code).toBe("ALREADY_TOMBSTONED");
    }
  });

  it("planDestructionForDocument: skips a held doc, emits legal_hold_skip, no tombstone", () => {
    const skip = planDestructionForDocument({
      status: "active",
      legalHoldActive: true,
      certificateId: "cert-1",
      legalHoldEventId: "lh-1",
      at: NOW,
    });
    expect(skip).not.toBeNull();
    expect(skip?.skipped).toBe(true);
    expect(outboxEvents(skip!.effects)).toContain("m22.eraser.legal_hold_skip");
  });

  it("planDestructionForDocument: returns null (proceed) for an unheld active doc", () => {
    const proceed = planDestructionForDocument({
      status: "active",
      legalHoldActive: false,
      certificateId: "cert-1",
      legalHoldEventId: null,
      at: NOW,
    });
    expect(proceed).toBeNull();
  });
});

describe("Access-log append (§2.4 / §3.3 / §164.528)", () => {
  it("signed_url_issued: appends the row + emits m22.signed_url.issued", () => {
    const plan = planAccessLog({
      organizationId: "org-1",
      documentId: "doc-1",
      documentVersionId: "ver-1",
      accessorMembershipId: "mem-1",
      accessKind: "signed_url_issued",
      purpose: "treatment",
      correlationId: "corr-1",
      accessedAt: NOW,
    });
    expect(plan.entry.documentId).toBe("doc-1");
    expect(plan.outboxEvent).toBe("m22.signed_url.issued");
  });

  it("metadata_read is audit-only (no outbox)", () => {
    const plan = planAccessLog({
      organizationId: "org-1",
      documentId: "doc-1",
      documentVersionId: "ver-1",
      accessorMembershipId: "mem-1",
      accessKind: "metadata_read",
      purpose: "operations",
      correlationId: "corr-2",
      accessedAt: NOW,
    });
    expect(plan.outboxEvent).toBeNull();
  });

  it("disclosure_export emits m22.phi_bundle.exported", () => {
    const plan = planAccessLog({
      organizationId: "org-1",
      documentId: "doc-1",
      documentVersionId: "ver-1",
      accessorMembershipId: "mem-1",
      accessKind: "disclosure_export",
      purpose: "disclosure",
      correlationId: "corr-3",
      accessedAt: NOW,
      recipientClass: "external_partner",
    });
    expect(plan.outboxEvent).toBe("m22.phi_bundle.exported");
    expect(plan.entry.recipientClass).toBe("external_partner");
  });
});

describe("Patient-merge redirect-on-fetch (§2.4 / patient.merged cascade)", () => {
  /** Build MergeFacts from a plain source→survivor map. */
  function facts(map: Record<string, string>): MergeFacts {
    return { survivorOf: (id) => map[id] ?? null };
  }

  it("an unmerged patient resolves to itself (no redirect)", () => {
    const r = resolvePatientRedirect("pat-1", facts({}));
    expect(r.survivingPatientId).toBe("pat-1");
    expect(r.redirected).toBe(false);
    expect(r.hops).toBe(0);
  });

  it("a merged patient redirects to the survivor", () => {
    const r = resolvePatientRedirect("pat-1", facts({ "pat-1": "pat-2" }));
    expect(r.survivingPatientId).toBe("pat-2");
    expect(r.redirected).toBe(true);
    expect(r.hops).toBe(1);
  });

  it("follows a multi-hop chain to the final survivor (within the hop bound)", () => {
    const r = resolvePatientRedirect("pat-1", facts({ "pat-1": "pat-2", "pat-2": "pat-3" }));
    expect(r.survivingPatientId).toBe("pat-3");
    expect(r.hops).toBe(2);
  });

  it("a cycle fails safe to the last resolvable id (never loops/throws)", () => {
    const r = resolvePatientRedirect("pat-1", facts({ "pat-1": "pat-2", "pat-2": "pat-1" }));
    // bounded; resolves without hanging.
    expect(["pat-1", "pat-2"]).toContain(r.survivingPatientId);
  });

  it("applyPatientMergeCascade: re-point to the resolved survivor is the only legal write", () => {
    const f = facts({ "pat-1": "pat-2" });
    expect(applyPatientMergeCascade({ current: "pat-1", requested: "pat-2", facts: f })).toBe(
      "pat-2",
    );
    // re-point to any other patient is refused (patient-binding stability, §2.3).
    try {
      applyPatientMergeCascade({ current: "pat-1", requested: "pat-9", facts: f });
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentStateError).code).toBe("PATIENT_BINDING_IMMUTABLE");
    }
  });
});
