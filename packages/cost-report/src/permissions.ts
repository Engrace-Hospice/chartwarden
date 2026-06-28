// @wardenx/cost-report — M27 permission-key catalog (§4.6).
//
// The authoritative list of every permission key Module 27 owns. In a later phase the backend re-exports
// this and registers it into Module 3's catalog (the M30 `M30_PERMISSIONS` / M33 `M33_PERMISSIONS`
// precedent); any route or seam handler referencing a key NOT in this list fails at boot. P1 ships only
// the pure constant catalog (no registration, no Fastify) — this is the source of truth the backend
// projects from. Keys use the platform `resource.action` dot form (the spec writes them with a `:`
// separator; the registry convention is the dot key — `cost_report.create`).
//
// The spec §4.6 table enumerates fourteen keys (its prose says "eleven" — the table is authoritative).

/**
 * The §4.6 permission keys M27 owns, as an ordered literal tuple. Grouped by surface (read, edit,
 * approval/submit, acknowledgment/reopen, rule administration). `*.submit` / `*.approve_for_submit` /
 * `*.reopen_submitted` / `*.override_validation` / `*.submit_past_deadline` additionally require M2
 * step-up auth at the route layer (D14) — the key grants the capability; step-up gates the action.
 */
export const M27_PERMISSIONS = [
  // read surface (§6)
  "cost_report.create",
  "cost_report.read",
  "cost_report.read_snapshot_detail",
  "cost_report.read_rules",
  // edit surface (draft/populating only)
  "cost_report.edit",
  "cost_report.edit_mappings",
  "cost_report.edit_bad_debt",
  // validation override + approval + submit (step-up gated)
  "cost_report.override_validation",
  "cost_report.approve_for_submit",
  "cost_report.submit",
  "cost_report.submit_past_deadline",
  // acknowledgment + reopen
  "cost_report.record_acknowledgment",
  "cost_report.reopen_submitted",
  // rule-library administration
  "cost_report.manage_rules",
] as const;

export type M27PermissionKey = (typeof M27_PERMISSIONS)[number];
