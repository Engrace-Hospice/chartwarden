// @chartwarden/mdm — the D7 tenant-offboarding eraseFn (M40-T10, spec §7.8).
//
// Registered with the M4 destruction registry (over the app boundary's DataEraser) to satisfy a
// tenant-offboarding / right-to-erasure request for the `mdm_tenant_overlays` data class. M40's
// tenant-attributable data is: the per-kind OVERLAY rows (`external_physician_tenant_overlay` + the
// other overlays as they land), all `mdm_provisional` rows, and all `mdm_baa_record` rows. The
// org-less CANONICAL entities (physician/facility/payer) are shared registry-sourced reference data
// — they survive the tenant and are NEVER touched (§7.8); at the DB they are out of reach anyway
// (the tenant `wardenx_app` role has no write grant on canonical, M40-T03).
//
// Pure orchestration over the {@link MdmEraseStore} port — the in-memory store implements it for the
// slice/tests; the Drizzle-backed store implements it over the overlay/provisional/baa tables in
// production. No clock, no I/O here, so the offboarding counts are deterministic and assertable.

/** The per-class row counts a tenant-offboarding erase removed (§7.8 destruction certificate). */
export interface MdmEraseCounts {
  /** Per-kind overlay rows deleted (Phase 1: `external_physician_tenant_overlay`). */
  readonly overlays: number;
  /** `mdm_provisional` rows deleted. */
  readonly provisionals: number;
  /** `mdm_baa_record` rows deleted. */
  readonly baaRecords: number;
}

/** The narrow data port the MDM eraseFn composes over (a slice of the Drizzle/in-memory backend). */
export interface MdmEraseStore {
  /** Delete every overlay row owned by `orgId` across the per-kind overlay tables; report the count. */
  eraseTenantOverlays(orgId: string): Promise<{ erased: number }>;
  /** Delete every `mdm_provisional` row owned by `orgId`; report the count. */
  eraseTenantProvisionals(orgId: string): Promise<{ erased: number }>;
  /** Delete every `mdm_baa_record` row owned by `orgId`; report the count. */
  eraseTenantBaaRecords(orgId: string): Promise<{ erased: number }>;
}

/**
 * Erase a tenant's MDM footprint on offboarding (D7, §7.8): delete the org's overlay, provisional,
 * and BAA rows — and NOTHING else. Canonical reference entities are never touched. `orgId` is the
 * offboarding org (the `subjectId` the M4 destruction registry hands the eraser). Returns the
 * per-class counts the destruction certificate records, plus the `erased` total the `DataEraser`
 * contract reports.
 */
export async function eraseTenantMdm(
  orgId: string,
  store: MdmEraseStore,
): Promise<{ erased: number; counts: MdmEraseCounts }> {
  // Independent per-table deletes — order does not matter (no canonical row is affected, so there is
  // no FK cascade to sequence). Run concurrently for one round trip.
  const [overlays, provisionals, baaRecords] = await Promise.all([
    store.eraseTenantOverlays(orgId),
    store.eraseTenantProvisionals(orgId),
    store.eraseTenantBaaRecords(orgId),
  ]);
  const counts: MdmEraseCounts = {
    overlays: overlays.erased,
    provisionals: provisionals.erased,
    baaRecords: baaRecords.erased,
  };
  return { erased: counts.overlays + counts.provisionals + counts.baaRecords, counts };
}

/** An in-memory {@link MdmEraseStore} for the slice/tests, seeded with per-class counts to remove. */
export function createInMemoryMdmEraseStore(
  seed: {
    overlaysByOrg?: Readonly<Record<string, number>>;
    provisionalsByOrg?: Readonly<Record<string, number>>;
    baaByOrg?: Readonly<Record<string, number>>;
  } = {},
): { store: MdmEraseStore } {
  const overlays = new Map(Object.entries(seed.overlaysByOrg ?? {}));
  const provisionals = new Map(Object.entries(seed.provisionalsByOrg ?? {}));
  const baa = new Map(Object.entries(seed.baaByOrg ?? {}));
  /** Pop the seeded count for an org (a delete clears it, so a re-run reports 0 — idempotent). */
  const take = (m: Map<string, number>, orgId: string) => {
    const n = m.get(orgId) ?? 0;
    m.set(orgId, 0);
    return { erased: n };
  };
  return {
    store: {
      async eraseTenantOverlays(orgId) {
        return take(overlays, orgId);
      },
      async eraseTenantProvisionals(orgId) {
        return take(provisionals, orgId);
      },
      async eraseTenantBaaRecords(orgId) {
        return take(baa, orgId);
      },
    },
  };
}
