// apps/backend/src/modules/23-billing-medicare/jobs/mac-jurisdictions.ts — the real `MacJurisdictionListPort`
// (GAP-143). The composition root used to hard-code `[{ macJurisdiction: "ngs_j6" }]`, so a tenant whose
// provider entity bills a different MAC (CGS J15, Palmetto JM, Noridian JE ...) never had its 999/277CA
// acknowledgments pulled and its MAC portal never health-probed — acks for those claims sat at
// `ack_pending` forever. The jurisdictions to poll are the DISTINCT `mac_jurisdiction` values of the
// configured `mac_submitter_credential` rows (one per provider entity), across every active tenant.
//
// `mac_submitter_credential` is ORG-scoped (RLS on `app.org_id`, no platform-role grant), so the cross-tenant
// union is built the way every other M23 cron fans out: enumerate the active orgs through the audited platform
// enumerator, then read each org's rows under its own `withOrgContext` envelope. Only the jurisdiction code
// is selected — never the cipher, client id or submitter ids.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { MacJurisdictionListPort } from "./m23-jobs";

/** The active-org fan-out unit (structurally the M23 `ActiveOrgListPort`). */
export interface MacJurisdictionOrgSource {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** Reads one org's configured MAC jurisdiction codes (any order, duplicates allowed). */
export type OrgMacJurisdictionReader = (organizationId: string) => Promise<readonly string[]>;

/**
 * Union of every active org's configured MAC jurisdictions, de-duplicated and sorted (a deterministic order
 * keeps the cron's pull sequence and the health breaker stable across ticks). An org whose read fails is
 * SKIPPED for this tick rather than aborting the union — one tenant's broken row must not stop every other
 * tenant's acknowledgments — and the failure is reported through `onOrgError`.
 */
export function buildMacJurisdictionLister(deps: {
  readonly orgs: MacJurisdictionOrgSource;
  readonly readOrg: OrgMacJurisdictionReader;
  readonly onOrgError?: (organizationId: string, error: unknown) => void;
}): MacJurisdictionListPort {
  return {
    async listJurisdictions() {
      const orgs = await deps.orgs.listActiveOrgs();
      const codes = new Set<string>();
      for (const { organizationId } of orgs) {
        try {
          for (const code of await deps.readOrg(organizationId)) codes.add(code);
        } catch (error) {
          deps.onOrgError?.(organizationId, error);
        }
      }
      return [...codes].sort().map((macJurisdiction) => ({ macJurisdiction }));
    },
  };
}

/** The Drizzle reader: `SELECT DISTINCT mac_jurisdiction` under the org's RLS envelope (system actor). */
export function buildDrizzleOrgMacJurisdictionReader(db: DbClient): OrgMacJurisdictionReader {
  return (organizationId) =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = await tx
        .selectDistinct({ macJurisdiction: schema.macSubmitterCredential.macJurisdiction })
        .from(schema.macSubmitterCredential);
      return rows.map((r) => r.macJurisdiction);
    });
}
