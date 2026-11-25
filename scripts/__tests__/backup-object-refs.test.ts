import { describe, expect, it } from "vitest";
import { renderChecks } from "../lib/backup/drill-report";
import {
  type LiveRef,
  type ManifestEntry,
  OBJECT_REF_SOURCES,
  indexManifest,
  locate,
  objectRefCheck,
  parseManifest,
  reconcileRef,
  resolveObjectRefSource,
  unclassifiedRefColumns,
} from "../lib/backup/object-refs";

const entry = (b: string, k: string, h: string): ManifestEntry => ({ b, k, s: 3, e: "etag", h });
const ref = (key: string, sha: string | null = "aa"): LiveRef => ({
  table: "message_attachment",
  organizationId: "org-a",
  key,
  sha256: sha,
});

describe("object reference registry", () => {
  it("flags a discovered object-reference column that is neither registered nor excluded", () => {
    // Arrange
    const discovered = [
      "message_attachment.object_key",
      "hope_submission.envelope_storage_uri",
      "new_module.object_key",
    ];

    // Act
    const unclassified = unclassifiedRefColumns(discovered);

    // Assert
    expect(unclassified).toEqual(["new_module.object_key"]);
  });

  it("registers each table/column pair once", () => {
    const ids = OBJECT_REF_SOURCES.map((s) => `${s.table}.${s.keyColumn}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("object reference columns across the 1546 rename", () => {
  const source = (table: string) => {
    const found = OBJECT_REF_SOURCES.find((s) => s.table === table);
    if (!found) throw new Error(`no registered source for ${table}`);
    return found;
  };

  it("reads the new column names on a schema that has them", () => {
    // Arrange
    const discovered = ["document_version.object_key", "dsar_export_job.bundle_object_key"];

    // Act / Assert
    expect(resolveObjectRefSource(source("document_version"), discovered).keyColumn).toBe(
      "object_key",
    );
    expect(resolveObjectRefSource(source("dsar_export_job"), discovered).keyColumn).toBe(
      "bundle_object_key",
    );
  });

  it("falls back to the legacy column names on a snapshot taken before the rename", () => {
    // Arrange: a restore of a pre-1546 snapshot still has minio_object_key / bundle_minio_object_key
    const discovered = [
      "document_version.minio_object_key",
      "dsar_export_job.bundle_minio_object_key",
      "message_attachment.object_key",
    ];

    // Act
    const document = resolveObjectRefSource(source("document_version"), discovered);
    const dsar = resolveObjectRefSource(source("dsar_export_job"), discovered);

    // Assert: the key column and every mention of it in the liveness predicate move together
    expect(document.keyColumn).toBe("minio_object_key");
    expect(dsar.keyColumn).toBe("bundle_minio_object_key");
    expect(dsar.liveWhere).toBe("t.bundle_minio_object_key IS NOT NULL AND t.status = 'fulfilled'");
    expect(dsar.liveWhere).not.toContain("t.bundle_object_key");
    expect(resolveObjectRefSource(source("message_attachment"), discovered).keyColumn).toBe(
      "object_key",
    );
  });

  it("keeps the new name when neither column exists, so the query fails loudly instead of reading nothing", () => {
    expect(resolveObjectRefSource(source("remittance_advice"), []).keyColumn).toBe("object_key");
  });

  it("classifies the legacy column names as registered, not as an unknown object reference", () => {
    // Arrange
    const discovered = [
      "document_version.minio_object_key",
      "remittance_advice.minio_object_key",
      "fhir_bulk_export_artifact.minio_object_key",
      "dsar_export_job.bundle_minio_object_key",
      "tenant_export_job.bundle_minio_object_key",
      "new_module.minio_object_key",
    ];

    // Act / Assert
    expect(unclassifiedRefColumns(discovered)).toEqual(["new_module.minio_object_key"]);
  });
});

describe("manifest", () => {
  it("parses ndjson and skips blank lines", () => {
    const parsed = parseManifest(
      `${JSON.stringify(entry("b1", "k1", "aa"))}\n\n${JSON.stringify(entry("b2", "k2", "bb"))}\n`,
    );
    expect(parsed.map((e) => e.k)).toEqual(["k1", "k2"]);
  });

  it("locates a key in the tenant bucket first, otherwise the only bucket holding it", () => {
    const byKey = indexManifest([
      entry("tenant-a", "k1", "aa"),
      entry("platform", "k1", "bb"),
      entry("platform", "k2", "cc"),
    ]);
    expect(locate(byKey, ref("k1"), "tenant-a")?.bucket).toBe("tenant-a");
    expect(locate(byKey, ref("k2"), "tenant-a")?.bucket).toBe("platform");
    expect(locate(byKey, ref("k3"), "tenant-a")).toBeNull();
  });

  it("refuses to guess when a key is in several non-tenant buckets", () => {
    const byKey = indexManifest([entry("x", "k1", "aa"), entry("y", "k1", "aa")]);
    expect(locate(byKey, ref("k1"), "tenant-a")).toBeNull();
  });
});

describe("reconcileRef", () => {
  const located = { bucket: "tenant-a", entry: entry("tenant-a", "k1", "aa") };

  it("passes when restored bytes equal the snapshot and the row", () => {
    expect(reconcileRef(ref("k1", "AA"), located, { sha256: "aa" })).toBeNull();
  });

  it("names each kind of inconsistency", () => {
    expect(reconcileRef(ref("k1"), null, null)?.problem).toBe("not-in-snapshot");
    expect(reconcileRef(ref("k1"), located, null)?.problem).toBe("missing-after-restore");
    expect(reconcileRef(ref("k1"), located, { sha256: "zz" })?.problem).toBe(
      "bytes-differ-from-snapshot",
    );
    const otherBytes = { bucket: "tenant-a", entry: entry("tenant-a", "k1", "bb") };
    expect(reconcileRef(ref("k1", "aa"), otherBytes, { sha256: "bb" })?.problem).toBe(
      "bytes-differ-from-row",
    );
  });

  it("skips the row comparison when the table records no sha256", () => {
    expect(reconcileRef(ref("k1", null), located, { sha256: "aa" })).toBeNull();
  });
});

describe("objectRefCheck", () => {
  it("fails on any finding and never prints object keys", () => {
    const check = objectRefCheck(
      2,
      [{ ref: ref("secret-key-name"), problem: "missing-after-restore" }],
      {
        message_attachment: 2,
      },
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toBe("1 message_attachment:missing-after-restore");
    expect(check.detail).not.toContain("secret-key-name");
  });

  it("is not vacuous: zero references is a failure", () => {
    expect(objectRefCheck(0, [], {}).ok).toBe(false);
    expect(objectRefCheck(3, [], { message_attachment: 3 }).ok).toBe(true);
  });
});

describe("renderChecks", () => {
  it("escapes pipes in details so the markdown table stays intact", () => {
    expect(renderChecks([{ name: "n", ok: true, detail: "a|b" }])).toContain("| PASS | n | a/b |");
  });
});
