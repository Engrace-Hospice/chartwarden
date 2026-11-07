// apps/backend/src/bootstrap/onboarding-baa-document-port.ts — the seam through which the platform route (M34
// `POST /api/v1/platform/tenants/:orgSlug/baa-document`) files the signed business associate agreement a platform operator uploads for a
// tenant, without importing M22 (M34 has no `dependsOn` edge to the documents module). The sibling of `onboarding-notice-port.ts`.
//
// M22 implements the port over its OWN upload pipeline (content gate: size, MIME allowlist, magic bytes, SHA-256; the malware scan; the
// tenant's object bucket) on the CALLER'S open transaction, which is already scoped to the target org's `app.org_id` and attributed to the
// operator, so the document rows commit or roll back with the platform audit row. The kind is NOT an input: the port files exactly one
// document kind (`tenant_baa`, never patient-bound, never patient-facing) and the caller cannot name another. It reads nothing back and
// lists nothing: this is the narrowest door into M22 that onboarding step 3 needs.
import type { DbClient } from "@chartwarden/db";
import type { OnboardingWriteScope } from "./onboarding-credential-port";

export type { OnboardingWriteScope } from "./onboarding-credential-port";

/** The one document kind this seam files (the `document_aggregate_type` value, migration 1367). */
export const TENANT_BAA_DOCUMENT_KIND = "tenant_baa";

/**
 * The largest signed agreement the operator's upload takes, in decoded bytes: 10 MiB, well under the general documents cap (25 MiB). A
 * signed BAA is a few pages; the route's body limit and its base64 bound derive from this one figure, and the adapter enforces it on
 * the decoded bytes.
 */
export const TENANT_BAA_MAX_BYTES = 10 * 1024 * 1024;

/** The document as the platform sees it: its id (what the BAA register row links) and what the server verified about the bytes. */
export interface OnboardingBaaDocument {
  readonly documentId: string;
  readonly mimeType: string;
  /** The server-computed size, never the client's claim. */
  readonly byteSize: number;
  /** The server-computed SHA-256 (lower-case hex). */
  readonly sha256Hex: string;
}

export interface OnboardingBaaDocumentUpload {
  /** The document id (the audit row's resource id). */
  readonly resourceId: string;
  readonly view: OnboardingBaaDocument;
  /** Non-sensitive facts for the platform audit row: the kind, the MIME type, the size and the digest. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  /**
   * Take the stored object back out. For the caller whose transaction rolls back after `upload` returned (the rows go with the rollback,
   * the object would not). Best effort: never throws.
   */
  discard(): Promise<void>;
}

/** What `isFiled` is asked: a document id and the organization it must belong to. */
export interface OnboardingBaaDocumentRef {
  readonly organizationId: string;
  readonly documentId: string;
}

export interface OnboardingBaaDocumentPort {
  /**
   * Whether `documentId` is a signed BAA filed for this organization: a document row IN that organization of kind `tenant_baa` (another
   * tenant's document, a document of any other kind and an id that is no document at all are all false). On the caller's transaction, so
   * a BAA register write judges the link in the same transaction that records it. Reads nothing back: a boolean.
   */
  isFiled(tx: DbClient, ref: OnboardingBaaDocumentRef): Promise<boolean>;

  /**
   * File the signed BAA for the tenant `scope` names, on the caller's transaction. The bytes arrive as base64 text: M22 decodes them
   * strictly, so the check is the documents pipeline's own, not a copy. A refused file is a typed 4xx (415 type, 422 not base64 / size /
   * content mismatch / scanner verdict) and nothing is stored; a deployment with no object store answers 503.
   */
  upload(
    tx: DbClient,
    scope: OnboardingWriteScope,
    input: { readonly contentBase64: string; readonly mimeType: string },
  ): Promise<OnboardingBaaDocumentUpload>;
}
