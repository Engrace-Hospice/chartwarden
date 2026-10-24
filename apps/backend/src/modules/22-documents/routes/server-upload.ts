// apps/backend/src/modules/22-documents/routes/server-upload.ts — GAP-068: the single-request document
// upload behind `POST /api/v1/documents` and `POST /api/v1/documents/:id/versions`.
//
// The bytes arrive in the request (base64 in the JSON body — the platform has no multipart parser, and the
// presigned two-step flow in ./verified-upload.ts stays the path for browser uploads). This service is the
// ONLY place those bytes become an object + rows, and it does in order:
//   1. validate (fail closed, before any IO): size 1..MAX_DOCUMENT_UPLOAD_BYTES, MIME allowlist, the
//      content's magic bytes match the declared MIME, and — when the caller declared a SHA-256 — the
//      server-computed digest equals it. The digest and size persisted are ALWAYS the server-computed ones.
//   2. malware posture: when `scanRequired` is set a scanner MUST be bound, otherwise the upload is refused
//      503 (never stored unscanned). An infected verdict is a 422 and nothing is stored.
//   3. store the object under the tenant bucket (`putObject`, which also enforces the SHA-256 at the store),
//      then insert document + version (+ tags) in ONE org-scoped transaction under the actor's audit
//      identity. If the transaction fails the object is destroyed best-effort (nothing references it).
// No store bound -> 503 `document-storage` (the only remaining DegradedError). Org and actor are server
// facts handed in by the route; nothing here reads them from the body.
import { createHash, randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DocumentAggregateType, OrgId } from "@chartwarden/types";
import { ChartWardenError, DegradedError, NotFoundError } from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { deriveTenantBucket } from "../lifecycle/storage";
import type { ObjectStorePort } from "../seams/store";
import type {
  DocumentWriteActor,
  UploadDocumentArgs,
  UploadVersionArgs,
  UploadedContent,
} from "./service";
import { MAX_DOCUMENT_UPLOAD_BYTES, type ReferralAccessReader } from "./verified-upload";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  DOCX_MIME,
] as const;
type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** Leading-byte signatures per MIME (DOCX is an OOXML zip container). */
const MAGIC_PREFIXES: Readonly<Record<AllowedMime, readonly (readonly number[])[]>> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/tiff": [
    [0x49, 0x49, 0x2a, 0x00],
    [0x4d, 0x4d, 0x00, 0x2a],
  ],
  [DOCX_MIME]: [[0x50, 0x4b, 0x03, 0x04]],
};

export type ContentScanVerdict = { readonly verdict: "clean" | "infected" };

/** A malware scanner over the verified bytes. None is bound in this repo yet; see `scanRequired`. */
export interface DocumentContentScanner {
  scan(input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }): Promise<ContentScanVerdict>;
}

export interface UploadLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ServerUploadDeps {
  readonly db: DbClient;
  readonly objects: ObjectStorePort | null;
  readonly referralReader?: ReferralAccessReader;
  readonly scanner?: DocumentContentScanner | null;
  /** Fail closed when no scanner is bound (production posture while no scanner implementation exists). */
  readonly scanRequired?: boolean;
  readonly logger?: UploadLogger;
  readonly now?: () => Date;
  readonly randomId?: () => string;
}

export interface CommittedUpload {
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNumber: number;
}

export interface ServerUploadService {
  createDocument(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    args: UploadDocumentArgs,
  ): Promise<CommittedUpload>;
  createVersion(
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    args: UploadVersionArgs,
  ): Promise<CommittedUpload>;
}

export interface VerifiedContent {
  readonly mimeType: AllowedMime;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

/** Pure content gate: size, MIME allowlist, magic bytes, declared digest. Throws a typed 4xx. */
export function verifyUploadContent(content: UploadedContent): VerifiedContent {
  const { bytes, mimeType, sha256Hex } = content;
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new ChartWardenError("UNSUPPORTED_MEDIA_TYPE", "unsupported document MIME type", 415);
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new ChartWardenError(
      "UPLOAD_SIZE_INVALID",
      `document byteSize must be between 1 and ${MAX_DOCUMENT_UPLOAD_BYTES}`,
      422,
    );
  }
  const allowed = mimeType as AllowedMime;
  const matchesMagic = MAGIC_PREFIXES[allowed].some((prefix) =>
    prefix.every((byte, i) => bytes[i] === byte),
  );
  if (!matchesMagic) {
    throw new ChartWardenError(
      "UPLOAD_CONTENT_MISMATCH",
      "document content does not match the declared MIME type",
      415,
    );
  }
  const computed = createHash("sha256").update(bytes).digest("hex");
  if (sha256Hex !== undefined && sha256Hex !== computed) {
    throw new ChartWardenError(
      "UPLOAD_INTEGRITY_MISMATCH",
      "document content does not match the declared SHA-256",
      422,
    );
  }
  return { mimeType: allowed, byteSize: bytes.byteLength, sha256Hex: computed };
}

/** Strict base64 decode (the body field is attacker-shaped; `Buffer.from` alone is lenient). */
export function decodeBase64Content(contentBase64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new ChartWardenError("VALIDATION_FAILED", "contentBase64 is not valid base64", 422);
  }
  return new Uint8Array(Buffer.from(contentBase64, "base64"));
}

export function createServerUploadService(deps: ServerUploadDeps): ServerUploadService {
  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const D = schema.documents;
  const V = schema.documentVersions;
  const TAG = schema.documentTags;
  const LH = schema.documentLegalHold;

  const inOrg = <T>(organizationId: OrgId, userId: string, fn: (tx: DbClient) => Promise<T>) =>
    withOrgContext(deps.db, { organizationId, userId }, (tx) => fn(tx as DbClient));

  function requireStore(): ObjectStorePort {
    if (!deps.objects) {
      throw new DegradedError(
        "document-storage",
        "document upload requires the configured MinIO/S3 adapter",
      );
    }
    return deps.objects;
  }

  async function assertScanned(content: UploadedContent, verified: VerifiedContent) {
    if (!deps.scanner) {
      if (deps.scanRequired) {
        throw new DegradedError(
          "document-scanner",
          "document upload requires a malware scanner and none is bound",
        );
      }
      return;
    }
    const result = await deps.scanner.scan({ bytes: content.bytes, mimeType: verified.mimeType });
    if (result.verdict !== "clean") {
      throw new ChartWardenError(
        "UPLOAD_REJECTED",
        "the uploaded file was rejected by content scan",
        422,
      );
    }
  }

  async function assertReferralAccess(
    organizationId: OrgId,
    userId: string,
    aggregateType: string,
    aggregateId: string | null,
  ) {
    if (aggregateType !== "referral") return;
    if (!aggregateId) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        "aggregateId is required for referral documents",
        422,
      );
    }
    if (!deps.referralReader) {
      throw new DegradedError(
        "referral-reader",
        "referral document uploads require the M6 ReferralReader seam",
      );
    }
    const ok = await deps.referralReader.canAccessReferral({
      organizationId,
      userId,
      referralId: aggregateId,
    });
    if (!ok) throw new NotFoundError("referral");
  }

  /** Lock the document row and refuse a write onto an immutable / held document. Returns its facts. */
  async function lockWritableDocument(
    tx: DbClient,
    organizationId: OrgId,
    documentId: string,
    expectedPatientId?: string | null,
  ) {
    await tx.execute(sql`select id from document where id = ${documentId} for update`);
    const [doc] = await tx
      .select({
        id: D.id,
        status: D.status,
        aggregateType: D.aggregateType,
        activeVersionId: D.activeVersionId,
        patientId: D.patientId,
      })
      .from(D)
      .where(and(eq(D.id, documentId), eq(D.organizationId, organizationId)))
      .limit(1);
    if (!doc) throw new NotFoundError("document");
    // #641 — the route's scope check saw this patient; a row that has since moved is out of scope.
    if (expectedPatientId !== undefined && doc.patientId !== expectedPatientId)
      throw new NotFoundError("document");
    const [hold] = await tx
      .select({ id: LH.id })
      .from(LH)
      .where(and(eq(LH.documentId, documentId), isNull(LH.releasedAt)))
      .limit(1);
    if (hold || doc.status === "legal_hold" || doc.status === "destroyed_tombstone") {
      throw new ChartWardenError("DOCUMENT_IMMUTABLE", "document cannot accept a new version", 409);
    }
    return doc;
  }

  function objectKeyFor(aggregateType: string): string {
    return `uploads/${randomId()}/${aggregateType}-${randomId().slice(0, 12)}`;
  }

  /** Store the object, run `commit`, and destroy the object if the commit fails (nothing references it). */
  async function storeThenCommit(
    organizationId: OrgId,
    objectKey: string,
    content: UploadedContent,
    verified: VerifiedContent,
    commit: () => Promise<CommittedUpload>,
  ): Promise<CommittedUpload> {
    const objects = requireStore();
    const bucket = deriveTenantBucket(organizationId);
    const stored = await objects.putObject({
      bucket,
      objectKey,
      bytes: content.bytes,
      mimeType: verified.mimeType,
    });
    if (stored.sha256Hex !== verified.sha256Hex) {
      await destroyQuietly(organizationId, objectKey);
      throw new ChartWardenError(
        "UPLOAD_INTEGRITY_MISMATCH",
        "stored object does not match the verified checksum",
        422,
      );
    }
    try {
      return await commit();
    } catch (error) {
      await destroyQuietly(organizationId, objectKey);
      throw error;
    }
  }

  async function destroyQuietly(organizationId: OrgId, objectKey: string): Promise<void> {
    try {
      await requireStore().destroyAllVersions({
        bucket: deriveTenantBucket(organizationId),
        objectKey,
        organizationId,
      });
    } catch {
      deps.logger?.warn(
        { organizationId, objectKey },
        "m22 upload: orphaned object could not be removed after a failed commit",
      );
    }
  }

  async function insertVersion(
    tx: DbClient,
    organizationId: OrgId,
    actor: DocumentWriteActor,
    documentId: string,
    versionNumber: number,
    replacesVersionId: string | null,
    objectKey: string,
    verified: VerifiedContent,
  ): Promise<string> {
    const [version] = await tx
      .insert(V)
      .values({
        organizationId,
        documentId,
        versionNumber: String(versionNumber),
        replacesVersionId,
        minioObjectKey: objectKey,
        mimeType: verified.mimeType,
        byteSize: String(verified.byteSize),
        sha256Hex: verified.sha256Hex,
        sha256VerifiedAt: now(),
        uploadedByMembershipId: actor.membershipId,
        uploadedByKind: "user",
      })
      .returning({ id: V.id });
    if (!version) throw new Error("document version insert returned no row");
    return version.id;
  }

  return {
    async createDocument(organizationId, actor, args) {
      requireStore();
      const verified = verifyUploadContent(args.content);
      await assertReferralAccess(
        organizationId,
        actor.userId,
        args.aggregateType,
        args.aggregateId,
      );
      await assertScanned(args.content, verified);
      const objectKey = objectKeyFor(args.aggregateType);
      return storeThenCommit(organizationId, objectKey, args.content, verified, () =>
        inOrg(organizationId, actor.userId, async (tx) => {
          const [doc] = await tx
            .insert(D)
            .values({
              organizationId,
              patientId: args.patientId,
              admissionId: args.admissionId,
              retentionClass: args.retentionClass,
              sourceKind: "user_upload",
              aggregateType: args.aggregateType as DocumentAggregateType,
              aggregateId: args.aggregateId,
              title: args.title,
              patientFacing: args.patientFacing,
              metadata: null,
              createdByMembershipId: actor.membershipId,
            })
            .returning({ id: D.id });
          if (!doc) throw new Error("document insert returned no row");
          const versionId = await insertVersion(
            tx,
            organizationId,
            actor,
            doc.id,
            1,
            null,
            objectKey,
            verified,
          );
          await tx
            .update(D)
            .set({ activeVersionId: versionId, updatedAt: now() })
            .where(eq(D.id, doc.id));
          for (const t of args.tags) {
            await tx.insert(TAG).values({
              organizationId,
              documentId: doc.id,
              tagKind: t.tagKind,
              tagKey: t.tagKey,
              tagValue: t.tagValue,
              addedByMembershipId: actor.membershipId,
            });
          }
          return { documentId: doc.id, versionId, versionNumber: 1 };
        }),
      );
    },

    async createVersion(organizationId, actor, documentId, args) {
      requireStore();
      const verified = verifyUploadContent(args.content);
      const target = await inOrg(organizationId, actor.userId, (tx) =>
        lockWritableDocument(tx, organizationId, documentId, args.expectedPatientId),
      );
      await assertScanned(args.content, verified);
      const objectKey = objectKeyFor(target.aggregateType);
      return storeThenCommit(organizationId, objectKey, args.content, verified, () =>
        inOrg(organizationId, actor.userId, async (tx) => {
          const doc = await lockWritableDocument(
            tx,
            organizationId,
            documentId,
            args.expectedPatientId,
          );
          const rows = await tx
            .select({ versionNumber: V.versionNumber })
            .from(V)
            .where(eq(V.documentId, documentId));
          const versionNumber =
            rows.reduce((max, row) => Math.max(max, Number(row.versionNumber)), 0) + 1;
          const versionId = await insertVersion(
            tx,
            organizationId,
            actor,
            documentId,
            versionNumber,
            doc.activeVersionId,
            objectKey,
            verified,
          );
          await tx
            .update(D)
            .set({
              activeVersionId: versionId,
              updatedAt: now(),
              ...(args.title !== undefined ? { title: args.title } : {}),
            })
            .where(eq(D.id, documentId));
          return { documentId, versionId, versionNumber };
        }),
      );
    },
  };
}
