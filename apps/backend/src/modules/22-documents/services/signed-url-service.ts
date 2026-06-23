// apps/backend/src/modules/22-documents/services/signed-url-service.ts — the §4.12 external-partner signed-URL
// gate (M22-T06). Before M22 presigns a download URL that targets an external partner (a partner-lab results feed,
// a referral-source disclosure, a DME/funeral-home artifact), it consumes M40's REAL `BaaStatusProvider`: an
// active BAA at `asOf` (or a `requiredByPolicy=false` "no BAA needed" kind) is mandatory, else the URL is NEVER
// minted (fail closed, §7.7). Internal clinician access (no external partner) does NOT pass this gate — that path
// is the standard §1.3 presign the M22-T07 routes own.
//
// M22's manifest `dependsOn` is `[1, 5]`, so M22 code never imports `@wardenx/mdm`: the BAA seam is consumed
// through the NARROW structural {@link ExternalPartnerBaaGate} port, which the composition root adapts from
// M40's `BaaStatusProvider` (resolved lazily through the M1 registry at call time — see apps/backend/src/index.ts).
// The presign itself runs through M22's own `DocumentStorageProvider` seam (the per-tenant object store).
import type { OrgScope } from "@wardenx/types";
import { DocumentStateError } from "../domain/index";

/** The BAA entity kinds the §4.6.1 gate guards (mirrors M40 `BaaEntityKind`; kept local so M22 imports no M40 type). */
export type ExternalDisclosureEntityKind =
  | "facility"
  | "payer"
  | "referral_source"
  | "dme_vendor"
  | "funeral_home";

/** The §4.6.1 gate decision the port returns (the structural subset M22 needs of M40's `BaaStatusResult`). */
export interface ExternalDisclosureBaaDecision {
  /** True when disclosure is permitted: an active BAA at `asOf`, OR the kind needs no BAA (`n_a`). */
  readonly isActive: boolean;
  /** The governing BAA status (`executed` / `n_a` / `missing` / `pending` / `expired`) — surfaced in the deny + metric. */
  readonly status: string;
}

/**
 * The §4.12 BAA gate M22 consumes before any external-partner presign. A NARROW structural port over M40's
 * `BaaStatusProvider.baaStatusByMdmEntity(...)` (the composition root supplies the adapter; `asOf` is stamped
 * there as `new Date()`). M22 never imports `@wardenx/mdm` — the gate keeps the §4.12 disclosure path inside
 * M22's `[1, 5]` dependency envelope.
 */
export interface ExternalPartnerBaaGate {
  checkDisclosure(args: {
    organizationId: string;
    entityKind: ExternalDisclosureEntityKind;
    entityId: string;
  }): Promise<ExternalDisclosureBaaDecision>;
}

/** The per-tenant object-store presign port M22 mints the URL through (M22's `DocumentStorageProvider` seam). */
export interface SignedUrlPresignPort {
  presignDownload(args: {
    scope: OrgScope;
    tenantId: string;
    objectKey: string;
    downloadFilename: string;
    ttlSeconds: number;
  }): Promise<{ url: string; expiresAt: string }>;
}

/** A request to mint a presigned download URL targeting an external partner (the §4.12 BAA-gated path). */
export interface ExternalPartnerUrlRequest {
  readonly organizationId: string;
  readonly objectKey: string;
  readonly downloadFilename: string;
  readonly partnerEntityKind: ExternalDisclosureEntityKind;
  readonly partnerEntityId: string;
  readonly ttlSeconds: number;
}

/** The §4.12 service: a single BAA-gated external-partner presign over the injected gate + presign ports. */
export interface ExternalPartnerSignedUrlService {
  grantExternalPartnerDownloadUrl(req: ExternalPartnerUrlRequest): Promise<{ url: string; expiresAt: string }>;
}

/**
 * Build the §4.12 external-partner signed-URL service. `grantExternalPartnerDownloadUrl` calls the BAA gate FIRST
 * (an explicit allow before any URL exists); a non-active result throws `DOCUMENT_EXTERNAL_DISCLOSURE_BAA_BLOCKED`
 * (403) carrying the offending `status` + partner id (the `m22_baa_gate_blocked_total` metric label, §8). Only on
 * an active BAA does it presign through the object store. The TTL must be positive (§7.10 D11). Pure orchestration
 * over the injected ports — unit-testable with fakes; the composition root wires the REAL M40 gate + M22 storage.
 */
export function createExternalPartnerSignedUrlService(deps: {
  baaGate: ExternalPartnerBaaGate;
  presign: SignedUrlPresignPort;
}): ExternalPartnerSignedUrlService {
  return {
    async grantExternalPartnerDownloadUrl(req) {
      if (!Number.isFinite(req.ttlSeconds) || req.ttlSeconds < 1) {
        throw new DocumentStateError(
          "DOCUMENT_SIGNED_URL_TTL_INVALID",
          "a signed URL must live for at least one second (§7.10 D11).",
        );
      }
      const decision = await deps.baaGate.checkDisclosure({
        organizationId: req.organizationId,
        entityKind: req.partnerEntityKind,
        entityId: req.partnerEntityId,
      });
      if (!decision.isActive) {
        throw new DocumentStateError(
          "DOCUMENT_EXTERNAL_DISCLOSURE_BAA_BLOCKED",
          `external disclosure refused — no active BAA (status=${decision.status}) for ${req.partnerEntityKind} ${req.partnerEntityId} (§4.12).`,
        );
      }
      return deps.presign.presignDownload({
        scope: { orgId: req.organizationId },
        tenantId: req.organizationId,
        objectKey: req.objectKey,
        downloadFilename: req.downloadFilename,
        ttlSeconds: req.ttlSeconds,
      });
    },
  };
}
