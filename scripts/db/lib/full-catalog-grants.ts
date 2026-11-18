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

/** The catalog rows a full-catalog dev role is given: every row except the withheld closure keys. */
export function fullCatalogGrantRows<T extends { readonly key: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !WITHHELD_CLOSURE_KEYS.has(row.key));
}
