// @chartwarden/auth · role catalog + `system_locked` permission floor (M3 — Authorization,
// M3-T02; spec §3.4, §3.4.1, M03-F06).
//
// The role catalog is the public surface every module binds permissions to. A role is a
// named set of permissions; a tenant may disable, rename, clone, or extend the defaults,
// but it **cannot delete a `system_locked` role or strip it below its CoP-required
// permission floor**. This file owns the floor — the load-bearing, normatively-specified
// part of §3.4.1 that §2.4 validation and the role editor (PATCH /roles/:id, M3-T08)
// enforce. The ≈60 default `system_default` templates are normatively enumerated in the
// spec's Appendix A (generated from this file, CI-checked); the concretely-specified
// `system_locked` roles below are the floor-bearing subset this task ships.

// NOTE: these two unions mirror the `role_category` / `scope_level` DB enums (spec §3.2,
// authored in packages/db/src/enums.ts under M3-T01). They are inlined rather than imported
// from `@chartwarden/db` on purpose: M3 (dependsOn: [2]) may reach db only through the
// `packages/db/src/schema` type surface, not the `@chartwarden/db` runtime barrel (the import
// boundary in .dependency-cruiser.cjs). check-ddl-legality.ts keeps the DB enum canonical.

import { CARE_PLAN_DEFAULT_GRANTS } from "./care-plan-grants";
import { SYSTEM_ROLE_DISPLAY_NAMES } from "./display-names";
import { NOTE_CLOSURE_DEFAULT_GRANTS } from "./note-closure-grants";
import { VISIT_NOTE_DRAFT_DEFAULT_GRANTS } from "./visit-note-draft-grants";

/** The twelve role categories A–L (mirrors the `role_category` DB enum, spec §3.2). */
export type RoleCategory =
  | "clinical_staff"
  | "clinical_leadership"
  | "operations"
  | "admin_executive"
  | "billing_finance"
  | "compliance_quality"
  | "volunteer"
  | "patient_family"
  | "external_auditor"
  | "external_collaborator"
  | "platform_staff"
  | "temporary_special";
/** How broadly a role grants (mirrors the `scope_level` DB enum, spec §3.2). */
export type ScopeLevel = "organization" | "provider_entity" | "location" | "patient";

/**
 * A default role template. `key` is the stable catalog identifier (snake_case);
 * `floor` is the minimum permission-key set a `system_locked` role must always retain
 * (empty for non-locked roles). Floor entries are permission-key strings — many name
 * keys owned by *other* modules (e.g. `patient.read`, `cti.sign`), which those modules
 * register into the catalog (spec §3.3), so the floor is typed `readonly string[]`, not
 * the M3-only `PermissionKey` union.
 */
export interface RoleTemplate {
  key: string;
  name: string;
  category: RoleCategory;
  scopeLevel: ScopeLevel;
  systemDefault: boolean;
  systemLocked: boolean;
  description: string;
  /** CoP-required permission floor (minimum — may not be stripped below). */
  floor: readonly string[];
  /**
   * The default permission keys this template GRANTS out of the box (the seed a fresh org/platform
   * catalog materializes into `role_permission`). Distinct from `floor` (the un-strippable minimum a
   * `system_locked` role must retain): a non-locked template carries no floor but may still carry a
   * default grant — e.g. the §4.7 platform-ops roles below bind the M35 `billing_admin.*` keys here.
   * Absent → the template grants nothing by default (the historical behavior for the ≈60
   * `system_default` templates whose grants are assigned per-org at seed time). Every `grants` key is a
   * permission-key string owned by some module's catalog fragment (typed `readonly string[]`, not the
   * M3-only `PermissionKey` union), mirroring `floor`.
   */
  grants?: readonly string[];
}

// ── Platform-ops role catalog (§4.7, platform-owned) ───────────────────────────────────────────────────
//
// M35 (Subscription Billing) gates its cross-tenant `/api/admin` surface on the `platform_billing_scope`
// ABAC predicate, which admits any caller carrying a platform-ops role. Those roles are platform-owned (they
// live in the platform catalog, not a tenant's), so they are registered HERE — the single role catalog every
// module binds to — and M35 re-derives its `PLATFORM_BILLING_ROLES` from `PLATFORM_OPS_ROLE_KEYS` so the ABAC
// gate's role list and the catalog can never drift.

/**
 * The six §4.7 platform-ops role keys: the admit-set of every platform-role predicate that decides on role-set membership
 * (`platform_billing_scope`, M2's organization lifecycle and cross-tenant organization reads, M33 `platform_admin_scope`, M29's operator
 * check, the Claim.MD ops routes). The three onboarding duty roles CW-AC-22 split off `platform_ops` are NOT here: a member of this list
 * plus one permission key (`org.manage`, say) reaches cross-tenant routes, and a duty role must not be one more way to get there. The two
 * of them that read pricing are admitted to `platform_billing_scope` alone ({@link PLATFORM_PRICING_READ_DUTY_ROLE_KEYS}).
 */
export const PLATFORM_OPS_ROLE_KEYS = [
  "platform_owner",
  "platform_admin",
  "platform_billing_admin",
  "platform_support_t2",
  "platform_sales",
  "platform_ops",
] as const;

/** Union of the platform-ops role keys. */
export type PlatformOpsRoleKey = (typeof PLATFORM_OPS_ROLE_KEYS)[number];

/** The three onboarding duty roles CW-AC-22 split off `platform_ops` (platform-owned role templates; see {@link PLATFORM_ROLE_CONFLICTS}). */
export const PLATFORM_DUTY_ROLE_KEYS = [
  "platform_baa_steward",
  "platform_go_live_approver",
  "platform_pricing_operator",
] as const;

export type PlatformDutyRoleKey = (typeof PLATFORM_DUTY_ROLE_KEYS)[number];

/** Every platform role that has a default permission template (the six §4.7 roles and the three duty roles). */
export type PlatformRoleTemplateKey = PlatformOpsRoleKey | PlatformDutyRoleKey;

/**
 * The duty roles `platform_billing_scope` admits besides the six: the two that hold `subscription.pricing_read_platform` (the pricing
 * operator, and the go-live approver for its console panel). That one key, a cross-tenant read of plans, a tenant's contract and
 * statements, is all a billing-scope route accepts from them; the BAA steward is not admitted at all.
 */
export const PLATFORM_PRICING_READ_DUTY_ROLE_KEYS = [
  "platform_pricing_operator",
  "platform_go_live_approver",
] as const;

// The eighteen M35 `billing_admin.*` permission keys (catalog `category: "billing_admin"`), split by the
// §4.7 binding rule this wave applies (see ADMIN-T02; `dunning.admin.read` added in M35A-T03 as the
// dunning-list screen's read source):
//   • READ keys        → support / billing / admin / owner   (the read-only ops surface)
//   • WRITE/step-up    → billing / admin / owner             (mutating ops, each also §D14 step-up-gated)
//   • refund.approve   → admin / owner ONLY                  (kept DISJOINT from `refund.request` so the
//                                                             §4.8 four-eyes approver ≠ requester rule stays
//                                                             assignable — a `platform_billing_admin` may
//                                                             REQUEST a refund but never self-APPROVE it)
/** The 8 read keys of the M35 `billing_admin.*` surface. */
export const M35_BILLING_ADMIN_READ_KEYS = [
  "plan.admin.read",
  "subscription.admin.read",
  "dunning.admin.read",
  "refund.read",
  "promo.admin.read",
  "revenue.admin.read",
  "usage.admin.read",
  "stripe.admin.read",
] as const;
/** The 9 mutating (write / override / request / apply / revoke / replay) `billing_admin.*` keys. */
export const M35_BILLING_ADMIN_WRITE_KEYS = [
  "plan.admin.write",
  "subscription.admin.write",
  "dunning.admin.override",
  "refund.request",
  "promo.admin.write",
  "promo.admin.apply",
  "promo.admin.revoke",
  "revenue.admin.write",
  "stripe.admin.replay",
] as const;
/** The single four-eyes-gated approval key, kept disjoint from `refund.request`. */
export const M35_REFUND_APPROVE_KEY = "refund.approve" as const;

/** The role sets each key band binds to (owner ⊇ admin ⊇ billing ⊇ support in read reach). */
const PLATFORM_READ_ROLES: readonly string[] = [
  "platform_support_t2",
  "platform_billing_admin",
  "platform_admin",
  "platform_owner",
];
const PLATFORM_WRITE_ROLES: readonly string[] = [
  "platform_billing_admin",
  "platform_admin",
  "platform_owner",
];
const PLATFORM_APPROVE_ROLES: readonly string[] = ["platform_admin", "platform_owner"];
/**
 * GAP-001 follow-up — the platform user-lifecycle grant. `POST /api/v1/platform/users/:id/deactivate`
 * gates on `user.deactivate` AND the M2 `user_lifecycle_platform_ops` ABAC predicate, which admits exactly
 * these roles; without the grant a pure platform operator failed the RBAC check first.
 */
export const PLATFORM_USER_LIFECYCLE_KEY = "user.deactivate" as const;
export const PLATFORM_PASSWORD_RESET_KEY = "user.password.reset" as const;
const PLATFORM_USER_LIFECYCLE_ROLES: readonly string[] = [
  "platform_ops",
  "platform_admin",
  "platform_owner",
];

/**
 * Onboarding wizard v2 (M34, migration 1329): the platform operator's own wizard keys (CW-AC-22: the three powers that were bound to
 * `platform_ops` beside these now have their own roles, below). `onboarding.manage_platform` attests, re-opens, sets the org profile
 * and the compliance officer; every route behind these gates on `tenant_lifecycle_platform_ops`, the exact `platform_ops` role.
 * Migration 1438 granted the wizard's own read and its skip: without the read key a template operator was refused the wizard itself.
 */
export const M34_PLATFORM_OPS_ONBOARDING_KEYS = [
  "onboarding.manage_platform",
  "onboarding.read_platform",
  "onboarding.skip",
  // The wizard's BAA panel reads the platform BAA register beside the step the operator attests (CW-AC-22: reading it is not the
  // steward's write; `tenant_platform_onboarding_staff` admits both).
  "platform_tenant_baa.read_platform",
] as const;

/**
 * CW-AC-22 (migration 1559): the three onboarding powers `platform_ops` used to hold together, each now its own least-privilege role so
 * no one account both enters data and approves it. Each route gates on a predicate that admits exactly the one role
 * (`tenant_platform_baa_steward`, `tenant_platform_go_live_approver`, `tenant_platform_pricing_operator`), so a key is bound to that role
 * alone: a grant to a role the predicate always denies would be a control that exists on paper only.
 *   - BAA steward: the signed-BAA upload and the platform BAA register (the uploader and the register writer are the two operators
 *     go-live approval refuses as its approver, so the approver must not be able to be either).
 *   - Go-live approver: the second party of the two-party go-live (approve and revoke) and nothing else.
 *   - Pricing operator: signs a tenant onto a plan at onboarding step 2 and changes its billing service mode.
 * Every duty role also reads the wizard it acts in (`onboarding.read_platform`, behind `tenant_platform_onboarding_staff`).
 */
export const PLATFORM_BAA_STEWARD_KEYS = [
  "tenant_baa_document.upload_platform",
  "platform_tenant_baa.write_platform",
  "platform_tenant_baa.read_platform",
] as const;
/**
 * The approval, plus the two reads the console's go-live panel loads before it enables the button (the tenant's clearinghouse choice, behind
 * `tenant_platform_onboarding_staff`, and its plan contract, behind `platform_billing_scope`): without them the one role allowed to approve
 * could approve only by calling the API directly.
 */
export const PLATFORM_GO_LIVE_APPROVER_KEYS = [
  "go_live.approve_platform",
  "tenant_clearinghouse.read_platform",
  "subscription.pricing_read_platform",
] as const;
export const M35_PLATFORM_PRICING_OPERATOR_KEYS = ["subscription.onboard_platform"] as const;

/** The wizard read every onboarding role needs to see the step it acts in. */
export const PLATFORM_ONBOARDING_READ_KEY = "onboarding.read_platform" as const;

/** The four roles that work the onboarding wizard: `platform_ops` plus the three duty roles (`tenant_platform_onboarding_staff` admits them). */
export const PLATFORM_ONBOARDING_ROLE_KEYS: readonly string[] = [
  "platform_ops",
  "platform_baa_steward",
  "platform_go_live_approver",
  "platform_pricing_operator",
];

/**
 * Platform roles one account may not hold together (CW-AC-22). The go-live approver is the second party of the two-party go-live, so it
 * holds no onboarding write duty: `db:platform-role grant` refuses a pair listed here. The check is on the ACCOUNT (the platform-owned
 * roles bound to any membership of one user), and `superadmin`, which stands for every role by design, is outside it; two accounts held
 * by one person are not detectable here either, which is why the go-live guards keep comparing accounts as well.
 */
export const PLATFORM_ROLE_CONFLICTS: readonly (readonly [
  PlatformRoleTemplateKey,
  PlatformRoleTemplateKey,
])[] = [
  ["platform_go_live_approver", "platform_ops"],
  ["platform_go_live_approver", "platform_baa_steward"],
  ["platform_go_live_approver", "platform_pricing_operator"],
];

/**
 * Slice 7 (7S, migration 1484): the support-session keys the platform console's routes gate on. `support_session.list_platform` and
 * `.close` gate on `tenant_lifecycle_platform_ops` (the exact `platform_ops` role) and `.start` on the distinct-actor predicate, but no
 * template or migration granted them, so a template operator was refused every one (as 1438 found for the onboarding pair). Only
 * `platform_ops` carries them: the console that starts, lists and ends sessions is that role's. `support_session.elevate_phi_read` is NOT
 * here: an elevation is PHI work no slice grants yet, and a session on an `assist` grant can never be elevated.
 */
export const M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS = [
  "support_session.list_platform",
  "support_session.start",
  "support_session.close",
] as const;

/**
 * Slice 7 (7S, migration 1484): the compliance officer's consent-grant keys. Until now only org_admin and administrator held them (through
 * the full non-platform catalog), so the officer, who is the grantor the spec names, could not issue, list or revoke a grant. The
 * template gives NEW tenants the same; migration 1484 covers existing roles. Who may issue WHICH scope is the service's rule, not this list's.
 */
export const M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS = [
  "support_consent_grant.list_own",
  "support_consent_grant.issue",
  "support_consent_grant.revoke",
] as const;

/**
 * The platform onboarding-data keys (M34 `/api/v1/platform/tenants/:orgSlug/{provider-entities,locations,mac-credentials}`):
 * operators fill in a tenant's provider entities, service locations and MAC credentials on its behalf while it is
 * still onboarding. The routes also gate on the `tenant_lifecycle_platform_ops` predicate, which admits the EXACT
 * `platform_ops` role only (a `platform_admin` / `platform_owner` is denied by it), a fresh step-up and a recorded
 * reason. So only `platform_ops` carries the keys: a grant to a role the predicate always denies would be a control
 * that exists on paper only.
 */
export const PLATFORM_ONBOARDING_DATA_KEYS = [
  "tenant_onboarding_data.read_platform",
  "tenant_onboarding_data.write_platform",
  // ADR-0053 amendment 2026-11-06: the tenant's clearinghouse choice (`/platform/tenants/:orgSlug/clearinghouse`) is
  // onboarding data entered on its behalf, with the same predicate, step-up and reason.
  "tenant_clearinghouse.read_platform",
  "tenant_clearinghouse.write_platform",
  "tenant_clearinghouse.verify_baa_platform",
  // Owner decision "build it" (2026-11-09): revoking a tenant's vendor BAA is its own platform duty (migration 1468).
  "tenant_clearinghouse.revoke_baa_platform",
  // Owner decision 2026-11-08: releasing a tenant's earlier clearinghouse credentials is its own platform duty (migration 1435).
  "tenant_clearinghouse.release_credential_platform",
  // Owner decision 2026-11-06: an operator withdraws a tenant's mistaken "filed outside ChartWarden" NOE/NOTR record (migration 1422).
  "tenant_notice_filing.withdraw_platform",
  // The signed-BAA upload (migration 1424) is the BAA steward's since CW-AC-22 (PLATFORM_BAA_STEWARD_KEYS).
  // Tenant onboarding slice 4 (ADR-0111): the tenant's DoseSpot clinic registration is onboarding data entered on its behalf,
  // with the same predicate, step-up and reason (migration 1429).
  "tenant_dosespot.read_platform",
  "tenant_dosespot.write_platform",
] as const;
const PLATFORM_ONBOARDING_DATA_ROLES: readonly string[] = ["platform_ops"];

/**
 * Slice 2 (tenant pricing, migration 1413). `subscription.onboard_platform` (sign a tenant onto a plan at onboarding step 2, change its
 * billing service mode) is the pricing operator's since CW-AC-22 (M35_PLATFORM_PRICING_OPERATOR_KEYS above).
 * `subscription.pricing_read_platform` (offered plans, the price preview, a tenant's contract and statements) is read-only behind
 * `platform_billing_scope`, so the operator who prices a tenant, `platform_ops` and the three billing roles hold it.
 */
export const M35_PRICING_READ_KEY = "subscription.pricing_read_platform" as const;
const PRICING_READ_ROLES: readonly string[] = [
  "platform_ops",
  "platform_pricing_operator",
  "platform_billing_admin",
  "platform_admin",
  "platform_owner",
];

/** Build a platform-ops role's default grant: `billing_admin.*` per the §4.7 binding rule, plus user lifecycle. */
function platformOpsGrantsFor(role: PlatformRoleTemplateKey): readonly string[] {
  const keys: string[] = [];
  if (PLATFORM_READ_ROLES.includes(role)) keys.push(...M35_BILLING_ADMIN_READ_KEYS);
  if (PLATFORM_WRITE_ROLES.includes(role)) keys.push(...M35_BILLING_ADMIN_WRITE_KEYS);
  if (PLATFORM_APPROVE_ROLES.includes(role)) keys.push(M35_REFUND_APPROVE_KEY);
  if (PLATFORM_USER_LIFECYCLE_ROLES.includes(role))
    keys.push(PLATFORM_USER_LIFECYCLE_KEY, PLATFORM_PASSWORD_RESET_KEY);
  if (role === "platform_ops") keys.push(...M34_PLATFORM_OPS_ONBOARDING_KEYS);
  if (role === "platform_ops") keys.push(...M34_PLATFORM_OPS_SUPPORT_SESSION_KEYS);
  if (role === "platform_baa_steward") keys.push(...PLATFORM_BAA_STEWARD_KEYS);
  if (role === "platform_go_live_approver") keys.push(...PLATFORM_GO_LIVE_APPROVER_KEYS);
  if (role === "platform_pricing_operator") keys.push(...M35_PLATFORM_PRICING_OPERATOR_KEYS);
  // Every onboarding duty role reads the wizard it acts in (platform_ops already holds the key above).
  if (PLATFORM_ONBOARDING_ROLE_KEYS.includes(role) && role !== "platform_ops")
    keys.push(PLATFORM_ONBOARDING_READ_KEY);
  if (PRICING_READ_ROLES.includes(role)) keys.push(M35_PRICING_READ_KEY);
  if (PLATFORM_ONBOARDING_DATA_ROLES.includes(role)) keys.push(...PLATFORM_ONBOARDING_DATA_KEYS);
  return keys;
}

/**
 * Default grant per platform-ops role: `billing_admin.*` (§4.7) plus `user.deactivate` for the user-lifecycle
 * roles. `platform_sales` and `platform_ops` carry NO `billing_admin.*` keys under this wave's binding rule — they are still registered (they satisfy the
 * `platform_billing_scope` ABAC gate) but hold no RBAC grant here, so they fail closed at `requirePermission`
 * until a later wave binds their surface. `platform_billing_admin` deliberately lacks `refund.approve`.
 */
export const PLATFORM_OPS_ROLE_GRANTS = Object.fromEntries(
  [...PLATFORM_OPS_ROLE_KEYS, ...PLATFORM_DUTY_ROLE_KEYS].map((role) => [
    role,
    platformOpsGrantsFor(role),
  ]),
) as Record<PlatformRoleTemplateKey, readonly string[]>;

/**
 * The `system_locked` permission floor (spec §3.4.1, M03-F06). Each CoP-required role
 * maps to the minimum permission set it must always retain. A tenant may rename or
 * *extend* a locked role but may not delete it or remove any of these keys.
 *
 * EVERY ENTRY MUST BE A KEY THE PERMISSION CATALOG ACTUALLY REGISTERS. Eight of the original
 * twenty-seven were not (F-093) — they were written from the spec's illustrative names before the
 * owning modules registered their real ones, and nothing ever compared the two. That is not a naming
 * blemish: `role_permission.permission_key` REFERENCES `permission.key`, so a floor key with no
 * catalog row cannot be GRANTED at all (the insert dies on the foreign key), which means the CoP floor
 * for four of the six locked roles was unsatisfiable — and once §3.4.1 is genuinely enforced (it was
 * not; see `role-store.ts`), `floorViolations` reports an ungrantable key as stripped on every edit, so
 * a locked role becomes permanently uneditable. `permission-catalog.test.ts` now pins the invariant.
 *
 * The corrections, each a mapping onto the key the owning module registers rather than an invention:
 *   `cti.sign`           → `cti.sign_hospice_md`  M6 splits the CTI signature into the hospice-MD and
 *                                                 attending arms because 42 CFR 418.22(c)(1) requires
 *                                                 both; the Medical Director's is the hospice-MD one.
 *   `idg.participate`    → `idg.attend`           M14's participation key (CoP 418.56(a)(1)).
 *   `order.cosign`       → `orders.cosign`        M11 registers the `orders.*` namespace, not `order.*`.
 *   `care_plan.manage`   → `care_plan.finalize`   Of M7's seven `care_plan.*` keys this is the one that
 *                                                 expresses AUTHORITY over the plan — `author` is
 *                                                 per-discipline, `sign` fills one signer slot, and
 *                                                 `idg_revise` belongs to the group, not the DON.
 *   `assignment.manage`  → `patient.assign`       M5's caseload-assignment key — CoP 418.64(a)'s
 *                                                 "assigns nursing staff to patients", exactly.
 *   `report.read`        → `report.dashboard.read` There is no two-part `report.*` key; this is M33's
 *                                                 read entry point.
 *   `security_event.read`→ `incident.read`        No `security_event` resource exists anywhere in the
 *                                                 platform — no table, no route, no key. §164.308's
 *                                                 information-system-activity review is audit (already
 *                                                 floored here twice) plus SECURITY-INCIDENT TRACKING,
 *                                                 which is M30's `incident.*` surface.
 */
export const SYSTEM_LOCKED_FLOORS = {
  // Medical Director — CoP 418.102.
  medical_director: [
    "patient.read",
    "cti.sign_hospice_md",
    "idg.attend",
    "orders.cosign",
    "breakglass.invoke",
  ],
  // Director of Nursing (DON) — CoP 418.64(a).
  director_of_nursing: [
    "patient.read",
    "care_plan.finalize",
    "idg.attend",
    "patient.assign",
    "breakglass.invoke",
  ],
  // Administrator — CoP 418.100.
  administrator: ["org.manage", "member.manage", "role.read", "report.dashboard.read"],
  // Compliance Officer — CoP 418.52 / HIPAA.
  compliance_officer: [
    "audit.read",
    "audit.disclosure_report",
    "breakglass.read",
    "breakglass.cosign",
    "engagement.manage",
    "legalhold.manage",
  ],
  // HIPAA Privacy Officer — §164.530(a). `privacy.admin` (M5 §4.7) is the privacy official's own
  // control over the patient privacy-flag snapshot (the officer view + "Resync from consent", M5 §5.1);
  // without it the §164.530(a) role could not reach the one screen the M5 spec names it the actor for.
  hipaa_privacy_officer: [
    "audit.read",
    "audit.disclosure_report",
    "consent.read",
    "legalhold.read",
    "privacy.admin",
  ],
  // HIPAA Security Officer — §164.308(a)(2).
  hipaa_security_officer: ["audit.read", "audit.integrity", "incident.read"],
} as const satisfies Record<string, readonly string[]>;

/** Union of the `system_locked` role keys (the CoP-required floor-bearing roles). */
export type SystemLockedRoleKey = keyof typeof SYSTEM_LOCKED_FLOORS;

/**
 * The floor-bearing subset of the role catalog: the six CoP-required `system_locked`
 * roles (spec §3.4.1). The ≈60 `system_default` (non-locked) templates extend this array
 * — they are enumerated in Appendix A and carry an empty floor.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: "medical_director",
    name: SYSTEM_ROLE_DISPLAY_NAMES.medical_director,
    category: "clinical_leadership",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.102 hospice medical director.",
    floor: SYSTEM_LOCKED_FLOORS.medical_director,
    // WP 4.1 (ADR-0068): a physician may raise and receive an urgent clinical message, as migration 1105 grants.
    // WP 5.8 (ADR-0087): a physician may open a break-glass read grant, as migration 1140 grants.
    // D-2 (CW-AC-44): the Medical Director can read and sign a care plan on a fresh tenant, as migration 1494 grants.
    grants: [
      "messaging.urgent.send",
      "messaging.urgent.receive",
      "messaging.break_glass.invoke",
      ...(CARE_PLAN_DEFAULT_GRANTS.medical_director ?? []),
    ],
  },
  {
    key: "director_of_nursing",
    name: "Director of Nursing",
    category: "clinical_leadership",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.64(a) director of nursing services.",
    floor: SYSTEM_LOCKED_FLOORS.director_of_nursing,
    // The lifecycle review queue is a supervisory decision (ADR-0065 D6); no template grants it to the org-wide admins.
    // WP 4.1 (ADR-0068): the supervisory nurse may raise and receive an urgent clinical message, as migration 1105 grants.
    // WP 5.8 (ADR-0087): the supervisory nurse may open a break-glass read grant, as migration 1140 grants.
    // D-2 (CW-AC-44): the DON can open, author and finalize a care plan on a fresh tenant, as migration 1494 grants.
    // ADR-0113 D7: the DON can lift a blocked clinician's visit-note closure and set the tenant's closure mode, as migration 1515
    // grants. `closure_override` is in FULL_CATALOG_EXCLUDED_KEYS (org_admin / administrator do not hold it); the administrators
    // derive `closure_policy_admin` from the full catalog.
    grants: [
      "messaging.review",
      "messaging.urgent.send",
      "messaging.urgent.receive",
      "messaging.break_glass.invoke",
      ...(CARE_PLAN_DEFAULT_GRANTS.director_of_nursing ?? []),
      ...(NOTE_CLOSURE_DEFAULT_GRANTS.director_of_nursing ?? []),
      // ADR-0114 VN-D17: the DON can switch the tenant's visit-note draft on or off, as migration 1520 grants.
      ...(VISIT_NOTE_DRAFT_DEFAULT_GRANTS.director_of_nursing ?? []),
    ],
  },
  {
    key: "administrator",
    name: "Administrator",
    category: "admin_executive",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.100 hospice administrator.",
    floor: SYSTEM_LOCKED_FLOORS.administrator,
  },
  {
    // SaaS tenant/account administrator — the operational org-admin the platform's
    // authorization layer keys on: `isAdmin` derivation (rbac/drizzle-store.ts
    // ORG_ADMIN_ROLE_KEY), the M2 last-admin lockout guard, tenant provisioning's
    // first-admin, and the ~10 `hasRole(ctx,"org_admin")` ABAC predicates across
    // M20/M22/M23/M24/M25/M32/M33/M34. Distinct from the CoP-418.100 `administrator`
    // (clinical/regulatory) role: a tenant may hold either or both. Non-locked (no CoP
    // permission floor); grantable as a `system_default` template.
    key: "org_admin",
    name: "Organization Administrator",
    category: "admin_executive",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description: "SaaS tenant/account administrator (org-scoped platform authority).",
    floor: [],
  },
  {
    key: "compliance_officer",
    name: SYSTEM_ROLE_DISPLAY_NAMES.compliance_officer,
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "CoP 418.52 / HIPAA compliance officer; default break-glass approver.",
    floor: SYSTEM_LOCKED_FLOORS.compliance_officer,
    // M5 §4.7 grants `privacy.admin` to "Privacy Officer, Compliance Officer" (§6: both may resync privacy
    // flags). `step_up_override.manage` (GAP-115, M2 §4.1: "org_admin/compliance_officer") likewise. A DEFAULT grant, not floor: the CoP 418.52 floor is the un-strippable minimum, and a tenant
    // whose privacy official alone should hold resync may remove it from the compliance officer.
    grants: [
      ...SYSTEM_LOCKED_FLOORS.compliance_officer,
      "privacy.admin",
      "step_up_override.manage",
      // GAP-010: the compliance officer may reveal a stored SSN (M5 spec 4.7); the single source is ssn-grants.ts.
      "phi.read_ssn",
      // M34 two-party go-live (migration 1329 covers existing roles): the compliance officer reads the onboarding wizard
      // and attests go-live readiness.
      "onboarding.read_own",
      "go_live.attest",
      // Slice 7 (7S, migration 1484 covers existing roles): the officer lists, issues and revokes support consent grants.
      ...M34_COMPLIANCE_OFFICER_SUPPORT_GRANT_KEYS,
      // WP 5.6 (ADR-0086): migration 1138 grants this to EXISTING compliance_officer roles; this entry gives NEW tenants the same
      // (administrator / org_admin get it through the non-platform catalog, the mirror in permissions/contributed.ts).
      "messaging.retention.manage",
      // WP 5.8 (ADR-0087): the compliance officer completes the post-review of a break-glass grant (migration 1140 covers existing roles).
      "messaging.break_glass.review",
      // WP 5.7 (ADR-0089): the compliance officer requests, approves and downloads a restricted export (migration 1147 covers existing roles).
      "messaging.export.request",
      "messaging.export.approve",
      "messaging.export.download",
      // WP 6.6 (ADR-0096): the compliance officer manages external partner shares (migration 1180 covers existing roles).
      "messaging.share.manage",
      // WP 6.7 (ADR-0099 D9): the compliance officer manages and answers family messaging (migration 1234 covers existing roles).
      "messaging.family.manage",
      "messaging.family.respond",
      // WP 6.10 (ADR-0102): the compliance officer manages alarm ingest sources (migration 1250 covers existing roles).
      "messaging.alarm_ingest.manage",
      // WP 5.6 (ADR-0055 item 7): request and approve a message redaction (two different people; migration 1156 covers existing roles).
      "messaging.redact.request",
      "messaging.redact.approve",
      // M25 milestone 9a-1: the compliance officer reviews and publishes denial playbooks someone else wrote (migration 1252 covers
      // existing roles; administrator / org_admin get the keys through the non-platform catalog).
      "playbook.read",
      "playbook.publish",
      // M25 milestone 9a-2: the leadership medical-review report (migration 1253 covers existing roles).
      "medical_review.report.read",
      // M41 (#724): commercial billing (migration 1265 covers existing roles). Administrator and org_admin get them through the catalog.
      "commercial_billing.read",
      "commercial_billing.write",
      "commercial_billing.submit",
      "commercial_billing.override_validation",
      "commercial_billing.manage_enrollment",
    ],
  },
  {
    key: "hipaa_privacy_officer",
    name: SYSTEM_ROLE_DISPLAY_NAMES.hipaa_privacy_officer,
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "§164.530(a) privacy official.",
    floor: SYSTEM_LOCKED_FLOORS.hipaa_privacy_officer,
    // WP 5.6 (ADR-0055 D9): the second role that countersigns a sole officer's self-approved message redaction (migration 1165).
    grants: ["messaging.redact.countersign"],
  },
  {
    key: "hipaa_security_officer",
    name: "HIPAA Security Officer",
    category: "compliance_quality",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: true,
    description: "§164.308(a)(2) security official.",
    floor: SYSTEM_LOCKED_FLOORS.hipaa_security_officer,
  },
  // ── §4.7 platform-ops roles (platform_staff, category K). Non-locked (no CoP floor); each carries its
  // default M35 `billing_admin.*` grant via `PLATFORM_OPS_ROLE_GRANTS`. `scopeLevel` is `organization` —
  // the broadest `scope_level` enum value (there is no platform-wide scope), which the platform console's
  // ABAC gate (`platform_billing_scope`) confines to the cross-tenant admin surface, not any one org.
  {
    key: "platform_owner",
    name: "Platform Owner",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops owner — full billing-admin surface incl. refund approval and MRR/ARR.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_owner,
  },
  {
    key: "platform_admin",
    name: "Platform Admin",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops admin — full billing-admin surface incl. refund approval (four-eyes approver).",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_admin,
  },
  {
    key: "platform_billing_admin",
    name: "Platform Billing Admin",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops billing admin — reads + mutates the billing surface and REQUESTS refunds; cannot self-approve them (§4.8 four-eyes).",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_billing_admin,
  },
  {
    key: "platform_support_t2",
    name: "Platform Support (Tier 2)",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description: "Platform-ops tier-2 support — read-only across the billing-admin surface.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_support_t2,
  },
  {
    key: "platform_sales",
    name: "Platform Sales",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops sales — satisfies `platform_billing_scope`; no default `billing_admin.*` grant this wave.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_sales,
  },
  {
    key: "platform_ops",
    name: "Platform Operations",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Platform-ops operations — satisfies `platform_billing_scope`; no default `billing_admin.*` grant this wave.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_ops,
  },
  // CW-AC-22: the three onboarding powers split off platform_ops. Each is a platform-owned role created by `db:platform-role grant`
  // (migration 1559 removes the same keys from the platform_ops row); none carries a `billing_admin.*` key.
  {
    key: "platform_baa_steward",
    name: "Platform BAA Steward",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Files a tenant's signed BAA and keeps the platform BAA register. Holds no data-entry, pricing or go-live approval key.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_baa_steward,
  },
  {
    key: "platform_go_live_approver",
    name: "Platform Go-Live Approver",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "The second party of the two-party go-live: approves or revokes a tenant's go-live. Holds no onboarding write key, and one account may not also hold platform_ops, the BAA steward or the pricing operator.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_go_live_approver,
  },
  {
    key: "platform_pricing_operator",
    name: "Platform Pricing Operator",
    category: "platform_staff",
    scopeLevel: "organization",
    systemDefault: true,
    systemLocked: false,
    description:
      "Signs a tenant onto a plan at onboarding step 2 and changes its billing service mode. Reads the pricing surface; holds no other onboarding write key.",
    floor: [],
    grants: PLATFORM_OPS_ROLE_GRANTS.platform_pricing_operator,
  },
] as const;

/** True when `roleKey` names a CoP-required `system_locked` role. */
export function isSystemLocked(roleKey: string): roleKey is SystemLockedRoleKey {
  return Object.hasOwn(SYSTEM_LOCKED_FLOORS, roleKey);
}

/**
 * The required permission floor for a role, or `[]` for non-locked roles. The role
 * editor unions a proposed permission set with this to guarantee the floor is retained.
 */
export function floorFor(roleKey: string): readonly string[] {
  return isSystemLocked(roleKey) ? SYSTEM_LOCKED_FLOORS[roleKey] : [];
}

/**
 * Floor enforcement (spec §2.4 / §3.4.1): the permission keys that `proposedKeys` would
 * illegally strip from a `system_locked` role. A non-empty result means the edit must be
 * rejected (the role editor returns 409). Non-locked roles never violate (empty result).
 */
export function floorViolations(
  roleKey: string,
  proposedKeys: readonly string[],
): readonly string[] {
  const have = new Set(proposedKeys);
  return floorFor(roleKey).filter((key) => !have.has(key));
}

/** True when `proposedKeys` retains every floor permission of `roleKey` (§3.4.1). */
export function satisfiesFloor(roleKey: string, proposedKeys: readonly string[]): boolean {
  return floorViolations(roleKey, proposedKeys).length === 0;
}

/**
 * The default role keys that GRANT `permissionKey` out of the box — the union of every template whose
 * `grants` (or `system_locked` `floor`) includes it. Used to prove no permission key is orphaned (each
 * `billing_admin.*` key must resolve to ≥1 role, else the whole surface is 403-for-all).
 */
export function rolesForPermission(permissionKey: string): readonly string[] {
  return ROLE_TEMPLATES.filter(
    (t) => (t.grants ?? []).includes(permissionKey) || t.floor.includes(permissionKey),
  ).map((t) => t.key);
}

/** A single seedable `role_permission` grant row: which platform-ops role holds which permission key. */
export interface RolePermissionSeedRow {
  roleKey: PlatformRoleTemplateKey;
  permissionKey: string;
}

/**
 * The platform-ops role→permission grant seed (§4.7). Flattens `PLATFORM_OPS_ROLE_GRANTS` into the
 * `(roleKey, permissionKey)` rows a platform-catalog seed materializes into `role_permission` — the
 * platform analogue of the per-org grant the dev seed writes for tenant roles.
 */
export function platformOpsRolePermissionSeedRows(): RolePermissionSeedRow[] {
  return [...PLATFORM_OPS_ROLE_KEYS, ...PLATFORM_DUTY_ROLE_KEYS].flatMap((roleKey) =>
    PLATFORM_OPS_ROLE_GRANTS[roleKey].map((permissionKey) => ({ roleKey, permissionKey })),
  );
}
