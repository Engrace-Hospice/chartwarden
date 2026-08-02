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
// M13-T08 — Module 13's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M13ContributedPermissionKey,
  M13_CONTRIBUTED_PERMISSIONS,
  m13ContributedPermissionMirrorRows,
} from "./contributed";
// M14-T05 — Module 14's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M14ContributedPermissionKey,
  M14_CONTRIBUTED_PERMISSIONS,
  m14ContributedPermissionMirrorRows,
} from "./contributed";
// M17-T07 — Module 17's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M17ContributedPermissionKey,
  M17_CONTRIBUTED_PERMISSIONS,
  m17ContributedPermissionMirrorRows,
} from "./contributed";
// M18-T06 — Module 18's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M18ContributedPermissionKey,
  M18_CONTRIBUTED_PERMISSIONS,
  m18ContributedPermissionMirrorRows,
} from "./contributed";
// M22-T07 — Module 22's permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M22ContributedPermissionKey,
  M22_CONTRIBUTED_PERMISSIONS,
  m22ContributedPermissionMirrorRows,
} from "./contributed";
// M33 — Module 33's reporting permission keys registered into M3's catalog (§4.6 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M33ContributedPermissionKey,
  M33_CONTRIBUTED_PERMISSIONS,
  m33ContributedPermissionMirrorRows,
} from "./contributed";
// M34 — Module 34's forty-one permission keys registered into M3's catalog (§4.5 handshake), in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M30ContributedPermissionKey,
  type M34ContributedPermissionKey,
  M30_CONTRIBUTED_PERMISSIONS,
  M34_CONTRIBUTED_PERMISSIONS,
  m30ContributedPermissionMirrorRows,
  m34ContributedPermissionMirrorRows,
} from "./contributed";
// M23 — Module 23's twenty-eight Billing — Medicare permission keys registered into M3's catalog (§4.6
// handshake), in a dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M23ContributedPermissionKey,
  M23_CONTRIBUTED_PERMISSIONS,
  m23ContributedPermissionMirrorRows,
} from "./contributed";
// M25 — Module 25's twenty-two Remittance & Denials permission keys registered into M3's catalog (§4.6
// handshake), in a dedicated const so each module's contribution stays attributable (§3.3 ownership model).
export {
  type M25ContributedPermissionKey,
  M25_CONTRIBUTED_PERMISSIONS,
  m25ContributedPermissionMirrorRows,
} from "./contributed";

// M26 — Module 26's fourteen Cap Management permission keys registered into M3's catalog (§4.6 handshake).
export {
  type M26ContributedPermissionKey,
  M26_CONTRIBUTED_PERMISSIONS,
  m26ContributedPermissionMirrorRows,
} from "./contributed";

// M27 — Module 27's fifteen Cost Report permission keys registered into M3's catalog (§4.6 handshake).
export {
  type M27ContributedPermissionKey,
  M27_CONTRIBUTED_PERMISSIONS,
  m27ContributedPermissionMirrorRows,
} from "./contributed";

// M24 — Module 24's twenty-six Billing — Medicaid permission keys registered into M3's catalog (§4.7 handshake).
export {
  type M24ContributedPermissionKey,
  M24_CONTRIBUTED_PERMISSIONS,
  m24ContributedPermissionMirrorRows,
} from "./contributed";

// M15 — Module 15's twenty Discipline Care Plans permission keys registered into M3's catalog (§4.4 handshake).
export {
  type M15ContributedPermissionKey,
  M15_CONTRIBUTED_PERMISSIONS,
  m15ContributedPermissionMirrorRows,
} from "./contributed";

// M16 — Module 16's twenty-nine Bereavement permission keys registered into M3's catalog (§4.7 handshake).
export {
  type M16ContributedPermissionKey,
  M16_CONTRIBUTED_PERMISSIONS,
  m16ContributedPermissionMirrorRows,
} from "./contributed";

// M21 — Module 21's twenty-eight Supplies / DME / Comfort-Kit permission keys (§4.3 handshake).
export {
  type M21ContributedPermissionKey,
  M21_CONTRIBUTED_PERMISSIONS,
  m21ContributedPermissionMirrorRows,
} from "./contributed";

// M19 — Module 19's seventeen On-Call Triage permission keys (§4.6 handshake).
export {
  type M19ContributedPermissionKey,
  M19_CONTRIBUTED_PERMISSIONS,
  m19ContributedPermissionMirrorRows,
} from "./contributed";

// M20 — Module 20's twenty-five Field Safety permission keys (§4.6 handshake).
export {
  type M20ContributedPermissionKey,
  M20_CONTRIBUTED_PERMISSIONS,
  m20ContributedPermissionMirrorRows,
} from "./contributed";

// M32 — Module 32's twenty-two AI Platform permission keys (§4.6 handshake).
export {
  type M32ContributedPermissionKey,
  M32_CONTRIBUTED_PERMISSIONS,
  m32ContributedPermissionMirrorRows,
} from "./contributed";

// M31 — Module 31's forty-seven Patient/Family Portal & Telehealth permission keys (§4.6 handshake).
export {
  type M31ContributedPermissionKey,
  M31_CONTRIBUTED_PERMISSIONS,
  m31ContributedPermissionMirrorRows,
} from "./contributed";
