// apps/backend/src/m36-export-binding.ts - the composition-root binding for M36 WP 5.7 (ADR-0089, PROPOSED): the export artefact builder, the
// artefact reader the download route uses, and the expiry sweep, over the real object store, the tenant KEK and the message body cipher.
// Lives at the app root like m36-attachment-storage.ts because it reaches M22's object store (M36 does not depend on M22).
//   · object store: the per-tenant `tenant-<orgId>` bucket through the SAME MinIO/S3 config as attachments; without MINIO_* every call is a typed 503.
//   · keys: the platform KEK adapter M34 uses (`M34_TENANT_KEK`); without it the build fails closed (EXPORT_BUILD_FAILED) and a download is refused.
//   · Part 2: M5's privacy flags through the `PatientPrivacyFlagReader` seam; an unreadable flag fails the build (never "not SUD").
import type { DbClient } from "@chartwarden/db";
import { DegradedError } from "@chartwarden/types";
import { getSeam } from "./bootstrap/index";
import { type PlatformKekRing, createPlatformKekAdapter } from "./bootstrap/tenant-kek";
import { buildM36AttachmentStorage } from "./m36-attachment-storage";
import {
  createS3ObjectStore,
  deriveTenantBucket,
  s3ObjectStoreConfigFromEnv,
} from "./modules/22-documents";
import { createExportBuildStore } from "./modules/36-messaging/export/export-build-store";
import { createExportBuilder } from "./modules/36-messaging/export/export-builder";
import {
  type ExportKeyWrap,
  createExportKeyWrap,
} from "./modules/36-messaging/export/export-crypto";
import {
  createExportExpiryStore,
  createExportExpirySweep,
} from "./modules/36-messaging/export/export-expiry-sweep";
import { createExportArtefactReader } from "./modules/36-messaging/export/export-reader";
import type { HintOutboxPort } from "./modules/36-messaging/message-hint-events";
import type { MessageBodyCipher } from "./modules/36-messaging/messaging-write-core";

/** A stored artefact is read whole to decrypt it: refuse an object beyond this (the build caps messages, not bytes). */
const EXPORT_MAX_ARTEFACT_BYTES = 256 * 1024 * 1024;

interface PrivacyFlagReaderShape {
  roomingFactsFor(input: {
    organizationId: string;
    patientIds: readonly string[];
  }): Promise<readonly { patientId: string; privacyFlags: readonly string[] }[]>;
}

const SUD_PRIVACY_FLAG = "sud";

export function buildM36ExportBinding(deps: {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort;
  readonly env: Record<string, string | undefined>;
  readonly kekRing: PlatformKekRing | null;
  readonly bodyCipher: Pick<MessageBodyCipher, "open">;
}) {
  const attachments = buildM36AttachmentStorage(deps.env);
  const s3 = s3ObjectStoreConfigFromEnv(deps.env);
  const store = s3 ? createS3ObjectStore({ ...s3, publicEndpoint: s3.endpoint }) : null;
  const keys: ExportKeyWrap = deps.kekRing
    ? createExportKeyWrap(createPlatformKekAdapter(deps.kekRing))
    : {
        mint: () =>
          Promise.reject(new DegradedError("export-keys", "tenant key is not configured")),
        unwrap: () =>
          Promise.reject(new DegradedError("export-keys", "tenant key is not configured")),
      };

  const putObject = async (a: {
    organizationId: string;
    objectKey: string;
    bytes: Uint8Array;
  }): Promise<void> => {
    if (!store) throw new DegradedError("export-storage", "the object store is not configured");
    await attachments.ensureBucket?.(a.organizationId);
    await store.putObject({
      bucket: deriveTenantBucket(a.organizationId as never),
      objectKey: a.objectKey,
      bytes: a.bytes,
    });
  };
  const deleteObject = (a: { organizationId: string; objectKey: string }) =>
    attachments.destroyObject(a);
  const getObject = (a: { organizationId: string; objectKey: string }) =>
    attachments.readBytes({ ...a, maxBytes: EXPORT_MAX_ARTEFACT_BYTES });

  const builder = createExportBuilder({
    store: createExportBuildStore({ db: deps.db, outbox: deps.outbox }),
    keys,
    openBody: (organizationId, cipher) => deps.bodyCipher.open(organizationId, cipher),
    part2Patients: async (organizationId, patientIds) => {
      const reader = getSeam("PatientPrivacyFlagReader") as unknown as PrivacyFlagReaderShape;
      const facts = await reader.roomingFactsFor({ organizationId, patientIds });
      const byPatient = new Map(facts.map((f) => [f.patientId, f.privacyFlags] as const));
      return new Set(
        patientIds.filter((id) => {
          const flags = byPatient.get(id);
          if (!flags) throw new Error("privacy flags unreadable"); // fail closed: never "not SUD"
          return flags.includes(SUD_PRIVACY_FLAG);
        }),
      );
    },
    putObject,
    deleteObject,
  });

  return {
    builder,
    /** B1's `ExportArtefactReader` for the download route. */
    artefactReader: createExportArtefactReader({ get: getObject, keys }),
    sweep: createExportExpirySweep({
      store: createExportExpiryStore({ db: deps.db, outbox: deps.outbox }),
      deleteObject,
    }),
  };
}

export type M36ExportBinding = ReturnType<typeof buildM36ExportBinding>;
