// apps/backend/src/modules/33-reporting/permission-keys.ts — M33 (§4.6).
//
// The THIRTY-THREE permission keys Module 33 (Reporting & Dashboards) registers into Module 3's
// catalog — the §4.6 binding cross-module handshake (M33 spec §4.6). M3 must include these before
// M33's report-builder / dashboard / scheduled-report / platform-MV routes can be authorized; those
// routes (a later M33 phase) gate on them. The catalog `abac` field is the DEFAULT predicate per key;
// the route layer additionally composes the explicit §4.7 chain M33 owns (./abac-predicates) — the
// cross-cutting `reportable_scope` envelope on every read tile/dashboard/export/drilldown, and
// `dashboard_visibility` on the saved-view read/edit/share surface.
//
// Categories (§4.6): keys 1–28 are `reporting`; the five platform/compliance admin keys (29–33) are
// `reporting_admin`. NB the spec prose elsewhere says "eighteen keys" — that is a stale internal
// inconsistency; the registered set audits to THIRTY-THREE (the §4.6 list below).
//
// Same `resource.action[_scope]` shape and DB-mirror contract as M3's own `PERMISSIONS`; kept in a
// dedicated const so each module's contribution stays attributable (§3.3 ownership).
//
// REGISTRATION: this map is consumed by `@wardenx/auth`'s contributed-permission registry exactly
// as the M34 `M34_CONTRIBUTED_PERMISSIONS` map is (packages/auth/src/permissions/contributed.ts —
// `m33ContributedPermissionMirrorRows`). The companion mirror-row projector + `allPermissionMirrorRows`
// wiring lives in that file (M3-owned catalog); this typed list is the M33-owned source of truth those
// rows project from.
import type { PermissionDef } from "@wardenx/auth";

/**
 * The §4.6 permission keys M33 owns (registered into M3). Single-owner across the platform registry.
 * `as const satisfies` pins the literal keys while validating each value against `PermissionDef`.
 */
export const M33_CONTRIBUTED_PERMISSIONS = {
  // --- dashboards + tiles (reporting) ---
  "report.dashboard.list": {
    resource: "report_dashboard",
    action: "list",
    category: "reporting",
    abac: "none",
  },
  "report.dashboard.read": {
    resource: "report_dashboard",
    action: "read",
    category: "reporting",
    abac: "reportable_scope",
  },
  "report.tile.read": {
    resource: "report_tile",
    action: "read",
    category: "reporting",
    abac: "reportable_scope",
  },
  // --- report bases + metric catalog (reporting) ---
  "report.base.list": {
    resource: "report_base_catalog",
    action: "list",
    category: "reporting",
    abac: "none",
  },
  "report.base.read": {
    resource: "report_base_catalog",
    action: "read",
    category: "reporting",
    abac: "none",
  },
  "report.metric.list": {
    resource: "report_metric_catalog",
    action: "list",
    category: "reporting",
    abac: "none",
  },
  // --- report definitions (reporting) ---
  "report.definition.list": {
    resource: "report_definition",
    action: "list",
    category: "reporting",
    abac: "none",
  },
  "report.definition.read": {
    resource: "report_definition",
    action: "read",
    category: "reporting",
    abac: "none",
  },
  "report.definition.write": {
    resource: "report_definition",
    action: "write",
    category: "reporting",
    abac: "none",
  },
  "report.definition.publish": {
    resource: "report_definition",
    action: "publish",
    category: "reporting",
    abac: "none",
  },
  "report.definition.archive": {
    resource: "report_definition",
    action: "archive",
    category: "reporting",
    abac: "none",
  },
  // --- saved views (reporting) ---
  "report.view.list": {
    resource: "report_view",
    action: "list",
    category: "reporting",
    abac: "none",
  },
  "report.view.read": {
    resource: "report_view",
    action: "read",
    category: "reporting",
    abac: "dashboard_visibility",
  },
  "report.view.write": {
    resource: "report_view",
    action: "write",
    category: "reporting",
    abac: "dashboard_visibility",
  },
  "report.view.archive": {
    resource: "report_view",
    action: "archive",
    category: "reporting",
    abac: "dashboard_visibility",
  },
  "report.view.set_org_default": {
    resource: "report_view",
    action: "set_org_default",
    category: "reporting",
    abac: "none",
  },
  // --- view sharing (reporting) ---
  "report.share.write": {
    resource: "report_view_share",
    action: "write",
    category: "reporting",
    abac: "dashboard_visibility",
  },
  "report.share.org": {
    resource: "report_view_share",
    action: "share_org",
    category: "reporting",
    abac: "none",
  },
  // --- scheduled reports (reporting) ---
  "report.schedule.list": {
    resource: "report_schedule",
    action: "list",
    category: "reporting",
    abac: "none",
  },
  "report.schedule.read": {
    resource: "report_schedule",
    action: "read",
    category: "reporting",
    abac: "none",
  },
  "report.schedule.write": {
    resource: "report_schedule",
    action: "write",
    category: "reporting",
    abac: "none",
  },
  "report.schedule.cancel": {
    resource: "report_schedule",
    action: "cancel",
    category: "reporting",
    abac: "none",
  },
  "report.schedule.delete_all_runs": {
    resource: "report_schedule",
    action: "delete_all_runs",
    category: "reporting",
    abac: "none",
  },
  // --- exports (reporting) ---
  "report.export.csv": {
    resource: "report_export",
    action: "export_csv",
    category: "reporting",
    abac: "reportable_scope",
  },
  "report.export.pdf": {
    resource: "report_export",
    action: "export_pdf",
    category: "reporting",
    abac: "reportable_scope",
  },
  "report.export.xlsx": {
    resource: "report_export",
    action: "export_xlsx",
    category: "reporting",
    abac: "reportable_scope",
  },
  // --- drilldowns (reporting) ---
  "report.drilldown.read": {
    resource: "report_drilldown",
    action: "read",
    category: "reporting",
    abac: "reportable_scope",
  },
  "report.drilldown.bulk_export": {
    resource: "report_drilldown",
    action: "bulk_export",
    category: "reporting",
    abac: "reportable_scope",
  },
  // --- platform / compliance admin (reporting_admin) ---
  "report.admin.mv_list": {
    resource: "materialized_view_metadata",
    action: "list",
    category: "reporting_admin",
    abac: "none",
  },
  "report.admin.mv_refresh": {
    resource: "materialized_view_metadata",
    action: "refresh",
    category: "reporting_admin",
    abac: "none",
  },
  "report.admin.mv_suspend": {
    resource: "materialized_view_metadata",
    action: "suspend",
    category: "reporting_admin",
    abac: "none",
  },
  "report.admin.lag_read": {
    resource: "replica_lag",
    action: "read",
    category: "reporting_admin",
    abac: "none",
  },
  "report.admin.audit_read": {
    resource: "report_drilldown_audit",
    action: "read",
    category: "reporting_admin",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M33 contributed permission keys (thirty-three). */
export type M33ContributedPermissionKey = keyof typeof M33_CONTRIBUTED_PERMISSIONS;

/**
 * The §4.6 permission-key names M33 owns, as an ordered literal tuple ready for registration.
 * Convenience projection of `M33_CONTRIBUTED_PERMISSIONS` keys (the boot path / auth-package
 * mirror-row projector consumes the full map; this is the flat name list for assertions/tests).
 */
export const M33_PERMISSION_KEYS = Object.keys(
  M33_CONTRIBUTED_PERMISSIONS,
) as readonly M33ContributedPermissionKey[];

/** Back-compat alias — the spec refers to the registered array as `M33_PERMISSIONS`. */
export const M33_PERMISSIONS = M33_PERMISSION_KEYS;
