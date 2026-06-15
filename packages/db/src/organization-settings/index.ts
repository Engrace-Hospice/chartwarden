// @wardenx/db — Organization-Settings Registry barrel (M1 Foundation §3.15, M1-T07).
// The typed registry + reader over `organization.settings`; the matching schema table
// `organization_settings_registry` is exported via the schema barrel.
export * from "./types";
export * from "./registry";
export * from "./reader";
export * from "./boot";
