// @wardenx/auth — package barrel. Auth code is split across modules per the manifest:
// identity (M2) and rbac/abac/permissions/roles/breakglass/engagements (M3). Each
// module's public surface is re-exported here as it lands.
export * from "./identity";
