// apps/backend/src/modules/25-remittance/routes/payer-seam.ts - M25 milestone 12a-1: payer names and kinds through M40's
// `MdmEntityProvider` seam. M25 does not depend on M40, so this is a STRUCTURAL view resolved through the M1 registry (no M40
// import; the ingest/claim-match-adapter.ts pattern). It FAILS CLOSED: any failure (seam not registered, deny-stub throw, RLS
// rejection) reads as "payer not resolved" (null), which the callers show and never guess around.
import { getSeam } from "../../../bootstrap/index";

export interface ResolvedPayer {
  readonly id: string;
  readonly name: string;
  /** The M40 canonical kind (medicare, medicaid, medicare_advantage, commercial, other). */
  readonly kind: string;
}

export interface PayerSeam {
  resolve(organizationId: string, payerId: string): Promise<ResolvedPayer | null>;
}

/** Structural view of M40's `MdmEntityProvider.resolvePayer` (opaque `unknown` in the M1 registry). */
interface MdmPayerProviderView {
  resolvePayer(
    orgId: string,
    id: string,
  ): Promise<{
    id: string;
    canonical: { displayName?: unknown; kind?: unknown };
  } | null>;
}

export function buildSeamPayerSeam(): PayerSeam {
  return {
    async resolve(organizationId, payerId) {
      try {
        const provider = getSeam("MdmEntityProvider") as MdmPayerProviderView;
        const found = await provider.resolvePayer(organizationId, payerId);
        const { displayName, kind } = found?.canonical ?? {};
        // A payer with no name or no program kind is "not resolved": the Medicare/Medicaid guard branches on `kind`,
        // so a missing kind must never be defaulted to a program that passes it.
        if (!found || typeof displayName !== "string" || displayName.trim() === "") return null;
        if (typeof kind !== "string" || kind === "") return null;
        return { id: found.id, name: displayName, kind };
      } catch {
        return null;
      }
    },
  };
}
