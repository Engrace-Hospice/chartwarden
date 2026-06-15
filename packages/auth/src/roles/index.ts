// @wardenx/auth · roles (M3 — Authorization). Owned per module-manifest.ts codePath
// `packages/auth/src/roles`. The role catalog + `system_locked` permission floor (M3-T02)
// ship in ./templates; the org-seed routine (clone templates into an org) lands in M3-T06.
export {
  type RoleCategory,
  type RoleTemplate,
  type ScopeLevel,
  type SystemLockedRoleKey,
  ROLE_TEMPLATES,
  SYSTEM_LOCKED_FLOORS,
  floorFor,
  floorViolations,
  isSystemLocked,
  satisfiesFloor,
} from "./templates";
