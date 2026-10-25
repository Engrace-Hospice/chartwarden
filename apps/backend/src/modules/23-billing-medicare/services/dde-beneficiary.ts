// apps/backend/src/modules/23-billing-medicare/services/dde-beneficiary.ts — the MBI seam of the DDE provider path
// (ADR-0103, #793). A provider operation keys a beneficiary, so it needs the MBI; the queue holds none (ADR-0052 D7).
// The ONLY source is M5's `MbiUnlockReader` (M23-only seam; the MBI is `patient_payer.subscriber_id` of the patient's
// medicare_ffs coverage). That reader audits EVERY unlock (`patient_payer.mbi_disclosed`: ids, purpose, actor; never the
// MBI) in the same transaction as the read, so a disclosure that cannot be audited returns nothing.
//
// This file is the narrow door: it returns the identity to ONE caller (the submit builder) which hands it to the
// provider call in memory. It holds nothing (no cache, no log), and every failure is a typed refusal that carries no
// identity. The permission check is the route's (`billing.dde.submit_via_provider` + step-up + the assignee rule); this
// port is not reachable from any other path. Fail-closed default: with no reader bound the port refuses.
import { ChartWardenError, type MbiUnlockReader } from "@chartwarden/types";
import type { DdeBeneficiary } from "@chartwarden/x12-837-client";

export const DDE_BENEFICIARY_UNAVAILABLE = "DDE_BENEFICIARY_UNAVAILABLE";
export const DDE_BENEFICIARY_NOT_ON_FILE = "DDE_BENEFICIARY_NOT_ON_FILE";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DdeBeneficiaryRequest {
  readonly organizationId: string;
  readonly patientId: string;
  /** The DDE work item the disclosure serves (a uuid; recorded on the audit row). */
  readonly ddeItemId: string;
  /** The acting user (a uuid), recorded as the disclosure's actor. */
  readonly actorUserId: string;
  /** Joins the audit row to the request; dropped (not echoed) when it is not uuid-shaped. */
  readonly correlationId?: string;
  /** `YYYY-MM-DD`: which Medicare coverage is in force. */
  readonly onDate: string;
}

export interface DdeBeneficiaryPort {
  /** The beneficiary identity for one provider operation, or a typed refusal. Never logs, never caches. */
  unlock(request: DdeBeneficiaryRequest): Promise<DdeBeneficiary>;
}

/** The fail-closed default: nothing can be keyed without a beneficiary, and nothing invents one. */
export const UNBOUND_DDE_BENEFICIARY: DdeBeneficiaryPort = {
  unlock: () =>
    Promise.reject(
      new ChartWardenError(
        DDE_BENEFICIARY_UNAVAILABLE,
        "the beneficiary identity cannot be unlocked for the DDE access provider",
        503,
      ),
    ),
};

/** `reader` is resolved lazily per call so boot registration order never matters (the HETS port's shape). */
export function buildDdeBeneficiaryPort(reader: () => MbiUnlockReader): DdeBeneficiaryPort {
  return {
    async unlock(request) {
      let unlocked: Awaited<ReturnType<MbiUnlockReader["unlockForEligibility"]>>;
      try {
        unlocked = await reader().unlockForEligibility({
          organizationId: request.organizationId,
          patientId: request.patientId,
          onDate: request.onDate,
          disclosure: {
            purpose: "dde_provider_operation",
            subjectId: request.ddeItemId,
            actorUserId: request.actorUserId,
            ...(request.correlationId && UUID_SHAPE.test(request.correlationId)
              ? { correlationId: request.correlationId }
              : {}),
          },
        });
      } catch {
        // The reader's error text is not provably free of identity: never echoed.
        return UNBOUND_DDE_BENEFICIARY.unlock(request);
      }
      if (!unlocked) {
        throw new ChartWardenError(
          DDE_BENEFICIARY_NOT_ON_FILE,
          "no Medicare beneficiary identifier is on file for this patient; key the item manually",
          422,
        );
      }
      return {
        mbi: unlocked.mbi,
        lastName: unlocked.lastName,
        firstName: unlocked.firstName,
        dateOfBirth: unlocked.dateOfBirth,
      };
    },
  };
}
