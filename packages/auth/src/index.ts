// @chartwarden/auth — package barrel. Auth code is split across modules per the manifest:
// identity (M2) and rbac/abac/permissions/roles/breakglass/engagements (M3). Each
// module's public surface is re-exported here as it lands.
export * from "./identity";
// M3 (Authorization) — the code-owned permission catalog (M3-T01) and the role catalog +
// `system_locked` floor (M3-T02) land first; the Authorization Contract guard surface
// (rbac/abac, M3-T05) follows; breakglass/engagements re-export here as they ship.
export * from "./permissions";
export * from "./roles";
export * from "./rbac";
export * from "./abac";
