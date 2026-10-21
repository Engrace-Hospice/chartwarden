// apps/backend/src/modules/22-documents/lifecycle/storage.ts — M22-T03 (§2.2 / §11 D1 / D11).
//
// The per-tenant MinIO object-storage MODEL as pure planning logic. D1 fixes the physical layout (one
// bucket per tenant, opaque keys); D11 fixes that the key + URL filename are PHI-free by construction.
// This file derives the bucket name, the object key and the presign descriptor as DATA — no MinIO SDK
// import, no network IO. The real client (presign + version-aware delete) is the injected
// `DocumentStorageProvider` port (@chartwarden/types); these helpers compute the arguments it is handed.
import type {
  DocumentAccessKind,
  DocumentAggregateType,
  OrgId,
  SignedUrlDescriptor,
} from "@chartwarden/types";

/** §11 D1 — one bucket per tenant: `tenant-{tenantId}`. The only place this string is shaped. */
export function deriveTenantBucket(organizationId: OrgId): string {
  return `tenant-${organizationId}`;
}

/** §11 D11 — the opaque per-version filename. `shortVersionId` is a random 12-char token (never the real
 * uuid, never a patient identifier). The aggregate type is a fixed enum value, also PHI-free. */
export function deriveObjectFilename(
  aggregateType: DocumentAggregateType,
  shortVersionId: string,
): string {
  return `${aggregateType}-${shortVersionId}.pdf`;
}

/**
 * §11 D1 — derive the full per-version object key. Rendered documents path under
 * `documents/{patientId}/{aggregateType}/{documentId}/{filename}`; intake artifacts (no patient yet,
 * `kind='intake'`) path under `intake/{batchId}/{filename}` so an unmatched upload never sits under a
 * patient prefix. The key is opaque (D11): no free-text title, no MRN, no DOB — only ids + enum values.
 */
export function deriveObjectKey(args: {
  readonly kind: "rendered" | "intake";
  readonly aggregateType: DocumentAggregateType;
  readonly documentId: string;
  readonly patientId: string | null;
  readonly batchId: string | null;
  readonly shortVersionId: string;
}): string {
  const filename = deriveObjectFilename(args.aggregateType, args.shortVersionId);
  if (args.kind === "intake") {
    if (!args.batchId) throw new Error("intake object key requires a batchId");
    return `intake/${args.batchId}/${filename}`;
  }
  // rendered: patientId may be null only for org-level operational docs; fall back to a stable bucket.
  const patientPrefix = args.patientId ?? "unbound";
  return `documents/${patientPrefix}/${args.aggregateType}/${args.documentId}/${filename}`;
}

/** §4.12 / §2.6 — the short-TTL presign descriptor a download plan hands the storage port. 5-minute floor
 * (300s) per the signed-URL TTL workflow (W10); callers may pass a tighter ttl, never looser. */
export const SIGNED_URL_TTL_SECONDS = 300;

/** Build the {@link SignedUrlDescriptor} for one object version (pure; the port presigns it later). */
export function planSignedUrl(args: {
  readonly organizationId: OrgId;
  readonly objectKey: string;
  readonly accessKind: DocumentAccessKind;
  readonly ttlSeconds?: number;
}): SignedUrlDescriptor {
  const ttl = args.ttlSeconds ?? SIGNED_URL_TTL_SECONDS;
  return {
    bucket: deriveTenantBucket(args.organizationId),
    objectKey: args.objectKey,
    // never looser than the platform floor (W10): a request for a longer ttl is clamped down.
    ttlSeconds: Math.min(ttl, SIGNED_URL_TTL_SECONDS),
    accessKind: args.accessKind,
  };
}
