// @chartwarden/mdm — D7 tenant-offboarding destruction (M40-T10, §7.8).
// The pure eraseFn that deletes a tenant's overlay/provisional/baa rows (canonical never touched)
// + its narrow store port and in-memory default. M40 registers it over the M1 destruction-cert
// deny-stub for the `mdm_tenant_overlays` data class.
export {
  eraseTenantMdm,
  createInMemoryMdmEraseStore,
  type MdmEraseStore,
  type MdmEraseCounts,
} from "./eraseFn";
