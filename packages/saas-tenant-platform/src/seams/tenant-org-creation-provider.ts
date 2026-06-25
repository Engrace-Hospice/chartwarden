// @wardenx/saas-tenant-platform — the `TenantOrgCreationProvider` FORWARD seam M34 CONSUMES from M2
// (§2.5 r2 / §7.1 step 3): the M2 organization-creation surface the `tenant.provision` worker needs to
// mint / attach the per-tenant `organization` row.
//
// The CONTRACT now lives in @wardenx/types (a leaf both M2 and M34 import edge-free — M2 is the producer,
// M34 the consumer, and neither may import the other's package). This file re-exports it so M34's wiring
// keeps a local import site, and keeps the fail-closed deny-stub (the value the registry holds until M2
// registers the real provider — the M1 seam registry also carries an identical structural deny-stub).
import type { TenantOrgCreationProvider } from "@wardenx/types";

export type {
  TenantOrgCreationIntent,
  TenantOrgCreationProvider,
  TenantOrgCreationResult,
} from "@wardenx/types";

/**
 * The deny-stub proxy: returns `{ kind: 'unavailable', reason: 'm2_org_creation_not_yet_locked' }` for
 * every intent until M2 registers the real provider. The provision worker branches on `kind` and degrades
 * cleanly (never fabricates an org id, never fails open). Mirrors the M1 registry's structural deny-stub.
 */
export const denyStubTenantOrgCreationProvider: TenantOrgCreationProvider = {
  async createOrganizationForTenant() {
    return { kind: "unavailable", reason: "m2_org_creation_not_yet_locked" };
  },
};
