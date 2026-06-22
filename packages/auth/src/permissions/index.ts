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
// M5-T09 — Module 5's permission keys registered into M3's catalog (§4.7 handshake).
export {
  type M5ContributedPermissionKey,
  M5_CONTRIBUTED_PERMISSIONS,
  m5ContributedPermissionMirrorRows,
} from "./contributed";
// M39-T07 — Module 39's permission keys registered into M3's catalog (§4.7 handshake).
export {
  type M39ContributedPermissionKey,
  M39_CONTRIBUTED_PERMISSIONS,
  m39ContributedPermissionMirrorRows,
} from "./contributed";
// M6-T06 — Module 6's permission keys registered into M3's catalog (§4.5 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M6ContributedPermissionKey,
  M6_CONTRIBUTED_PERMISSIONS,
  m6ContributedPermissionMirrorRows,
} from "./contributed";
// M7-T05 — Module 7's permission keys registered into M3's catalog (§4.5 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M7ContributedPermissionKey,
  M7_CONTRIBUTED_PERMISSIONS,
  m7ContributedPermissionMirrorRows,
} from "./contributed";
// M8-T09 — Module 8's permission keys registered into M3's catalog (§4.5 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M8ContributedPermissionKey,
  M8_CONTRIBUTED_PERMISSIONS,
  m8ContributedPermissionMirrorRows,
} from "./contributed";
// M9-T05 — Module 9's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M9ContributedPermissionKey,
  M9_CONTRIBUTED_PERMISSIONS,
  m9ContributedPermissionMirrorRows,
} from "./contributed";
// M10-T06 — Module 10's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M10ContributedPermissionKey,
  M10_CONTRIBUTED_PERMISSIONS,
  m10ContributedPermissionMirrorRows,
} from "./contributed";
// M11-T06 — Module 11's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M11ContributedPermissionKey,
  M11_CONTRIBUTED_PERMISSIONS,
  m11ContributedPermissionMirrorRows,
} from "./contributed";
// M12-T08 — Module 12's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M12ContributedPermissionKey,
  M12_CONTRIBUTED_PERMISSIONS,
  m12ContributedPermissionMirrorRows,
} from "./contributed";
