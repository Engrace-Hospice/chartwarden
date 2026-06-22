// apps/backend/__tests__/document-lifecycle.test.ts — M22-T03 (§2.2.1, §2.2.2, §2.3, §2.4, §7.9, §7.10, §7.14).
//
// The pure M22 document-lifecycle domain: the §2.2.1 aggregate state machine (create / add-version / legal-hold
// apply+release / tombstone), the §2.2.2 append-only version-ledger guards, the §2.3 retention-class rules + D9
// promotion + D12 destruction policy, the §3.3 D1 MinIO key model + §7.10 D11 opaque presigned leaf, the §2.4 /
// §164.528 signed-URL TTL clamp + access-log effects, and the §2.4 patient-merge redirect. No DB, no MinIO, no
// clock — every function is a validated, declarative factory over resolved context.
import { describe, expect, it } from "vitest";
import {
  type DocumentSideEffect,
  type M22ErrorCode,
  type VersionInput,
  DocumentStateError,
  SHORT_VERSION_ID_LEN,
  SIGNED_URL_MAX_TTL_SECONDS,
  accessLogEffects,
  addVersion,
  applyLegalHold,
  assertPatientBindingChange,
  assertRetentionClassChange,
  changeRetentionClass,
  clampSignedUrlTtlSeconds,
  createDocument,
  decideDestruction,
  intakeObjectKey,
  isWithinSignedUrlIdempotencyWindow,
  opaqueDownloadFilename,
  outboxEvents,
  releaseLegalHold,
  renderedObjectKey,
  resolveEffectivePatientId,
  retentionClassAfterWriteback,
  tenantBucket,
  tombstoneDocument,
} from "../src/modules/22-documents/domain/index";

/** Assert `fn` throws a {@link DocumentStateError} carrying the exact §2.3 `code`. */
function expectCode(fn: () => unknown, code: M22ErrorCode): void {
  expect(fn).toThrow(DocumentStateError);
  try {
    fn();
  } catch (e) {
    expect((e as DocumentStateError).code).toBe(code);
  }
}

const version = (over: Partial<VersionInput> = {}): VersionInput => ({
  versionNumber: 1,
  minioObjectKey: "documents/patient-1/encounter/doc-1/ver-1.pdf",
  sha256Hex: "a".repeat(64),
  mimeType: "application/pdf",
  uploadedByKind: "system_render",
  uploadedByMembershipId: null,
  ...over,
});

const kinds = (effects: readonly DocumentSideEffect[]): string[] => effects.map((e) => e.kind);

// ── §2.2.1 create ───────────────────────────────────────────────────────────────────────────────────
describe("createDocument (§2.2.1)", () => {
  it("inserts v1 active, flips active_version, audits, and emits m22.document.created", () => {
    const r = createDocument({ retentionClass: "clinical_record", sourceKind: "form_render", firstVersion: version() });
    expect(r.status).toBe("active");
    expect(kinds(r.effects)).toEqual(["audit", "insert_version", "set_active_version", "outbox"]);
    expect(outboxEvents(r.effects)).toEqual(["m22.document.created"]);
  });

  it("rejects a first version that is not version_number 1 (§2.3 monotonicity)", () => {
    expectCode(
      () => createDocument({ retentionClass: "operational", sourceKind: "user_upload", firstVersion: version({ versionNumber: 2 }) }),
      "DOCUMENT_VERSION_NOT_MONOTONIC",
    );
  });

  it("requires a sha256 on the version (§2.3 sha256 immutability)", () => {
    expectCode(
      () => createDocument({ retentionClass: "operational", sourceKind: "user_upload", firstVersion: version({ sha256Hex: "" }) }),
      "DOCUMENT_SHA256_REQUIRED",
    );
  });

  it("enforces the §2.3 uploader shape (user ⇔ membership id present)", () => {
    expectCode(
      () => createDocument({ retentionClass: "operational", sourceKind: "user_upload", firstVersion: version({ uploadedByKind: "user", uploadedByMembershipId: null }) }),
      "DOCUMENT_UPLOADER_SHAPE_INVALID",
    );
  });
});

// ── §2.2.2 add version ──────────────────────────────────────────────────────────────────────────────
describe("addVersion (§2.2.2)", () => {
  it("appends a strictly-monotonic version and flips active_version without transitioning the document", () => {
    const r = addVersion({ currentStatus: "active", currentActiveVersionNumber: 1, newVersion: version({ versionNumber: 2 }) });
    expect(r.status).toBe("active");
    expect(outboxEvents(r.effects)).toEqual(["m22.document.versioned"]);
  });

  it("supersedes the document on the D21 external-source two-PDF case", () => {
    const r = addVersion({ currentStatus: "active", currentActiveVersionNumber: 1, newVersion: version({ versionNumber: 2 }), supersedeDocument: true });
    expect(r.status).toBe("superseded");
    expect(kinds(r.effects)).toContain("set_status");
  });

  it("rejects a non-monotonic version number", () => {
    expectCode(
      () => addVersion({ currentStatus: "active", currentActiveVersionNumber: 1, newVersion: version({ versionNumber: 3 }) }),
      "DOCUMENT_VERSION_NOT_MONOTONIC",
    );
  });

  it("refuses a new version on a tombstoned document", () => {
    expectCode(
      () => addVersion({ currentStatus: "destroyed_tombstone", currentActiveVersionNumber: 1, newVersion: version({ versionNumber: 2 }) }),
      "DOCUMENT_TOMBSTONED",
    );
  });

  it("refuses a new version on a legally-held document", () => {
    expectCode(
      () => addVersion({ currentStatus: "legal_hold", currentActiveVersionNumber: 1, newVersion: version({ versionNumber: 2 }) }),
      "DOCUMENT_NOT_VERSIONABLE",
    );
  });
});

// ── §2.3 retention class ────────────────────────────────────────────────────────────────────────────
describe("retention class (§2.3, D9, D12)", () => {
  it("allows the clinical_record → compliance upgrade", () => {
    expect(() => assertRetentionClassChange("clinical_record", "compliance")).not.toThrow();
    expect(kinds(changeRetentionClass({ from: "clinical_record", to: "compliance" }))).toEqual(["audit", "set_retention_class"]);
  });

  it("returns no effects for a no-op change", () => {
    expect(changeRetentionClass({ from: "compliance", to: "compliance" })).toEqual([]);
  });

  it("forbids a downgrade", () => {
    expectCode(() => assertRetentionClassChange("compliance", "clinical_record"), "DOCUMENT_RETENTION_DOWNGRADE_FORBIDDEN");
  });

  it("treats compliance_42cfr_part2 as immutable on either side (D23)", () => {
    expectCode(() => assertRetentionClassChange("compliance_42cfr_part2", "compliance"), "DOCUMENT_SUD_RETENTION_IMMUTABLE");
    expectCode(() => assertRetentionClassChange("clinical_record", "compliance_42cfr_part2"), "DOCUMENT_SUD_RETENTION_IMMUTABLE");
  });

  it("promotes intake_artifact → clinical_record on first committed candidate (D9)", () => {
    expect(retentionClassAfterWriteback("intake_artifact", true)).toBe("clinical_record");
    expect(retentionClassAfterWriteback("intake_artifact", false)).toBe("intake_artifact");
    expect(retentionClassAfterWriteback("clinical_record", true)).toBe("clinical_record");
  });

  it("decides destruction: legal hold wins, then SUD refusal, else destroy (D12)", () => {
    expect(decideDestruction({ retentionClass: "clinical_record", hasActiveLegalHold: true }).outcome).toBe("skip_legal_hold");
    expect(decideDestruction({ retentionClass: "compliance_42cfr_part2", hasActiveLegalHold: false }).outcome).toBe("skip_compliance_42cfr_part2");
    expect(decideDestruction({ retentionClass: "clinical_record", hasActiveLegalHold: false }).outcome).toBe("destroy");
  });
});

// ── §2.4 legal hold + tombstone ─────────────────────────────────────────────────────────────────────
describe("legal hold + tombstone (§2.4, §7.14)", () => {
  it("applies a hold: active → legal_hold + insert + emit", () => {
    const r = applyLegalHold({ currentStatus: "active" });
    expect(r.status).toBe("legal_hold");
    expect(outboxEvents(r.effects)).toEqual(["m22.document.legal_hold_applied"]);
  });

  it("refuses a second active hold", () => {
    expectCode(() => applyLegalHold({ currentStatus: "legal_hold" }), "DOCUMENT_ALREADY_ON_LEGAL_HOLD");
  });

  it("releases a hold: legal_hold → active + emit", () => {
    const r = releaseLegalHold({ currentStatus: "legal_hold" });
    expect(r.status).toBe("active");
    expect(outboxEvents(r.effects)).toEqual(["m22.document.legal_hold_released"]);
  });

  it("refuses releasing a hold that is not held", () => {
    expectCode(() => releaseLegalHold({ currentStatus: "active" }), "DOCUMENT_NOT_ON_LEGAL_HOLD");
  });

  it("tombstones: deletes object versions, shreds DEK, nulls active version, preserves the row", () => {
    const r = tombstoneDocument({ currentStatus: "active" });
    expect(r.status).toBe("destroyed_tombstone");
    expect(kinds(r.effects)).toEqual(["audit", "delete_minio_object_versions", "shred_version_dek", "set_status", "null_active_version", "outbox"]);
  });

  it("blocks tombstoning a legally-held document (D12 non-negotiable)", () => {
    expectCode(() => tombstoneDocument({ currentStatus: "legal_hold" }), "DOCUMENT_DESTRUCTION_BLOCKED_LEGAL_HOLD");
  });

  it("refuses tombstoning an already-tombstoned document", () => {
    expectCode(() => tombstoneDocument({ currentStatus: "destroyed_tombstone" }), "DOCUMENT_TOMBSTONED");
  });
});

// ── §3.3 D1 / §7.10 D11 storage keys ────────────────────────────────────────────────────────────────
describe("object storage (D1, D11)", () => {
  it("scopes the bucket per tenant", () => {
    expect(tenantBucket("org-7")).toBe("tenant-org-7");
  });

  it("builds the internal patient-prefixed rendered key (D1)", () => {
    expect(renderedObjectKey({ patientId: "p1", documentType: "encounter", documentId: "d1", versionId: "v1" })).toBe(
      "documents/p1/encounter/d1/v1.pdf",
    );
  });

  it("builds the batch-prefixed intake key (no patient prefix)", () => {
    expect(intakeObjectKey({ batchId: "b1", leaf: "page-3.png" })).toBe("intake/b1/page-3.png");
  });

  it("builds the opaque PHI-free presigned leaf (D11/SEC-015)", () => {
    const token = "Ab3xY9zQ12cD".slice(0, SHORT_VERSION_ID_LEN);
    expect(opaqueDownloadFilename("encounter", token)).toBe(`encounter-${token}.pdf`);
  });

  it("rejects a non-opaque short token (no PHI leaks into the URL leaf)", () => {
    expectCode(() => opaqueDownloadFilename("encounter", "García"), "DOCUMENT_OBJECT_KEY_REQUIRED");
    expectCode(() => opaqueDownloadFilename("Free Text Type", "Ab3xY9zQ12cD"), "DOCUMENT_OBJECT_KEY_REQUIRED");
  });
});

// ── §7.10 D11 / §2.4 / §2.6 signed-URL TTL + access log ─────────────────────────────────────────────
describe("signed-URL TTL + access log (§7.10, §2.4, §2.6)", () => {
  it("clamps to 5 min non-portal / 60 min portal", () => {
    expect(clampSignedUrlTtlSeconds(99999, false)).toBe(SIGNED_URL_MAX_TTL_SECONDS.nonPortal);
    expect(clampSignedUrlTtlSeconds(99999, true)).toBe(SIGNED_URL_MAX_TTL_SECONDS.portal);
    expect(clampSignedUrlTtlSeconds(120, false)).toBe(120);
  });

  it("rejects a non-positive TTL", () => {
    expectCode(() => clampSignedUrlTtlSeconds(0, false), "DOCUMENT_SIGNED_URL_TTL_INVALID");
  });

  it("honours the 5-second idempotency window (§2.6)", () => {
    expect(isWithinSignedUrlIdempotencyWindow(1000, 4000)).toBe(true);
    expect(isWithinSignedUrlIdempotencyWindow(1000, 7000)).toBe(false);
  });

  it("emits the §164.528 access-log + audit, and the signed-url outbox stream", () => {
    expect(kinds(accessLogEffects("metadata_read"))).toEqual(["insert_access_log", "audit"]);
    expect(outboxEvents(accessLogEffects("signed_url_issued"))).toEqual(["m22.signed_url.issued"]);
    expect(outboxEvents(accessLogEffects("signed_url_consumed"))).toEqual(["m22.signed_url.consumed"]);
  });
});

// ── §2.4 patient-merge redirect ─────────────────────────────────────────────────────────────────────
describe("patient-merge redirect (§2.4, §2.3)", () => {
  const chain: Record<string, string> = { a: "b", b: "c" }; // a → b → c (survivor)
  const mergedInto = (id: string): string | null => chain[id] ?? null;

  it("follows the merge chain to its terminal survivor", () => {
    expect(resolveEffectivePatientId("a", mergedInto)).toBe("c");
    expect(resolveEffectivePatientId("c", mergedInto)).toBe("c");
  });

  it("throws on a merge cycle", () => {
    const cyclic = (id: string): string | null => ({ x: "y", y: "x" } as Record<string, string>)[id] ?? null;
    expectCode(() => resolveEffectivePatientId("x", cyclic), "DOCUMENT_MERGE_CHAIN_UNRESOLVED");
  });

  it("permits a binding change only via merge to the resolved survivor (§2.3)", () => {
    expect(() => assertPatientBindingChange({ from: "a", to: "c", viaMerge: true, resolvedSurvivorId: "c" })).not.toThrow();
    expect(() => assertPatientBindingChange({ from: "a", to: "a", viaMerge: false, resolvedSurvivorId: "a" })).not.toThrow();
  });

  it("refuses a non-merge binding change and a merge to a non-survivor", () => {
    expectCode(() => assertPatientBindingChange({ from: "a", to: "z", viaMerge: false, resolvedSurvivorId: "c" }), "DOCUMENT_PATIENT_BINDING_IMMUTABLE");
    expectCode(() => assertPatientBindingChange({ from: "a", to: "z", viaMerge: true, resolvedSurvivorId: "c" }), "DOCUMENT_PATIENT_BINDING_IMMUTABLE");
  });
});
