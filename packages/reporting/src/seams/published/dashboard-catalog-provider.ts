// @wardenx/reporting — the `DashboardCatalogProvider` PUBLISHED seam (M33 §4.3).
//
// The dashboard-catalog read surface M34's tenant ops console consults to enumerate the dashboards
// available in an org's scope. Aggregate metadata only (no tile results, no PHI). Registered into
// the M1 SeamRegistry at boot (P2C); fails closed (D13) until the real provider is registered.

/** Consumed by M34 (tenant ops console). */
export interface DashboardCatalogProvider {
  listDashboardsForOrg(organizationId: string): Promise<
    {
      dashboardId: string;
      displayName: string;
      authorship: "system" | "tenant";
      tileCount: number;
      shareScope: "private" | "role" | "org";
      isOrgDefault: boolean;
    }[]
  >;
}
