// F-204 (#248) — the DEFAULT grants of the lab-transmission recovery permissions (F-203) to the operational roles a
// tenant is expected to have. F-203 split `orders.transmission.*` out of `orders.amend` and granted the three keys to
// `administrator` + `org_admin` only, which left a tenant with a single org admin unable to complete a two-person
// recovery (the co-signer must be a DIFFERENT user). These are the roles that ALSO hold them by default, wherever the
// tenant has created that role: a director of nursing and a clinical supervisor run lab-order follow-up; a compliance
// officer is the high-trust co-signer the collusion bound (F-203) asks for.
//
// NOT a `system_locked` floor: a tenant may still remove a key from a role it owns (a floor would also make every
// existing tenant's role fail `floorViolations` until backfilled). It is the migration `0274` seed, the dev-seed grant
// and the single source both are pinned to — `m11-orm-recovery.live.test.ts` compares migration and constant.
//
// `medical_director` and every discipline role are deliberately absent: re-disclosing an order to a lab and attesting to
// a third party's state is an operational authority, not a clinical one, and `orders.amend` already covers them.
export const LAB_RECOVERY_KEYS = {
  recover: "orders.transmission.recover",
  viewHeld: "orders.transmission.view_held",
  cosignEscalated: "orders.transmission.cosign_escalated",
} as const;

export const LAB_RECOVERY_DEFAULT_GRANTS = {
  director_of_nursing: [LAB_RECOVERY_KEYS.recover, LAB_RECOVERY_KEYS.viewHeld],
  clinical_supervisor: [LAB_RECOVERY_KEYS.recover, LAB_RECOVERY_KEYS.viewHeld],
  compliance_officer: [LAB_RECOVERY_KEYS.cosignEscalated, LAB_RECOVERY_KEYS.viewHeld],
} as const satisfies Record<string, readonly string[]>;
