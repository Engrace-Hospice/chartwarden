// @chartwarden/bereavement — D18 external-source first-contact gate (M16-T01 domain layout).
//
// An external HL7 death notification is a strong signal, not a hospice clinician witnessing the death — and
// the sending system can still retract it. The medical-director cosign closes that loop, so counselor
// first-contact with a grieving family is gated until it lands. Tenants may TIGHTEN the gate (death
// certificate on file, coordinator acknowledgment); they may never loosen it.
//
// This module is the pure decision; the M16 service layer supplies the facts (M22 death-certificate
// presence, the coordinator acknowledgment flag) and turns a denial into the §4.3.2 409 envelope.
// PURE — no IO, `@chartwarden/types`-only.

import type { BereavementExternalSourceMetadata } from "@chartwarden/types";

/** D18 — the tenant-tightened preconditions from `tenant_bereavement_external_source_gate_override`.
 *  Absent (or all-false) is the platform floor: cosign only. */
export interface BereavementExternalGateOverride {
  readonly requireDeathCertificateUploaded: boolean;
  readonly requireCoordinatorAcknowledgment: boolean;
}

/** D18 — the facts the service layer resolves before asking for a decision. */
export interface BereavementExternalGateFacts {
  /** M22: a death-certificate document exists for the decedent. */
  readonly hasDeathCertificate: boolean;
  /** M16: the Bereavement Program Coordinator acknowledged the external-source banner. */
  readonly hasCoordinatorAcknowledgment: boolean;
}

/** D18 — the machine-readable `code` on the 409 the route answers with. */
export type BereavementExternalGateDenialCode =
  | "external_source_cosign_pending"
  | "tenant_gate_death_certificate_missing"
  | "tenant_gate_coordinator_acknowledgment_missing";

/** D18 — the gate decision. `allowed: false` always carries a code (there is no unexplained denial). */
export type BereavementExternalGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: BereavementExternalGateDenialCode };

const ALLOWED: BereavementExternalGateDecision = { allowed: true };

/**
 * D18 — may counselor first-contact proceed?
 *
 * `externalSource === null` is an internal-clinician-recorded death (D16), which is never gated — the
 * hospice's own clinician recorded the death, so there is no attribution loop to close.
 *
 * Fail-closed on the cosign: anything other than an explicit `'cosigned'` denies, so a metadata blob that
 * arrived without a `cosignStatus` (a malformed or truncated upstream payload) blocks outreach rather than
 * waving it through.
 */
export function evaluateExternalSourceGate(
  externalSource: BereavementExternalSourceMetadata | null,
  tenantOverride: BereavementExternalGateOverride | null,
  facts: BereavementExternalGateFacts,
): BereavementExternalGateDecision {
  if (externalSource === null) return ALLOWED;

  if (externalSource.cosignStatus !== "cosigned") {
    return { allowed: false, code: "external_source_cosign_pending" };
  }

  if (tenantOverride?.requireDeathCertificateUploaded && !facts.hasDeathCertificate) {
    return { allowed: false, code: "tenant_gate_death_certificate_missing" };
  }

  if (tenantOverride?.requireCoordinatorAcknowledgment && !facts.hasCoordinatorAcknowledgment) {
    return { allowed: false, code: "tenant_gate_coordinator_acknowledgment_missing" };
  }

  return ALLOWED;
}

/**
 * D18 — apply an inbound `m6.discharge.cosigned` to the plan's provenance blob. Returns `null` when the
 * receipt does not apply (wrong proposal, or the plan is already cosigned), which is exactly the worker's
 * idempotency check: a redelivered cosign event is a no-op, not a second update with a newer timestamp.
 */
export function applyCosignReceipt(
  externalSource: BereavementExternalSourceMetadata | null,
  receipt: {
    readonly sourceProposalId: string;
    readonly cosignedAt: string;
    readonly medicalDirectorMembershipId: string;
  },
): BereavementExternalSourceMetadata | null {
  if (externalSource === null) return null;
  if (externalSource.cosignStatus !== "pending") return null;
  if (externalSource.sourceProposalId !== receipt.sourceProposalId) return null;

  return {
    ...externalSource,
    cosignStatus: "cosigned",
    cosignedAt: receipt.cosignedAt,
    medicalDirectorMembershipId: receipt.medicalDirectorMembershipId,
  };
}
