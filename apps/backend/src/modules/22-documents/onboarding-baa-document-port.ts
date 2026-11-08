// apps/backend/src/modules/22-documents/onboarding-baa-document-port.ts — M22's side of the platform BAA-document seam
// (bootstrap/onboarding-baa-document-port.ts): a platform operator uploads the signed business associate agreement for a tenant that is
// still onboarding, through M22's OWN upload pipeline (the content gate, the scan, the tenant's object bucket), on the caller's transaction.
//
// The narrowest door: the document kind, retention class and shape are fixed here, the caller names none of them, the bytes are the only
// input. Nothing is read back and nothing is listed. The document is filed under the operator's own membership (the platform org's), the
// attribution the document table's write-audit trigger also records through `app.user_id`.
//
// FAIL CLOSED like every M22 upload: no object store configured (`MINIO_*` unset) answers a typed 503 and nothing is stored; with
// `DOCUMENT_UPLOAD_SCAN_REQUIRED=true` an unbound scanner does too.
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError, type OrgId } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import {
  type OnboardingBaaDocumentPort,
  type OnboardingBaaDocumentRef,
  TENANT_BAA_DOCUMENT_KIND,
  TENANT_BAA_MAX_BYTES,
} from "../../bootstrap/onboarding-baa-document-port";
import { assertTxScopedToOrg } from "../../bootstrap/onboarding-credential-port";
import {
  type ServerUploadService,
  type UploadLogger,
  createServerUploadService,
  decodeBase64Content,
} from "./routes/server-upload";
import { createS3ObjectStore, s3ObjectStoreConfigFromEnv } from "./seams/index";

const BAA_DOCUMENT_TITLE = "Business associate agreement";
const DOCUMENT = schema.documents;

/** Whether `ref.documentId` is a `tenant_baa` document of `ref.organizationId` (a boolean; reads nothing else). On the caller's transaction. */
export async function isTenantBaaDocumentFiled(
  tx: DbClient,
  ref: OnboardingBaaDocumentRef,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: DOCUMENT.id })
    .from(DOCUMENT)
    .where(
      and(
        eq(DOCUMENT.id, ref.documentId),
        eq(DOCUMENT.organizationId, ref.organizationId),
        eq(DOCUMENT.aggregateType, TENANT_BAA_DOCUMENT_KIND),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The port over an upload service (injected so the unit test needs no object store). */
export function buildTenantBaaDocumentOnboardingPort(
  uploads: Pick<ServerUploadService, "createDocumentOn">,
): OnboardingBaaDocumentPort {
  return {
    isFiled: isTenantBaaDocumentFiled,
    async upload(tx, scope, input) {
      await assertTxScopedToOrg(tx, scope.organizationId);
      const bytes = decodeBase64Content(input.contentBase64);
      // The operator's upload is capped below the general documents limit: a signed BAA is a few pages.
      if (bytes.byteLength > TENANT_BAA_MAX_BYTES) {
        throw new ChartWardenError(
          "UPLOAD_SIZE_INVALID",
          `the signed agreement can be at most ${TENANT_BAA_MAX_BYTES / (1024 * 1024)} MiB`,
          422,
        );
      }
      const filed = await uploads.createDocumentOn(
        tx,
        scope.organizationId as OrgId,
        { userId: scope.operatorUserId, membershipId: scope.operatorMembershipId },
        {
          patientId: null,
          admissionId: null,
          retentionClass: "compliance",
          aggregateType: TENANT_BAA_DOCUMENT_KIND,
          aggregateId: null,
          title: BAA_DOCUMENT_TITLE,
          patientFacing: false,
          tags: [],
          content: { bytes, mimeType: input.mimeType },
        },
      );
      return {
        resourceId: filed.documentId,
        objectKey: filed.objectKey,
        view: {
          documentId: filed.documentId,
          mimeType: filed.mimeType,
          byteSize: filed.byteSize,
          sha256Hex: filed.sha256Hex,
        },
        detail: {
          documentKind: TENANT_BAA_DOCUMENT_KIND,
          mimeType: filed.mimeType,
          byteSize: filed.byteSize,
          sha256Hex: filed.sha256Hex,
        },
        discard: filed.discard,
      };
    },
  };
}

/** The production port: the bound object store (`MINIO_*`) and the scan posture the other M22 uploads use. */
export function buildEnvTenantBaaDocumentOnboardingPort(
  db: DbClient,
  logger: UploadLogger,
): OnboardingBaaDocumentPort {
  const objectStoreConfig = s3ObjectStoreConfigFromEnv(process.env);
  return buildTenantBaaDocumentOnboardingPort(
    createServerUploadService({
      db,
      logger,
      objects: objectStoreConfig ? createS3ObjectStore(objectStoreConfig) : null,
      scanRequired: process.env.DOCUMENT_UPLOAD_SCAN_REQUIRED === "true",
    }),
  );
}
