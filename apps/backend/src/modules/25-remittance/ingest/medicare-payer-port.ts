// apps/backend/src/modules/25-remittance/ingest/medicare-payer-port.ts - #717: the canonical Medicare payer's id through
// M40's `MdmEntityProvider` seam. Structural view resolved through the M1 registry (no M40 import; same pattern as
// routes/payer-seam.ts). Anything but exactly one Medicare payer with a uuid id reads as "not resolvable" (null), so an
// advice is never filed under a stranger.
import { getSeam } from "../../../bootstrap/index";
import type { MedicarePayerPort } from "./clearinghouse-pull";

interface MdmPayerSearchView {
  search(
    orgId: string,
    kind: "payer",
    q: { identifier: string; limit: number },
  ): Promise<Array<{ id: string; canonical: { kind?: unknown } }>>;
}

const MEDICARE_X12_PAYER_ID = "MEDICARE";
const SEARCH_LIMIT = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildSeamMedicarePayerPort(): MedicarePayerPort {
  return {
    async medicarePayerId(organizationId) {
      try {
        const provider = getSeam("MdmEntityProvider") as MdmPayerSearchView;
        const found = await provider.search(organizationId, "payer", {
          identifier: MEDICARE_X12_PAYER_ID,
          limit: SEARCH_LIMIT,
        });
        const medicare = found.filter((p) => p.canonical.kind === "medicare" && UUID.test(p.id));
        return medicare.length === 1 ? (medicare[0]?.id ?? null) : null;
      } catch {
        return null;
      }
    },
  };
}
