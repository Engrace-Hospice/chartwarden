// apps/backend/src/modules/31-portal/provisioning/uploads.ts — GAP-092. The portal document upload in three steps:
//
//   begin    validates (size / MIME allowlist / discharged-read-only, the pure §7.8 core) and records an upload intent;
//   stage    takes the caregiver's bytes, re-checks the magic bytes against the declared MIME, and keeps them ONLY as
//            a tenant-DEK envelope on the `portal_document_upload` row (encrypted staging — never in the clear);
//   complete hands the decrypted bytes to M22's intake (a verified document + an intake batch) and clears the
//            staged ciphertext, keeping the provenance. A failed hand-off leaves the staged bytes for a retry.
//
// The caller's account + patient come from the SESSION; a row that is not this account's is a 404.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, ForbiddenError, NotFoundError } from "@chartwarden/types";
import { and, eq, isNull } from "drizzle-orm";
import type { PortalPhiCipher } from "../portal-crypto";
import { planDocumentUpload } from "../write-paths/document-upload";
import { PortalWriteError, requirePortalWrite } from "../write-paths/errors";
import type { PortalUploadIntakePort } from "./types";

const UP = schema.portalDocumentUploads;
const GRANT = schema.portalAccessGrants;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type UploadRow = typeof UP.$inferSelect;

/** How long an initiated upload stays open for its bytes. */
export const PORTAL_UPLOAD_TTL_MS = 15 * 60_000;
/** The leading bytes read for the §7.8 magic-byte re-check (HEIC needs the first 12). */
const MAGIC_WINDOW = 16;

/** The route that takes the bytes (what `signedUploadUrl` points at). */
export const portalUploadContentPath = (uploadId: string): string =>
  `/api/v1/portal/documents/uploads/${uploadId}/content`;

export interface PortalUploads {
  begin(input: {
    readonly organizationId: string;
    readonly actingUserId: string;
    readonly portalAccountId: string;
    readonly patientId: string;
    readonly purpose: string;
    readonly mimeType: string;
    readonly expectedByteSize: number;
    readonly patientDischargedReadOnly: boolean;
  }): Promise<{ uploadId: string; contentPath: string; expiresAt: string }>;
  stage(input: {
    readonly organizationId: string;
    readonly actingUserId: string;
    readonly portalAccountId: string;
    readonly patientId: string;
    readonly uploadId: string;
    readonly bytes: Buffer;
  }): Promise<{ uploadId: string; status: "staged"; byteSize: number }>;
  complete(input: {
    readonly organizationId: string;
    readonly actingUserId: string;
    readonly portalAccountId: string;
    readonly patientId: string;
    readonly uploadId: string;
  }): Promise<{ uploadId: string; status: "received"; documentId: string; intakeBatchId: string }>;
}

export interface PortalUploadsDeps {
  readonly db: DbClient;
  readonly cipher: PortalPhiCipher;
  /** Unbound ⇒ `complete` refuses 503 (the bytes stay staged for a retry). */
  readonly intake?: PortalUploadIntakePort;
  readonly now?: () => Date;
}

export function createPortalUploads(deps: PortalUploadsDeps): PortalUploads {
  const now = deps.now ?? (() => new Date());
  const inOrg = <T>(
    organizationId: string,
    userId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> => withOrgContext(deps.db, { organizationId, userId }, (tx) => fn(tx as Tx));

  /** This account's own upload, or 404 (another account's / another patient's id is indistinguishable). */
  const ownUpload = async (
    tx: Tx,
    portalAccountId: string,
    patientId: string,
    uploadId: string,
  ): Promise<UploadRow> => {
    const [row] = await tx
      .select()
      .from(UP)
      .where(
        and(
          eq(UP.id, uploadId),
          eq(UP.portalAccountId, portalAccountId),
          eq(UP.patientId, patientId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("upload");
    return row;
  };

  return {
    async begin(input) {
      // The pure §7.8 gate: discharged-read-only, size ≤ cap, MIME on the allowlist.
      planDocumentUpload({
        orgId: input.organizationId,
        patientId: input.patientId,
        portalAccountId: input.portalAccountId,
        byteSize: input.expectedByteSize,
        declaredMime: input.mimeType,
        magicBytes: [],
        patientDischargedReadOnly: input.patientDischargedReadOnly,
      });
      return inOrg(input.organizationId, input.actingUserId, async (tx) => {
        // The patient-bearing row takes its tenancy columns from the account's own live grant for the patient.
        const [grant] = await tx
          .select({ providerEntityId: GRANT.providerEntityId, locationId: GRANT.locationId })
          .from(GRANT)
          .where(
            and(
              eq(GRANT.portalAccountId, input.portalAccountId),
              eq(GRANT.patientId, input.patientId),
              isNull(GRANT.revokedAt),
            ),
          )
          .limit(1);
        if (!grant) throw new ForbiddenError("no active portal grant for this patient");
        const expiresAt = new Date(now().getTime() + PORTAL_UPLOAD_TTL_MS);
        const [row] = await tx
          .insert(UP)
          .values({
            organizationId: input.organizationId,
            providerEntityId: grant.providerEntityId,
            locationId: grant.locationId,
            portalAccountId: input.portalAccountId,
            patientId: input.patientId,
            purpose: input.purpose,
            declaredMime: input.mimeType,
            expectedByteSize: input.expectedByteSize,
            expiresAt,
          })
          .returning({ id: UP.id });
        if (!row) throw new Error("portal_document_upload insert returned no row");
        return {
          uploadId: row.id,
          contentPath: portalUploadContentPath(row.id),
          expiresAt: expiresAt.toISOString(),
        };
      });
    },

    async stage(input) {
      // A refusal that must be RECORDED (expired / rejected) is returned out of the transaction and thrown AFTER it
      // commits: throwing inside `withOrgContext` rolls the status update back with it, so the row would stay
      // `initiated` forever (a live test caught exactly that).
      const outcome = await inOrg(input.organizationId, input.actingUserId, async (tx) => {
        const row = await ownUpload(tx, input.portalAccountId, input.patientId, input.uploadId);
        if (row.status === "submitted" || row.status === "rejected" || row.status === "expired") {
          throw new ChartWardenError("UPLOAD_CLOSED", `this upload is already ${row.status}`, 409);
        }
        if (row.expiresAt.getTime() <= now().getTime()) {
          await tx.update(UP).set({ status: "expired" }).where(eq(UP.id, row.id));
          return {
            refusal: new ChartWardenError(
              "UPLOAD_EXPIRED",
              "this upload window has closed; start again",
              410,
            ),
          };
        }
        requirePortalWrite(
          input.bytes.byteLength === row.expectedByteSize,
          "UPLOAD_SIZE_MISMATCH",
          "The file size does not match what was declared. Please re-upload the original file.",
        );
        try {
          // Re-run the §7.8 gate over the REAL bytes: size cap, MIME allowlist and the magic-byte match.
          planDocumentUpload({
            orgId: input.organizationId,
            patientId: input.patientId,
            portalAccountId: input.portalAccountId,
            byteSize: input.bytes.byteLength,
            declaredMime: row.declaredMime,
            magicBytes: [...input.bytes.subarray(0, MAGIC_WINDOW)],
            patientDischargedReadOnly: false,
          });
        } catch (error) {
          if (!(error instanceof PortalWriteError)) throw error;
          await tx
            .update(UP)
            .set({ status: "rejected", rejectionCode: error.code })
            .where(eq(UP.id, row.id));
          return { refusal: error };
        }
        const sealed = await deps.cipher.encrypt(
          input.organizationId,
          "portal_document_upload.content_cipher",
          input.bytes,
        );
        await tx
          .update(UP)
          .set({
            status: "staged",
            contentCipher: sealed.envelope,
            contentKeyVersion: sealed.keyVersion,
            byteSize: input.bytes.byteLength,
            contentSha256: createHash("sha256").update(input.bytes).digest("hex"),
            stagedAt: now(),
          })
          .where(eq(UP.id, row.id));
        return {
          staged: {
            uploadId: row.id,
            status: "staged" as const,
            byteSize: input.bytes.byteLength,
          },
        };
      });
      if ("refusal" in outcome) throw outcome.refusal;
      return outcome.staged;
    },

    async complete(input) {
      const row = await inOrg(input.organizationId, input.actingUserId, (tx) =>
        ownUpload(tx, input.portalAccountId, input.patientId, input.uploadId),
      );
      // Idempotent: a retry after a successful hand-off answers the same ids.
      if (row.status === "submitted" && row.documentId && row.intakeBatchId) {
        return {
          uploadId: row.id,
          status: "received" as const,
          documentId: row.documentId,
          intakeBatchId: row.intakeBatchId,
        };
      }
      if (row.status !== "staged" || !row.contentCipher) {
        throw new ChartWardenError(
          "UPLOAD_NOT_STAGED",
          row.status === "initiated"
            ? "no file has been uploaded for this request yet"
            : `this upload is ${row.status}`,
          409,
        );
      }
      if (!deps.intake) {
        throw new ChartWardenError(
          "PORTAL_UPLOAD_INTAKE_UNAVAILABLE",
          "Documents cannot be filed right now. Your upload is saved; please try again later.",
          503,
        );
      }
      const bytes = await deps.cipher.decrypt(
        input.organizationId,
        "portal_document_upload.content_cipher",
        row.contentCipher,
      );
      const accepted = await deps.intake.accept({
        organizationId: input.organizationId,
        patientId: input.patientId,
        portalAccountId: input.portalAccountId,
        actingUserId: input.actingUserId,
        purpose: row.purpose,
        mimeType: row.declaredMime,
        bytes,
      });
      await inOrg(input.organizationId, input.actingUserId, (tx) =>
        tx
          .update(UP)
          .set({
            status: "submitted",
            contentCipher: null,
            contentKeyVersion: null,
            documentId: accepted.documentId,
            intakeBatchId: accepted.intakeBatchId,
            submittedAt: now(),
          })
          .where(eq(UP.id, row.id)),
      );
      return {
        uploadId: row.id,
        status: "received" as const,
        documentId: accepted.documentId,
        intakeBatchId: accepted.intakeBatchId,
      };
    },
  };
}
