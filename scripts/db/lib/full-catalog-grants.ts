// Which catalog keys a dev "full catalog" role (`administrator`, `org_admin`) is given by the seed scripts and the permission sync.
//
// A tenant provisioned through the product derives those roles from the full catalog minus FULL_CATALOG_EXCLUDED_KEYS. Of that set the dev
// scripts withhold ONLY the visit-note closure keys in it (today `encounter.closure_override`: an administrator is not a clinical
// supervisor, ADR-0113 D7), so a seeded or synced dev database, and the demo tenant reseeded from it, holds what a freshly provisioned
// tenant holds. The other excluded keys keep their earlier dev behaviour (the demo admin still reviews messaging).
import { FULL_CATALOG_EXCLUDED_KEYS, NOTE_CLOSURE_PERMISSION_KEYS } from "@chartwarden/auth";

export const WITHHELD_CLOSURE_KEYS: ReadonlySet<string> = new Set(
  NOTE_CLOSURE_PERMISSION_KEYS.filter((key) => FULL_CATALOG_EXCLUDED_KEYS.has(key)),
);

/**
 * CW-AC-46: the key that lowers the HOPE signer-licence check to shadow. It is category `platform`, which the tenant materializer already
 * withholds from org_admin and administrator (so it is not in FULL_CATALOG_EXCLUDED_KEYS, whose arithmetic is for non-platform keys), but
 * THESE seed scripts grant every catalog row, so a seeded or demo tenant's admin would hold it and could lower its own control. Withheld
 * here: a dev database holds what a freshly provisioned tenant holds.
 */
export const WITHHELD_PLATFORM_KEYS: ReadonlySet<string> = new Set([
  "hope.admin.signer_licence_policy",
]);

/** The catalog rows a full-catalog dev role is given: every row except the withheld closure and platform keys. */
export function fullCatalogGrantRows<T extends { readonly key: string }>(rows: readonly T[]): T[] {
  return rows.filter(
    (row) => !WITHHELD_CLOSURE_KEYS.has(row.key) && !WITHHELD_PLATFORM_KEYS.has(row.key),
  );
}
