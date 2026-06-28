// apps/backend/src/modules/27-cost-report/permission-keys.ts — M27 (§4.6 / §6).
//
// The fourteen permission keys Module 27 (Cost Report) registers into Module 3's catalog — the §4.6
// binding cross-module handshake (mirrored from the pure `M27_PERMISSIONS` tuple in
// `@wardenx/cost-report`). M3 must include these before M27's cost-report / worksheet / mapping / import /
// bad-debt / validation / submission routes (§4.1) can be authorized; those routes gate on
// `requirePermission(key)`. The catalog `abac` field is the DEFAULT predicate per key; the route layer
// additionally composes the explicit §4.7 chain M27 owns (./abac-predicates) over the M3-base `inOrg`.
//
// Categories (admin-UI grouping): operator keys are `cost_report`; the higher-bar admin keys (mappings,
// rule management, the approval/submit/reopen ladder) are `cost_report_admin` (the M30
// quality/quality_admin and M33 reporting/reporting_admin split precedent).
//
// REGISTRATION: this map is consumed by `@wardenx/auth`'s contributed-permission registry exactly as the
// M30 `M30_CONTRIBUTED_PERMISSIONS` map is; the companion mirror-row projector + wiring lands in the
// Integrate phase (P3). The KEYS here are kept in lock-step with `@wardenx/cost-report`'s `M27_PERMISSIONS`
// tuple (the pure source of truth) and the §4.1 route inventory — asserted equal in test.
import type { PermissionDef } from "@wardenx/auth";
import { M27_PERMISSIONS, type M27PermissionKey } from "@wardenx/cost-report";

/**
 * The §4.6 permission keys M27 owns (registered into M3). Single-owner across the platform registry.
 * `as const satisfies` pins the literal keys while validating each value against `PermissionDef`; the
 * `abac` default is the dominant §4.7 predicate per key (the route composes it after the base `inOrg`).
 */
export const M27_CONTRIBUTED_PERMISSIONS = {
  // --- read surface (§6) — aggregate-only, inOrg-scoped ---
  "cost_report.create": {
    resource: "cost_report",
    action: "create",
    category: "cost_report",
    abac: "cost_report_editor_for_provider",
  },
  "cost_report.read": {
    resource: "cost_report",
    action: "read",
    category: "cost_report",
    abac: "inOrg",
  },
  "cost_report.read_snapshot_detail": {
    resource: "cost_report",
    action: "read_snapshot_detail",
    category: "cost_report",
    abac: "inOrg",
  },
  "cost_report.read_rules": {
    resource: "cost_report",
    action: "read_rules",
    category: "cost_report",
    abac: "inOrg",
  },
  // --- edit surface (draft/populating only) ---
  "cost_report.edit": {
    resource: "cost_report",
    action: "edit",
    category: "cost_report",
    abac: "cost_report_editor_for_provider",
  },
  "cost_report.edit_mappings": {
    resource: "cost_report",
    action: "edit_mappings",
    category: "cost_report_admin",
    abac: "cost_report_editor_for_provider",
  },
  "cost_report.edit_bad_debt": {
    resource: "cost_report",
    action: "edit_bad_debt",
    category: "cost_report",
    abac: "cost_report_editor_for_provider",
  },
  // --- validation override + approval + submit (step-up gated at the route, D14) ---
  "cost_report.override_validation": {
    resource: "cost_report",
    action: "override_validation",
    category: "cost_report_admin",
    abac: "cost_report_approver_for_provider",
  },
  "cost_report.approve_for_submit": {
    resource: "cost_report",
    action: "approve_for_submit",
    category: "cost_report_admin",
    abac: "cost_report_approver_for_provider",
  },
  "cost_report.submit": {
    resource: "cost_report",
    action: "submit",
    category: "cost_report_admin",
    abac: "cost_report_approver_for_provider",
  },
  "cost_report.submit_past_deadline": {
    resource: "cost_report",
    action: "submit_past_deadline",
    category: "cost_report_admin",
    abac: "cost_report_approver_for_provider",
  },
  // --- acknowledgment + reopen ---
  "cost_report.record_acknowledgment": {
    resource: "cost_report",
    action: "record_acknowledgment",
    category: "cost_report",
    abac: "inOrg",
  },
  "cost_report.reopen_submitted": {
    resource: "cost_report",
    action: "reopen_submitted",
    category: "cost_report_admin",
    abac: "cost_report_approver_for_provider",
  },
  // --- rule-library administration ---
  "cost_report.manage_rules": {
    resource: "cost_report",
    action: "manage_rules",
    category: "cost_report_admin",
    abac: "inOrg",
  },
} as const satisfies Record<M27PermissionKey, PermissionDef>;

/** The ordered key list — kept identical to `@wardenx/cost-report`'s `M27_PERMISSIONS` (asserted in test). */
export const M27_PERMISSION_KEY_LIST: readonly M27PermissionKey[] = M27_PERMISSIONS;

export type M27ContributedPermissionKey = keyof typeof M27_CONTRIBUTED_PERMISSIONS;
