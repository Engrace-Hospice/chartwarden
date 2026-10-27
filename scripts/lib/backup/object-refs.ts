/**
 * Which database columns point at an object in the object store, and the pure row <-> object reconciliation the
 * restore verifier runs (#857). No IO here: scripts/__tests__/backup-object-refs.test.ts pins every verdict.
 *
 * The registry is a ratchet. The verifier discovers every column whose NAME looks like an object reference
 * ({@link OBJECT_REF_COLUMN_PATTERN}); one that is neither registered nor explicitly excluded fails the check, so a new
 * module that stores objects cannot silently fall outside the backup's reconciliation.
 */
import type { Check } from "../restore-drill/report";

export interface ObjectRefSource {
  readonly table: string;
  readonly keyColumn: string;
  /** Column holding the sha256 of the stored bytes, when the table records one. */
  readonly shaColumn: string | null;
  /** SQL predicate over alias `t`: rows for which the object MUST exist (completed, not destroyed, ...). */
  readonly liveWhere: string;
}

export const OBJECT_REF_SOURCES: readonly ObjectRefSource[] = [
  {
    table: "message_attachment",
    keyColumn: "object_key",
    shaColumn: "sha256_hex",
    liveWhere: "t.completed_at IS NOT NULL AND t.object_destroyed_at IS NULL",
  },
  {
    table: "document_version",
    keyColumn: "minio_object_key",
    shaColumn: "sha256_hex",
    liveWhere:
      "NOT EXISTS (SELECT 1 FROM document d WHERE d.id = t.document_id AND d.status = 'destroyed_tombstone')",
  },
  {
    table: "document_upload",
    keyColumn: "object_key",
    shaColumn: "expected_sha256_hex",
    liveWhere: "t.completed_at IS NOT NULL",
  },
  {
    table: "dsar_export_job",
    keyColumn: "bundle_minio_object_key",
    shaColumn: "bundle_sha256",
    liveWhere: "t.bundle_minio_object_key IS NOT NULL AND t.status = 'fulfilled'",
  },
  {
    table: "tenant_export_job",
    keyColumn: "bundle_minio_object_key",
    shaColumn: "bundle_sha256",
    liveWhere: "t.bundle_minio_object_key IS NOT NULL AND t.status = 'fulfilled'",
  },
  {
    table: "fhir_bulk_export_artifact",
    keyColumn: "minio_object_key",
    shaColumn: "checksum_sha256",
    liveWhere: "TRUE",
  },
  {
    table: "remittance_advice",
    keyColumn: "minio_object_key",
    shaColumn: "file_sha256",
    liveWhere: "TRUE",
  },
  {
    table: "cap_psr_import",
    keyColumn: "file_storage_key",
    shaColumn: "file_sha256",
    liveWhere: "TRUE",
  },
];

/** Columns whose name matches the pattern but which do NOT address this object store, with the reason. */
export const NOT_OBJECT_STORE_REFS: Readonly<Record<string, string>> = {
  "claim_acknowledgment.ack_file_uri":
    "clearinghouse reference (clearinghouse:<event>), not an object key",
  "claim_submission.generated_file_uri": "clearinghouse reference (clearinghouse:<vendor>:<id>)",
  "eligibility_check.raw_response_file_uri": "vendor response reference",
  "hope_submission.envelope_storage_uri": "db://hope_submission/... (stored in the database)",
  "hope_submission.package_storage_uri": "db://hope_submission/... (stored in the database)",
  "hope_submission_item.xml_storage_uri": "db://hope_submission/... (stored in the database)",
  "ai_model_backend.artifact_storage_ref": "model registry reference, not a tenant object",
};

export const OBJECT_REF_COLUMN_PATTERN =
  "(object_key|storage_key|storage_uri|file_uri|storage_ref)$";

export function unclassifiedRefColumns(discovered: readonly string[]): string[] {
  const known = new Set([
    ...OBJECT_REF_SOURCES.map((s) => `${s.table}.${s.keyColumn}`),
    ...Object.keys(NOT_OBJECT_STORE_REFS),
  ]);
  return discovered.filter((c) => !known.has(c)).sort();
}

/** One manifest line written by cw-backup.sh: bucket, key, size, etag, sha256 of the bytes, content type. */
export interface ManifestEntry {
  readonly b: string;
  readonly k: string;
  readonly s: number;
  readonly e: string;
  readonly h: string;
  readonly t?: string;
}

export function parseManifest(ndjson: string): ManifestEntry[] {
  return ndjson
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ManifestEntry);
}

export interface LiveRef {
  readonly table: string;
  readonly organizationId: string;
  readonly key: string;
  readonly sha256: string | null;
}

/** What GETting the restored object (through the app's object-store adapter) returned; null = 404. */
export interface Retrieved {
  readonly sha256: string;
}

export interface Located {
  readonly bucket: string;
  readonly entry: ManifestEntry;
}

/** The manifest entry for a row's key: the tenant bucket first, otherwise the only bucket that holds that key. */
export function locate(
  manifestByKey: ReadonlyMap<string, readonly ManifestEntry[]>,
  ref: LiveRef,
  tenantBucket: string,
): Located | null {
  const candidates = manifestByKey.get(ref.key) ?? [];
  const entry =
    candidates.find((c) => c.b === tenantBucket) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  return entry ? { bucket: entry.b, entry } : null;
}

export function indexManifest(entries: readonly ManifestEntry[]): Map<string, ManifestEntry[]> {
  const out = new Map<string, ManifestEntry[]>();
  for (const e of entries) out.set(e.k, [...(out.get(e.k) ?? []), e]);
  return out;
}

export interface RefFinding {
  readonly ref: LiveRef;
  readonly problem:
    | "not-in-snapshot"
    | "missing-after-restore"
    | "bytes-differ-from-snapshot"
    | "bytes-differ-from-row";
}

/** Reconcile one live row against the snapshot manifest and the restored bytes. Null = consistent. */
export function reconcileRef(
  ref: LiveRef,
  located: Located | null,
  retrieved: Retrieved | null,
): RefFinding | null {
  if (!located) return { ref, problem: "not-in-snapshot" };
  if (!retrieved) return { ref, problem: "missing-after-restore" };
  if (retrieved.sha256 !== located.entry.h) return { ref, problem: "bytes-differ-from-snapshot" };
  if (ref.sha256 !== null && ref.sha256.toLowerCase() !== retrieved.sha256) {
    return { ref, problem: "bytes-differ-from-row" };
  }
  return null;
}

/** Ids are never printed (a key may be all a reader has); only table + problem counts. */
export function objectRefCheck(
  refs: number,
  findings: readonly RefFinding[],
  perTable: Readonly<Record<string, number>>,
): Check {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const k = `${f.ref.table}:${f.problem}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const tables = Object.entries(perTable)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t}=${n}`)
    .join(", ");
  return {
    name: "every live row that references an object has it after restore, retrievable through the app adapter, sha256 = snapshot = row",
    ok: findings.length === 0 && refs > 0,
    detail:
      findings.length === 0
        ? `${refs} object reference(s) reconciled (${tables || "none"})`
        : [...counts].map(([k, n]) => `${n} ${k}`).join("; "),
  };
}
