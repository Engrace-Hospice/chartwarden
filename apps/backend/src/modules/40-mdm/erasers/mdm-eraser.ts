// apps/backend/src/modules/40-mdm/erasers/mdm-eraser.ts — M40-T10 the `mdm_tenant_overlays` data
// eraser (M40 spec §7.8, D7 tenant offboarding).
//
// M40 owns the destruction path for its tenant-attributable data — a tenant's overlay rows, all
// `mdm_provisional` rows, and all `mdm_baa_record` rows — so it registers the REAL eraser over the
// Phase-0 deny-stub (bootstrap REQUIRED_ERASERS + wireErasers()); the composition root invokes
// registerMdmErasers() through buildServer's `registerModuleErasers` hook, which runs AFTER
// wireErasers() and before validateErasers(), so the real eraser stands and a tenant-offboarding
// request hits a working eraser, not a silent no-op (mirrors the M2/M4/M38/M36 erasers).
//
// The actual deletion is the pure `eraseTenantMdm` (packages/mdm/src/destruction): it deletes the
// org's overlay/provisional/baa rows and NOTHING else — the org-less CANONICAL entities
// (physician/facility/payer) are shared registry-sourced reference data that survive the tenant and
// are physically out of reach (the tenant role has no canonical write grant, M40-T03). Runs over an
// injected store with an in-memory default; production injects the Drizzle-backed store.
import { type DbClient, schema } from "@chartwarden/db";
import { type MdmEraseStore, createInMemoryMdmEraseStore, eraseTenantMdm } from "@chartwarden/mdm";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DataEraser } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import { registerEraser } from "../../../bootstrap/index";

/** Injected adapter for the M40 eraser (slice defaults to the in-memory erase store). */
export interface MdmEraserDeps {
  /** The data port deletes run over (Drizzle-backed in production; in-memory by default). */
  store?: MdmEraseStore;
}

/**
 * The Drizzle-backed erase store (TASK-003 / ARCH-007 — the argument-less registration bound the
 * in-memory store, so a tenant offboarding "erased" overlay rows that exist nowhere). Each method
 * hard-deletes ONE org-scoped table inside `withOrgContext` (app.org_id RLS — an offboarding can
 * never reach another tenant's rows) and reports the `.returning()` count; the three run
 * independently, exactly as the pure `eraseTenantMdm` schedules them (no FK sequencing — nothing
 * references the overlay/provisional/baa rows). Canonical entities are physically out of reach
 * here: `chartwarden_app` has no canonical write grant (M40-T03, migration 0019).
 *
 * GRANT CAVEAT (0019 §7): `mdm_provisional` grants `chartwarden_app` SELECT+INSERT only (promotion is
 * a chartwarden_admin path), so the provisional DELETE is refused by Postgres until the erase path is
 * granted DELETE (or runs under the admin role). That refusal is the correct fail direction — the
 * erase fails loudly rather than certifying provisional rows destroyed while they survive.
 */
export function createDrizzleMdmEraseStore(db: DbClient): MdmEraseStore {
  const OVERLAY = schema.externalPhysicianOverlay;
  const PROV = schema.mdmProvisional;
  const BAA = schema.mdmBaaRecords;
  const LIC = schema.mdmLicenseRecords;

  return {
    async eraseTenantOverlays(orgId) {
      // Phase 1: `external_physician_tenant_overlay` is the only per-kind overlay table built.
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const deleted = await tx
          .delete(OVERLAY)
          .where(eq(OVERLAY.organizationId, orgId))
          .returning({ id: OVERLAY.id });
        return { erased: deleted.length };
      });
    },

    async eraseTenantProvisionals(orgId) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const deleted = await tx
          .delete(PROV)
          .where(eq(PROV.organizationId, orgId))
          .returning({ id: PROV.id });
        return { erased: deleted.length };
      });
    },

    async eraseTenantBaaRecords(orgId) {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const deleted = await tx
          .delete(BAA)
          .where(eq(BAA.organizationId, orgId))
          .returning({ id: BAA.id });
        // GAP-173 — the tenant's manual license entries (`mdm_license_record`) are the same class of
        // compliance record as its BAA register, so they go with it and are counted with it.
        const deletedLicenses = await tx
          .delete(LIC)
          .where(eq(LIC.organizationId, orgId))
          .returning({ id: LIC.id });
        return { erased: deleted.length + deletedLicenses.length };
      });
    },
  };
}

/**
 * Build M40's `mdm_tenant_overlays` DataEraser. The destruction registry hands `subjectId` = the
 * offboarding org id; the eraser deletes that org's overlay/provisional/baa rows and reports the
 * faithful total removed (0 when the org never created any). The per-class counts the destruction
 * certificate records are computed by the pure `eraseTenantMdm`.
 */
export function createMdmEraser(store: MdmEraseStore): DataEraser {
  return {
    async erase(scope, subjectId) {
      // The data class is org-scoped: both `scope.orgId` and the offboarding `subjectId` name the
      // org. Erase by the subject (the offboarding org), consistent with the M2/M4/M38 erasers.
      void scope;
      const { erased } = await eraseTenantMdm(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register M40's REAL `mdm_tenant_overlays` eraser into the M1 destruction-cert registry over the
 * Phase-0 deny-stub (M40-T10). Called by the composition root's wireModuleErasers() AFTER
 * wireErasers() and before validateErasers(), so the real eraser stands.
 */
export function registerMdmErasers(deps: MdmEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryMdmEraseStore().store;
  registerEraser("mdm_tenant_overlays", createMdmEraser(store));
}
