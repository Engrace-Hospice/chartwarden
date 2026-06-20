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
// M38-T06 — Module 38's permission keys registered into M3's catalog (§4.4 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M38ContributedPermissionKey,
  M38_CONTRIBUTED_PERMISSIONS,
  m38ContributedPermissionMirrorRows,
} from "./contributed";
// M36-T07 — Module 36's permission keys registered into M3's catalog (§4.5 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M36ContributedPermissionKey,
  M36_CONTRIBUTED_PERMISSIONS,
  m36ContributedPermissionMirrorRows,
} from "./contributed";
// M40-T07 — Module 40's permission keys registered into M3's catalog (§4.4 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M40ContributedPermissionKey,
  M40_CONTRIBUTED_PERMISSIONS,
  m40ContributedPermissionMirrorRows,
} from "./contributed";
