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
    canonical: { name?: unknown; kind?: unknown };
  } | null>;
}

export function buildSeamPayerSeam(): PayerSeam {
  return {
    async resolve(organizationId, payerId) {
      try {
        const provider = getSeam("MdmEntityProvider") as MdmPayerProviderView;
        const found = await provider.resolvePayer(organizationId, payerId);
        if (
          !found ||
          typeof found.canonical.name !== "string" ||
          found.canonical.name.trim() === ""
        ) {
          return null;
        }
        return {
          id: found.id,
          name: found.canonical.name,
          kind: typeof found.canonical.kind === "string" ? found.canonical.kind : "other",
        };
      } catch {
        return null;
      }
    },
  };
}
