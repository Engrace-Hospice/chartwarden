// apps/backend/src/modules/22-documents/routes/signed-url-service.ts — M22-T07 (§4.1 content route / §4.12).
//
// The signed-URL service the `GET …/versions/:versionId/content` route composes. It is the seam between
// the pure PHI-free presign MATH (T03 `planSignedUrl`, 300s TTL floor) and the injected
// `DocumentStorageProvider` seam (T04, the per-tenant MinIO presign port). The minted URL is short-lived
// (≤ 300s, never looser — `planSignedUrl` clamps) and is NEVER logged (§4.12); the route hands it straight
// back to the caller (302 redirect in prod) and records a `signed_url_issued` access-log fact.
//
// EXTERNAL-DISCLOSURE GATE (§4.12). When the purpose targets an out-of-network recipient (`purpose` ∈
// {disclosure, survey_export} with a `recipientClass`), the mint additionally consults M40's real
// `BaaStatusProvider` via the T06 fail-closed BAA resolver — a missing/inactive BAA blocks the presign
// (`baa_inactive`). M22 `dependsOn` is `[1, 5]`: the BAA seam is resolved OPAQUELY from the M1 registry
// (no `@wardenx/mdm` import, no dependency-cruiser edge — the T06 baa-gate precedent).
import type {
  DocumentAccessKind,
  DocumentAccessPurpose,
  IsoInstant,
  OrgId,
  SignedUrlDescriptor,
} from "@wardenx/types";
import { ForbiddenError, NotFoundError } from "@wardenx/types";
import { planSignedUrl } from "../lifecycle/storage";
import { resolveExternalBaaActive } from "../outbox-consumers/baa-gate";
import type { ExternalRecipientRef } from "../outbox-consumers/decide-document-request";

/** The §4.3 `DocumentStorageProvider` arm the signed-URL service consumes (presign only). */
export interface SignedUrlStoragePort {
  presignDownload(args: {
    readonly descriptor: SignedUrlDescriptor;
    readonly organizationId: OrgId;
  }): Promise<{ readonly url: string; readonly expiresAt: IsoInstant }>;
}

/** The org-scoped object-key + recipient facts the service needs for one document version (RLS-backed). */
export interface SignedUrlObjectFacts {
  readonly objectKey: string;
  /** The external partner this presign targets, if any — gates the BAA check (§4.12). */
  readonly externalRecipient: ExternalRecipientRef | null;
}

/** Loads a version's org-scoped object-key facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface SignedUrlObjectResolver {
  loadObject(args: {
    organizationId: OrgId;
    documentId: string;
    versionId: string;
  }): Promise<SignedUrlObjectFacts | null>;
}

/** The §164.528 access-purpose → access-log classification (the `document_access_kind`, §3.2). */
const ACCESS_KIND_FOR_PURPOSE: Readonly<Record<DocumentAccessPurpose, DocumentAccessKind>> = {
  treatment: "signed_url_issued",
  payment: "signed_url_issued",
  operations: "signed_url_issued",
  disclosure: "disclosure_export",
  patient_access: "signed_url_issued",
  amendment_review: "signed_url_issued",
  survey_export: "disclosure_export",
};

/** Whether a purpose targets an out-of-network recipient → the §4.12 BAA gate applies. */
function isExternalDisclosure(purpose: DocumentAccessPurpose): boolean {
  return purpose === "disclosure" || purpose === "survey_export";
}

export interface MintSignedUrlArgs {
  readonly organizationId: OrgId;
  readonly documentId: string;
  readonly versionId: string;
  readonly purpose: DocumentAccessPurpose;
  readonly ttlSeconds?: number;
}

export interface MintedSignedUrl {
  readonly url: string;
  readonly expiresAt: IsoInstant;
  readonly documentVersionId: string;
  readonly accessKind: DocumentAccessKind;
}

export interface SignedUrlServiceDeps {
  readonly storage: SignedUrlStoragePort;
  readonly resolver: SignedUrlObjectResolver;
}

/** The signed-URL service the §4.1 content route composes over (T03 plan + T04 presign port + §4.12 gate). */
export interface SignedUrlService {
  mint(args: MintSignedUrlArgs): Promise<MintedSignedUrl>;
}

/**
 * Build the §4.1 signed-URL service. `mint` plans the PHI-free presign descriptor (T03, ≤ 300s),
 * runs the §4.12 external-disclosure BAA gate (fail-closed via the T06 resolver), and presigns through the
 * injected T04 storage port. A missing/cross-tenant version is a non-leaking 404; a blocked BAA is 403.
 */
export function createSignedUrlService(deps: SignedUrlServiceDeps): SignedUrlService {
  const { storage, resolver } = deps;
  return {
    async mint(args) {
      const facts = await resolver.loadObject({
        organizationId: args.organizationId,
        documentId: args.documentId,
        versionId: args.versionId,
      });
      if (!facts) throw new NotFoundError("document version");

      // §4.12 — external disclosure presigns gate on M40's live BAA status (as-of NOW); fail closed.
      if (isExternalDisclosure(args.purpose) && facts.externalRecipient) {
        const active = await resolveExternalBaaActive({
          organizationId: args.organizationId,
          recipient: facts.externalRecipient,
        });
        if (!active) {
          throw new ForbiddenError("signed-url denied: no active BAA for the external recipient");
        }
      }

      const accessKind = ACCESS_KIND_FOR_PURPOSE[args.purpose];
      const descriptor = planSignedUrl({
        organizationId: args.organizationId,
        objectKey: facts.objectKey,
        accessKind,
        ttlSeconds: args.ttlSeconds,
      });
      const { url, expiresAt } = await storage.presignDownload({
        descriptor,
        organizationId: args.organizationId,
      });
      return { url, expiresAt, documentVersionId: args.versionId, accessKind };
    },
  };
}
