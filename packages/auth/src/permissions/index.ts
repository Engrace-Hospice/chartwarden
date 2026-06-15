// @wardenx/auth · permissions (M3 — Authorization). Owned per module-manifest.ts
// codePath `packages/auth/src/permissions`. The code-owned permission catalog (the
// source of truth mirrored to the DB `permission` table) ships in ./catalog (M3-T01).
export {
  type PermissionDef,
  type PermissionKey,
  type PermissionMirrorRow,
  PERMISSIONS,
  permissionMirrorRows,
} from "./catalog";
// M3-T10 — the M1/M2 permission-key back-fill (§3.3 / M03-F07; M2 §4.7 handshake): the keys
// other modules contribute into M3's catalog, kept out of the locked `PERMISSIONS` const.
export {
  type ContributedPermissionKey,
  CONTRIBUTED_PERMISSIONS,
  allPermissionMirrorRows,
  contributedPermissionMirrorRows,
} from "./contributed";
// M4-T10 — Module 4's permission keys registered into M3's catalog (§4.5 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M4ContributedPermissionKey,
  M4_CONTRIBUTED_PERMISSIONS,
  m4ContributedPermissionMirrorRows,
} from "./contributed";
