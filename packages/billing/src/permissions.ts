// @wardenx/billing — M23 permission-key catalog (§4.6).
//
// The authoritative list of every permission key Module 23 owns. The backend re-exports this and
// registers it into Module 3's catalog (the M27 `M27_PERMISSIONS` / M30 `M30_PERMISSIONS` precedent);
// any route or seam handler referencing a key NOT in this list fails at boot. P1 ships only the pure
// constant catalog (no registration, no Fastify) — this is the source of truth the backend projects from.
// Keys use the platform `resource.action` DOT form (the spec §4.6 writes the same dot keys).
//
// `*.submit` / `*.void` / `*.replace` / `*.override` / `*.admin` additionally require M2 step-up auth at
// the route layer (D2) — the key grants the capability; step-up gates the privileged human action.

/** The §4.6 permission keys M23 owns, grouped by surface, as an ordered literal tuple. */
export const M23_PERMISSIONS = [
  // claim surface
  "billing.claim.assemble",
  "billing.claim.read",
  "billing.claim.update_draft",
  "billing.claim.delete_draft",
  "billing.claim.submit",
  "billing.claim.replace",
  "billing.claim.void",
  "billing.claim.read_ar_dashboard",
  "billing.claim.read_metrics",
  // NOE
  "billing.noe.read",
  "billing.noe.submit",
  "billing.noe.cancel",
  // NOTR
  "billing.notr.read",
  "billing.notr.submit",
  "billing.notr.cancel",
  // validation
  "billing.validation.read_run",
  "billing.validation.run",
  "billing.validation.override",
  "billing.validation.read_override",
  // rule config
  "billing.rule_config.read",
  "billing.rule_config.edit",
  "billing.rule_config.platform_admin",
  // eligibility
  "billing.eligibility.check",
  "billing.eligibility.read",
  // sequestration policy
  "billing.sequestration_policy.read",
  "billing.sequestration_policy.edit",
  // MAC credentials
  "billing.mac_credential.read",
  "billing.mac_credential.admin",
  // hospice rate table (F-210: tenant-entered CMS per-diem rates)
  "billing.rate_table.read",
  "billing.rate_table.admin",
  // tenant-entered hospice visit-charge schedule (charge per 15-minute unit per discipline)
  "billing.visit_charge.read",
  "billing.visit_charge.admin",
  // tenant-entered wage index (F-211)
  "billing.wage_index.read",
  "billing.wage_index.admin",
  // DDE work queue (ADR-0052): human work tracking for Medicare Direct Data Entry items.
  "billing.dde.read",
  "billing.dde.work",
  "billing.dde.mark_submitted",
  "billing.dde.admin",
  // ADR-0053: settle a clearinghouse attempt the transport can no longer settle (past the vendor's key window).
  "billing.clearinghouse.resolve_attempt",
] as const;

export type M23PermissionKey = (typeof M23_PERMISSIONS)[number];
