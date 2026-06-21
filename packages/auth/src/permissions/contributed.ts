// @wardenx/auth · permissions — the M1/M2 permission-key back-fill (M3 — Authorization,
// M3-T10; spec §3.3 / M03-F07; M2 spec §4.7 binding handshake).
//
// The §3.3 ownership model: the catalog is code, and EACH module contributes its own
// `resource.action` keys into Module 3's now-real catalog (mirrored to the DB `permission`
// table). M3's own cross-cutting subset (`role.*` / `breakglass.*` / `engagement.*`) is the
// LOCKED `PERMISSIONS` const in ./catalog (a unit test pins it to exactly those eight keys);
// the keys OTHER modules own live here so the catalog const never drifts from M3's surface.
//
// This file closes the M2-T08 deferral: Module 2's admin routes are authorized by Module 3,
// so their permission keys must be in M3's catalog and assigned to the default `org_admin` /
// `platform_ops` templates (M2 spec §4.7). When M2's routes flipped from the M1 deny-stub to
// the real `requirePermission`/`requireAbac` (M3-T10), these are the keys the resolver grants.
//
// Module 1 (Foundation) contributes NO fine-grained permission key: its only privileged route
// (system-status mutation) is gated by the coarse `platform_ops` ROLE via `requireRole`, not a
// permission key, so there is nothing for M1 to register here.
import { type PermissionDef, type PermissionMirrorRow, permissionMirrorRows } from "./catalog";

/**
 * The permission keys Modules 1 & 2 register into Module 3's catalog (the §4.7 handshake).
 * Same `resource.action` shape and DB-mirror contract as M3's own `PERMISSIONS`; kept
 * separate only so the M3-owned catalog const stays exactly M3's cross-cutting subset.
 */
export const CONTRIBUTED_PERMISSIONS = {
  // --- Module 2 (Identity & Org) admin keys (M2 spec §4.7) ---
  // Org/ProviderEntity/Location CRUD + HearthNote opt-in (org_admin, platform_ops).
  "org.manage": { resource: "org", action: "manage", category: "admin", abac: "none" },
  // POST /orgs/:id/invitations (+ rescind) — invite a user to an org (org_admin).
  "member.invite": { resource: "member", action: "invite", category: "admin", abac: "none" },
  // Suspend/reinstate/revoke a membership + default-scope edits (org_admin).
  "member.manage": { resource: "member", action: "manage", category: "admin", abac: "none" },
  // Full offboard — disable credentials everywhere (org_admin own-org / platform_ops any).
  "user.deactivate": { resource: "user", action: "deactivate", category: "admin", abac: "none" },
  // Per-patient collaborator magic-link — clinician on the patient's caseload (ABAC), or
  // org_admin. The default ABAC predicate is `caseload_membership` (M5/M17 provider seam).
  "collaborator.invite": {
    resource: "collaborator",
    action: "invite",
    category: "clinical",
    abac: "caseload_membership",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the contributed permission keys (M1/M2). */
export type ContributedPermissionKey = keyof typeof CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 4 (Audit & Compliance Log) registers into Module 3's catalog —
 * the §4.5 binding cross-module handshake (M4-T10; M4 spec §4.5). M3 must include these before
 * M4's routes can be authorized; the audit/legal-hold/destruction routes (M4-T06/T08) gate on
 * them, and the six CoP-required `system_locked` compliance roles already pin their load-bearing
 * subset (`audit.read`/`audit.disclosure_report`/`audit.integrity`/`legalhold.*`) in their floor
 * (M3-T02 SYSTEM_LOCKED_FLOORS). Kept in a dedicated const (not folded into the M1/M2
 * `CONTRIBUTED_PERMISSIONS`) so each module's contribution stays attributable (§3.3 ownership).
 *
 * `audit.disclosure_report_all_scopes` is the only ABAC-gated key: the §164.528 / §2.13
 * accounting route's `?scope=all` additionally requires the `audit_accounting_scope_allowed`
 * predicate M4 registered into M3 (M4-T09, §7.2).
 */
export const M4_CONTRIBUTED_PERMISSIONS = {
  // --- audit read / reporting (§4.5) ---
  "audit.read": { resource: "audit", action: "read", category: "compliance", abac: "none" },
  "audit.disclosure_report": {
    resource: "audit",
    action: "disclosure_report",
    category: "compliance",
    abac: "none",
  },
  "audit.disclosure_report_all_scopes": {
    resource: "audit",
    action: "disclosure_report_all_scopes",
    category: "compliance",
    abac: "audit_accounting_scope_allowed",
  },
  "audit.export": { resource: "audit", action: "export", category: "compliance", abac: "none" },
  "audit.integrity": {
    resource: "audit",
    action: "integrity",
    category: "compliance",
    abac: "none",
  },
  // --- legal hold (§4.5) ---
  "legalhold.read": {
    resource: "legalhold",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "legalhold.manage": {
    resource: "legalhold",
    action: "manage",
    category: "compliance",
    abac: "none",
  },
  // --- destruction (§4.5; destruction.approve additionally step-up re-auths at the route) ---
  "destruction.read": {
    resource: "destruction",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "destruction.approve": {
    resource: "destruction",
    action: "approve",
    category: "compliance",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M4 contributed permission keys. */
export type M4ContributedPermissionKey = keyof typeof M4_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 38 (Clinical Terminology Service) registers into Module 3's
 * catalog — the §4.4 binding cross-module handshake (M38-T06; M38 spec §4.4). M3 must include
 * these before M38's routes can be authorized; the read/value-set/extension routes (M38-T06)
 * gate on them. The set is deliberately small: read-side terminology is a foundational utility
 * (`terminology.read` is everyone's by default, like reading a dictionary). The protective keys
 * sit at the two boundaries where meaning can change — tenant value-set extension (per-tenant)
 * and platform code-system load (global) — plus the per-tenant deprecation remediation report
 * and the platform-ops admin read. Kept in a dedicated const (not folded into the M1/M2 or M4
 * sets) so each module's contribution stays attributable (§3.3 ownership).
 *
 * All five are pure RBAC (`abac: 'none'`): platform terminology tables are non-tenant reference
 * data (RLS `USING(true)`), and `value_set_tenant_extension` is org-scoped by RLS — neither
 * needs an ABAC predicate. The `admin.*` keys are additionally platform-only (assigned to
 * `platform_ops` templates), and `admin.load` step-up re-auths at the route (§4.2).
 *
 * Unlike M3's own keys (and the M1/M2/M4 contributed sets), M38's keys carry a `terminology.`
 * NAMESPACE prefix on top of the `resource.action` decomposition (the §4.4 "Key" vs
 * "Resource.action" columns are distinct) — so `key` is the full dotted permission string used
 * at `requirePermission(...)`, while `resource`/`action` carry the spec's decomposition.
 */
export const M38_CONTRIBUTED_PERMISSIONS = {
  // --- read-side terminology utility (§4.4; the everyone-can-read default) ---
  "terminology.read": {
    resource: "terminology",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  // --- tenant value-set extension (add-only, never weakens platform; §4.4, §7.6) ---
  "terminology.value_set.extend": {
    resource: "value_set",
    action: "extend",
    category: "admin",
    abac: "none",
  },
  // --- per-tenant deprecation remediation report (§4.4, §7.3) ---
  "terminology.deprecation_report": {
    resource: "deprecation_report",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  // --- platform-ops admin (§4.4; admin.load step-up re-auths at the route, §4.2) ---
  "terminology.admin.read": {
    resource: "admin",
    action: "read",
    category: "platform",
    abac: "none",
  },
  "terminology.admin.load": {
    resource: "admin",
    action: "load",
    category: "platform",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M38 contributed permission keys. */
export type M38ContributedPermissionKey = keyof typeof M38_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 36 (Secure Messaging & Alerts) registers into Module 3's catalog —
 * the §4.5 binding cross-module handshake (M36-T07; M36 spec §4.5). M3 must include these before
 * M36's routes can be authorized; the route inventory (M36-T07) gates on them.
 *
 * Read and DM are deliberately BROAD — the system is a chat system, so "can't read or DM a
 * coworker" is not a meaningful default; every authenticated role gets them (subject to the
 * `channel_visibility` ABAC predicate M36 registers, which branches per channel kind: caseload
 * membership for `care_team`, bereavement membership for `bereavement`, a channel-member check
 * otherwise). The GATED keys are `announce` and `manage_members` (the auto-channel admin
 * override), the alert-rule edits, and the platform-only `messaging.admin.read`. The two
 * `notifications.*` keys are SELF-only (the user themself; §4.5 note) — even org_admin cannot
 * edit another human's private preferences without break-glass.
 *
 * Like M38's set, M36's keys carry a NAMESPACE prefix (`messaging.` / `notifications.` /
 * `alert.`) on top of the `resource.action` decomposition (the §4.5 "Key" vs "Resource.action"
 * columns are distinct) — so `key` is the full dotted permission string passed to
 * `requirePermission(...)`, while `resource`/`action` carry the spec's decomposition. Kept in a
 * dedicated const (not folded into the other contributed sets) so each module's contribution
 * stays attributable (§3.3 ownership).
 */
export const M36_CONTRIBUTED_PERMISSIONS = {
  // --- read / send / DM — broad chat defaults, ABAC-scoped per channel kind (§4.5) ---
  "messaging.read": {
    resource: "messaging",
    action: "read",
    category: "clinical",
    abac: "channel_visibility",
  },
  "messaging.send": {
    resource: "messaging",
    action: "send",
    category: "clinical",
    abac: "channel_visibility",
  },
  "messaging.dm": { resource: "messaging", action: "dm", category: "clinical", abac: "none" },
  // --- auto-channel admin override + tenant announcements (§4.5) ---
  "messaging.manage_members": {
    resource: "messaging",
    action: "manage_members",
    category: "admin",
    abac: "channel_visibility",
  },
  "messaging.announce": {
    resource: "messaging",
    action: "announce",
    category: "admin",
    abac: "none",
  },
  // --- self-only notification preferences + delivery endpoints (§4.5; SELF, no other actor) ---
  "notifications.preferences.manage": {
    resource: "preferences",
    action: "manage",
    category: "clinical",
    abac: "none",
  },
  "notifications.endpoint.manage": {
    resource: "endpoint",
    action: "manage",
    category: "clinical",
    abac: "none",
  },
  // --- alert-rule read / edit (§4.5; system_locked rows can't be disabled even by manage) ---
  "alert.rules.read": {
    resource: "alert_rules",
    action: "read",
    category: "admin",
    abac: "none",
  },
  "alert.rules.manage": {
    resource: "alert_rules",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // --- platform-ops admin (§4.5; platform-only — failures + delivery audit drill) ---
  "messaging.admin.read": {
    resource: "admin",
    action: "read",
    category: "platform",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M36 contributed permission keys. */
export type M36ContributedPermissionKey = keyof typeof M36_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 5 (Patient & Demographics) registers into Module 3's catalog — the
 * §4.7 binding cross-module handshake (M5-T09; M5 spec §4.7). M3 must include these before M5's
 * routes can be authorized; the route inventory (M5-T09) gates on them. `patient.read` is the
 * most-used permission in the system.
 *
 * The default ABAC predicate per key follows §4.7: clinical reads/edits narrow by
 * `caseload_or_scope` (the actor's caseload OR a location/PE scope), `patient.create` by
 * `location_scope`, and the compliance/portal keys are pure RBAC (`none`). The catalog `abac` is the
 * DEFAULT predicate metadata; a route may additionally `requireAbac`/`requireStepUp` (merge / death /
 * bypass / SSN-write step-up). Bare `resource.action` keys (not namespaced) — patient is a
 * first-class platform resource. Kept in a dedicated const for §3.3 attributability.
 */
export const M5_CONTRIBUTED_PERMISSIONS = {
  "patient.read": { resource: "patient", action: "read", category: "clinical", abac: "caseload_or_scope" },
  "patient.create": { resource: "patient", action: "create", category: "clinical", abac: "location_scope" },
  "patient.create_bypass_match": { resource: "patient", action: "create_bypass_match", category: "clinical", abac: "none" },
  "patient.edit": { resource: "patient", action: "edit", category: "clinical", abac: "caseload_or_scope" },
  "patient.edit_identifiers": { resource: "patient", action: "edit_identifiers", category: "clinical", abac: "caseload_or_scope" },
  "patient.edit_payers": { resource: "patient", action: "edit_payers", category: "clinical", abac: "caseload_or_scope" },
  "patient.assign": { resource: "patient", action: "assign", category: "clinical", abac: "caseload_or_scope" },
  "patient.transition_status": { resource: "patient", action: "transition_status", category: "clinical", abac: "caseload_or_scope" },
  "patient.record_death": { resource: "patient", action: "record_death", category: "clinical", abac: "caseload_or_scope" },
  "patient.match_review": { resource: "patient", action: "match_review", category: "compliance", abac: "none" },
  "patient.merge": { resource: "patient", action: "merge", category: "compliance", abac: "caseload_or_scope" },
  "patient.amend_request_submit": { resource: "patient", action: "amend_request_submit", category: "clinical", abac: "none" },
  "patient.amend_request_record": { resource: "patient", action: "amend_request_record", category: "clinical", abac: "caseload_or_scope" },
  "patient.amend_review": { resource: "patient", action: "amend_review", category: "compliance", abac: "none" },
  "phi.read_ssn": { resource: "phi", action: "read_ssn", category: "clinical", abac: "caseload_or_scope" },
  "phi.write_ssn": { resource: "phi", action: "write_ssn", category: "clinical", abac: "caseload_or_scope" },
  "privacy.admin": { resource: "privacy", action: "admin", category: "compliance", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M5 contributed permission keys. */
export type M5ContributedPermissionKey = keyof typeof M5_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 40 (Master Data Management) registers into Module 3's catalog —
 * the §4.4 binding cross-module handshake (M40-T07; M40 spec §4.4). M3 must include these before
 * M40's routes can be authorized; the route inventory (M40-T07) gates on them.
 *
 * THREE keys per entity kind (read/propose/overlay) by design (§4.4): they are different blast
 * radii — read is broad, propose creates a provisional that becomes GLOBAL canonical state, overlay
 * edits only this-tenant's-opinion. Collapsing them would make "anyone who can read can propose",
 * the dedup-spam vector this module exists to prevent. The platform-only keys (`mdm.canonical.write`
 * / `mdm.merge.read` / `mdm.merge.approve`) are assigned to `platform_ops` ONLY and never to a
 * tenant role — the §7.4 canonical-write lockdown in depth (DB grant + route omission + this key);
 * `mdm.merge.approve` additionally step-up re-auths at the route (§4.1, §7.6).
 *
 * Like M38/M36's sets, M40's keys carry a `mdm.` NAMESPACE prefix on top of the `resource.action`
 * decomposition (the §4.4 "Key" vs "Resource.action" columns are distinct). Kept in a dedicated
 * const so each module's contribution stays attributable (§3.3 ownership). All pure RBAC
 * (`abac: 'none'`): canonical is public reference data (RLS `USING(true)`) and overlay is org-scoped
 * by RLS, so neither needs an ABAC predicate.
 */
export const M40_CONTRIBUTED_PERMISSIONS = {
  // --- physician (read / propose / overlay) ---
  "mdm.physician.read": { resource: "physician", action: "read", category: "clinical", abac: "none" },
  "mdm.physician.propose": { resource: "physician", action: "propose", category: "clinical", abac: "none" },
  "mdm.physician.overlay": { resource: "physician", action: "overlay", category: "admin", abac: "none" },
  // --- facility ---
  "mdm.facility.read": { resource: "facility", action: "read", category: "clinical", abac: "none" },
  "mdm.facility.propose": { resource: "facility", action: "propose", category: "clinical", abac: "none" },
  "mdm.facility.overlay": { resource: "facility", action: "overlay", category: "admin", abac: "none" },
  // --- pharmacy ---
  "mdm.pharmacy.read": { resource: "pharmacy", action: "read", category: "clinical", abac: "none" },
  "mdm.pharmacy.propose": { resource: "pharmacy", action: "propose", category: "clinical", abac: "none" },
  "mdm.pharmacy.overlay": { resource: "pharmacy", action: "overlay", category: "admin", abac: "none" },
  // --- referral_source ---
  "mdm.referral_source.read": { resource: "referral_source", action: "read", category: "clinical", abac: "none" },
  "mdm.referral_source.propose": { resource: "referral_source", action: "propose", category: "clinical", abac: "none" },
  "mdm.referral_source.overlay": { resource: "referral_source", action: "overlay", category: "admin", abac: "none" },
  // --- payer ---
  "mdm.payer.read": { resource: "payer", action: "read", category: "clinical", abac: "none" },
  "mdm.payer.propose": { resource: "payer", action: "propose", category: "clinical", abac: "none" },
  "mdm.payer.overlay": { resource: "payer", action: "overlay", category: "admin", abac: "none" },
  // --- dme_vendor ---
  "mdm.dme_vendor.read": { resource: "dme_vendor", action: "read", category: "clinical", abac: "none" },
  "mdm.dme_vendor.propose": { resource: "dme_vendor", action: "propose", category: "clinical", abac: "none" },
  "mdm.dme_vendor.overlay": { resource: "dme_vendor", action: "overlay", category: "admin", abac: "none" },
  // --- funeral_home ---
  "mdm.funeral_home.read": { resource: "funeral_home", action: "read", category: "clinical", abac: "none" },
  "mdm.funeral_home.propose": { resource: "funeral_home", action: "propose", category: "clinical", abac: "none" },
  "mdm.funeral_home.overlay": { resource: "funeral_home", action: "overlay", category: "admin", abac: "none" },
  // --- BAA register (Compliance/Privacy) + manual license entry (§4.1) ---
  "mdm.baa.read": { resource: "baa", action: "read", category: "compliance", abac: "none" },
  "mdm.baa.manage": { resource: "baa", action: "manage", category: "compliance", abac: "none" },
  "mdm.license.manage": { resource: "license", action: "manage", category: "admin", abac: "none" },
  // --- platform-ops ONLY: canonical write + merge governance (§4.4; never granted to tenant roles) ---
  "mdm.canonical.write": { resource: "canonical", action: "write", category: "platform", abac: "none" },
  "mdm.merge.read": { resource: "merge", action: "read", category: "platform", abac: "none" },
  "mdm.merge.approve": { resource: "merge", action: "approve", category: "platform", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M40 contributed permission keys. */
export type M40ContributedPermissionKey = keyof typeof M40_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 39 (Consent & Authorization Management) registers into Module 3's
 * catalog — the §4.7 binding handshake (M39-T07; M39 spec §4.7). Boot validation fails if any key is
 * missing from M3's catalog at startup, so the route inventory (§4.1) can gate on them.
 *
 * Bare `consent.*` keys (resource="consent") — consent is a first-class platform resource, like M5's
 * `patient.*`. The catalog `abac` is DEFAULT metadata; a patient-scoped route additionally applies an
 * explicit `requireAbac(...)` (caseload / the eleven §4.8 predicates) and the sign/supersede/revoke/
 * overlay/admin routes additionally `requireStepUp(...)` (the `consent_management` profile, §4.1).
 * All `abac: 'none'` here — the route layer composes the real predicate chain (§4.11) per route.
 */
export const M39_CONTRIBUTED_PERMISSIONS = {
  "consent.read_catalog": { resource: "consent", action: "read_catalog", category: "clinical", abac: "none" },
  "consent.read": { resource: "consent", action: "read", category: "clinical", abac: "none" },
  "consent.read_history": { resource: "consent", action: "read_history", category: "compliance", abac: "none" },
  "consent.read_phi_content": { resource: "consent", action: "read_phi_content", category: "clinical", abac: "none" },
  "consent.read_eval_audit": { resource: "consent", action: "read_eval_audit", category: "compliance", abac: "none" },
  "consent.author": { resource: "consent", action: "author", category: "clinical", abac: "none" },
  "consent.sign": { resource: "consent", action: "sign", category: "clinical", abac: "none" },
  "consent.revoke": { resource: "consent", action: "revoke", category: "clinical", abac: "none" },
  "consent.manage_overlay": { resource: "consent", action: "manage_overlay", category: "admin", abac: "none" },
  "consent.admin_re_render": { resource: "consent", action: "admin_re_render", category: "admin", abac: "none" },
  "consent.delegate_assignment": { resource: "consent", action: "delegate_assignment", category: "clinical", abac: "none" },
  "consent.portal_self_service": { resource: "consent", action: "portal_self_service", category: "clinical", abac: "none" },
  "consent.read_bereavement_outreach": { resource: "consent", action: "read_bereavement_outreach", category: "clinical", abac: "none" },
  "consent.bereavement_outreach_author": { resource: "consent", action: "bereavement_outreach_author", category: "clinical", abac: "none" },
  "consent.cascade_admin": { resource: "consent", action: "cascade_admin", category: "platform", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M39 contributed permission keys. */
export type M39ContributedPermissionKey = keyof typeof M39_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 6 (Admission, Election & Certification) registers into Module 3's
 * catalog — the §4.5 binding handshake (M6-T06; M6 spec §4.5). M3 must include these before M6's
 * routes can be authorized; the route inventory (M6-T06) gates on them.
 *
 * Bare `resource.action` keys (referral/admission/election/cti/f2f/loc/revocation/transfer/
 * discharge/nor/compliance are first-class admission resources, like M5's `patient.*`). The catalog
 * `abac` field is the DEFAULT predicate per route (§4.6); the route layer additionally applies an
 * explicit `requireAbac(...)` for the role-only signer/override predicates M6 owns
 * (`f2f.is_hospice_md_or_np`, `f2f.window_override`, `discharge.is_medical_director`,
 * `compliance.window_override`). `patient.scope` (route 8) is M5's re-used predicate; M6 does not
 * own it.
 *
 * Route 39 (`POST …/discharge`) derives its key from `reason` server-side (§6.3): the five
 * `discharge.<reason>` keys below are the derivation targets, gated dynamically at the route so a
 * client cannot bypass the per-reason policy by changing the path. `discharge.create` is the
 * umbrella capability key (§4.5); `discharge.record_death` is the M29-accept step-up gate
 * (D14 precondition (e)), not a client route. Kept in a dedicated const for §3.3 attributability.
 */
export const M6_CONTRIBUTED_PERMISSIONS = {
  // --- Referral (routes 1–7) ---
  "referral.create": { resource: "referral", action: "create", category: "clinical", abac: "none" },
  "referral.read": { resource: "referral", action: "read", category: "clinical", abac: "referral.scope" },
  "referral.update": { resource: "referral", action: "update", category: "clinical", abac: "referral.scope" },
  "referral.triage": { resource: "referral", action: "triage", category: "clinical", abac: "referral.scope" },
  "referral.accept": { resource: "referral", action: "accept", category: "clinical", abac: "referral.scope" },
  "referral.decline": { resource: "referral", action: "decline", category: "clinical", abac: "referral.scope" },
  // --- Admission lifecycle (routes 8–14) ---
  "admission.create": { resource: "admission", action: "create", category: "clinical", abac: "patient.scope" },
  "admission.read": { resource: "admission", action: "read", category: "clinical", abac: "admission.scope" },
  "admission.update": { resource: "admission", action: "update", category: "clinical", abac: "admission.scope" },
  "admission.hold": { resource: "admission", action: "hold", category: "clinical", abac: "admission.scope" },
  "admission.activate": { resource: "admission", action: "activate", category: "clinical", abac: "admission.scope" },
  // --- Election statement & period (routes 15–21) ---
  "election.draft": { resource: "election", action: "draft", category: "clinical", abac: "admission.scope" },
  "election.read": { resource: "election", action: "read", category: "clinical", abac: "admission.scope" },
  "election.sign": { resource: "election", action: "sign", category: "clinical", abac: "admission.scope" },
  "election.void": { resource: "election", action: "void", category: "compliance", abac: "admission.scope" },
  // --- CTI (routes 22–27) ---
  "cti.draft": { resource: "cti", action: "draft", category: "clinical", abac: "admission.scope" },
  "cti.read": { resource: "cti", action: "read", category: "clinical", abac: "admission.scope" },
  "cti.sign_hospice_md": { resource: "cti", action: "sign_hospice_md", category: "clinical", abac: "cti.is_hospice_md" },
  "cti.sign_attending": { resource: "cti", action: "sign_attending", category: "clinical", abac: "cti.is_attending" },
  "cti.void": { resource: "cti", action: "void", category: "compliance", abac: "admission.scope" },
  "cti.mark_late": { resource: "cti", action: "mark_late", category: "clinical", abac: "admission.scope" },
  // --- F2F (routes 28–32) ---
  "f2f.schedule": { resource: "f2f", action: "schedule", category: "clinical", abac: "admission.scope" },
  "f2f.read": { resource: "f2f", action: "read", category: "clinical", abac: "admission.scope" },
  "f2f.complete": { resource: "f2f", action: "complete", category: "clinical", abac: "f2f.is_hospice_clinician" },
  "f2f.attest": { resource: "f2f", action: "attest", category: "clinical", abac: "f2f.is_hospice_md_or_np" },
  "f2f.window_override": { resource: "f2f", action: "window_override", category: "compliance", abac: "f2f.window_override" },
  // --- Level of care (routes 33–35) ---
  "loc.read": { resource: "loc", action: "read", category: "clinical", abac: "admission.scope" },
  "loc.change": { resource: "loc", action: "change", category: "clinical", abac: "admission.scope" },
  // --- Revocation / transfer / discharge (routes 36–40) ---
  "revocation.create": { resource: "revocation", action: "create", category: "clinical", abac: "admission.scope" },
  "transfer.out": { resource: "transfer", action: "out", category: "clinical", abac: "admission.scope" },
  "transfer.in": { resource: "transfer", action: "in", category: "clinical", abac: "admission.scope" },
  "discharge.create": { resource: "discharge", action: "create", category: "clinical", abac: "admission.scope" },
  "discharge.cosign_for_cause": { resource: "discharge", action: "cosign_for_cause", category: "clinical", abac: "discharge.is_medical_director" },
  "discharge.record_death": { resource: "discharge", action: "record_death", category: "clinical", abac: "none" },
  // §6.3 reason-derived keys for route 39 (gated dynamically server-side).
  "discharge.death": { resource: "discharge", action: "death", category: "clinical", abac: "admission.scope" },
  "discharge.moved": { resource: "discharge", action: "moved", category: "clinical", abac: "admission.scope" },
  "discharge.no_longer_terminal": { resource: "discharge", action: "no_longer_terminal", category: "clinical", abac: "admission.scope" },
  "discharge.for_cause": { resource: "discharge", action: "for_cause", category: "clinical", abac: "admission.scope" },
  "discharge.other": { resource: "discharge", action: "other", category: "clinical", abac: "admission.scope" },
  // --- NOR (routes 41–42) ---
  "nor.acknowledge": { resource: "nor", action: "acknowledge", category: "clinical", abac: "admission.scope" },
  "nor.read": { resource: "nor", action: "read", category: "clinical", abac: "admission.scope" },
  // --- Compliance windows (routes 43–46) ---
  "compliance.read": { resource: "compliance", action: "read", category: "compliance", abac: "compliance.scope" },
  "compliance.close": { resource: "compliance", action: "close", category: "compliance", abac: "admission.scope" },
  "compliance.override": { resource: "compliance", action: "override", category: "compliance", abac: "compliance.window_override" },
  "compliance.window_override": { resource: "compliance", action: "window_override", category: "compliance", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M6 contributed permission keys. */
export type M6ContributedPermissionKey = keyof typeof M6_CONTRIBUTED_PERMISSIONS;

/** Project a contributed-key map into `permission`-table mirror rows (same contract as M3's). */
function mirrorRowsFor(map: Record<string, PermissionDef>): PermissionMirrorRow[] {
  return Object.entries(map).map(([key, def]) => ({
    key,
    resource: def.resource,
    action: def.action,
    category: def.category,
    defaultAbac: def.abac,
    description: "",
  }));
}

/** Project the M1/M2 contributed keys into `permission`-table mirror rows. */
export function contributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(CONTRIBUTED_PERMISSIONS);
}

/** Project the M4 contributed keys into `permission`-table mirror rows (M4-T10). */
export function m4ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M4_CONTRIBUTED_PERMISSIONS);
}

/** Project the M38 contributed keys into `permission`-table mirror rows (M38-T06). */
export function m38ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M38_CONTRIBUTED_PERMISSIONS);
}

/** Project the M36 contributed keys into `permission`-table mirror rows (M36-T07). */
export function m36ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M36_CONTRIBUTED_PERMISSIONS);
}

/** Project the M40 contributed keys into `permission`-table mirror rows (M40-T07). */
export function m40ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M40_CONTRIBUTED_PERMISSIONS);
}

/** Project the M5 contributed keys into `permission`-table mirror rows (M5-T09). */
export function m5ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M5_CONTRIBUTED_PERMISSIONS);
}

/** Project the M39 contributed keys into `permission`-table mirror rows (M39-T07). */
export function m39ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M39_CONTRIBUTED_PERMISSIONS);
}

/** Project the M6 contributed keys into `permission`-table mirror rows (M6-T06). */
export function m6ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M6_CONTRIBUTED_PERMISSIONS);
}

/**
 * The full `permission`-table mirror: M3's own cross-cutting keys plus every contributed
 * (M1/M2 + M4 + M38 + M36) key. This is the row set the deploy-time sync writes to the read-only
 * `permission` table once the catalog goes real. Keys are single-owner across all sets — a
 * collision would be a registration bug, so the deploy sync (and the unit test) asserts uniqueness.
 */
export function allPermissionMirrorRows(): PermissionMirrorRow[] {
  return [
    ...permissionMirrorRows(),
    ...contributedPermissionMirrorRows(),
    ...m4ContributedPermissionMirrorRows(),
    ...m38ContributedPermissionMirrorRows(),
    ...m36ContributedPermissionMirrorRows(),
    ...m40ContributedPermissionMirrorRows(),
    ...m5ContributedPermissionMirrorRows(),
    ...m39ContributedPermissionMirrorRows(),
    ...m6ContributedPermissionMirrorRows(),
  ];
}
