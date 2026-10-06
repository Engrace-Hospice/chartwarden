// apps/backend/src/modules/37-ipu/routes/ipu-trust-gates.ts — GAP-106: the port-driven gates that turn
// "the client said so" into "a seam proved it" for the body-release and GIP-attestation writes.
//
// Every gate here FAILS CLOSED, including on a seam that THROWS — an unbound seam is the registry's
// deny-stub, which throws `NotImplementedError`, and an unreadable M22/M40 is indistinguishable from an
// absent document / funeral home. None of them trusts a body field for anything but the ID it then
// resolves; the facts (document type, owning release, patient, funeral-home status, physician status) come
// from M22/M40, and the actor's discipline from the server-assembled role set.
import type { BodyReleaseEvent } from "@wardenx/inpatient";
import { isIpuSystemActor } from "./system-actor";

/** M22 `DocumentType` the signed body-release authorization is filed under (the render consumer's type). */
const BODY_RELEASE_DOCUMENT_TYPE = "body_release_authorization";
const ACTIVE = "active";

/** The slice of M22's `DocumentReader` the release gate reads. Narrowed for a small, honest fake. */
export interface BodyReleaseDocumentReader {
  documentMetadata(args: { documentId: never; organizationId: never }): Promise<{
    readonly aggregateType: string;
    readonly aggregateId: string | null;
    readonly patientId: string | null;
    readonly status: string;
    readonly activeVersionId: string | null;
  } | null>;
}

/** The slice of M40's `MdmEntityProvider` the funeral-home / attester gates read. */
export interface MdmDirectoryReader {
  resolveFuneralHome(
    organizationId: string,
    id: string,
  ): Promise<{ readonly id: string; readonly status: string } | null>;
  resolvePhysician(
    organizationId: string,
    id: string,
  ): Promise<{ readonly id: string; readonly status: string } | null>;
}

/** Disciplines that may attest GIP criteria (CoP 418.108 — hospice physician only; no NP, no RN). */
export const GIP_ATTESTER_ROLE_KEYS = ["medical_director", "hospice_physician"] as const;

/** True when the server-assembled role set carries a GIP-attesting discipline. */
export const hasGipAttesterRole = (roles: readonly string[]): boolean =>
  GIP_ATTESTER_ROLE_KEYS.some((role) => roles.includes(role));

/** Run a seam read; ANY throw (deny-stub, outage) reads as "not proven". */
async function proven<T>(read: () => Promise<T | null> | T | null): Promise<T | null> {
  try {
    return (await read()) ?? null;
  } catch {
    return null;
  }
}

async function funeralHomeIsResolved(
  directory: MdmDirectoryReader,
  organizationId: string,
  funeralHomeId: string | undefined,
): Promise<boolean> {
  if (funeralHomeId === undefined) return false;
  const resolved = await proven(() => directory.resolveFuneralHome(organizationId, funeralHomeId));
  return resolved !== null && resolved.status === ACTIVE;
}

async function releaseDocumentIsVerified(
  documents: BodyReleaseDocumentReader,
  organizationId: string,
  bodyRelease: { readonly id: string; readonly patientId: string },
  documentId: string,
): Promise<boolean> {
  const digest = await proven(() =>
    documents.documentMetadata({
      documentId: documentId as never,
      organizationId: organizationId as never,
    }),
  );
  return (
    digest !== null &&
    digest.aggregateType === BODY_RELEASE_DOCUMENT_TYPE &&
    digest.aggregateId === bodyRelease.id &&
    digest.patientId === bodyRelease.patientId &&
    digest.status === ACTIVE &&
    digest.activeVersionId !== null
  );
}

export interface BodyReleaseFactInput {
  readonly action: "identifyFuneralHome" | "releaseBody" | "postClose";
  readonly organizationId: string;
  readonly bodyRelease: {
    readonly id: string;
    readonly patientId: string;
    readonly releaseDocumentId: string | null;
  };
  readonly funeralHomeId: string | undefined;
  readonly releaseDocumentId: string | undefined;
  /** True only for the typed body-release sweep actor (never derived from the request). */
  readonly actorIsSweep: boolean;
  readonly documents: BodyReleaseDocumentReader;
  readonly directory: MdmDirectoryReader;
}

/**
 * Resolve the §2.11 machine event for a body-release action, with every fact proven by a seam:
 *  - `identifyFuneralHome`: M40 resolves the id to an ACTIVE funeral home for this org.
 *  - `releaseBody`: M22 holds an ACTIVE `body_release_authorization` document, filed against THIS release
 *    and THIS patient, with an active version. A document id that names anything else is `documentRejected`
 *    (422), distinct from "no document at all" (412).
 *  - `postClose`: system-driven only.
 */
export async function resolveBodyReleaseEventFacts(
  input: BodyReleaseFactInput,
): Promise<BodyReleaseEvent> {
  if (input.action === "identifyFuneralHome") {
    return {
      type: "identifyFuneralHome",
      funeralHomeResolved: await funeralHomeIsResolved(
        input.directory,
        input.organizationId,
        input.funeralHomeId,
      ),
    };
  }
  if (input.action === "postClose") {
    return { type: "postClose", isSystemActor: input.actorIsSweep };
  }
  const candidate = input.releaseDocumentId ?? input.bodyRelease.releaseDocumentId ?? undefined;
  if (candidate === undefined) return { type: "releaseBody", hasReleaseDocument: false };
  const verified = await releaseDocumentIsVerified(
    input.documents,
    input.organizationId,
    input.bodyRelease,
    candidate,
  );
  return verified
    ? { type: "releaseBody", hasReleaseDocument: true }
    : { type: "releaseBody", hasReleaseDocument: false, documentRejected: true };
}

/**
 * §2.4 `m37.gip_criteria.attester_eligible`, composed from the two facts the spec names: the actor's
 * discipline (server-assembled roles) AND an active M40 physician for the physician the attestation names.
 */
export async function evaluateGipAttesterEligibility(input: {
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly attestingPhysicianId: string;
  readonly directory: MdmDirectoryReader;
}): Promise<boolean> {
  if (!hasGipAttesterRole(input.roles)) return false;
  const physician = await proven(() =>
    input.directory.resolvePhysician(input.organizationId, input.attestingPhysicianId),
  );
  return physician !== null && physician.status === ACTIVE;
}

export { isIpuSystemActor };

// Narrow cross-module reader ports the seam registry (../seams) binds. They live here, not in
// service-drizzle, so seams.ts and the drizzle service never import each other.
/**
 * The slice of M11's `OrderProvider` the restraint gate reads. Narrowed rather than imported whole for
 * the same reason `VisitorConsentGate` is: M37 consumes one method, and a narrow port is a smaller
 * thing for a test to fake honestly.
 */
export interface RestraintOrderReader {
  getOrder(input: { orderId: string }): Promise<{
    readonly orderId: string;
    readonly patientId: string;
    readonly status: string;
    readonly signedAt: string | null;
    readonly orderingPhysicianMdmId: string | null;
  } | null>;
}

/**
 * The M39 `ConsentEvaluator` narrowed to the ONE method §2.7's visitor gate calls (GAP-062) — the M12
 * `DoseSpotConsentValidator` precedent. M39's rich interface lives in @wardenx/consent, which M37 does
 * not import; the seam is registered opaquely (`SeamContracts["ConsentEvaluator"] = unknown`) and this
 * subset is what M37 depends on, so no manifest edge appears.
 *
 * The spec asks for `ConsentEvaluator.evaluateForVisit(patientId, visitorRelationship)`. M39 publishes
 * no such method, and adding one would put IPU visitation vocabulary inside the consent module — so the
 * relationship → consent-type mapping stays in M37's pure core (`visitorConsentTypesFor`) and this calls
 * M39's real, general `evaluate` per candidate type.
 */
export interface VisitorConsentGate {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string; membershipId?: string };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{
    allowed: boolean;
    consentRecordId?: string;
    consentVersionAtEval?: number;
    expiresAt?: string;
    denyReason?: string;
  }>;
}

/**
 * The slice of M6's `AdmissionStatusReader` the discharge gate reads (F-070). Narrowed for the same
 * reason `RestraintOrderReader` is: M37 consumes one method, and a narrow port is a smaller thing for a
 * test to fake honestly.
 */
export interface AdmissionDischargeReader {
  getAdmissionSummary(
    organizationId: string,
    admissionId: string,
  ): Promise<{
    readonly status: string;
    readonly dischargedAt: string | null;
  }>;
}
