// @chartwarden/auth · rbac — what a granted role confers, with `superadmin` answered from the code catalog.
//
// `administrator` and `org_admin` hold the permission catalog (FULL_CATALOG_ROLE_KEYS), and `superadmin` supersedes
// both. A stored `role_permission` row cannot promise that: the catalog grows with every module, and the grants that
// keep the two tenant admin roles whole (materialization, `db:sync:permissions`) write tenant-owned rows, never the
// platform-owned `superadmin` one. So the resolver does not read superadmin's stored rows at all — it grants every
// key the code catalog declares, and a key added tomorrow is granted tomorrow.
//
// It withholds the SAME keys the admin roles are denied on purpose (FULL_CATALOG_EXCLUDED_KEYS): the messaging
// redaction request and approve keys are the two halves of a two-person control (ADR-0055 D9), and one account must
// never hold both. `superadmin` is therefore exactly what `org_admin` holds plus the platform-category keys.
import { allPermissionMirrorRows } from "../permissions";
import { SUPERADMIN_ROLE_KEY } from "../roles/platform-reserved";
import {
  FULL_CATALOG_EXCLUDED_KEYS,
  PLATFORM_PERMISSION_CATEGORY,
} from "../roles/template-materialization";

const PLATFORM_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  allPermissionMirrorRows()
    .filter((row) => row.category === PLATFORM_PERMISSION_CATEGORY)
    .map((row) => row.key),
);

/**
 * The platform-category (cross-tenant) keys among `keys`. A tenant-owned role never carries one: materialization
 * withholds them from every tenant default, and the role routes refuse them. Anti-escalation compares keys only,
 * so without this a holder of the platform keys (`superadmin`, `platform_ops`) could mint a tenant-owned role
 * carrying them and assign it without the operator CLI, a ticket or a passkey.
 */
export function platformPermissionKeysIn(keys: readonly string[]): readonly string[] {
  return keys.filter((key) => PLATFORM_PERMISSION_KEYS.has(key));
}

const SUPERADMIN_KEYS: readonly string[] = Object.freeze([
  ...new Set(
    allPermissionMirrorRows()
      .map((row) => row.key)
      .filter((key) => !FULL_CATALOG_EXCLUDED_KEYS.has(key)),
  ),
]);

/**
 * The permission keys one granted role confers. `storedKeys` are its `role_permission` rows; they are returned as
 * they are for every role but the PLATFORM-OWNED `superadmin` (`roleOrganizationId` null). A tenant-owned row that
 * carries the key confers nothing in `roleConfersKey` before it gets here; requiring a null owner as well means a
 * reordered or removed filter upstream cannot hand it the catalog.
 */
export function effectivePermissionKeys(
  roleKey: string,
  storedKeys: readonly string[],
  roleOrganizationId: string | null,
): readonly string[] {
  return answersFromCatalog(roleKey, roleOrganizationId) ? SUPERADMIN_KEYS : storedKeys;
}

/**
 * True for the one role whose permissions come from the code catalog and never from its stored rows: the
 * PLATFORM-OWNED `superadmin`. A loader uses it to skip reading `role_permission` rows that would be thrown away.
 */
export function answersFromCatalog(roleKey: string, roleOrganizationId: string | null): boolean {
  return roleKey === SUPERADMIN_ROLE_KEY && roleOrganizationId === null;
}
