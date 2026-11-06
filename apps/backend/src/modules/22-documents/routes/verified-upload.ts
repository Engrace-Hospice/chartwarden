import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type DocumentAggregateType,
  type DocumentRetentionClass,
  ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES,
} from "@chartwarden/types";
import { ChartWardenError, DegradedError, ForbiddenError, NotFoundError } from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
import { assertNotInternalOnlyForWrite, isInternalOnlyAggregateType } from "../internal-documents";
import { deriveTenantBucket } from "../lifecycle/storage";
import type { ObjectReaderPort, ObjectStorePort } from "../seams/store";
import type { DocumentProvenanceMetadata } from "./service";

const UPLOAD_TTL_MS = 15 * 60 * 1000;
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff", DOCX_MIME]);
/**
 * ADR-0109 D10 (PR 3) — the grief-library VIDEO policy: `video/mp4` is accepted ONLY for an org-level library document
 * (`ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES`), ONLY on this presigned path (the server-upload route never buffers a video; its MIME list has no mp4),
 * up to {@link MAX_LIBRARY_VIDEO_BYTES} with the declared size signed into the presigned PUT, and `complete` reads the first bytes back and refuses
 * anything without an ISO-BMFF `ftyp` box. No transcoding (deferred): what the agency uploads is what families stream.
 */
export const VIDEO_MP4_MIME = "video/mp4";
export const MAX_LIBRARY_VIDEO_BYTES = 500 * 1024 * 1024;
const FTYP_PROBE_BYTES = 12;

const isLibraryType = (aggregateType: string): boolean =>
  ORG_LIBRARY_DOCUMENT_AGGREGATE_TYPES.has(aggregateType as DocumentAggregateType);

/** Pure: does this head of a file carry an ISO-BMFF `ftyp` box at offset 4 (every mp4 starts with one)? */
export function hasMp4FtypBox(head: Uint8Array): boolean {
  return (
    head.byteLength >= 8 &&
    head[4] === 0x66 /* f */ &&
    head[5] === 0x74 /* t */ &&
    head[6] === 0x79 /* y */ &&
    head[7] === 0x70 /* p */
  );
}

export interface ReferralAccessReader {
  canAccessReferral(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly referralId: string;
  }): Promise<boolean>;
}

export interface InitiateVerifiedUploadInput {
  readonly mode: "new_document" | "new_version";
  readonly targetDocumentId: string | null;
  readonly patientId: string | null;
  readonly admissionId: string | null;
  readonly retentionClass: DocumentRetentionClass;
  readonly aggregateType: DocumentAggregateType;
  readonly aggregateId: string | null;
  readonly title: string;
  readonly patientFacing: boolean;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  readonly sourceMetadata?: DocumentProvenanceMetadata;
}

export interface VerifiedUploadService {
  initiate(args: {
    organizationId: string;
    userId: string;
    membershipId: string;
    input: InitiateVerifiedUploadInput;
  }): Promise<{
    uploadId: string;
    uploadUrl: string;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresAt: string;
  }>;
  complete(args: {
    organizationId: string;
    userId: string;
    membershipId: string;
    uploadId: string;
  }): Promise<{ documentId: string; versionId: string; versionNumber: number }>;
  abort(args: {
    organizationId: string;
    userId: string;
    membershipId: string;
    uploadId: string;
  }): Promise<void>;
}

function validateInput(input: InitiateVerifiedUploadInput): void {
  assertNotInternalOnlyForWrite(input.aggregateType);
  if ((input.mode === "new_version") !== Boolean(input.targetDocumentId)) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "targetDocumentId is required only when mode is 'new_version'",
      422,
    );
  }
  const isVideo = input.mimeType === VIDEO_MP4_MIME && isLibraryType(input.aggregateType);
  if (!MIME_TYPES.has(input.mimeType) && !isVideo) {
    throw new ChartWardenError("UNSUPPORTED_MEDIA_TYPE", "unsupported document MIME type", 415);
  }
  // A grief-library document is agency content: never filed on a patient's chart.
  if (
    isLibraryType(input.aggregateType) &&
    (input.patientId !== null || input.admissionId !== null)
  ) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "a grief-library document is org-level: it names no patient or admission",
      422,
    );
  }
  const maxBytes = isVideo ? MAX_LIBRARY_VIDEO_BYTES : MAX_DOCUMENT_UPLOAD_BYTES;
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > maxBytes) {
    throw new ChartWardenError(
      "UPLOAD_SIZE_INVALID",
      `document byteSize must be between 1 and ${maxBytes}`,
      422,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256Hex)) {
    throw new ChartWardenError("VALIDATION_FAILED", "sha256Hex must be lowercase SHA-256 hex", 422);
  }
}

function assertStore(objects: ObjectStorePort | null): ObjectStorePort {
  if (!objects) {
    throw new DegradedError(
      "document-storage",
      "verified document upload requires the configured MinIO/S3 adapter",
    );
  }
  return objects;
}

/** The mp4 head probe. No reader bound => false (fail closed: an unverifiable video is refused). */
async function mp4HeadOk(
  reader: ObjectReaderPort | null,
  organizationId: string,
  objectKey: string,
): Promise<boolean> {
  if (reader === null) return false;
  const head = await reader.getObject({
    bucket: deriveTenantBucket(organizationId),
    objectKey,
    maxBytes: FTYP_PROBE_BYTES,
    firstBytes: FTYP_PROBE_BYTES,
  });
  return head !== null && hasMp4FtypBox(head);
}

/** Two-step upload: presigned checksum-enforced PUT, then authoritative HEAD verification and DB commit. */
export function createVerifiedUploadService(deps: {
  readonly db: DbClient;
  readonly objects: ObjectStorePort | null;
  /** Reads an upload's first bytes back (the mp4 `ftyp` check). Unbound => a video upload cannot complete (fail closed). */
  readonly reader?: ObjectReaderPort | null;
  readonly referralReader?: ReferralAccessReader;
  readonly now?: () => Date;
  readonly randomId?: () => string;
}): VerifiedUploadService {
  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const U = schema.documentUploads;
  const D = schema.documents;
  const V = schema.documentVersions;

  const inOrg = <T>(organizationId: string, userId: string, fn: (tx: DbClient) => Promise<T>) =>
    withOrgContext(deps.db, { organizationId, userId }, (tx) => fn(tx as DbClient));

  async function validateReferralAccess(
    organizationId: string,
    userId: string,
    input: InitiateVerifiedUploadInput,
  ) {
    if (input.aggregateType !== "referral") return;
    if (!input.aggregateId) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        "aggregateId is required for referral documents",
        422,
      );
    }
    const reader = deps.referralReader;
    if (!reader) {
      throw new DegradedError(
        "referral-reader",
        "referral document uploads require the M6 ReferralReader seam",
      );
    }
    if (
      !(await reader.canAccessReferral({ organizationId, userId, referralId: input.aggregateId }))
    ) {
      throw new NotFoundError("referral");
    }
  }

  function documentSourceKind(metadata: DocumentProvenanceMetadata | undefined) {
    switch (metadata?.sourceChannel) {
      case "fax":
        return "fax_ingest" as const;
      case "portal":
        return "portal_upload" as const;
      case "api":
      case "email":
        return "api_ingest" as const;
      default:
        return "user_upload" as const;
    }
  }

  return {
    async initiate({ organizationId, userId, membershipId, input }) {
      const objects = assertStore(deps.objects);
      validateInput(input);
      await validateReferralAccess(organizationId, userId, input);
      const uploadId = randomId();
      const opaqueVersionId = randomId();
      const objectKey = `uploads/${uploadId}/${input.aggregateType}-${opaqueVersionId.slice(0, 12)}`;
      const expiresAt = new Date(now().getTime() + UPLOAD_TTL_MS);

      if (input.targetDocumentId) {
        const targetDocumentId = input.targetDocumentId;
        await inOrg(organizationId, userId, async (tx) => {
          const [doc] = await tx
            .select({ id: D.id, status: D.status, aggregateType: D.aggregateType })
            .from(D)
            .where(eq(D.id, targetDocumentId))
            .limit(1);
          if (!doc) throw new NotFoundError("document");
          // Render-only and never a version target for anyone: answer as if absent (no internal/unknown oracle).
          if (isInternalOnlyAggregateType(doc.aggregateType)) throw new NotFoundError("document");
          if (doc.status === "legal_hold" || doc.status === "destroyed_tombstone") {
            throw new ChartWardenError(
              "DOCUMENT_IMMUTABLE",
              "document cannot accept a new version",
              409,
            );
          }
        });
      }

      await inOrg(organizationId, userId, async (tx) => {
        await tx.insert(U).values({
          id: uploadId,
          organizationId,
          createdByMembershipId: membershipId,
          targetDocumentId: input.targetDocumentId,
          patientId: input.patientId,
          admissionId: input.admissionId,
          retentionClass: input.retentionClass,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          title: input.title,
          patientFacing: input.patientFacing,
          objectKey,
          mimeType: input.mimeType,
          expectedByteSize: String(input.byteSize),
          expectedSha256Hex: input.sha256Hex,
          sourceMetadata: input.sourceMetadata ?? null,
          expiresAt,
        });
      });

      try {
        const presigned = await objects.presignUpload({
          bucket: deriveTenantBucket(organizationId),
          objectKey,
          mimeType: input.mimeType,
          sha256Hex: input.sha256Hex,
          ttlSeconds: UPLOAD_TTL_MS / 1000,
          // a video's declared size is signed: the store refuses a body of any other length
          ...(input.mimeType === VIDEO_MP4_MIME ? { contentLength: input.byteSize } : {}),
        });
        return {
          uploadId,
          uploadUrl: presigned.url,
          requiredHeaders: presigned.headers,
          expiresAt: presigned.expiresAt,
        };
      } catch (error) {
        await inOrg(organizationId, userId, async (tx) => {
          await tx.update(U).set({ status: "aborted", updatedAt: now() }).where(eq(U.id, uploadId));
        });
        throw error;
      }
    },

    async complete({ organizationId, userId, membershipId, uploadId }) {
      const objects = assertStore(deps.objects);
      const upload = await inOrg(organizationId, userId, async (tx) => {
        const [row] = await tx.select().from(U).where(eq(U.id, uploadId)).limit(1);
        return row ?? null;
      });
      if (!upload) throw new NotFoundError("document upload");
      if (upload.createdByMembershipId !== membershipId) throw new ForbiddenError();
      if (upload.status === "completed") {
        if (!upload.completedDocumentId || !upload.completedVersionId) {
          throw new Error("completed document upload is missing result identifiers");
        }
        const completedDocumentId = upload.completedDocumentId;
        const completedVersionId = upload.completedVersionId;
        return {
          documentId: completedDocumentId,
          versionId: completedVersionId,
          versionNumber: await inOrg(organizationId, userId, async (tx) => {
            const [version] = await tx
              .select({ versionNumber: V.versionNumber })
              .from(V)
              .where(eq(V.id, completedVersionId))
              .limit(1);
            if (!version) throw new NotFoundError("document version");
            return Number(version.versionNumber);
          }),
        };
      }
      if (upload.status !== "pending") {
        throw new ChartWardenError("UPLOAD_NOT_COMPLETABLE", `upload is ${upload.status}`, 409);
      }
      if (upload.expiresAt.getTime() <= now().getTime()) {
        await inOrg(organizationId, userId, async (tx) => {
          await tx.update(U).set({ status: "expired", updatedAt: now() }).where(eq(U.id, uploadId));
        });
        throw new ChartWardenError("UPLOAD_EXPIRED", "document upload has expired", 410);
      }

      const object = await objects.inspectObject({
        bucket: deriveTenantBucket(organizationId),
        objectKey: upload.objectKey,
      });
      if (!object)
        throw new ChartWardenError("UPLOAD_INCOMPLETE", "uploaded object is not available", 409);
      const integrityMatches =
        object.byteSize === Number(upload.expectedByteSize) &&
        object.mimeType === upload.mimeType &&
        object.sha256Hex === upload.expectedSha256Hex;
      // ADR-0109 D10 (PR 3) — a video must really be an mp4: read its head back and look for the `ftyp` box.
      const videoLooksWrong =
        integrityMatches && upload.mimeType === VIDEO_MP4_MIME
          ? !(await mp4HeadOk(deps.reader ?? null, organizationId, upload.objectKey))
          : false;
      if (!integrityMatches || videoLooksWrong) {
        await inOrg(organizationId, userId, async (tx) => {
          await tx.update(U).set({ status: "aborted", updatedAt: now() }).where(eq(U.id, uploadId));
        });
        await objects.destroyAllVersions({
          bucket: deriveTenantBucket(organizationId),
          objectKey: upload.objectKey,
          organizationId,
        });
        throw new ChartWardenError(
          "UPLOAD_INTEGRITY_MISMATCH",
          videoLooksWrong
            ? "uploaded object is not an MP4 video"
            : "uploaded object does not match the declared checksum, size, and MIME type",
          422,
        );
      }

      return inOrg(organizationId, userId, async (tx) => {
        await tx.execute(sql`select id from document_upload where id = ${uploadId} for update`);
        const [current] = await tx.select().from(U).where(eq(U.id, uploadId)).limit(1);
        if (!current) throw new NotFoundError("document upload");
        if (current.status === "completed") {
          if (!current.completedDocumentId || !current.completedVersionId) {
            throw new Error("completed document upload is missing result identifiers");
          }
          const [existingVersion] = await tx
            .select({ versionNumber: V.versionNumber })
            .from(V)
            .where(eq(V.id, current.completedVersionId))
            .limit(1);
          return {
            documentId: current.completedDocumentId,
            versionId: current.completedVersionId,
            versionNumber: Number(existingVersion?.versionNumber ?? "1"),
          };
        }
        if (current.status !== "pending") {
          throw new ChartWardenError("UPLOAD_NOT_COMPLETABLE", `upload is ${current.status}`, 409);
        }

        let documentId = current.targetDocumentId;
        let versionNumber = 1;
        let replacesVersionId: string | null = null;
        if (documentId) {
          await tx.execute(sql`select id from document where id = ${documentId} for update`);
          const [doc] = await tx
            .select({ id: D.id, activeVersionId: D.activeVersionId, status: D.status })
            .from(D)
            .where(and(eq(D.id, documentId), eq(D.organizationId, organizationId)))
            .limit(1);
          if (!doc) throw new NotFoundError("document");
          if (doc.status === "legal_hold" || doc.status === "destroyed_tombstone") {
            throw new ChartWardenError(
              "DOCUMENT_IMMUTABLE",
              "document cannot accept a new version",
              409,
            );
          }
          const rows = await tx
            .select({ versionNumber: V.versionNumber })
            .from(V)
            .where(eq(V.documentId, documentId));
          versionNumber =
            rows.reduce((max, row) => Math.max(max, Number(row.versionNumber)), 0) + 1;
          replacesVersionId = doc.activeVersionId;
        } else {
          const [doc] = await tx
            .insert(D)
            .values({
              organizationId,
              patientId: current.patientId,
              admissionId: current.admissionId,
              retentionClass: current.retentionClass,
              sourceKind: documentSourceKind(
                current.sourceMetadata as DocumentProvenanceMetadata | undefined,
              ),
              aggregateType: current.aggregateType,
              aggregateId: current.aggregateId,
              title: current.title,
              patientFacing: current.patientFacing,
              metadata: current.sourceMetadata ?? null,
              createdByMembershipId: membershipId,
            })
            .returning({ id: D.id });
          if (!doc) throw new Error("document insert returned no row");
          documentId = doc.id;
        }

        const [version] = await tx
          .insert(V)
          .values({
            organizationId,
            documentId,
            versionNumber: String(versionNumber),
            replacesVersionId,
            minioObjectKey: current.objectKey,
            mimeType: current.mimeType,
            byteSize: current.expectedByteSize,
            sha256Hex: current.expectedSha256Hex,
            sha256VerifiedAt: now(),
            uploadedByMembershipId: membershipId,
            uploadedByKind: "user",
          })
          .returning({ id: V.id });
        if (!version) throw new Error("document version insert returned no row");
        await tx
          .update(D)
          .set({ activeVersionId: version.id, title: current.title, updatedAt: now() })
          .where(eq(D.id, documentId));
        await tx
          .update(U)
          .set({
            status: "completed",
            completedDocumentId: documentId,
            completedVersionId: version.id,
            completedAt: now(),
            updatedAt: now(),
          })
          .where(eq(U.id, uploadId));
        return { documentId, versionId: version.id, versionNumber };
      });
    },

    async abort({ organizationId, userId, membershipId, uploadId }) {
      const objects = assertStore(deps.objects);
      const upload = await inOrg(organizationId, userId, async (tx) => {
        const [row] = await tx.select().from(U).where(eq(U.id, uploadId)).limit(1);
        if (!row) throw new NotFoundError("document upload");
        if (row.createdByMembershipId !== membershipId) throw new ForbiddenError();
        if (row.status === "completed") {
          throw new ChartWardenError(
            "UPLOAD_NOT_ABORTABLE",
            "completed upload cannot be aborted",
            409,
          );
        }
        await tx.update(U).set({ status: "aborted", updatedAt: now() }).where(eq(U.id, uploadId));
        return row;
      });
      await objects.destroyAllVersions({
        bucket: deriveTenantBucket(organizationId),
        objectKey: upload.objectKey,
        organizationId,
      });
    },
  };
}
