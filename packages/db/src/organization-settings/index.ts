// @chartwarden/db — Organization-Settings Registry barrel (M1 Foundation §3.15, M1-T07).
// The typed registry + reader over `organization.settings`; the matching schema table
// `organization_settings_registry` is exported via the schema barrel.
export * from "./types";
export * from "./registry";
export * from "./reader";
export * from "./boot";
// M1's own `org_timezone` setting (PARAM-004 follow-up) — DEFAULT_ORGANIZATION_TIMEZONE is exported
// as a second line of defense for a caller that can't reach the settings reader at all (e.g. the
// organization row itself failed to load), distinct from the reader's own defaultValue fallback for
// "row loaded, key just never set".
export { DEFAULT_ORGANIZATION_TIMEZONE } from "./settings-by-m1";
export {
  organizationTimezone,
  serviceDateForOrganization,
  todayForOrganization,
} from "./org-today";
