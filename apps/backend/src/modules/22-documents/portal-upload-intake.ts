// apps/backend/src/modules/22-documents/portal-upload-intake.ts — GAP-092. M22's side of the portal document upload: the
// hand-off M31's `upload-complete` makes once a caregiver's staged bytes have passed the portal gate.
//
// It composes M22's OWN services — the verified server upload (size / MIME / magic bytes / SHA-256, the bound object
// store, the optional scanner) and the intake batch — so a portal upload lands exactly like any other intake source:
// an `intake_artifact` document filed against the patient, plus an intake batch (`source_channel = portal_upload`) the
// DocLens pipeline then classifies. M31 injects the result as a locally-declared PORT at the composition root (M31's
// manifest `dependsOn` excludes 22), so M31 imports nothing from here.
//
// FAIL CLOSED: with no object store configured (`MINIO_*` unset) the upload service answers a typed 503 and nothing
// is stored — the portal then keeps the caregiver's staged bytes for a retry.
import type { DbClient } from "@chartwarden/db";
import { getSeam } from "../../bootstrap/index";
import { createDbDocumentBackend } from "./documents-route-service-db";
import { createServerUploadService } from "./routes/server-upload";
import { RENDER_SYSTEM_MEMBERSHIP_ID } from "./seams/drizzle-seam-store";
import { createS3ObjectStore, s3ObjectStoreConfigFromEnv } from "./seams/index";

/** The structural port M31 declares (kept local so M22 imports nothing of M31). */
export interface PortalUploadIntakeAdapter {
  accept(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly portalAccountId: string;
    readonly actingUserId: string;
    readonly purpose: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly documentId: string; readonly intakeBatchId: string }>;
}

export function buildPortalUploadIntakePort(db: DbClient): PortalUploadIntakeAdapter {
  const objectStoreConfig = s3ObjectStoreConfigFromEnv(process.env);
  const objects = objectStoreConfig ? createS3ObjectStore(objectStoreConfig) : null;
  const uploads = createServerUploadService({
    db,
    objects,
    scanRequired: process.env.DOCUMENT_UPLOAD_SCAN_REQUIRED === "true",
    referralReader: {
      canAccessReferral(input) {
        return getSeam("ReferralReader").canAccessReferral(input);
      },
    },
  });
  const service = createDbDocumentBackend(db, {}, uploads).service;

  return {
    async accept(input) {
      // A portal session carries no workforce membership: the document is filed under the M22 system sentinel (the
      // render-consumer precedent) and the audit actor is the caregiver's own user id.
      const actor = { userId: input.actingUserId, membershipId: RENDER_SYSTEM_MEMBERSHIP_ID };
      const document = await service.uploadDocument(input.organizationId as never, actor, {
        patientId: input.patientId,
        admissionId: null,
        retentionClass: "intake_artifact",
        aggregateType: "intake_source",
        aggregateId: null,
        title: `Portal upload (${input.purpose})`,
        patientFacing: false,
        tags: [],
        content: { bytes: input.bytes, mimeType: input.mimeType },
      });
      const batch = await service.uploadBatch(input.organizationId as never, actor, {
        patientId: input.patientId,
        sourceChannel: "portal_upload",
        sourceMetadata: `portal_account:${input.portalAccountId};purpose:${input.purpose}`,
        documentId: document.id,
      });
      return { documentId: document.id, intakeBatchId: batch.id };
    },
  };
}
