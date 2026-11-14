// M23-CM-4A: internal-only notice rendering. This deliberately has no HTTP, clearinghouse,
// X12-sidecar, or MAC-portal dependency. The caller supplies source readers so M23 can consume
// M5/M6/M40 facts through their published seams while keeping this deterministic core testable.
import { createHmac } from "node:crypto";
import {
  type Notice837iInput,
  type TransferNotice837iInput,
  build837iNotice,
  build837iTransferNotice,
} from "@chartwarden/x12-837-client";

export type MedicareNoticeKind = "noe" | "notr" | "transfer_notice" | "cancellation_notice";
export type MedicareNoticeUsage = "test" | "production";

/** Non-PHI facts that bind one render to its durable, already-committed submission attempt. */
export interface MedicareNoticeRenderIdentity {
  readonly organizationId: string;
  readonly noticeId: string;
  readonly submissionId: string;
  readonly kind: MedicareNoticeKind;
  readonly relatedSourceId: string;
  readonly sourceVersion: string;
  /** Includes provider route, payer/account, usage, and EDI profile versions; never credentials. */
  readonly routeFingerprint: string;
  readonly providerEntityId: string;
  readonly jurisdiction: string;
  readonly vendor: string;
  readonly accountReference: string;
  readonly usage: MedicareNoticeUsage;
  readonly mapperVersion: string;
  readonly controlNumber: string;
}

export interface MedicareNoticeRenderReservation {
  readonly identity: MedicareNoticeRenderIdentity;
  readonly fingerprint: string;
  readonly interchangeNumber: number;
  readonly renderedAt: Date;
}

/** Must be backed by a durable organization-scoped store in production. Insert is atomic and immutable. */
export interface MedicareNoticeRenderIdentityStore {
  reserve(
    input: Omit<MedicareNoticeRenderReservation, "interchangeNumber" | "renderedAt">,
  ): Promise<MedicareNoticeRenderReservation>;
}

export interface MedicareNoticeArtifactStore {
  recover(input: { organizationId: string; noticeId: string; submissionId: string; kind: MedicareNoticeKind }): Promise<RenderedMedicareNotice | null>;
  persist(input: { reservation: MedicareNoticeRenderReservation; sourceFingerprint: string; x12: string }): Promise<RenderedMedicareNotice>;
}

export interface MedicareNoticeSourceFacts {
  readonly ready: true;
  /** Typed NOE/NOTR builder data assembled only from authoritative source records. */
  readonly input: Notice837iInput;
  readonly identity: MedicareNoticeRenderIdentity;
}

export interface MedicareTransferSourceFacts {
  readonly ready: true;
  readonly input: TransferNotice837iInput;
  readonly identity: MedicareNoticeRenderIdentity;
}

export interface MedicareNoticeSourceLoader {
  loadNoe(input: { organizationId: string; noticeId: string; submissionId: string }): Promise<MedicareNoticeSourceFacts>;
  loadNotr(input: { organizationId: string; noticeId: string; submissionId: string }): Promise<MedicareNoticeSourceFacts>;
  loadTransfer(input: { organizationId: string; noticeId: string; submissionId: string }): Promise<MedicareTransferSourceFacts>;
  loadCancellation(input: { organizationId: string; noticeId: string; submissionId: string }): Promise<MedicareTransferSourceFacts>;
}

export type MedicareNoticeRenderHoldCode =
  | "NOTICE_SOURCE_NOT_FOUND"
  | "NOTICE_SOURCE_INVALID"
  | "NOTICE_FACTS_INCOMPLETE"
  | "NOTICE_ROUTE_NOT_READY"
  | "NOTICE_IDENTITY_CHANGED"
  | "NOTICE_RENDER_IDENTITY_UNAVAILABLE"
  | "NOTICE_BUILD_REJECTED"
  | "NOTICE_ARTIFACT_KEY_UNAVAILABLE"
  | "NOTICE_ARTIFACT_INTEGRITY_FAILED"
  | "NOTICE_ARTIFACT_CONFLICT";

/** PHI-safe typed hold. `field` is a schema path only; never put fact values in this error. */
export class MedicareNoticeRenderHold extends Error {
  public override readonly name = "MedicareNoticeRenderHold";
  constructor(
    readonly code: MedicareNoticeRenderHoldCode,
    readonly field?: string,
  ) {
    super(field ? `${code}: ${field}` : code);
  }
}

export interface RenderedMedicareNotice {
  readonly organizationId: string;
  readonly noticeId: string;
  readonly submissionId: string;
  readonly kind: MedicareNoticeKind;
  readonly transactionSet: "837";
  readonly usage: MedicareNoticeUsage;
  readonly sourceFingerprint: string;
  readonly routeFingerprint: string;
  readonly interchangeControlNumber: string;
  readonly renderedAt: Date;
  /** Present for a finalized durable artifact; dispatch must refuse an in-memory-only render. */
  readonly renderIdentityId?: string;
  readonly artifactId?: string;
  readonly artifactSha256?: string;
  /** Contains beneficiary PHI/MBI. Return only to an authorized internal worker; never log or persist here. */
  readonly x12: string;
}

/** Production composition contract for the four internal notice render paths. */
export interface MedicareNoticeRenderer {
  renderNoe(request: { organizationId: string; noticeId: string; submissionId: string }): Promise<RenderedMedicareNotice>;
  renderNotr(request: { organizationId: string; noticeId: string; submissionId: string }): Promise<RenderedMedicareNotice>;
  renderTransfer(request: { organizationId: string; noticeId: string; submissionId: string }): Promise<RenderedMedicareNotice>;
  renderCancellation(request: { organizationId: string; noticeId: string; submissionId: string }): Promise<RenderedMedicareNotice>;
}

const fingerprint = (value: unknown, key: string): string => createHmac("sha256", key)
  .update("chartwarden:m23:notice-render:fingerprint:v1\0")
  .update(JSON.stringify(value))
  .digest("hex");

function validateIdentity(
  expected: { organizationId: string; noticeId: string; submissionId: string; kind: MedicareNoticeKind },
  actual: MedicareNoticeRenderIdentity,
): void {
  if (
    actual.organizationId !== expected.organizationId ||
    actual.noticeId !== expected.noticeId ||
    actual.submissionId !== expected.submissionId ||
    actual.kind !== expected.kind
  ) {
    throw new MedicareNoticeRenderHold("NOTICE_SOURCE_INVALID");
  }
  if (!actual.routeFingerprint || !actual.sourceVersion || !actual.controlNumber || !actual.accountReference) {
    throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY");
  }
}

/**
 * Pure orchestration around authoritative loaders, immutable identity reservation, and the repository's
 * executable TypeScript X12 builders. No transport capability is accepted by this service.
 */
export function createMedicareNoticeRenderer(deps: {
  readonly sources: MedicareNoticeSourceLoader;
  readonly identities: MedicareNoticeRenderIdentityStore;
  readonly artifacts?: MedicareNoticeArtifactStore;
  /** Server-only HMAC key; the builder facts include PHI and must not be persisted as plain hashes. */
  readonly fingerprintKey: string;
}) {
  async function render(
    kind: MedicareNoticeKind,
    request: { organizationId: string; noticeId: string; submissionId: string },
  ): Promise<RenderedMedicareNotice> {
    const recovered = await deps.artifacts?.recover({ ...request, kind });
    if (recovered) return recovered;
    const source = kind === "noe"
      ? await deps.sources.loadNoe(request)
      : kind === "notr"
        ? await deps.sources.loadNotr(request)
        : kind === "transfer_notice"
          ? await deps.sources.loadTransfer(request)
          : await deps.sources.loadCancellation(request);
    const identity = source.identity;
    validateIdentity({ ...request, kind }, identity);
    const x12Input = source.input;
    // The loader's sourceVersion covers source-row revisions. Do not serialize the in-memory builder input
    // (which includes MBI and street address) even transiently for fingerprinting.
    if (deps.fingerprintKey.length < 32) {
      throw new MedicareNoticeRenderHold("NOTICE_RENDER_IDENTITY_UNAVAILABLE");
    }
    const { envelope: _envelope, ...businessInput } = x12Input;
    const identityFingerprint = fingerprint({ identity, businessInput }, deps.fingerprintKey);
    let reservation: MedicareNoticeRenderReservation;
    try {
      reservation = await deps.identities.reserve({
        identity,
        fingerprint: identityFingerprint,
      });
    } catch (error) {
      if (error instanceof MedicareNoticeRenderHold) throw error;
      throw new MedicareNoticeRenderHold("NOTICE_RENDER_IDENTITY_UNAVAILABLE");
    }
    if (reservation.fingerprint !== identityFingerprint) {
      throw new MedicareNoticeRenderHold("NOTICE_IDENTITY_CHANGED");
    }
    const envelope = {
      senderId: x12Input.envelope.senderId,
      receiverId: x12Input.envelope.receiverId,
      applicationReceiverCode: x12Input.envelope.applicationReceiverCode,
      interchangeControlNumber: reservation.interchangeNumber,
      usage: identity.usage === "test" ? "T" as const : "P" as const,
      createdAt: reservation.renderedAt,
    };
    let x12: string;
    try {
      x12 = kind === "transfer_notice" || kind === "cancellation_notice"
        ? build837iTransferNotice({ ...(source.input as TransferNotice837iInput), envelope })
        : build837iNotice({ ...(source.input as Notice837iInput), envelope });
    } catch (error) {
      if (error && typeof error === "object" && "field" in error && typeof error.field === "string") {
        throw new MedicareNoticeRenderHold("NOTICE_BUILD_REJECTED", error.field);
      }
      throw error;
    }
    const rendered: RenderedMedicareNotice = {
      organizationId: identity.organizationId,
      noticeId: identity.noticeId,
      submissionId: identity.submissionId,
      kind,
      transactionSet: "837",
      usage: identity.usage,
      sourceFingerprint: identityFingerprint,
      routeFingerprint: identity.routeFingerprint,
      interchangeControlNumber: String(reservation.interchangeNumber).padStart(9, "0"),
      renderedAt: reservation.renderedAt,
      x12,
    };
    return deps.artifacts
      ? deps.artifacts.persist({ reservation, sourceFingerprint: identityFingerprint, x12 })
      : rendered;
  }
  return {
    renderNoe: (request: { organizationId: string; noticeId: string; submissionId: string }) => render("noe", request),
    renderNotr: (request: { organizationId: string; noticeId: string; submissionId: string }) => render("notr", request),
    renderTransfer: (request: { organizationId: string; noticeId: string; submissionId: string }) => render("transfer_notice", request),
    renderCancellation: (request: { organizationId: string; noticeId: string; submissionId: string }) => render("cancellation_notice", request),
  };
}
