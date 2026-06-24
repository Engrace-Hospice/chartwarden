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
  "patient.read": {
    resource: "patient",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.create": {
    resource: "patient",
    action: "create",
    category: "clinical",
    abac: "location_scope",
  },
  "patient.create_bypass_match": {
    resource: "patient",
    action: "create_bypass_match",
    category: "clinical",
    abac: "none",
  },
  "patient.edit": {
    resource: "patient",
    action: "edit",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.edit_identifiers": {
    resource: "patient",
    action: "edit_identifiers",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.edit_payers": {
    resource: "patient",
    action: "edit_payers",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.assign": {
    resource: "patient",
    action: "assign",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.transition_status": {
    resource: "patient",
    action: "transition_status",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.record_death": {
    resource: "patient",
    action: "record_death",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.match_review": {
    resource: "patient",
    action: "match_review",
    category: "compliance",
    abac: "none",
  },
  "patient.merge": {
    resource: "patient",
    action: "merge",
    category: "compliance",
    abac: "caseload_or_scope",
  },
  "patient.amend_request_submit": {
    resource: "patient",
    action: "amend_request_submit",
    category: "clinical",
    abac: "none",
  },
  "patient.amend_request_record": {
    resource: "patient",
    action: "amend_request_record",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.amend_review": {
    resource: "patient",
    action: "amend_review",
    category: "compliance",
    abac: "none",
  },
  "phi.read_ssn": {
    resource: "phi",
    action: "read_ssn",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "phi.write_ssn": {
    resource: "phi",
    action: "write_ssn",
    category: "clinical",
    abac: "caseload_or_scope",
  },
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
  "mdm.physician.read": {
    resource: "physician",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "mdm.physician.propose": {
    resource: "physician",
    action: "propose",
    category: "clinical",
    abac: "none",
  },
  "mdm.physician.overlay": {
    resource: "physician",
    action: "overlay",
    category: "admin",
    abac: "none",
  },
  // --- facility ---
  "mdm.facility.read": { resource: "facility", action: "read", category: "clinical", abac: "none" },
  "mdm.facility.propose": {
    resource: "facility",
    action: "propose",
    category: "clinical",
    abac: "none",
  },
  "mdm.facility.overlay": {
    resource: "facility",
    action: "overlay",
    category: "admin",
    abac: "none",
  },
  // --- pharmacy ---
  "mdm.pharmacy.read": { resource: "pharmacy", action: "read", category: "clinical", abac: "none" },
  "mdm.pharmacy.propose": {
    resource: "pharmacy",
    action: "propose",
    category: "clinical",
    abac: "none",
  },
  "mdm.pharmacy.overlay": {
    resource: "pharmacy",
    action: "overlay",
    category: "admin",
    abac: "none",
  },
  // --- referral_source ---
  "mdm.referral_source.read": {
    resource: "referral_source",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "mdm.referral_source.propose": {
    resource: "referral_source",
    action: "propose",
    category: "clinical",
    abac: "none",
  },
  "mdm.referral_source.overlay": {
    resource: "referral_source",
    action: "overlay",
    category: "admin",
    abac: "none",
  },
  // --- payer ---
  "mdm.payer.read": { resource: "payer", action: "read", category: "clinical", abac: "none" },
  "mdm.payer.propose": { resource: "payer", action: "propose", category: "clinical", abac: "none" },
  "mdm.payer.overlay": { resource: "payer", action: "overlay", category: "admin", abac: "none" },
  // --- dme_vendor ---
  "mdm.dme_vendor.read": {
    resource: "dme_vendor",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "mdm.dme_vendor.propose": {
    resource: "dme_vendor",
    action: "propose",
    category: "clinical",
    abac: "none",
  },
  "mdm.dme_vendor.overlay": {
    resource: "dme_vendor",
    action: "overlay",
    category: "admin",
    abac: "none",
  },
  // --- funeral_home ---
  "mdm.funeral_home.read": {
    resource: "funeral_home",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "mdm.funeral_home.propose": {
    resource: "funeral_home",
    action: "propose",
    category: "clinical",
    abac: "none",
  },
  "mdm.funeral_home.overlay": {
    resource: "funeral_home",
    action: "overlay",
    category: "admin",
    abac: "none",
  },
  // --- BAA register (Compliance/Privacy) + manual license entry (§4.1) ---
  "mdm.baa.read": { resource: "baa", action: "read", category: "compliance", abac: "none" },
  "mdm.baa.manage": { resource: "baa", action: "manage", category: "compliance", abac: "none" },
  "mdm.license.manage": { resource: "license", action: "manage", category: "admin", abac: "none" },
  // --- platform-ops ONLY: canonical write + merge governance (§4.4; never granted to tenant roles) ---
  "mdm.canonical.write": {
    resource: "canonical",
    action: "write",
    category: "platform",
    abac: "none",
  },
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
  "consent.read_catalog": {
    resource: "consent",
    action: "read_catalog",
    category: "clinical",
    abac: "none",
  },
  "consent.read": { resource: "consent", action: "read", category: "clinical", abac: "none" },
  "consent.read_history": {
    resource: "consent",
    action: "read_history",
    category: "compliance",
    abac: "none",
  },
  "consent.read_phi_content": {
    resource: "consent",
    action: "read_phi_content",
    category: "clinical",
    abac: "none",
  },
  "consent.read_eval_audit": {
    resource: "consent",
    action: "read_eval_audit",
    category: "compliance",
    abac: "none",
  },
  "consent.author": { resource: "consent", action: "author", category: "clinical", abac: "none" },
  "consent.sign": { resource: "consent", action: "sign", category: "clinical", abac: "none" },
  "consent.revoke": { resource: "consent", action: "revoke", category: "clinical", abac: "none" },
  "consent.manage_overlay": {
    resource: "consent",
    action: "manage_overlay",
    category: "admin",
    abac: "none",
  },
  "consent.admin_re_render": {
    resource: "consent",
    action: "admin_re_render",
    category: "admin",
    abac: "none",
  },
  "consent.delegate_assignment": {
    resource: "consent",
    action: "delegate_assignment",
    category: "clinical",
    abac: "none",
  },
  "consent.portal_self_service": {
    resource: "consent",
    action: "portal_self_service",
    category: "clinical",
    abac: "none",
  },
  "consent.read_bereavement_outreach": {
    resource: "consent",
    action: "read_bereavement_outreach",
    category: "clinical",
    abac: "none",
  },
  "consent.bereavement_outreach_author": {
    resource: "consent",
    action: "bereavement_outreach_author",
    category: "clinical",
    abac: "none",
  },
  "consent.cascade_admin": {
    resource: "consent",
    action: "cascade_admin",
    category: "platform",
    abac: "none",
  },
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
  "referral.read": {
    resource: "referral",
    action: "read",
    category: "clinical",
    abac: "referral.scope",
  },
  "referral.update": {
    resource: "referral",
    action: "update",
    category: "clinical",
    abac: "referral.scope",
  },
  "referral.triage": {
    resource: "referral",
    action: "triage",
    category: "clinical",
    abac: "referral.scope",
  },
  "referral.accept": {
    resource: "referral",
    action: "accept",
    category: "clinical",
    abac: "referral.scope",
  },
  "referral.decline": {
    resource: "referral",
    action: "decline",
    category: "clinical",
    abac: "referral.scope",
  },
  // --- Admission lifecycle (routes 8–14) ---
  "admission.create": {
    resource: "admission",
    action: "create",
    category: "clinical",
    abac: "patient.scope",
  },
  "admission.read": {
    resource: "admission",
    action: "read",
    category: "clinical",
    abac: "admission.scope",
  },
  "admission.update": {
    resource: "admission",
    action: "update",
    category: "clinical",
    abac: "admission.scope",
  },
  "admission.hold": {
    resource: "admission",
    action: "hold",
    category: "clinical",
    abac: "admission.scope",
  },
  "admission.activate": {
    resource: "admission",
    action: "activate",
    category: "clinical",
    abac: "admission.scope",
  },
  // --- Election statement & period (routes 15–21) ---
  "election.draft": {
    resource: "election",
    action: "draft",
    category: "clinical",
    abac: "admission.scope",
  },
  "election.read": {
    resource: "election",
    action: "read",
    category: "clinical",
    abac: "admission.scope",
  },
  "election.sign": {
    resource: "election",
    action: "sign",
    category: "clinical",
    abac: "admission.scope",
  },
  "election.void": {
    resource: "election",
    action: "void",
    category: "compliance",
    abac: "admission.scope",
  },
  // --- CTI (routes 22–27) ---
  "cti.draft": { resource: "cti", action: "draft", category: "clinical", abac: "admission.scope" },
  "cti.read": { resource: "cti", action: "read", category: "clinical", abac: "admission.scope" },
  "cti.sign_hospice_md": {
    resource: "cti",
    action: "sign_hospice_md",
    category: "clinical",
    abac: "cti.is_hospice_md",
  },
  "cti.sign_attending": {
    resource: "cti",
    action: "sign_attending",
    category: "clinical",
    abac: "cti.is_attending",
  },
  "cti.void": { resource: "cti", action: "void", category: "compliance", abac: "admission.scope" },
  "cti.mark_late": {
    resource: "cti",
    action: "mark_late",
    category: "clinical",
    abac: "admission.scope",
  },
  // --- F2F (routes 28–32) ---
  "f2f.schedule": {
    resource: "f2f",
    action: "schedule",
    category: "clinical",
    abac: "admission.scope",
  },
  "f2f.read": { resource: "f2f", action: "read", category: "clinical", abac: "admission.scope" },
  "f2f.complete": {
    resource: "f2f",
    action: "complete",
    category: "clinical",
    abac: "f2f.is_hospice_clinician",
  },
  "f2f.attest": {
    resource: "f2f",
    action: "attest",
    category: "clinical",
    abac: "f2f.is_hospice_md_or_np",
  },
  "f2f.window_override": {
    resource: "f2f",
    action: "window_override",
    category: "compliance",
    abac: "f2f.window_override",
  },
  // --- Level of care (routes 33–35) ---
  "loc.read": { resource: "loc", action: "read", category: "clinical", abac: "admission.scope" },
  "loc.change": {
    resource: "loc",
    action: "change",
    category: "clinical",
    abac: "admission.scope",
  },
  // --- Revocation / transfer / discharge (routes 36–40) ---
  "revocation.create": {
    resource: "revocation",
    action: "create",
    category: "clinical",
    abac: "admission.scope",
  },
  "transfer.out": {
    resource: "transfer",
    action: "out",
    category: "clinical",
    abac: "admission.scope",
  },
  "transfer.in": {
    resource: "transfer",
    action: "in",
    category: "clinical",
    abac: "admission.scope",
  },
  "discharge.create": {
    resource: "discharge",
    action: "create",
    category: "clinical",
    abac: "admission.scope",
  },
  "discharge.cosign_for_cause": {
    resource: "discharge",
    action: "cosign_for_cause",
    category: "clinical",
    abac: "discharge.is_medical_director",
  },
  "discharge.record_death": {
    resource: "discharge",
    action: "record_death",
    category: "clinical",
    abac: "none",
  },
  // §6.3 reason-derived keys for route 39 (gated dynamically server-side).
  "discharge.death": {
    resource: "discharge",
    action: "death",
    category: "clinical",
    abac: "admission.scope",
  },
  "discharge.moved": {
    resource: "discharge",
    action: "moved",
    category: "clinical",
    abac: "admission.scope",
  },
  "discharge.no_longer_terminal": {
    resource: "discharge",
    action: "no_longer_terminal",
    category: "clinical",
    abac: "admission.scope",
  },
  "discharge.for_cause": {
    resource: "discharge",
    action: "for_cause",
    category: "clinical",
    abac: "admission.scope",
  },
  "discharge.other": {
    resource: "discharge",
    action: "other",
    category: "clinical",
    abac: "admission.scope",
  },
  // --- NOR (routes 41–42) ---
  "nor.acknowledge": {
    resource: "nor",
    action: "acknowledge",
    category: "clinical",
    abac: "admission.scope",
  },
  "nor.read": { resource: "nor", action: "read", category: "clinical", abac: "admission.scope" },
  // --- Compliance windows (routes 43–46) ---
  "compliance.read": {
    resource: "compliance",
    action: "read",
    category: "compliance",
    abac: "compliance.scope",
  },
  "compliance.close": {
    resource: "compliance",
    action: "close",
    category: "compliance",
    abac: "admission.scope",
  },
  "compliance.override": {
    resource: "compliance",
    action: "override",
    category: "compliance",
    abac: "compliance.window_override",
  },
  "compliance.window_override": {
    resource: "compliance",
    action: "window_override",
    category: "compliance",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M6 contributed permission keys. */
export type M6ContributedPermissionKey = keyof typeof M6_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 7 (Care Plan / IPOC) registers into Module 3's catalog — the §4.5
 * binding cross-module handshake (M7-T06; M7 spec §4.5). The seven keys gate the §4.1 route
 * inventory: reads (`care_plan.read`/`care_plan.read_summary`), the system/admin bootstrap of the
 * plan row on admission activation (`care_plan.bootstrap`), authoring of problems/goals/interventions
 * and version drafting (`care_plan.author`), the `draft → in_review` finalize (`care_plan.finalize`),
 * signing a version against the Required Signer Set (`care_plan.sign`), and the outbox-driven IDG
 * revision apply (`care_plan.idg_revise`). The `abac` field carries each key's DEFAULT predicate name:
 * `caseload_or_scope` (the actor's caseload OR a location/PE scope), `signer_role_match` on sign (the
 * §2.3 / D5 rule the route enforces in addition to RBAC), `collaborator_or_caseload` on the summary
 * surface (Portal/Collaborator session class), and `none` for the system idg-revise path. The
 * per-route ABAC composition (∧ `discipline_scope` / ∧ `sud_disclosure_allowed`) lands with the
 * authoring work (M7-T06); here the keys + their defaults are the M3 catalog contribution.
 */
export const M7_CONTRIBUTED_PERMISSIONS = {
  "care_plan.read": {
    resource: "care_plan",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "care_plan.bootstrap": {
    resource: "care_plan",
    action: "bootstrap",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "care_plan.author": {
    resource: "care_plan",
    action: "author",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "care_plan.finalize": {
    resource: "care_plan",
    action: "finalize",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "care_plan.sign": {
    resource: "care_plan",
    action: "sign",
    category: "clinical",
    abac: "signer_role_match",
  },
  "care_plan.read_summary": {
    resource: "care_plan",
    action: "read_summary",
    category: "clinical",
    abac: "collaborator_or_caseload",
  },
  "care_plan.idg_revise": {
    resource: "care_plan",
    action: "idg_revise",
    category: "clinical",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M7 contributed permission keys. */
export type M7ContributedPermissionKey = keyof typeof M7_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 8 (Encounters & Visit Notes) registers into Module 3's catalog — the
 * §4.5 binding cross-module handshake (M8-T09; M8 spec §4.5). M3 must include these before M8's
 * routes can be authorized; the route inventory (M8-T09) gates on them.
 *
 * Bare `resource.action` keys (encounter/vitals/mileage are first-class clinical resources, like
 * M5's `patient.*`). The catalog `abac` field is the DEFAULT predicate per key (the §4.1 Auth
 * column); the route layer additionally composes the explicit chain (`caseload_membership` ∧
 * `discipline_scope`, the `is_author*` ownership predicates, `step_up_fresh` on signing, and the new
 * `cosigner_role_match` predicate M8 owns and registers — see abac-predicates.ts). `encounter.cosign`
 * carries `cosigner_role_match` (RN ∧ not-self-author); `encounter.read_internal` is the system-
 * principal seam key (never on a human role template), kept pure RBAC. Kept in a dedicated const for
 * §3.3 attributability.
 */
export const M8_CONTRIBUTED_PERMISSIONS = {
  "encounter.read": {
    resource: "encounter",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "encounter.author": {
    resource: "encounter",
    action: "author",
    category: "clinical",
    abac: "caseload_membership",
  },
  "encounter.finalize": {
    resource: "encounter",
    action: "finalize",
    category: "clinical",
    abac: "is_author",
  },
  "encounter.sign": {
    resource: "encounter",
    action: "sign",
    category: "clinical",
    abac: "is_author",
  },
  "encounter.cosign": {
    resource: "encounter",
    action: "cosign",
    category: "clinical",
    abac: "cosigner_role_match",
  },
  "encounter.cosign_supervisor_release": {
    resource: "encounter",
    action: "cosign_supervisor_release",
    category: "clinical",
    abac: "none",
  },
  "encounter.addendum_author": {
    resource: "encounter",
    action: "addendum_author",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "encounter.addendum_sign": {
    resource: "encounter",
    action: "addendum_sign",
    category: "clinical",
    abac: "is_addendum_author",
  },
  "encounter.late_entry_override": {
    resource: "encounter",
    action: "late_entry_override",
    category: "compliance",
    abac: "none",
  },
  "encounter.administrative_override": {
    resource: "encounter",
    action: "administrative_override",
    category: "compliance",
    abac: "none",
  },
  "encounter.read_internal": {
    resource: "encounter",
    action: "read_internal",
    category: "platform",
    abac: "none",
  },
  "hearthnote.layer2_disable": {
    resource: "hearthnote",
    action: "layer2_disable",
    category: "clinical",
    abac: "none",
  },
  "vitals.author": {
    resource: "vitals",
    action: "author",
    category: "clinical",
    abac: "is_author_or_supervisor",
  },
  "mileage.author": {
    resource: "mileage",
    action: "author",
    category: "clinical",
    abac: "is_author_or_supervisor",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M8 contributed permission keys. */
export type M8ContributedPermissionKey = keyof typeof M8_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 9 (Clinical Assessments Suite) registers into Module 3's catalog — the §4.6
 * binding cross-module handshake (M9-T05; M9 spec §4.6). M3 must include these before M9's routes can be
 * authorized; the route inventory (M9-T05) gates on them. Boot validation fails if any key is missing.
 *
 * Bare `assessment.*` keys (assessment is a first-class clinical resource, like M5's `patient.*`). The
 * catalog `abac` field is the DEFAULT predicate per key (the §4.1 Auth column's base predicate); the route
 * layer additionally composes the explicit chain — author/correction routes add the `discipline_can_record_scale`
 * predicate M9 OWNS (the D8 typed matrix), the cosign route adds the `cosigner_role_match` predicate M9 owns,
 * and the AIMS/SUD read + DPOA-proxy gates resolve through M39's `ConsentEvaluator` seam (`sud_disclosure_allowed`
 * / `dpoa_active`, registered by M5/M7). The four admin keys are pure RBAC (`none`) — license/policy rows are
 * org-scoped reference data administered by org_admin. Kept in a dedicated const for §3.3 attributability.
 */
export const M9_CONTRIBUTED_PERMISSIONS = {
  "assessment.read": { resource: "assessment", action: "read", category: "clinical", abac: "caseload_or_scope" },
  "assessment.author": { resource: "assessment", action: "author", category: "clinical", abac: "caseload_or_scope" },
  "assessment.amend": { resource: "assessment", action: "amend", category: "clinical", abac: "caseload_or_scope" },
  "assessment.cosign": { resource: "assessment", action: "cosign", category: "clinical", abac: "cosigner_role_match" },
  "assessment.read_trend": { resource: "assessment", action: "read_trend", category: "clinical", abac: "caseload_or_scope" },
  "assessment.acknowledge_change": { resource: "assessment", action: "acknowledge_change", category: "clinical", abac: "caseload_or_scope" },
  "assessment.read_summary": { resource: "assessment", action: "read_summary", category: "clinical", abac: "caseload_or_scope" },
  "assessment.license_read": { resource: "assessment", action: "license_read", category: "admin", abac: "none" },
  "assessment.license_admin": { resource: "assessment", action: "license_admin", category: "admin", abac: "none" },
  "assessment.policy_read": { resource: "assessment", action: "policy_read", category: "admin", abac: "none" },
  "assessment.policy_admin": { resource: "assessment", action: "policy_admin", category: "admin", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M9 contributed permission keys. */
export type M9ContributedPermissionKey = keyof typeof M9_CONTRIBUTED_PERMISSIONS;

/**
 * M10-T06 — Module 10 (HOPE Engine) §4.6 permission keys registered into M3's catalog. The clinical
 * read/write/sign/correct keys default to `caseload_or_scope` (the patient-scope predicate M5/M7 own);
 * the timepoint write/sign/correct routes ALSO carry M10's owned `hope.authorDisciplineAllowed` /
 * `hope.correctionAuthorAllowed` predicates at the route (registered by 10-hope/abac-predicates.ts).
 * The submission/dashboard keys default to `provider_entity_scope` (HOPE is inherently per-PE; M10-F09).
 * The two admin keys are pure RBAC (`none`) — platform-admin-gated by role assignment. Kept in a
 * dedicated const for §3.3 attributability.
 */
export const M10_CONTRIBUTED_PERMISSIONS = {
  // Read (caseload-scoped clinical reads)
  "hope.schedule.read": { resource: "hope_schedule", action: "read", category: "clinical", abac: "caseload_or_scope" },
  "hope.timepoint.read": { resource: "hope_timepoint", action: "read", category: "clinical", abac: "caseload_or_scope" },
  "hope.sfv.read": { resource: "hope_sfv", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Read (provider-entity-scoped compliance reads)
  "hope.submission.read": { resource: "hope_submission", action: "read", category: "compliance", abac: "provider_entity_scope" },
  "hope.dashboard.read": { resource: "hope_dashboard", action: "read", category: "compliance", abac: "provider_entity_scope" },
  // Write
  "hope.timepoint.write": { resource: "hope_timepoint", action: "write", category: "clinical", abac: "caseload_or_scope" },
  "hope.timepoint.sign": { resource: "hope_timepoint", action: "sign", category: "clinical", abac: "caseload_or_scope" },
  "hope.timepoint.correct": { resource: "hope_timepoint", action: "correct", category: "clinical", abac: "caseload_or_scope" },
  // Schedule operations
  "hope.schedule.skip": { resource: "hope_schedule", action: "skip", category: "clinical", abac: "caseload_or_scope" },
  // Submission management
  "hope.submission.manage": { resource: "hope_submission", action: "manage", category: "compliance", abac: "provider_entity_scope" },
  // Platform admin
  "hope.admin.regenerate_schedules": { resource: "hope_admin", action: "regenerate_schedules", category: "platform", abac: "none" },
  "hope.admin.late_deadline_override": { resource: "hope_admin", action: "late_deadline_override", category: "platform", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M10 contributed permission keys. */
export type M10ContributedPermissionKey = keyof typeof M10_CONTRIBUTED_PERMISSIONS;

/**
 * M11-T06 — Module 11 (Orders) §4.6 permission keys registered into M3's catalog (the binding handshake;
 * boot validation fails if any key is missing at startup). The clinical read/author/sign/verbal/cosign/
 * discontinue/amend/complete keys default to `caseload_or_scope` (the patient-scope predicate M5/M6/M7
 * own); the author routes ALSO carry M11's owned `discipline_can_order` predicate, the sign routes the
 * owned `signer_eligible` predicate, and the cosign route the owned `cosigner_role_match` predicate
 * (registered by 11-orders/abac-predicates.ts) — applied explicitly at the route on top of the default.
 * The policy keys are pure RBAC (`none`; org-admin / compliance reference rows), and the platform-ops
 * verbal-timer regeneration key is `none` (audited as `audit.elevated_access` at the route, §4.1). Keys
 * carry an `orders.` NAMESPACE prefix on top of the `resource.action` decomposition (like M10's `hope.`),
 * so `key` is the full dotted permission string used at `requirePermission(...)`. Kept in a dedicated
 * const for §3.3 attributability.
 */
export const M11_CONTRIBUTED_PERMISSIONS = {
  // Read (caseload-scoped clinical reads) — every GET route.
  "orders.read": { resource: "order", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Authoring — POST /orders, PATCH draft (route ALSO requires `discipline_can_order`).
  "orders.draft": { resource: "order", action: "draft", category: "clinical", abac: "caseload_or_scope" },
  // Signing — sign / request-signature (route ALSO requires `signer_eligible`).
  "orders.sign": { resource: "order", action: "sign", category: "clinical", abac: "caseload_or_scope" },
  // Proxy sign — medical_director only (pure RBAC; reason captured at the route).
  "orders.sign_on_behalf": { resource: "order", action: "sign_on_behalf", category: "clinical", abac: "none" },
  // Verbal order recording — RN / Clinical Supervisor.
  "orders.verbal.record": { resource: "order_verbal", action: "record", category: "clinical", abac: "caseload_or_scope" },
  // Cosignature attach (route ALSO requires `cosigner_role_match`).
  "orders.cosign": { resource: "order", action: "cosign", category: "clinical", abac: "cosigner_role_match" },
  // Discontinue an active / pending / verbal order.
  "orders.discontinue": { resource: "order", action: "discontinue", category: "clinical", abac: "caseload_or_scope" },
  // Corrected order with replaces_order_id.
  "orders.amend": { resource: "order", action: "amend", category: "clinical", abac: "caseload_or_scope" },
  // Manual completion (incl. lab "Mark reviewed", D17).
  "orders.complete": { resource: "order", action: "complete", category: "clinical", abac: "caseload_or_scope" },
  // Standing-order template CRUD.
  "orders.standing.manage": { resource: "standing_order", action: "manage", category: "clinical", abac: "caseload_or_scope" },
  // PRN manual spawn (worker spawn is system actor).
  "orders.standing.spawn": { resource: "standing_order", action: "spawn", category: "clinical", abac: "caseload_or_scope" },
  // Org verbal-policy read / update (org_admin, compliance).
  "orders.policy.read": { resource: "order_policy", action: "read", category: "compliance", abac: "none" },
  "orders.policy.manage": { resource: "order_policy", action: "manage", category: "compliance", abac: "none" },
  // Platform-ops verbal-timer regeneration (audited as elevated access, §4.1).
  "orders.admin.regenerate_verbal_timer": { resource: "order_admin", action: "regenerate_verbal_timer", category: "platform", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M11 contributed permission keys. */
export type M11ContributedPermissionKey = keyof typeof M11_CONTRIBUTED_PERMISSIONS;

/**
 * M12-T08 — Module 12 (DoseSpot Integration) §4.6 permission keys registered into M3's catalog (the binding
 * handshake; boot validation fails if any key is missing at startup). The clinical read/draft/sign/verbal/
 * cosign/discontinue/history/refill keys default to `caseload_or_scope` (the patient-scope predicate M5/M6/M7
 * own); the draft routes ALSO carry M12's owned `prescriber_eligible[:medClass]` predicate, the sign routes
 * M11's `signer_eligible[:medication_order]` (via seam), the controlled-substance routes M12's owned
 * `dea_schedule_authorized[:schedule]`, the cosign route M11's `cosigner_role_match`, and the refill-inbox
 * read the owned `refill_inbox_scope` — applied explicitly at the route on top of the default (§4.7). The
 * admin roster/policy/EPCS-certification keys are pure RBAC (`none`; org-admin / compliance / platform-ops
 * reference rows, step-up enforced at the route). Keys carry a `prescribing.` NAMESPACE prefix on top of the
 * `resource.action` decomposition (like M11's `orders.` / M10's `hope.`), so `key` is the full dotted
 * permission string used at `requirePermission(...)`. Fourteen keys total (§4.6). Kept in a dedicated const
 * for §3.3 attributability.
 */
export const M12_CONTRIBUTED_PERMISSIONS = {
  // Read (caseload-scoped clinical reads) — every GET medication-order route.
  "prescribing.read": { resource: "medication_order", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Authoring — POST/PATCH draft (route ALSO requires `prescriber_eligible[:medClass]`).
  "prescribing.draft": { resource: "medication_order", action: "draft", category: "clinical", abac: "caseload_or_scope" },
  // Standard sign (→ signed; route ALSO requires M11 `signer_eligible[:medication_order]`).
  "prescribing.sign": { resource: "medication_order", action: "sign", category: "clinical", abac: "caseload_or_scope" },
  // Controlled-substance EPCS sign (route ALSO requires `dea_schedule_authorized[:schedule]` + IAL2 + tenant EPCS).
  "prescribing.sign_controlled_substance": { resource: "medication_order", action: "sign_controlled", category: "clinical", abac: "caseload_or_scope" },
  // Verbal medication-order recording — RN+ (D18: controlled is Phase-1-OFF).
  "prescribing.verbal.record": { resource: "medication_order", action: "verbal_record", category: "clinical", abac: "caseload_or_scope" },
  // Cosignature attach (route ALSO requires M11 `cosigner_role_match`).
  "prescribing.cosign": { resource: "medication_order", action: "cosign", category: "clinical", abac: "cosigner_role_match" },
  // Discontinue / complete an active / pending / verbal medication order.
  "prescribing.discontinue": { resource: "medication_order", action: "discontinue", category: "clinical", abac: "caseload_or_scope" },
  // Refill-inbox decide (approve mints a new order; route ALSO requires M11 `signer_eligible`).
  "prescribing.refill_decide": { resource: "refill_request", action: "decide", category: "clinical", abac: "caseload_or_scope" },
  // Per-tenant DoseSpot prescriber roster admin (org-scoped, step-up).
  "prescribing.admin.roster": { resource: "dosespot_prescriber", action: "admin", category: "compliance", abac: "none" },
  // Refill-inbox / controlled-substance policy admin (org-scoped, step-up, tighten-only).
  "prescribing.admin.policy": { resource: "prescribing_policy", action: "admin", category: "compliance", abac: "none" },
  // Platform + org EPCS certification gate (the D18 certification toggle, step-up).
  "prescribing.admin.epcs_certification": { resource: "epcs_certification", action: "admin", category: "platform", abac: "none" },
  // Medication-history read (caseload-scoped).
  "prescribing.history.read": { resource: "medication_history_record", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Medication-history reconcile (carry-forward mints a draft).
  "prescribing.history.reconcile": { resource: "medication_history_record", action: "reconcile", category: "clinical", abac: "caseload_or_scope" },
  // RxBenefit cached lookup (every prescriber + drafter).
  "prescribing.rx_benefit.lookup": { resource: "rx_benefit", action: "lookup", category: "clinical", abac: "caseload_or_scope" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M12 contributed permission keys. */
export type M12ContributedPermissionKey = keyof typeof M12_CONTRIBUTED_PERMISSIONS;

/**
 * M13-T08 — Module 13 (eMAR & Med Administration) §4.6 permission keys registered into M3's catalog (the
 * binding handshake; boot validation fails if any key is missing at startup). The clinical
 * read/record/refusal/witness/correct/reconciliation/comfort-kit keys default to `caseload_or_scope` (the
 * patient-scope predicate M5/M6/M7 own); the record route ALSO carries M13's owned
 * `administering_clinician_eligible[:medClass]` predicate, the witness-attest route M13's owned
 * `controlled_substance_witness_eligible`, the caregiver acknowledge/dispute routes M13's owned
 * `caregiver_attested_review_required`, and the reconciliation decide/finalize routes M13's owned
 * `reconciliation_authoring_eligible` — applied explicitly at the route on top of the default (§4.7). The
 * significant-late / administrative-override / void / policy keys carry the late-entry tier gate + step-up
 * enforced at the route. The caregiver-record key is an M31 portal-session path (`none` here; the portal
 * session token gates it). The policy admin key is pure RBAC (`none`; org-admin / compliance reference rows,
 * step-up at the route). Keys carry an `administration.` / `reconciliation.` / `comfort_kit.` NAMESPACE prefix
 * on top of the `resource.action` decomposition (like M12's `prescribing.`), so `key` is the full dotted
 * permission string used at `requirePermission(...)`. Twenty-two keys total (§4.6). Kept in a dedicated const
 * for §3.3 attributability.
 */
export const M13_CONTRIBUTED_PERMISSIONS = {
  // Read (caseload-scoped clinical reads) — every GET administration / scheduled-dose / IV-session route.
  "administration.read": { resource: "administration_record", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Record a clinician administration (route ALSO requires `administering_clinician_eligible[:medClass]`).
  "administration.record": { resource: "administration_record", action: "record", category: "clinical", abac: "caseload_or_scope" },
  // Significant-late tier (24h-7d) — supervisor cosign queued (D8).
  "administration.record_significant_late": { resource: "administration_record", action: "record_significant_late", category: "clinical", abac: "caseload_or_scope" },
  // Administrative-override tier (>7d) — step-up enforced at the route (D8).
  "administration.administrative_override": { resource: "administration_record", action: "administrative_override", category: "clinical", abac: "caseload_or_scope" },
  // Record a refusal (patient declined; no medication given; route ALSO requires `administering_clinician_eligible`).
  "administration.record_refusal": { resource: "administration_record", action: "record_refusal", category: "clinical", abac: "caseload_or_scope" },
  // Record an intentional hold of a scheduled dose before the grace window expires.
  "administration.record_missed": { resource: "scheduled_dose", action: "intentional_hold", category: "clinical", abac: "caseload_or_scope" },
  // Mint a witness-attestation token (route ALSO requires `controlled_substance_witness_eligible`).
  "administration.witness_attest": { resource: "administration_witness", action: "attest", category: "clinical", abac: "caseload_or_scope" },
  // Correction of a committed administration (creates a new row, supersedes original).
  "administration.correct": { resource: "administration_record", action: "correct", category: "clinical", abac: "caseload_or_scope" },
  // Administrative hard-void (recorded in error) — step-up enforced at the route.
  "administration.void": { resource: "administration_record", action: "void", category: "clinical", abac: "caseload_or_scope" },
  // Caregiver-attested administration via M31 portal — the portal session token gates it (no caseload predicate).
  "administration.caregiver_record": { resource: "administration_record", action: "caregiver_record", category: "clinical", abac: "none" },
  // RN case manager acknowledges a caregiver-attested row (route ALSO requires `caregiver_attested_review_required`).
  "administration.caregiver_acknowledge": { resource: "administration_record", action: "caregiver_acknowledge", category: "clinical", abac: "caseload_or_scope" },
  // RN case manager disputes a caregiver-attested row (route ALSO requires `caregiver_attested_review_required`).
  "administration.caregiver_dispute": { resource: "administration_record", action: "caregiver_dispute", category: "clinical", abac: "caseload_or_scope" },
  // Missed-dose read (caseload-scoped).
  "administration.read_missed": { resource: "missed_dose", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Case manager acknowledges a missed dose.
  "administration.acknowledge_missed": { resource: "missed_dose", action: "acknowledge", category: "clinical", abac: "caseload_or_scope" },
  // PRN minimum-interval override (supervisor / prescriber; reason captured).
  "administration.prn_interval_override": { resource: "administration_record", action: "prn_interval_override", category: "clinical", abac: "caseload_or_scope" },
  // Reconciliation worksheet read (caseload-scoped).
  "reconciliation.read": { resource: "medication_reconciliation_worksheet", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Record/update a per-line decision (route ALSO requires `reconciliation_authoring_eligible`).
  "reconciliation.decide": { resource: "medication_reconciliation_decision", action: "create", category: "clinical", abac: "caseload_or_scope" },
  // Finalize the worksheet (route ALSO requires `reconciliation_authoring_eligible`).
  "reconciliation.finalize": { resource: "medication_reconciliation_worksheet", action: "finalize", category: "clinical", abac: "caseload_or_scope" },
  // Void a worksheet (e.g., re-triggered by a transfer-correction).
  "reconciliation.void": { resource: "medication_reconciliation_worksheet", action: "void", category: "clinical", abac: "caseload_or_scope" },
  // Comfort-kit deployment read (caseload-scoped).
  "comfort_kit.read": { resource: "comfort_kit_deployment", action: "read", category: "clinical", abac: "caseload_or_scope" },
  // Manual comfort-kit return acknowledgment (Phase-1 fallback when M21 absent).
  "comfort_kit.acknowledge_return": { resource: "comfort_kit_deployment", action: "acknowledge_return", category: "clinical", abac: "caseload_or_scope" },
  // Per-tenant administration policy admin (org-scoped, step-up).
  "administration.admin.policy": { resource: "administration_policy", action: "admin", category: "compliance", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M13 contributed permission keys. */
export type M13ContributedPermissionKey = keyof typeof M13_CONTRIBUTED_PERMISSIONS;

/**
 * M14-T05 — Module 14 (Interdisciplinary Group / IDG) §4.6 permission keys registered into M3's catalog (the
 * binding handshake; boot validation fails if any key is missing at startup). The clinical
 * read/attend/coordinate/decide keys default to `idg_meeting_scope` (M14's owned location-scope predicate); the
 * decision routes ALSO carry M14's owned `quorate_decision` predicate and the cancel/reschedule routes M14's
 * owned `per_patient_review_floor_clear` — applied explicitly at the route on top of the default (§4.7). The
 * `idg.act` key is self-scoped to the assignee via the shared `is_assignee` predicate. The
 * `idg.schedule` / `idg.override_review_floor` / `idg.amend_minutes` keys carry a tenant-admin / compliance
 * scope (`none` here; the step-up + override-permission gates are enforced at the route). The `idg.system` key
 * is the internal system-principal path (packet build / FHIR / render reads; `none` — the system actor gates
 * it). Nine keys total (§4.6). Kept in a dedicated const for §3.3 attributability.
 */
export const M14_CONTRIBUTED_PERMISSIONS = {
  // Read packets / minutes / decisions / schedule for in-scope meetings (default `idg_meeting_scope`).
  "idg.read": { resource: "idg_meeting", action: "read", category: "clinical", abac: "idg_meeting_scope" },
  // Self check-in/check-out attendance (default `idg_meeting_scope`).
  "idg.attend": { resource: "idg_attendance", action: "check_in", category: "clinical", abac: "idg_meeting_scope" },
  // Build packets, manage agenda, run lifecycle transitions, manage action items as coordinator.
  "idg.coordinate": { resource: "idg_meeting", action: "coordinate", category: "clinical", abac: "idg_meeting_scope" },
  // Record / supersede decisions (route ALSO requires `quorate_decision`).
  "idg.decide": { resource: "idg_decision", action: "record", category: "clinical", abac: "idg_meeting_scope" },
  // Update assigned action items (self-scoped via the shared `is_assignee` predicate).
  "idg.act": { resource: "idg_action_item", action: "update", category: "clinical", abac: "is_assignee" },
  // Manage recurring policies, cancel/reschedule meetings (cancel/reschedule ALSO require `per_patient_review_floor_clear`).
  "idg.schedule": { resource: "idg_recurring_policy", action: "manage", category: "clinical", abac: "none" },
  // Override the per-patient 15-day review-floor guard on CANCEL/RESCHEDULE (audited + step-up; M14-F01 / ADR-0018 D2).
  "idg.override_review_floor": { resource: "idg_meeting", action: "override_review_floor", category: "compliance", abac: "none" },
  // Submit minutes amendments (tenant-admin / compliance scope).
  "idg.amend_minutes": { resource: "idg_minutes", action: "amend", category: "compliance", abac: "none" },
  // Internal system principal — packet build, action-item auto-close consumers, FHIR/render reads.
  "idg.system": { resource: "idg_patient_packet", action: "system_read", category: "admin", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M14 contributed permission keys. */
export type M14ContributedPermissionKey = keyof typeof M14_CONTRIBUTED_PERMISSIONS;

/**
 * M17-T07 — Module 17 (Scheduling & Route Optimization) §4.6 permission keys registered into M3's catalog
 * (the binding handshake; boot validation fails if any key is missing at startup). All `category:
 * 'scheduling'`. The patient-touching visit / proposal / recurring keys default to `caseload_or_scope` (the
 * shared patient-scope predicate M5/M6/M7 own); the assignment-write routes (create/edit/reschedule/reassign)
 * ALSO compose M17's four OWNED §4.7 predicates at the route — `clinician_credentials_active`,
 * `discipline_matches_visit`, `not_on_pto`, `within_caseload_or_unassigned_pool` (registered by
 * 17-scheduling/abac-predicates.ts) — the pre-schedule gate (D8). The membership-scoped availability/time_off
 * keys, the org-wide team/metrics reads, the on-demand optimisation trigger, and the portal upcoming-visit key
 * are pure RBAC (`none`); the route layer scopes them server-side (own-vs-team) or the portal session class
 * applies (per-patient via M39 consent, not caseload). Kept in a dedicated const for §3.3 attributability.
 */
export const M17_CONTRIBUTED_PERMISSIONS = {
  // --- visit reads (caseload-scoped clinical read + org-wide team/metrics) ---
  "visit.read": { resource: "visit", action: "read", category: "scheduling", abac: "caseload_or_scope" },
  "visit.read_team": { resource: "visit", action: "read_team", category: "scheduling", abac: "none" },
  "visit.read_metrics": { resource: "visit", action: "read_metrics", category: "scheduling", abac: "none" },
  // --- visit lifecycle writes (assignment routes ALSO compose the four owned §4.7 pre-schedule predicates) ---
  "visit.create": { resource: "visit", action: "create", category: "scheduling", abac: "caseload_or_scope" },
  "visit.edit": { resource: "visit", action: "edit", category: "scheduling", abac: "caseload_or_scope" },
  "visit.start": { resource: "visit", action: "start", category: "scheduling", abac: "caseload_or_scope" },
  "visit.cancel": { resource: "visit", action: "cancel", category: "scheduling", abac: "caseload_or_scope" },
  "visit.reschedule": { resource: "visit", action: "reschedule", category: "scheduling", abac: "caseload_or_scope" },
  "visit.reassign": { resource: "visit", action: "reassign", category: "scheduling", abac: "caseload_or_scope" },
  "visit.mark_no_show": { resource: "visit", action: "mark_no_show", category: "scheduling", abac: "caseload_or_scope" },
  // --- visit proposals (scheduler inbox) ---
  "visit.proposal.read": { resource: "visit_proposal", action: "read", category: "scheduling", abac: "caseload_or_scope" },
  "visit.proposal.dismiss": { resource: "visit_proposal", action: "dismiss", category: "scheduling", abac: "caseload_or_scope" },
  // --- recurring visit policies ---
  "recurring_visit.read": { resource: "recurring_visit", action: "read", category: "scheduling", abac: "caseload_or_scope" },
  "recurring_visit.create": { resource: "recurring_visit", action: "create", category: "scheduling", abac: "caseload_or_scope" },
  "recurring_visit.discontinue": { resource: "recurring_visit", action: "discontinue", category: "scheduling", abac: "caseload_or_scope" },
  // --- clinician availability (membership-scoped; own-vs-any) ---
  "availability.read": { resource: "availability", action: "read", category: "scheduling", abac: "none" },
  "availability.edit_own": { resource: "availability", action: "edit_own", category: "scheduling", abac: "none" },
  "availability.edit_any": { resource: "availability", action: "edit_any", category: "scheduling", abac: "none" },
  // --- time off (PTO) ---
  "time_off.read_own": { resource: "time_off", action: "read_own", category: "scheduling", abac: "none" },
  "time_off.read_team": { resource: "time_off", action: "read_team", category: "scheduling", abac: "none" },
  "time_off.request_own": { resource: "time_off", action: "request_own", category: "scheduling", abac: "none" },
  "time_off.approve": { resource: "time_off", action: "approve", category: "scheduling", abac: "none" },
  "time_off.cancel_own": { resource: "time_off", action: "cancel_own", category: "scheduling", abac: "none" },
  // --- route optimisation (behind scheduling.route_optimization, OFF) + efficiency metrics ---
  "route.optimize_on_demand": { resource: "route", action: "optimize_on_demand", category: "scheduling", abac: "none" },
  "route.read_metrics": { resource: "route", action: "read_metrics", category: "scheduling", abac: "none" },
  // --- portal session class — upcoming visits, lay-language, scrubbed (per-patient via M39 consent) ---
  "portal.visit.read_upcoming": { resource: "portal_visit", action: "read_upcoming", category: "scheduling", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M17 contributed permission keys. */
export type M17ContributedPermissionKey = keyof typeof M17_CONTRIBUTED_PERMISSIONS;

/**
 * M18-T06 — Module 18 (Electronic Visit Verification) §4.6 permission keys registered into M3's catalog (the
 * binding handshake; boot validation fails if any key is missing at startup). All `category: 'evv'`. The
 * patient-touching event read/correct + missing-resolution keys default to `caseload_or_scope` (the shared
 * patient-scope predicate M5/M6/M7 own); the `evv.check_in` / `evv.check_out` routes ALSO compose M18's two
 * OWNED §4.7 predicates at the route — `assigned_clinician_for_visit` ∧ `evv_within_visit_window` (registered
 * by 18-evv/abac-predicates.ts) — plus the shared `device_attestation_valid` (D8). `evv.read_coords` is a
 * SEPARATE key from `evv.read` for audit-prominence (D10). The device-registration, geofence-policy,
 * aggregator-submission, team-location, and metrics keys are pure RBAC (`none`) — they are membership-scoped /
 * org-wide / billing-ops surfaces the route layer scopes server-side, not patient-caseload reads. The portal
 * arrival key is the M31 portal session class (per-patient via M39 `family_caregiver_access` consent, not
 * caseload). Keys carry an `evv.` / `portal.evv.` NAMESPACE prefix on top of the `resource.action`
 * decomposition (like M11's `orders.` / M14's `idg.`). Twenty-one keys total (§4.6). Kept in a dedicated const
 * for §3.3 attributability.
 */
export const M18_CONTRIBUTED_PERMISSIONS = {
  // --- EVV event capture (routes ALSO compose `assigned_clinician_for_visit` ∧ `evv_within_visit_window`) ---
  "evv.check_in": { resource: "evv_event", action: "check_in", category: "evv", abac: "caseload_or_scope" },
  "evv.check_out": { resource: "evv_event", action: "check_out", category: "evv", abac: "caseload_or_scope" },
  // --- EVV event reads (coords is a SEPARATE key for audit-prominence, D10) ---
  "evv.read": { resource: "evv_event", action: "read", category: "evv", abac: "caseload_or_scope" },
  "evv.read_coords": { resource: "evv_event", action: "read_coords", category: "evv", abac: "caseload_or_scope" },
  "evv.read_metrics": { resource: "evv_metrics", action: "read", category: "evv", abac: "none" },
  // --- correction-of-record (Clinical Supervisor+, step-up at the route) ---
  "evv.correct_record": { resource: "evv_event", action: "correct_record", category: "evv", abac: "caseload_or_scope" },
  // --- device registration lifecycle (membership-scoped; the route scopes own-vs-team) ---
  "evv.device.register_self": { resource: "evv_device", action: "register_self", category: "evv", abac: "none" },
  "evv.device.read": { resource: "evv_device", action: "read", category: "evv", abac: "none" },
  "evv.device.approve": { resource: "evv_device", action: "approve", category: "evv", abac: "none" },
  "evv.device.suspend": { resource: "evv_device", action: "suspend", category: "evv", abac: "none" },
  "evv.device.retire": { resource: "evv_device", action: "retire", category: "evv", abac: "none" },
  // --- geofence policy (tenant tighten-only + per-address override; Clin Supv / DON / Compliance) ---
  "evv.policy.read": { resource: "evv_geofence_policy", action: "read", category: "evv", abac: "none" },
  "evv.policy.edit": { resource: "evv_geofence_policy", action: "edit", category: "evv", abac: "none" },
  // --- missing-EVV resolution (attest_self route ALSO composes `assigned_clinician_for_visit`) ---
  "evv.missing_resolution.read": { resource: "evv_missing_resolution", action: "read", category: "evv", abac: "caseload_or_scope" },
  "evv.missing_resolution.attest_self": { resource: "evv_missing_resolution", action: "attest_self", category: "evv", abac: "caseload_or_scope" },
  "evv.missing_resolution.supervisor_override": { resource: "evv_missing_resolution", action: "supervisor_override", category: "evv", abac: "none" },
  // --- per-state aggregator submission queue (billing-ops; org-wide) ---
  "evv.aggregator.read": { resource: "evv_aggregator_submission", action: "read", category: "evv", abac: "none" },
  "evv.aggregator.resubmit": { resource: "evv_aggregator_submission", action: "resubmit", category: "evv", abac: "none" },
  "evv.aggregator.cancel": { resource: "evv_aggregator_submission", action: "cancel", category: "evv", abac: "none" },
  // --- M20 field-safety supervisor live-awareness (org-wide team-location read; audit-prominent) ---
  "evv.location.read_team": { resource: "evv_location", action: "read_team", category: "evv", abac: "none" },
  // --- M31 portal arrival surface (portal session class; per-patient via M39 consent, not caseload) ---
  "portal.evv.read_arrival": { resource: "portal_evv", action: "read_arrival", category: "evv", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M18 contributed permission keys. */
export type M18ContributedPermissionKey = keyof typeof M18_CONTRIBUTED_PERMISSIONS;

/**
 * The permission keys Module 22 (Document Management) registers into Module 3's catalog — the §4.6
 * binding cross-module handshake (M22-T07; M22 spec §4.6). M3 must include these before M22's routes
 * can be authorized; the §4.1 route inventory (M22-T07) gates on them. §4.6 is the SOLE permission
 * registry for M22 (M22-F16 / ADR-0022): the canonical dot-key form, no parallel colon-key catalog.
 *
 * The catalog `abac` field is the DEFAULT predicate per key (the §4.1 Auth column); the route layer
 * additionally composes the explicit §4.7 chain — `document_owner_or_caseload` on PHI-content + export,
 * `legal_hold_aware` on metadata edits, `extraction_reviewer_eligible` on per-candidate decisions,
 * `form_template_publish_authority`/`tenant_template_overlay_edit_authority` on publish. Review actions
 * (approve low/high-risk, reject, discrepancy-resolve) all map to the single key `intake.review`; the
 * risk-level eligibility distinction is the `extraction_reviewer_eligible` ABAC concern, not a key.
 */
export const M22_CONTRIBUTED_PERMISSIONS = {
  // --- documents (§4.6) ---
  "documents.upload": { resource: "document", action: "upload", category: "clinical", abac: "caseload_membership" },
  "documents.read": { resource: "document", action: "read", category: "clinical", abac: "document_owner_or_caseload" },
  "documents.read_history": { resource: "document", action: "read_history", category: "clinical", abac: "document_owner_or_caseload" },
  "documents.read_access_log": { resource: "document", action: "read_access_log", category: "compliance", abac: "none" },
  "documents.read_phi_content": { resource: "document", action: "read_phi_content", category: "clinical", abac: "document_owner_or_caseload" },
  "documents.edit_metadata": { resource: "document", action: "edit_metadata", category: "clinical", abac: "legal_hold_aware" },
  "documents.attach_to_disclosures": { resource: "document", action: "attach_to_disclosures", category: "compliance", abac: "none" },
  "documents.export_phi_bundle": { resource: "document", action: "export_phi_bundle", category: "compliance", abac: "document_owner_or_caseload" },
  "documents.delete": { resource: "document", action: "delete", category: "compliance", abac: "legal_hold_aware" },
  "documents.read_templates": { resource: "form_template", action: "read", category: "clinical", abac: "none" },
  "documents.preview_template": { resource: "form_template", action: "preview", category: "platform", abac: "none" },
  "documents.publish_template": { resource: "form_template", action: "publish", category: "platform", abac: "form_template_publish_authority" },
  "documents.manage_overlay": { resource: "tenant_template_overlay", action: "manage", category: "admin", abac: "tenant_template_overlay_edit_authority" },
  "documents.admin_read_fills": { resource: "form_fill", action: "admin_read", category: "platform", abac: "none" },
  "documents.admin_retry_render": { resource: "form_fill", action: "admin_retry_render", category: "platform", abac: "none" },
  // --- intake (§4.6) ---
  "intake.upload": { resource: "intake_batch", action: "upload", category: "clinical", abac: "none" },
  "intake.read": { resource: "intake_batch", action: "read", category: "clinical", abac: "none" },
  "intake.reclassify": { resource: "intake_batch", action: "reclassify", category: "clinical", abac: "none" },
  "intake.confirm_classification": { resource: "intake_batch", action: "confirm_classification", category: "clinical", abac: "none" },
  "intake.split_batch": { resource: "intake_batch", action: "split_batch", category: "clinical", abac: "none" },
  "intake.review": { resource: "extraction_review", action: "review", category: "clinical", abac: "extraction_reviewer_eligible" },
  "intake.discard_batch": { resource: "intake_batch", action: "discard_batch", category: "clinical", abac: "none" },
  // --- extraction provenance (§4.6) ---
  "extraction.read_provenance": { resource: "extraction_provenance", action: "read", category: "compliance", abac: "none" },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M22 contributed permission keys. */
export type M22ContributedPermissionKey = keyof typeof M22_CONTRIBUTED_PERMISSIONS;

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

/** Project the M7 contributed keys into `permission`-table mirror rows (M7-T05). */
export function m7ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M7_CONTRIBUTED_PERMISSIONS);
}

/** Project the M8 contributed keys into `permission`-table mirror rows (M8-T09). */
export function m8ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M8_CONTRIBUTED_PERMISSIONS);
}

/** Project the M9 contributed keys into `permission`-table mirror rows (M9-T05). */
export function m9ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M9_CONTRIBUTED_PERMISSIONS);
}

/** Project the M10 contributed keys into `permission`-table mirror rows (M10-T06). */
export function m10ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M10_CONTRIBUTED_PERMISSIONS);
}

/** Project the M11 contributed keys into `permission`-table mirror rows (M11-T06). */
export function m11ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M11_CONTRIBUTED_PERMISSIONS);
}

/** Project the M12 contributed keys into `permission`-table mirror rows (M12-T08). */
export function m12ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M12_CONTRIBUTED_PERMISSIONS);
}

/** Project the M13 contributed keys into `permission`-table mirror rows (M13-T08). */
export function m13ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M13_CONTRIBUTED_PERMISSIONS);
}

/** Project the M14 contributed keys into `permission`-table mirror rows (M14-T05). */
export function m14ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M14_CONTRIBUTED_PERMISSIONS);
}

/** Project the M17 contributed keys into `permission`-table mirror rows (M17-T07). */
export function m17ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M17_CONTRIBUTED_PERMISSIONS);
}

/** Project the M18 contributed keys into `permission`-table mirror rows (M18-T06). */
export function m18ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M18_CONTRIBUTED_PERMISSIONS);
}

/** Project the M22 contributed keys into `permission`-table mirror rows (M22-T07). */
export function m22ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M22_CONTRIBUTED_PERMISSIONS);
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
    ...m7ContributedPermissionMirrorRows(),
    ...m8ContributedPermissionMirrorRows(),
    ...m9ContributedPermissionMirrorRows(),
    ...m10ContributedPermissionMirrorRows(),
    ...m11ContributedPermissionMirrorRows(),
    ...m12ContributedPermissionMirrorRows(),
    ...m13ContributedPermissionMirrorRows(),
    ...m14ContributedPermissionMirrorRows(),
    ...m17ContributedPermissionMirrorRows(),
    ...m18ContributedPermissionMirrorRows(),
    ...m22ContributedPermissionMirrorRows(),
  ];
}
