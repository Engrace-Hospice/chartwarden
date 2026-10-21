// @chartwarden/terminology — the D8 tenant-offboarding eraseFn (M38-T10, spec §11 D8, §3.1 layout).
//
// Registered with the M4 destruction registry (over the app boundary's DataEraser) to satisfy a
// right-to-erasure / tenant-offboarding request for the `terminology_tenant_extensions` data class.
// M38's ONLY tenant-attributable data is the tenant's `value_set_tenant_extension` rows (its
// add-only customizations of platform value sets, §2.4.3) plus their cached expansion overrides.
// Everything else M38 owns — code systems, concepts, value-set definitions, expansions, embeddings,
// the update log — is shared PLATFORM reference data that survives the tenant and is never subject to
// HIPAA retention destruction (§7.2: a destruction certificate has never been needed for canonical
// terminology data). So this eraser deletes the org's extensions and NOTHING else; platform tables
// are physically out of reach (the tenant `wardenx_app` role has no write grant on them, §7.4).
//
// Pure orchestration over the {@link TerminologyEraseStore} port — the in-memory store implements it
// for the slice/tests; the Drizzle-backed store implements it over `value_set_tenant_extension` in
// production. No clock, no I/O here, so the offboarding count is deterministic and assertable.

/** The narrow data port the terminology eraseFn composes over (a slice of `TerminologyStore`). */
export interface TerminologyEraseStore {
  /** Delete every `value_set_tenant_extension` row owned by `orgId`; report the count removed. */
  eraseTenantExtensions(orgId: string): Promise<{ erased: number }>;
}

/**
 * Erase a tenant's terminology footprint on offboarding (D8): delete the org's value-set extensions
 * and return the count. Platform reference tables are NEVER touched. `orgId` is the offboarding org
 * (the `subjectId` the M4 destruction registry hands the eraser).
 */
export async function eraseTenantTerminology(
  orgId: string,
  store: TerminologyEraseStore,
): Promise<{ erased: number }> {
  return store.eraseTenantExtensions(orgId);
}
