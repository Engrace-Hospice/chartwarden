// @chartwarden/auth · permissions — the M1/M2 permission-key back-fill (M3 — Authorization,
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
  // Org/ProviderEntity/Location CRUD + HearthNote opt-in (org_admin, platform_ops). §11 D19's
  // POST /api/v1/platform/organizations/:organizationId/status (organization-lifecycle-routes.ts) is
  // the first route bound to this key, narrowed by `organization_lifecycle_platform_ops` — RBAC alone
  // would let any org_admin transition an ARBITRARY other org, not just their own.
  "org.manage": {
    resource: "org",
    action: "manage",
    category: "admin",
    abac: "organization_lifecycle_platform_ops",
  },
  // POST /orgs/:id/invitations (+ rescind) — invite a user to an org (org_admin).
  "member.invite": { resource: "member", action: "invite", category: "admin", abac: "none" },
  // Suspend/reinstate/revoke a membership + default-scope edits (org_admin).
  "member.manage": { resource: "member", action: "manage", category: "admin", abac: "none" },
  // Direct staff provisioning. Role assignment remains independently bounded by role.assign + ceiling.
  "user.create": { resource: "user", action: "create", category: "admin", abac: "none" },
  // Global credential mutation; tenant routes additionally reject shared identities and require step-up.
  "user.password.reset": {
    resource: "user",
    action: "password.reset",
    category: "admin",
    abac: "none",
  },
  // Full offboard — disable credentials everywhere (org_admin own-org / platform_ops any).
  "user.deactivate": { resource: "user", action: "deactivate", category: "admin", abac: "none" },
  // GAP-115 — `POST/GET /orgs/:id/step-up-overrides` (+ DELETE): per-operation tenant step-up TIGHTENING
  // (M2 spec §3.7 / §4.3.2, org_admin or compliance_officer). The tighten-only rule is enforced twice: the route
  // refuses a loosening with 422, and `trg_tenant_step_up_tighten_only` (migration 0211) refuses it at rest.
  "step_up_override.manage": {
    resource: "step_up_override",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // GAP-115 — `POST /funeral/invite`: a per-deceased funeral-home magic link (72h), minted by staff on the
  // patient's caseload. Same default predicate as the collaborator link.
  "funeral.invite": {
    resource: "funeral",
    action: "invite",
    category: "clinical",
    abac: "caseload_membership",
  },
  // GAP-115 follow-up — `GET /funeral/case`: the ONE read a redeemed funeral-home session holds. It is a property of
  // the `funeral_home` session class (rbac/session-class-permissions.ts), never of a role: no staff role carries it.
  "funeral.case_read": {
    resource: "funeral",
    action: "case_read",
    category: "external",
    abac: "funeral_session_pinned_patient",
  },
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
  // --- WP 2.8: author shared message templates and re-word/disable platform ones for the tenant (admin) ---
  "messaging.template.manage": {
    resource: "template",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // --- WP 3.7: propose a secure message for the chart (ADR-0063). A request only; the reviewer accepts it in the owning
  //     module with that module's own permission. Granted to clinical roles by migration 1102, never to aides. ---
  "messaging.promote": {
    resource: "chart_promotion",
    action: "request",
    category: "clinical",
    abac: "none",
  },
  // --- WP 3.8: decide the lifecycle review queue (ADR-0065): reassign or close the open tasks of a patient who was
  //     discharged, died or transferred. Granted to supervisory role keys by migration 1103, never to org_admin. ---
  "messaging.review": {
    resource: "review_item",
    action: "manage",
    category: "clinical",
    abac: "none",
  },
  // --- WP 4.1: the urgent clinical message (ADR-0068). `send` raises one (05 matrix "Initiate urgent escalation": clinician,
  //     aide, team lead; not org admin or compliance by default); `receive` lets a user be NAMED as its recipient (matrix
  //     "Acknowledge clinical responsibility": a qualified clinical role, never an aide). Granted by migration 1105. ---
  "messaging.urgent.send": {
    resource: "urgent_message",
    action: "send",
    category: "clinical",
    abac: "none",
  },
  "messaging.urgent.receive": {
    resource: "urgent_message",
    action: "receive",
    category: "clinical",
    abac: "none",
  },
  // --- WP 4.12 (ADR-0080): read the on-call "who is covering now" directory (names and roles only). Read-only; role-based SEND is a
  //     separate, undecided change with its own key. Granted by migration 1128 to every role that already holds messaging.read. ---
  "messaging.oncall.read": {
    resource: "oncall_directory",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  // --- WP 4.12 follow-on (ADR-0081, PROPOSED): address a ROLE ("message the on-call RN"). It changes who is paged, so it is a key of its
  //     own and migration 1129 grants it to NO tenant role (full-catalog admin roles receive it); the clinical lead names who may hold it. ---
  "messaging.oncall.send": {
    resource: "oncall_role_send",
    action: "send",
    category: "clinical",
    abac: "none",
  },
  // --- WP 2.7b C4: switch tenant global search on/off (ADR-0058 decision 2; the route also demands a fresh step-up) ---
  "messaging.global_search.manage": {
    resource: "global_search",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // --- WP 5.5 (ADR-0083, PROPOSED): list and revoke ANOTHER user's sessions in the organisation (security officer). The revoke route also
  //     demands a fresh step-up; migration 1130 grants it to the full-catalog admin roles only. Self-service needs no key (own sessions only). ---
  "messaging.sessions.manage": {
    resource: "session_device",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // --- WP 5.9 (ADR-0084, PROPOSED): preview and run the offboarding of a departed user in the organisation (security officer). The execute
  //     route also demands a fresh step-up and the supervisor-reassign keys; migration 1131 grants it to the full-catalog admin roles only. ---
  "messaging.offboarding.manage": {
    resource: "workforce_offboarding",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // --- WP 6.2 (ADR-0092, PROPOSED): read the AGGREGATE response analytics (ack latency, escalation rate, handoff acceptance, per-discipline
  //     response). Aggregates only, small groups withheld; there is no individual-level key (HR/compliance review first). Migration 1170
  //     grants it to compliance_officer, administrator and org_admin. ---
  "messaging.analytics.read": {
    resource: "response_analytics",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  // --- WP 5.6 (ADR-0086, PROPOSED): apply and release a legal hold on messages and read the retention view (compliance officer). Apply and
  //     release each demand a fresh step-up and a written reason; migration 1138 grants it to compliance_officer, administrator and org_admin. ---
  "messaging.retention.manage": {
    resource: "message_retention",
    action: "manage",
    category: "compliance",
    abac: "none",
  },
  // --- WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED): redaction of a message. REQUEST asks for one, APPROVE decides it (never the requester's own;
  //     a fresh step-up is demanded). Org admin has NO implicit right to either (ADR-0055 D9), so the full-catalog roles skip both
  //     (FULL_CATALOG_EXCLUDED_KEYS) and migration 1156 / the compliance_officer template are the only default grants. ---
  "messaging.redact.request": {
    resource: "message_redaction",
    action: "request",
    category: "compliance",
    abac: "none",
  },
  "messaging.redact.approve": {
    resource: "message_redaction",
    action: "approve",
    category: "compliance",
    abac: "none",
  },
  // WP 5.6 (ADR-0055 D9, migration 1165, PROVISIONAL): the SECOND ROLE that countersigns a sole officer's self-approved redaction within 72 h.
  //     Org admin (through the full catalog) and the privacy officer; never the compliance officer. A fresh step-up is demanded.
  "messaging.redact.countersign": {
    resource: "message_redaction",
    action: "countersign",
    category: "compliance",
    abac: "none",
  },
  // --- WP 5.8 (ADR-0087, PROPOSED): break-glass. INVOKE opens a self-approved, time-limited, read-only grant on one channel (a fresh step-up and
  //     a written justification are demanded in the route); REVIEW completes the mandatory post-review and is never the grantee's own. Migration
  //     1140 grants invoke to administrator, org_admin and the qualified clinical roles, and review to compliance_officer, administrator, org_admin. ---
  "messaging.break_glass.invoke": {
    resource: "message_break_glass",
    action: "invoke",
    category: "compliance",
    abac: "none",
  },
  "messaging.break_glass.review": {
    resource: "message_break_glass",
    action: "review",
    category: "compliance",
    abac: "none",
  },
  // --- WP 5.7 (ADR-0089, PROPOSED): restricted export. REQUEST asks for a scoped export, APPROVE decides it (never the requester's own), DOWNLOAD
  //     reads the finished artefact (the requester only, checked in the service). A fresh step-up is demanded on request, approve, reject and
  //     download. Migration 1147 grants all three to compliance_officer, administrator, org_admin only; no clinical or aide role holds them. ---
  "messaging.export.request": {
    resource: "message_export",
    action: "request",
    category: "compliance",
    abac: "none",
  },
  "messaging.export.approve": {
    resource: "message_export",
    action: "approve",
    category: "compliance",
    abac: "none",
  },
  "messaging.export.download": {
    resource: "message_export",
    action: "download",
    category: "compliance",
    abac: "none",
  },
  // --- WP 6.6 (ADR-0096, PROPOSED): external partner share. MANAGE creates, lists and revokes a read-only, single-conversation, expiring
  //     share for a pharmacy / DME partner (a fresh step-up on create and revoke). Migration 1180 grants it to compliance_officer,
  //     administrator, org_admin only; no clinical or aide role holds it. The tenant flag messaging.external_partners is off by default. ---
  "messaging.share.manage": {
    resource: "message_external_share",
    action: "manage",
    category: "compliance",
    abac: "none",
  },
  // --- the caller's OWN alert inbox + mark-read (SELF only: both routes filter on recipient_user_id = the actor).
  //     Held by the zero-authority platform_alert_audience role (migration 1097) so a bound platform operator can
  //     read the alerts addressed to them; the routes also accept `messaging.read`, which every tenant role has. ---
  "alert.inbox.self": {
    resource: "alert_inbox",
    action: "self",
    category: "clinical",
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
  // GAP-020 -- print / reprint a patient wristband (the on-file side of the BCMA wrong_patient arm), and the
  // rarer hard kill of a generation (identity error / compromise; the route also demands step-up).
  "patient.wristband.issue": {
    resource: "patient_wristband",
    action: "issue",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "patient.wristband.void": {
    resource: "patient_wristband",
    action: "void",
    category: "compliance",
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
  /**
   * Unmasked PHI in a compliance projection — today only M32's §164.528 disclosure ledger (R16/R17),
   * where it unlocks the patient identity and the free-text error on an `ai_invocation` row.
   *
   * A CHECK-don't-gate key, like `cost_report.edit_any_provider`: no route gates on it (R16's route
   * key is `ai.invocation.read`); the projection consults it and masks when it is absent. It was
   * never in this catalog, so it could not be granted to anyone — and M32 asked for it as a ROLE
   * token (`context.roles.includes("phi.full_read")`, a `resource.action` key checked against a list
   * of role keys like `compliance_officer`) and as an unwritten context attribute. Both arms were
   * dead, so R16/R17 masked every caller including the compliance officer the ledger exists for
   * (F-030).
   *
   * Deliberately assigned to NO default role template: who reads unmasked PHI by default is a
   * tenant policy decision, and inventing one here would grant it silently on every existing org.
   */
  "phi.full_read": {
    resource: "phi",
    action: "full_read",
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
  // --- grief-resource catalog (GAP-158; tenant-curated external_grief_resource) ---
  "mdm.grief_resource.read": {
    resource: "grief_resource",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "mdm.grief_resource.manage": {
    resource: "grief_resource",
    action: "manage",
    category: "admin",
    abac: "none",
  },
  // --- PSAP jurisdiction catalog (GAP-032; tenant-curated emergency_service_jurisdiction) ---
  "mdm.psap_jurisdiction.read": {
    resource: "psap_jurisdiction",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "mdm.psap_jurisdiction.manage": {
    resource: "psap_jurisdiction",
    action: "manage",
    category: "admin",
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
 * (`f2f.is_hospice_md_or_np`, `f2f.window_override`, `compliance.window_override`) and the
 * 42 CFR 418.26(b) route-40 signer predicate `discharge.is_order_signer` (medical director, physician
 * designee, or the physician member of the patient's IDG — FY 2027; it replaced
 * `discharge.is_medical_director`). `patient.scope` (route 8) is M5's re-used predicate; M6 does not
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
  // 42 CFR 418.25(a) — record the physician admission recommendation (the recommender is validated
  // server-side against the signer set; this key gates who may ENTER it). Mirror row + grants: 0389.
  "admission.record_recommendation": {
    resource: "admission",
    action: "record_recommendation",
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
  // --- FY2027 election statement addendum (42 CFR 418.24(c)/(d); mig 0382 grants each to the roles
  //     holding its election.* counterpart) ---
  "election_addendum.read": {
    resource: "election_addendum",
    action: "read",
    category: "clinical",
    abac: "admission.scope",
  },
  "election_addendum.write": {
    resource: "election_addendum",
    action: "write",
    category: "clinical",
    abac: "admission.scope",
  },
  "election_addendum.acknowledge": {
    resource: "election_addendum",
    action: "acknowledge",
    category: "clinical",
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
    abac: "discharge.is_order_signer",
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
  "assessment.read": {
    resource: "assessment",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "assessment.author": {
    resource: "assessment",
    action: "author",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "assessment.amend": {
    resource: "assessment",
    action: "amend",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "assessment.cosign": {
    resource: "assessment",
    action: "cosign",
    category: "clinical",
    abac: "cosigner_role_match",
  },
  "assessment.read_trend": {
    resource: "assessment",
    action: "read_trend",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "assessment.acknowledge_change": {
    resource: "assessment",
    action: "acknowledge_change",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "assessment.read_summary": {
    resource: "assessment",
    action: "read_summary",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "assessment.license_read": {
    resource: "assessment",
    action: "license_read",
    category: "admin",
    abac: "none",
  },
  "assessment.license_admin": {
    resource: "assessment",
    action: "license_admin",
    category: "admin",
    abac: "none",
  },
  "assessment.policy_read": {
    resource: "assessment",
    action: "policy_read",
    category: "admin",
    abac: "none",
  },
  "assessment.policy_admin": {
    resource: "assessment",
    action: "policy_admin",
    category: "admin",
    abac: "none",
  },
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
  "hope.schedule.read": {
    resource: "hope_schedule",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "hope.timepoint.read": {
    resource: "hope_timepoint",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "hope.sfv.read": {
    resource: "hope_sfv",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Read (provider-entity-scoped compliance reads)
  "hope.submission.read": {
    resource: "hope_submission",
    action: "read",
    category: "compliance",
    abac: "provider_entity_scope",
  },
  "hope.dashboard.read": {
    resource: "hope_dashboard",
    action: "read",
    category: "compliance",
    abac: "provider_entity_scope",
  },
  // Write
  "hope.timepoint.write": {
    resource: "hope_timepoint",
    action: "write",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "hope.timepoint.sign": {
    resource: "hope_timepoint",
    action: "sign",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "hope.timepoint.correct": {
    resource: "hope_timepoint",
    action: "correct",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Schedule operations
  "hope.schedule.skip": {
    resource: "hope_schedule",
    action: "skip",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Submission management
  "hope.submission.manage": {
    resource: "hope_submission",
    action: "manage",
    category: "compliance",
    abac: "provider_entity_scope",
  },
  // Platform admin
  "hope.admin.regenerate_schedules": {
    resource: "hope_admin",
    action: "regenerate_schedules",
    category: "platform",
    abac: "none",
  },
  "hope.admin.late_deadline_override": {
    resource: "hope_admin",
    action: "late_deadline_override",
    category: "platform",
    abac: "none",
  },
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
  "orders.read": {
    resource: "order",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Authoring — POST /orders, PATCH draft (route ALSO requires `discipline_can_order`).
  "orders.draft": {
    resource: "order",
    action: "draft",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Signing — sign / request-signature (route ALSO requires `signer_eligible`).
  "orders.sign": {
    resource: "order",
    action: "sign",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Proxy sign — medical_director only (pure RBAC; reason captured at the route).
  "orders.sign_on_behalf": {
    resource: "order",
    action: "sign_on_behalf",
    category: "clinical",
    abac: "none",
  },
  // Verbal order recording — RN / Clinical Supervisor.
  "orders.verbal.record": {
    resource: "order_verbal",
    action: "record",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Cosignature attach (route ALSO requires `cosigner_role_match`).
  "orders.cosign": {
    resource: "order",
    action: "cosign",
    category: "clinical",
    abac: "cosigner_role_match",
  },
  // Discontinue an active / pending / verbal order.
  "orders.discontinue": {
    resource: "order",
    action: "discontinue",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Corrected order with replaces_order_id.
  "orders.amend": {
    resource: "order",
    action: "amend",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // F-203 (#248) — the lab-transmission recovery authority, split OUT of `orders.amend`. `orders.amend` (correct an
  // order) is granted to nearly every prescribing/nursing role; the actions below re-disclose a signed order to a lab,
  // attest to a fact about a third party, and can order a test TWICE, so they are a NARROW grant a tenant makes on
  // purpose (org_admin / administrator by default; a DON or clinical lead when the tenant chooses).
  // File / cancel a recovery, resend a refused order, co-sign a recovery, and read the lab contact's name + reference.
  "orders.transmission.recover": {
    resource: "order_transmission",
    action: "recover",
    category: "admin",
    abac: "none",
  },
  // Read the held-transmission worklist (patient ids + reasons) without being able to act on it.
  "orders.transmission.view_held": {
    resource: "order_transmission",
    action: "view_held",
    category: "admin",
    abac: "none",
  },
  // The HIGH-TRUST co-signer: once a requester or a requester/co-signer pair has reached the recovery bound
  // (default 3 executed `not_received_by_lab` recoveries in 24 h) the next co-signature must come from a holder of this
  // key (org_admin / administrator by default; a compliance officer when the tenant grants it). It also lets that
  // holder co-sign and read the evidence without holding `orders.transmission.recover`.
  "orders.transmission.cosign_escalated": {
    resource: "order_transmission",
    action: "cosign_escalated",
    category: "admin",
    abac: "none",
  },
  // Manual completion (incl. lab "Mark reviewed", D17).
  "orders.complete": {
    resource: "order",
    action: "complete",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Standing-order template CRUD.
  "orders.standing.manage": {
    resource: "standing_order",
    action: "manage",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // PRN manual spawn (worker spawn is system actor).
  "orders.standing.spawn": {
    resource: "standing_order",
    action: "spawn",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Org verbal-policy read / update (org_admin, compliance).
  "orders.policy.read": {
    resource: "order_policy",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "orders.policy.manage": {
    resource: "order_policy",
    action: "manage",
    category: "compliance",
    abac: "none",
  },
  // Platform-ops verbal-timer regeneration (audited as elevated access, §4.1).
  "orders.admin.regenerate_verbal_timer": {
    resource: "order_admin",
    action: "regenerate_verbal_timer",
    category: "platform",
    abac: "none",
  },
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
 * permission string used at `requirePermission(...)`. Sixteen keys total (§4.6; F-205, #248, added
 * `prescribing.report_error`; COP27 added `prescribing.coverage_determine`). Kept in a dedicated const
 * for §3.3 attributability.
 */
export const M12_CONTRIBUTED_PERMISSIONS = {
  // Read (caseload-scoped clinical reads) — every GET medication-order route.
  "prescribing.read": {
    resource: "medication_order",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Authoring — POST/PATCH draft (route ALSO requires `prescriber_eligible[:medClass]`).
  "prescribing.draft": {
    resource: "medication_order",
    action: "draft",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Standard sign (→ signed; route ALSO binds M12's `medication_signer_eligible` ABAC — GAP-035; `retransmit` reuses this key + the same ABAC).
  "prescribing.sign": {
    resource: "medication_order",
    action: "sign",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Controlled-substance EPCS sign (route ALSO requires `dea_schedule_authorized[:schedule]` + IAL2 + tenant EPCS).
  "prescribing.sign_controlled_substance": {
    resource: "medication_order",
    action: "sign_controlled",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Verbal medication-order recording — RN+ (D18: controlled is Phase-1-OFF).
  "prescribing.verbal.record": {
    resource: "medication_order",
    action: "verbal_record",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Cosignature attach (route ALSO requires M11 `cosigner_role_match`).
  "prescribing.cosign": {
    resource: "medication_order",
    action: "cosign",
    category: "clinical",
    abac: "cosigner_role_match",
  },
  // Discontinue / complete an active / pending / verbal medication order.
  "prescribing.discontinue": {
    resource: "medication_order",
    action: "discontinue",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // F-205 (#248) — file a clinician-initiated medication-error report against an order (`reportMedicationError`).
  "prescribing.report_error": {
    resource: "medication_order",
    action: "report_error",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // COP27 (42 CFR 418.24(c)) — set/change a medication order's hospice coverage determination (covered /
  // not covered + reason) that the M6 election-statement addendum lists. Clinical, caseload-scoped like the
  // other order writes.
  "prescribing.coverage_determine": {
    resource: "medication_order",
    action: "coverage_determine",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Refill-inbox decide (approve mints a new order; route ALSO requires M11 `signer_eligible`).
  "prescribing.refill_decide": {
    resource: "refill_request",
    action: "decide",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Per-tenant DoseSpot prescriber roster admin (org-scoped, step-up).
  "prescribing.admin.roster": {
    resource: "dosespot_prescriber",
    action: "admin",
    category: "compliance",
    abac: "none",
  },
  // Refill-inbox / controlled-substance policy admin (org-scoped, step-up, tighten-only).
  "prescribing.admin.policy": {
    resource: "prescribing_policy",
    action: "admin",
    category: "compliance",
    abac: "none",
  },
  // Platform + org EPCS certification gate (the D18 certification toggle, step-up).
  "prescribing.admin.epcs_certification": {
    resource: "epcs_certification",
    action: "admin",
    category: "platform",
    abac: "none",
  },
  // Medication-history read (caseload-scoped).
  "prescribing.history.read": {
    resource: "medication_history_record",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Medication-history reconcile (carry-forward mints a draft).
  "prescribing.history.reconcile": {
    resource: "medication_history_record",
    action: "reconcile",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // RxBenefit cached lookup (every prescriber + drafter).
  "prescribing.rx_benefit.lookup": {
    resource: "rx_benefit",
    action: "lookup",
    category: "clinical",
    abac: "caseload_or_scope",
  },
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
  "administration.read": {
    resource: "administration_record",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Record a clinician administration (route ALSO requires `administering_clinician_eligible[:medClass]`).
  "administration.record": {
    resource: "administration_record",
    action: "record",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Significant-late tier (24h-7d) — supervisor cosign queued (D8).
  "administration.record_significant_late": {
    resource: "administration_record",
    action: "record_significant_late",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Administrative-override tier (>7d) — step-up enforced at the route (D8).
  "administration.administrative_override": {
    resource: "administration_record",
    action: "administrative_override",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Record a refusal (patient declined; no medication given; route ALSO requires `administering_clinician_eligible`).
  "administration.record_refusal": {
    resource: "administration_record",
    action: "record_refusal",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Record an intentional hold of a scheduled dose before the grace window expires.
  "administration.record_missed": {
    resource: "scheduled_dose",
    action: "intentional_hold",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Mint a witness-attestation token (route ALSO requires `controlled_substance_witness_eligible`).
  "administration.witness_attest": {
    resource: "administration_witness",
    action: "attest",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Correction of a committed administration (creates a new row, supersedes original).
  "administration.correct": {
    resource: "administration_record",
    action: "correct",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Administrative hard-void (recorded in error) — step-up + supervisor floor are composed on the route
  // (GAP-041); this def's `abac` is declarative only (`requirePermission` never reads it).
  "administration.void": {
    resource: "administration_record",
    action: "void",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Caregiver-attested administration via M31 portal — the portal session token gates it (no caseload predicate).
  "administration.caregiver_record": {
    resource: "administration_record",
    action: "caregiver_record",
    category: "clinical",
    abac: "none",
  },
  // RN case manager acknowledges a caregiver-attested row (route ALSO requires `caregiver_attested_review_required`).
  "administration.caregiver_acknowledge": {
    resource: "administration_record",
    action: "caregiver_acknowledge",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // RN case manager disputes a caregiver-attested row (route ALSO requires `caregiver_attested_review_required`).
  "administration.caregiver_dispute": {
    resource: "administration_record",
    action: "caregiver_dispute",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Missed-dose read (caseload-scoped).
  "administration.read_missed": {
    resource: "missed_dose",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Case manager acknowledges a missed dose.
  "administration.acknowledge_missed": {
    resource: "missed_dose",
    action: "acknowledge",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // PRN minimum-interval override (supervisor / prescriber; reason captured).
  "administration.prn_interval_override": {
    resource: "administration_record",
    action: "prn_interval_override",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Reconciliation worksheet read (caseload-scoped).
  "reconciliation.read": {
    resource: "medication_reconciliation_worksheet",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Record/update a per-line decision (route ALSO requires `reconciliation_authoring_eligible`).
  "reconciliation.decide": {
    resource: "medication_reconciliation_decision",
    action: "create",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Finalize the worksheet (route ALSO requires `reconciliation_authoring_eligible`).
  "reconciliation.finalize": {
    resource: "medication_reconciliation_worksheet",
    action: "finalize",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Void a worksheet (e.g., re-triggered by a transfer-correction).
  "reconciliation.void": {
    resource: "medication_reconciliation_worksheet",
    action: "void",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Comfort-kit deployment read (caseload-scoped).
  "comfort_kit.read": {
    resource: "comfort_kit_deployment",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Manual comfort-kit return acknowledgment (Phase-1 fallback when M21 absent).
  "comfort_kit.acknowledge_return": {
    resource: "comfort_kit_deployment",
    action: "acknowledge_return",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  // Per-tenant administration policy admin (org-scoped, step-up).
  "administration.admin.policy": {
    resource: "administration_policy",
    action: "admin",
    category: "compliance",
    abac: "none",
  },
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
  "idg.read": {
    resource: "idg_meeting",
    action: "read",
    category: "clinical",
    abac: "idg_meeting_scope",
  },
  // Self check-in/check-out attendance (default `idg_meeting_scope`).
  "idg.attend": {
    resource: "idg_attendance",
    action: "check_in",
    category: "clinical",
    abac: "idg_meeting_scope",
  },
  // Build packets, manage agenda, run lifecycle transitions, manage action items as coordinator.
  "idg.coordinate": {
    resource: "idg_meeting",
    action: "coordinate",
    category: "clinical",
    abac: "idg_meeting_scope",
  },
  // Record / supersede decisions (route ALSO requires `quorate_decision`).
  "idg.decide": {
    resource: "idg_decision",
    action: "record",
    category: "clinical",
    abac: "idg_meeting_scope",
  },
  // Update assigned action items (self-scoped via the shared `is_assignee` predicate).
  "idg.act": {
    resource: "idg_action_item",
    action: "update",
    category: "clinical",
    abac: "is_assignee",
  },
  // Manage recurring policies, cancel/reschedule meetings (cancel/reschedule ALSO require `per_patient_review_floor_clear`).
  "idg.schedule": {
    resource: "idg_recurring_policy",
    action: "manage",
    category: "clinical",
    abac: "none",
  },
  // Override the per-patient 15-day review-floor guard on CANCEL/RESCHEDULE (audited + step-up; M14-F01 / ADR-0018 D2).
  "idg.override_review_floor": {
    resource: "idg_meeting",
    action: "override_review_floor",
    category: "compliance",
    abac: "none",
  },
  // Submit minutes amendments (tenant-admin / compliance scope).
  "idg.amend_minutes": {
    resource: "idg_minutes",
    action: "amend",
    category: "compliance",
    abac: "none",
  },
  // Internal system principal — packet build, action-item auto-close consumers, FHIR/render reads.
  "idg.system": {
    resource: "idg_patient_packet",
    action: "system_read",
    category: "admin",
    abac: "none",
  },
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
  "visit.read": {
    resource: "visit",
    action: "read",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.read_team": {
    resource: "visit",
    action: "read_team",
    category: "scheduling",
    abac: "none",
  },
  "visit.read_metrics": {
    resource: "visit",
    action: "read_metrics",
    category: "scheduling",
    abac: "none",
  },
  // --- visit lifecycle writes (assignment routes ALSO compose the four owned §4.7 pre-schedule predicates) ---
  "visit.create": {
    resource: "visit",
    action: "create",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.edit": {
    resource: "visit",
    action: "edit",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.start": {
    resource: "visit",
    action: "start",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.cancel": {
    resource: "visit",
    action: "cancel",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.reschedule": {
    resource: "visit",
    action: "reschedule",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.reassign": {
    resource: "visit",
    action: "reassign",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.mark_no_show": {
    resource: "visit",
    action: "mark_no_show",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  // --- visit proposals (scheduler inbox) ---
  "visit.proposal.read": {
    resource: "visit_proposal",
    action: "read",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "visit.proposal.dismiss": {
    resource: "visit_proposal",
    action: "dismiss",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  // --- recurring visit policies ---
  "recurring_visit.read": {
    resource: "recurring_visit",
    action: "read",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "recurring_visit.create": {
    resource: "recurring_visit",
    action: "create",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  "recurring_visit.discontinue": {
    resource: "recurring_visit",
    action: "discontinue",
    category: "scheduling",
    abac: "caseload_or_scope",
  },
  // --- clinician availability (membership-scoped; own-vs-any) ---
  "availability.read": {
    resource: "availability",
    action: "read",
    category: "scheduling",
    abac: "none",
  },
  "availability.edit_own": {
    resource: "availability",
    action: "edit_own",
    category: "scheduling",
    abac: "none",
  },
  "availability.edit_any": {
    resource: "availability",
    action: "edit_any",
    category: "scheduling",
    abac: "none",
  },
  // --- time off (PTO) ---
  "time_off.read_own": {
    resource: "time_off",
    action: "read_own",
    category: "scheduling",
    abac: "none",
  },
  "time_off.read_team": {
    resource: "time_off",
    action: "read_team",
    category: "scheduling",
    abac: "none",
  },
  "time_off.request_own": {
    resource: "time_off",
    action: "request_own",
    category: "scheduling",
    abac: "none",
  },
  "time_off.approve": {
    resource: "time_off",
    action: "approve",
    category: "scheduling",
    abac: "none",
  },
  "time_off.cancel_own": {
    resource: "time_off",
    action: "cancel_own",
    category: "scheduling",
    abac: "none",
  },
  // --- route optimisation (behind scheduling.route_optimization, OFF) + efficiency metrics ---
  "route.optimize_on_demand": {
    resource: "route",
    action: "optimize_on_demand",
    category: "scheduling",
    abac: "none",
  },
  "route.read_metrics": {
    resource: "route",
    action: "read_metrics",
    category: "scheduling",
    abac: "none",
  },
  // --- portal session class — upcoming visits, lay-language, scrubbed (per-patient via M39 consent) ---
  "portal.visit.read_upcoming": {
    resource: "portal_visit",
    action: "read_upcoming",
    category: "scheduling",
    abac: "none",
  },
  // --- GAP-093 — clinical-license/certification roster (§1.1 D8); org-wide staff management, not
  // caseload-scoped, so `abac: "none"` matches the sibling `time_off.approve` shape. ---
  "membership_credential.read": {
    resource: "membership_credential",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "membership_credential.grant": {
    resource: "membership_credential",
    action: "grant",
    category: "compliance",
    abac: "none",
  },
  "membership_credential.revoke": {
    resource: "membership_credential",
    action: "revoke",
    category: "compliance",
    abac: "none",
  },

  // --- GAP-029 — the on-call rotation M19's roster-sync reads through `tonightsOnCallRoster`. Org-wide
  // staff scheduling (who covers which night), not caseload-scoped: plain RBAC, the `time_off.approve` shape. ---
  "oncall_rotation.read": {
    resource: "oncall_rotation",
    action: "read",
    category: "scheduling",
    abac: "none",
  },
  "oncall_rotation.manage": {
    resource: "oncall_rotation",
    action: "manage",
    category: "scheduling",
    abac: "none",
  },

  // --- ADR-0023 D2 / SecHardening §12.4 — the device-attestation surface (M2). ---
  //
  // No `.attest` key: a clinician attesting the phone in their own hand is not an administrative act,
  // and gating it on a permission would mean an org had to grant every field user a security-management
  // key just to sign in from a device. The attest route is bound to the CALLER'S OWN membership by the
  // session, which is the narrower control — you can only ever enrol a device for yourself.
  "device_attestation.read": {
    resource: "device_attestation",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  // Revoking IS administrative: it is how a lost or compromised handset is taken out of service, and it
  // acts on someone else's device. Org-wide staff management, the `membership_credential.revoke` shape.
  "device_attestation.revoke": {
    resource: "device_attestation",
    action: "revoke",
    category: "compliance",
    abac: "none",
  },
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
  "evv.check_in": {
    resource: "evv_event",
    action: "check_in",
    category: "evv",
    abac: "caseload_or_scope",
  },
  "evv.check_out": {
    resource: "evv_event",
    action: "check_out",
    category: "evv",
    abac: "caseload_or_scope",
  },
  // --- EVV event reads (coords is a SEPARATE key for audit-prominence, D10) ---
  "evv.read": { resource: "evv_event", action: "read", category: "evv", abac: "caseload_or_scope" },
  "evv.read_coords": {
    resource: "evv_event",
    action: "read_coords",
    category: "evv",
    abac: "caseload_or_scope",
  },
  "evv.read_metrics": { resource: "evv_metrics", action: "read", category: "evv", abac: "none" },
  // --- correction-of-record (Clinical Supervisor+, step-up at the route) ---
  "evv.correct_record": {
    resource: "evv_event",
    action: "correct_record",
    category: "evv",
    abac: "caseload_or_scope",
  },
  // --- device registration lifecycle (membership-scoped; the route scopes own-vs-team) ---
  "evv.device.register_self": {
    resource: "evv_device",
    action: "register_self",
    category: "evv",
    abac: "none",
  },
  "evv.device.read": { resource: "evv_device", action: "read", category: "evv", abac: "none" },
  "evv.device.approve": {
    resource: "evv_device",
    action: "approve",
    category: "evv",
    abac: "none",
  },
  "evv.device.suspend": {
    resource: "evv_device",
    action: "suspend",
    category: "evv",
    abac: "none",
  },
  "evv.device.retire": { resource: "evv_device", action: "retire", category: "evv", abac: "none" },
  // --- geofence policy (tenant tighten-only + per-address override; Clin Supv / DON / Compliance) ---
  "evv.policy.read": {
    resource: "evv_geofence_policy",
    action: "read",
    category: "evv",
    abac: "none",
  },
  "evv.policy.edit": {
    resource: "evv_geofence_policy",
    action: "edit",
    category: "evv",
    abac: "none",
  },
  // --- missing-EVV resolution (attest_self route ALSO composes `assigned_clinician_for_visit`) ---
  "evv.missing_resolution.read": {
    resource: "evv_missing_resolution",
    action: "read",
    category: "evv",
    abac: "caseload_or_scope",
  },
  "evv.missing_resolution.attest_self": {
    resource: "evv_missing_resolution",
    action: "attest_self",
    category: "evv",
    abac: "caseload_or_scope",
  },
  "evv.missing_resolution.supervisor_override": {
    resource: "evv_missing_resolution",
    action: "supervisor_override",
    category: "evv",
    abac: "none",
  },
  // --- per-state aggregator submission queue (billing-ops; org-wide) ---
  "evv.aggregator.read": {
    resource: "evv_aggregator_submission",
    action: "read",
    category: "evv",
    abac: "none",
  },
  "evv.aggregator.resubmit": {
    resource: "evv_aggregator_submission",
    action: "resubmit",
    category: "evv",
    abac: "none",
  },
  "evv.aggregator.cancel": {
    resource: "evv_aggregator_submission",
    action: "cancel",
    category: "evv",
    abac: "none",
  },
  // --- M20 field-safety supervisor live-awareness (org-wide team-location read; audit-prominent) ---
  "evv.location.read_team": {
    resource: "evv_location",
    action: "read_team",
    category: "evv",
    abac: "none",
  },
  // --- M31 portal arrival surface (portal session class; per-patient via M39 consent, not caseload) ---
  "portal.evv.read_arrival": {
    resource: "portal_evv",
    action: "read_arrival",
    category: "evv",
    abac: "none",
  },
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
  "documents.upload": {
    resource: "document",
    action: "upload",
    category: "clinical",
    abac: "caseload_membership",
  },
  "documents.read": {
    resource: "document",
    action: "read",
    category: "clinical",
    abac: "document_owner_or_caseload",
  },
  // F-023 (#592) — view-only: lets a role that lists the whole org's documents keep doing so. `documents.read`
  // alone now lists the actor's caseload. Metadata only; content stays behind `documents.read_phi_content`.
  "documents.read_org_wide": {
    resource: "document",
    action: "read_org_wide",
    category: "clinical",
    abac: "none",
  },
  "documents.read_history": {
    resource: "document",
    action: "read_history",
    category: "clinical",
    abac: "document_owner_or_caseload",
  },
  "documents.read_access_log": {
    resource: "document",
    action: "read_access_log",
    category: "compliance",
    abac: "none",
  },
  "documents.read_phi_content": {
    resource: "document",
    action: "read_phi_content",
    category: "clinical",
    abac: "document_owner_or_caseload",
  },
  "documents.edit_metadata": {
    resource: "document",
    action: "edit_metadata",
    category: "clinical",
    abac: "legal_hold_aware",
  },
  "documents.attach_to_disclosures": {
    resource: "document",
    action: "attach_to_disclosures",
    category: "compliance",
    abac: "none",
  },
  "documents.export_phi_bundle": {
    resource: "document",
    action: "export_phi_bundle",
    category: "compliance",
    abac: "document_owner_or_caseload",
  },
  "documents.delete": {
    resource: "document",
    action: "delete",
    category: "compliance",
    abac: "legal_hold_aware",
  },
  "documents.read_templates": {
    resource: "form_template",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "documents.preview_template": {
    resource: "form_template",
    action: "preview",
    category: "platform",
    abac: "none",
  },
  "documents.publish_template": {
    resource: "form_template",
    action: "publish",
    category: "platform",
    abac: "form_template_publish_authority",
  },
  "documents.manage_overlay": {
    resource: "tenant_template_overlay",
    action: "manage",
    category: "admin",
    abac: "tenant_template_overlay_edit_authority",
  },
  "documents.admin_read_fills": {
    resource: "form_fill",
    action: "admin_read",
    category: "platform",
    abac: "none",
  },
  "documents.admin_retry_render": {
    resource: "form_fill",
    action: "admin_retry_render",
    category: "platform",
    abac: "none",
  },
  // --- intake (§4.6) ---
  "intake.upload": {
    resource: "intake_batch",
    action: "upload",
    category: "clinical",
    abac: "none",
  },
  "intake.read": { resource: "intake_batch", action: "read", category: "clinical", abac: "none" },
  "intake.reclassify": {
    resource: "intake_batch",
    action: "reclassify",
    category: "clinical",
    abac: "none",
  },
  "intake.confirm_classification": {
    resource: "intake_batch",
    action: "confirm_classification",
    category: "clinical",
    abac: "none",
  },
  "intake.split_batch": {
    resource: "intake_batch",
    action: "split_batch",
    category: "clinical",
    abac: "none",
  },
  "intake.review": {
    resource: "extraction_review",
    action: "review",
    category: "clinical",
    abac: "extraction_reviewer_eligible",
  },
  "intake.discard_batch": {
    resource: "intake_batch",
    action: "discard_batch",
    category: "clinical",
    abac: "none",
  },
  // --- extraction provenance (§4.6) ---
  "extraction.read_provenance": {
    resource: "extraction_provenance",
    action: "read",
    category: "compliance",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M22 contributed permission keys. */
export type M22ContributedPermissionKey = keyof typeof M22_CONTRIBUTED_PERMISSIONS;

/**
 * The forty-one permission keys Module 34 (SaaS Tenant Platform) registers into Module 3's catalog —
 * the §4.5 binding cross-module handshake (M34 spec §4.5 / D7). M3 must include these before M34's
 * platform-control-plane routes (tenant lifecycle, onboarding, invitations, support sessions, DSAR +
 * tenant export, feature flags, BAA register, signup intents) can be authorized; those routes
 * (apps/backend/src/modules/34-saas-tenant-platform/routes/*) gate on them.
 *
 * This map is the AUTHORITATIVE copy the boot path projects mirror rows from (an identical const lives
 * in apps/backend/.../permission-keys.ts as the M34-owned source of truth, kept byte-for-byte in sync —
 * the package may not import the app, so the keys are RE-DECLARED here the way M22's are). The catalog
 * `abac` field is the DEFAULT predicate per key (§4.1 Auth column); the route layer additionally composes
 * the explicit §4.6 chain M34 owns (e.g. `tenant_lifecycle_platform_ops` on the platform-ops surface,
 * `feature_flag_write_authority` on flag writes). PLATFORM-OPS NOTE (M34-F03): `platform_ops` is an M3
 * RBAC ROLE on a staff session, NOT a session class — the platform-surface keys default to the
 * `tenant_lifecycle_platform_ops` predicate, which tests the role. Kept in a dedicated const so each
 * module's contribution stays attributable (§3.3 ownership).
 */
export const M34_CONTRIBUTED_PERMISSIONS = {
  // --- tenant lifecycle: platform-ops surface (§4.5) ---
  "tenant.list_platform": {
    resource: "tenant_account",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.read_platform": {
    resource: "tenant_account",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.provision": {
    resource: "tenant_account",
    action: "provision",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.transition_status": {
    resource: "tenant_account",
    action: "transition_status",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.offboard": {
    resource: "tenant_account",
    action: "offboard",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.shred.execute": {
    resource: "tenant_key_ring",
    action: "shred_execute",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant.dek_rotate": {
    resource: "tenant_key_ring",
    action: "dek_rotate",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- tenant lifecycle: tenant surface (§4.5) ---
  "tenant.read_own": {
    resource: "tenant_account",
    action: "read_own",
    category: "admin",
    abac: "none",
  },
  // --- onboarding (§4.5) ---
  "onboarding.read_platform": {
    resource: "onboarding_task",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "onboarding.read_own": {
    resource: "onboarding_task",
    action: "read_own",
    category: "admin",
    abac: "none",
  },
  "onboarding.update": {
    resource: "onboarding_task",
    action: "update",
    category: "admin",
    abac: "onboarding_task_assignee_or_owner",
  },
  "onboarding.skip": {
    resource: "onboarding_task",
    action: "skip",
    category: "admin",
    abac: "onboarding_task_assignee_or_owner",
  },
  "onboarding_template.list": {
    resource: "onboarding_task_template",
    action: "list",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "onboarding_template.write": {
    resource: "onboarding_task_template",
    action: "write",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- invitations (§4.5) ---
  "tenant_invitation.list_platform": {
    resource: "tenant_invitation",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant_invitation.issue": {
    resource: "tenant_invitation",
    action: "issue",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant_invitation.revoke": {
    resource: "tenant_invitation",
    action: "revoke",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- support sessions (tenant-consented break-glass) (§4.5) ---
  "support_session.list_platform": {
    resource: "support_session",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "support_session.start": {
    resource: "support_session",
    action: "start",
    category: "platform",
    abac: "support_session_actor_distinct_from_grantor",
  },
  "support_session.elevate_phi_read": {
    resource: "support_session",
    action: "elevate_phi_read",
    category: "platform",
    abac: "tenant_consented_support_active",
  },
  "support_session.close": {
    resource: "support_session",
    action: "close",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "support_consent_grant.list_own": {
    resource: "support_consent_grant",
    action: "list_own",
    category: "admin",
    abac: "none",
  },
  "support_consent_grant.issue": {
    resource: "support_consent_grant",
    action: "issue",
    category: "admin",
    abac: "none",
  },
  "support_consent_grant.revoke": {
    resource: "support_consent_grant",
    action: "revoke",
    category: "admin",
    abac: "none",
  },
  // --- DSAR export (§4.5) ---
  "dsar_export.list_platform": {
    resource: "dsar_export_job",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "dsar_export.list_own": {
    resource: "dsar_export_job",
    action: "list_own",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.request": {
    resource: "dsar_export_job",
    action: "request",
    category: "compliance",
    abac: "dsar_export_patient_caseload_or_org_admin",
  },
  "dsar_export.fulfill": {
    resource: "dsar_export_job",
    action: "fulfill",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.extend": {
    resource: "dsar_export_job",
    action: "extend",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.deny": {
    resource: "dsar_export_job",
    action: "deny",
    category: "compliance",
    abac: "none",
  },
  "dsar_export.download": {
    resource: "dsar_export_job",
    action: "download",
    category: "compliance",
    abac: "dsar_export_patient_caseload_or_org_admin",
  },
  // --- tenant export (§4.5) ---
  "tenant_export.list_platform": {
    resource: "tenant_export_job",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "tenant_export.list_own": {
    resource: "tenant_export_job",
    action: "list_own",
    category: "admin",
    abac: "none",
  },
  "tenant_export.request": {
    resource: "tenant_export_job",
    action: "request",
    category: "admin",
    abac: "tenant_export_org_admin_or_platform_ops",
  },
  "tenant_export.download": {
    resource: "tenant_export_job",
    action: "download",
    category: "admin",
    abac: "tenant_export_org_admin_or_platform_ops",
  },
  // GAP-097: the SEC-052 second-actor release for an oversized-hold bundle (typebox.ts's
  // `ApproveOversizedExportRequest`, documented since M34-T-phase but never registered as a route).
  "tenant_export.approve_oversized": {
    resource: "tenant_export_job",
    action: "approve_oversized",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  // --- feature flags: admin surface (§4.5) ---
  "feature_flag.read_platform": {
    resource: "feature_flag",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "feature_flag.read_own": {
    resource: "feature_flag",
    action: "read_own",
    category: "admin",
    abac: "none",
  },
  "feature_flag.write_platform": {
    resource: "feature_flag",
    action: "write_platform",
    category: "platform",
    abac: "feature_flag_write_authority",
  },
  "feature_flag.write_tenant": {
    resource: "feature_flag",
    action: "write_tenant",
    category: "admin",
    abac: "feature_flag_write_authority",
  },
  "feature_flag.kill_switch": {
    resource: "feature_flag",
    action: "kill_switch",
    category: "platform",
    abac: "feature_flag_write_authority",
  },
  // --- platform-tenant BAA register (§4.5) ---
  "platform_tenant_baa.read_platform": {
    resource: "platform_tenant_baa_record",
    action: "read_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "platform_tenant_baa.read_own": {
    resource: "platform_tenant_baa_record",
    action: "read_own",
    category: "compliance",
    abac: "none",
  },
  "platform_tenant_baa.attest": {
    resource: "platform_tenant_baa_record",
    action: "attest",
    category: "compliance",
    abac: "tenant_platform_baa_compliance_officer",
  },
  // --- signup intents (§4.5) ---
  "signup_intent.list_platform": {
    resource: "tenant_signup_intent",
    action: "list_platform",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
  "signup_intent.qualify": {
    resource: "tenant_signup_intent",
    action: "qualify",
    category: "platform",
    abac: "tenant_lifecycle_platform_ops",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M34 contributed permission keys (forty-one). */
export type M34ContributedPermissionKey = keyof typeof M34_CONTRIBUTED_PERMISSIONS;

/**
 * Module 33 (Reporting & Dashboards) contributed permission keys (M33 §4.6) — the THIRTY-THREE keys
 * M33 owns + registers into M3's catalog. Categories: `reporting` (1–28) + `reporting_admin` (29–33).
 * Mirror of the M33-owned source of truth (apps/backend/src/modules/33-reporting/permission-keys.ts).
 * Defaults: read tiles/dashboards/exports/drilldowns gate on the §4.7 `reportable_scope` envelope (D8);
 * saved-view read/edit/share gate on `dashboard_visibility`; the rest are pure-RBAC (`none`).
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
 * Module 23 (Billing — Medicare) contributed permission keys (M23 §4.6) — the TWENTY-EIGHT keys
 * M23 owns + registers into M3's catalog. All group under the single `billing` category (§4.6).
 * Mirror of the M23-owned source of truth (apps/backend/src/modules/23-billing-medicare/permission-keys.ts),
 * which the Integrate phase asserts equal to `@chartwarden/billing`'s eventual `M23_PERMISSIONS` tuple.
 * Defaults: the `abac` per key is the dominant §4.7 predicate (the route composes it after the M3-base
 * `inOrg` / `caseload_or_scope`): claim reads/writes gate `claim_in_billing_manager_caseload`; assemble +
 * NOE/NOTR + sequestration + MAC-credential gate `provider_entity_billing_scope`; validation override gates
 * `override_role_eligible`; rule-config edit gates `regulatory_required_rule_protected`; the dashboard /
 * metrics / override-audit / rule-config reads are org-wide rollups (`inOrg`); eligibility is
 * `caseload_or_scope`; the platform-only `rule_config.platform_admin` is `none` (route-layer platform guard).
 * Step-up on submit/replace/void/credential-admin (§6) is enforced at the route layer (M2 SESSION_POLICY).
 */
export const M23_CONTRIBUTED_PERMISSIONS = {
  // --- claim surface (§6) ---
  "billing.claim.assemble": {
    resource: "billing_claim",
    action: "assemble",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.claim.read": {
    resource: "billing_claim",
    action: "read",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.update_draft": {
    resource: "billing_claim",
    action: "update_draft",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.delete_draft": {
    resource: "billing_claim",
    action: "delete_draft",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.submit": {
    resource: "billing_claim",
    action: "submit",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.replace": {
    resource: "billing_claim",
    action: "replace",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.void": {
    resource: "billing_claim",
    action: "void",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.claim.read_ar_dashboard": {
    resource: "billing_claim",
    action: "read_ar_dashboard",
    category: "billing",
    abac: "inOrg",
  },
  "billing.claim.read_metrics": {
    resource: "billing_claim",
    action: "read_metrics",
    category: "billing",
    abac: "inOrg",
  },
  // --- NOE surface ---
  "billing.noe.read": {
    resource: "billing_noe",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.noe.submit": {
    resource: "billing_noe",
    action: "submit",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.noe.cancel": {
    resource: "billing_noe",
    action: "cancel",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- NOTR surface ---
  "billing.notr.read": {
    resource: "billing_notr",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.notr.submit": {
    resource: "billing_notr",
    action: "submit",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.notr.cancel": {
    resource: "billing_notr",
    action: "cancel",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- validation surface ---
  "billing.validation.read_run": {
    resource: "billing_validation",
    action: "read_run",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.validation.run": {
    resource: "billing_validation",
    action: "run",
    category: "billing",
    abac: "claim_in_billing_manager_caseload",
  },
  "billing.validation.override": {
    resource: "billing_validation",
    action: "override",
    category: "billing",
    abac: "override_role_eligible",
  },
  "billing.validation.read_override": {
    resource: "billing_validation",
    action: "read_override",
    category: "billing",
    abac: "inOrg",
  },
  // --- rule-config surface ---
  "billing.rule_config.read": {
    resource: "billing_rule_config",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "billing.rule_config.edit": {
    resource: "billing_rule_config",
    action: "edit",
    category: "billing",
    abac: "regulatory_required_rule_protected",
  },
  "billing.rule_config.platform_admin": {
    resource: "billing_rule_config",
    action: "platform_admin",
    category: "billing",
    abac: "none",
  },
  // --- eligibility surface ---
  "billing.eligibility.check": {
    resource: "billing_eligibility",
    action: "check",
    category: "billing",
    abac: "caseload_or_scope",
  },
  "billing.eligibility.read": {
    resource: "billing_eligibility",
    action: "read",
    category: "billing",
    abac: "caseload_or_scope",
  },
  // --- sequestration-policy surface ---
  "billing.sequestration_policy.read": {
    resource: "billing_sequestration_policy",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.sequestration_policy.edit": {
    resource: "billing_sequestration_policy",
    action: "edit",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- MAC credential surface ---
  "billing.mac_credential.read": {
    resource: "billing_mac_credential",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.mac_credential.admin": {
    resource: "billing_mac_credential",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- hospice rate-table surface (F-210: tenant-entered CMS per-diem rates) ---
  "billing.rate_table.read": {
    resource: "billing_rate_table",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.rate_table.admin": {
    resource: "billing_rate_table",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- tenant-entered hospice visit-charge schedule (charge per 15-minute unit per discipline) ---
  "billing.visit_charge.read": {
    resource: "billing_visit_charge",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.visit_charge.admin": {
    resource: "billing_visit_charge",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  // --- tenant-entered wage index (F-211) ---
  "billing.wage_index.read": {
    resource: "billing_wage_index",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "billing.wage_index.admin": {
    resource: "billing_wage_index",
    action: "admin",
    category: "billing",
    abac: "inOrg",
  },
  "billing.dde.read": {
    resource: "billing_dde",
    action: "read",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.dde.work": {
    resource: "billing_dde",
    action: "work",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.dde.mark_submitted": {
    resource: "billing_dde",
    action: "mark_submitted",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.dde.admin": {
    resource: "billing_dde",
    action: "admin",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
  "billing.clearinghouse.resolve_attempt": {
    resource: "billing_clearinghouse_attempt",
    action: "resolve",
    category: "billing",
    abac: "provider_entity_billing_scope",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M23 contributed permission keys (twenty-eight + the two F-210 rate-table keys). */
export type M23ContributedPermissionKey = keyof typeof M23_CONTRIBUTED_PERMISSIONS;

/**
 * The twenty-three permission keys Module 25 (Remittance & Denials) registers into M3's catalog (§4.6).
 * Grouped under the `billing` category (the revenue-cycle surface, alongside M23). The `abac` default is
 * the dominant §4.7 predicate per key; M25 owns `claim_assigned_to_actor` + `appeal_within_deadline` (the
 * two new predicates, registered at boot) and reuses `provider_entity_scope` / `caseload_or_scope` /
 * `inOrg`. The step-up requirement on adjustment-override / appeal-submit / close-with-write-off (D15) is
 * enforced at the route layer (M2 SESSION_POLICY), not in the catalog `abac` field. The `*_internal` seam
 * keys are reached only by the `m25.system_principal` (architecture §17), not the user-facing gateway.
 */
export const M25_CONTRIBUTED_PERMISSIONS = {
  // --- remittance surface ---
  "remittance.read": {
    resource: "remittance_advice",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "remittance.replay": {
    resource: "remittance_advice",
    action: "replay",
    category: "billing",
    abac: "none",
  },
  "remittance.manual_match": {
    resource: "remittance_line",
    action: "manual_match",
    category: "billing",
    abac: "claim_assigned_to_actor",
  },
  "remittance.adjustment.override": {
    resource: "remittance_adjustment",
    action: "override",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "remittance.read_internal": {
    resource: "remittance_advice",
    action: "read_internal",
    category: "billing",
    abac: "none",
  },
  "remittance.ingest_internal": {
    resource: "remittance_advice",
    action: "ingest_internal",
    category: "billing",
    abac: "none",
  },
  // --- denial worklist surface ---
  "denial.worklist.read": {
    resource: "denial_case",
    action: "worklist_read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial.read": {
    resource: "denial_case",
    action: "read",
    category: "billing",
    abac: "claim_assigned_to_actor",
  },
  "denial.assign": {
    resource: "denial_case",
    action: "assign",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial.escalate": {
    resource: "denial_case",
    action: "escalate",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial.resolve": {
    resource: "denial_case",
    action: "resolve",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial.close_with_write_off": {
    resource: "denial_case",
    action: "close_with_write_off",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial.reopen": {
    resource: "denial_case",
    action: "reopen",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial.read_internal": {
    resource: "denial_case",
    action: "read_internal",
    category: "billing",
    abac: "none",
  },
  // --- appeal surface ---
  "appeal.read": {
    resource: "appeal_case",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "appeal.create": {
    resource: "appeal_case",
    action: "create",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "appeal.attach_document": {
    resource: "appeal_case",
    action: "attach_document",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "appeal.submit": {
    resource: "appeal_case",
    action: "submit",
    category: "billing",
    abac: "appeal_within_deadline",
  },
  "appeal.decide": {
    resource: "appeal_case",
    action: "decide",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "appeal.withdraw": {
    resource: "appeal_case",
    action: "withdraw",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // --- ADR surface (hospice ADR/TPE/QIC PRD milestone 2a; granted by migration 1108) ---
  "adr.read": {
    resource: "adr_case",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "adr.manage": {
    resource: "adr_case",
    action: "manage",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Milestone 2b (migration 1110): sign off a packet / record the filing (the filing is also step-up gated).
  "adr.review": {
    resource: "adr_case",
    action: "review",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "adr.submit": {
    resource: "adr_case",
    action: "submit",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Milestone 8a-1 (migrations 1190/1191): ADVISORY documentation readiness. None of these gates sign-off or filing.
  "adr.readiness_read": {
    resource: "adr_readiness",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "adr.readiness_request": {
    resource: "adr_readiness",
    action: "request",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "adr.readiness_dispose": {
    resource: "adr_readiness",
    action: "dispose",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Milestone 9a-1 (migrations 1250/1251): the denial-reason PLAYBOOK library. Guidance only: none of these gates a case.
  // Publishing needs a person other than the author. The per-case step tick needs denial.read + playbook.read.
  "playbook.read": {
    resource: "denial_playbook",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "playbook.author": {
    resource: "denial_playbook",
    action: "author",
    category: "billing",
    abac: "none",
  },
  "playbook.publish": {
    resource: "denial_playbook",
    action: "publish",
    category: "billing",
    abac: "none",
  },
  // Ticking a step is working the denial (advisory, gates nothing), so it is a write-level key of its own.
  "playbook.step.mark": {
    resource: "denial_playbook",
    action: "step_mark",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "mac_rule.manage": {
    resource: "mac_rule",
    action: "manage",
    category: "billing",
    abac: "none",
  },
  // --- non-response routing and MAC reopenings (milestone 3; granted by migration 1113) ---
  "reopening.read": {
    resource: "reopening_case",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "reopening.manage": {
    resource: "reopening_case",
    action: "manage",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Record the filing (also step-up gated).
  "reopening.submit": {
    resource: "reopening_case",
    action: "submit",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Appeal a denial the rules route to a reopening, with a recorded reason.
  "denial.route_override": {
    resource: "denial_case",
    action: "route_override",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "denial_route.manage": {
    resource: "denial_route_rule",
    action: "manage",
    category: "billing",
    abac: "none",
  },
  // --- TPE program tracker (milestone 5; granted by migration 1119) ---
  "tpe.read": {
    resource: "tpe_program",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "tpe.manage": {
    resource: "tpe_program",
    action: "manage",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Edit the organization's per-MAC TPE exit thresholds (no threshold is seeded).
  "tpe_rule.manage": {
    resource: "tpe_mac_rule",
    action: "manage",
    category: "billing",
    abac: "none",
  },
  // --- audit requests and later-tier record-keeping (milestone 7a-1; granted by migration 1173) ---
  // `audit_request.*`, not `audit.*`: the plain audit keys are the platform compliance audit trail.
  "audit_request.read": {
    resource: "audit_request",
    action: "read",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "audit_request.manage": {
    resource: "audit_request",
    action: "manage",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Milestone 7a-2 (migration 1175; granted by 1176): sign off an audit response packet (a person other than whoever
  // sent it to review) / record the filing (also step-up gated).
  "audit_request.review": {
    resource: "audit_request",
    action: "review",
    category: "billing",
    abac: "provider_entity_scope",
  },
  "audit_request.submit": {
    resource: "audit_request",
    action: "submit",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // Record the ALJ / Council / federal-court facts and the deadlines typed from a notice.
  "appeal.tier_record": {
    resource: "appeal_case",
    action: "tier_record",
    category: "billing",
    abac: "provider_entity_scope",
  },
  // --- taxonomy surface ---
  "taxonomy.read": {
    resource: "denial_taxonomy",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "taxonomy.edit": {
    resource: "denial_taxonomy",
    action: "edit",
    category: "billing",
    abac: "inOrg",
  },
  // --- patient-responsibility internal seam ---
  "pr.read_internal": {
    resource: "patient_responsibility_ledger",
    action: "read_internal",
    category: "billing",
    abac: "none",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M25 contributed permission keys (twenty-three). */
export type M25ContributedPermissionKey = keyof typeof M25_CONTRIBUTED_PERMISSIONS;

// M26 — Module 26's fourteen Cap Management permission keys registered into M3's catalog (§4.6). The
// route-level §4.7 ABAC predicates (cap_period_open / cap_period_in_settlement / cap_period_settled /
// cap_period_methodology_unlocked / cap_platform_admin) are composed at the route layer; the per-key
// `abac` here is the DEFAULT only ('none' — RBAC-gated; per-patient reads additionally compose
// caseload_or_scope at the route). category 'billing' (cap is a revenue-cycle surface).
export const M26_CONTRIBUTED_PERMISSIONS = {
  "cap.period.read": { resource: "cap_period", action: "read", category: "billing", abac: "none" },
  "cap.period.manage": {
    resource: "cap_period",
    action: "manage",
    category: "billing",
    abac: "none",
  },
  "cap.projection.read": {
    resource: "cap_projection_snapshot",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "cap.projection.recompute": {
    resource: "cap_projection_snapshot",
    action: "recompute",
    category: "billing",
    abac: "none",
  },
  "cap.accrual.read": {
    resource: "cap_beneficiary_accrual",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "cap.event.read": {
    resource: "cap_threshold_event",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "cap.event.acknowledge": {
    resource: "cap_threshold_event",
    action: "acknowledge",
    category: "billing",
    abac: "none",
  },
  "cap.psr.import": {
    resource: "cap_psr_import",
    action: "import",
    category: "billing",
    abac: "none",
  },
  "cap.psr.read": { resource: "cap_psr_import", action: "read", category: "billing", abac: "none" },
  "cap.psr.reconcile": {
    resource: "cap_psr_reconciliation",
    action: "reconcile",
    category: "billing",
    abac: "none",
  },
  "cap.settlement.read": {
    resource: "cap_settlement",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "cap.settlement.manage": {
    resource: "cap_settlement",
    action: "manage",
    category: "billing",
    abac: "none",
  },
  "cap.platform_constant.read": {
    resource: "cap_period_platform_constant",
    action: "read",
    category: "platform",
    abac: "none",
  },
  "cap.platform_constant.manage": {
    resource: "cap_period_platform_constant",
    action: "manage",
    category: "platform",
    abac: "none",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M26 contributed permission keys (fourteen). */
export type M26ContributedPermissionKey = keyof typeof M26_CONTRIBUTED_PERMISSIONS;

// M27 — Module 27's fifteen Cost Report permission keys registered into M3's catalog (§4.6). The route-level
// §4.7 ABAC predicates (cost_report_editor_for_provider / cost_report_approver_for_provider /
// cost_report_period_active, + provider_entity_scope reused from M40) are composed at the route layer; the
// per-key `abac` here is the DEFAULT only ('none' — RBAC-gated; the route additionally composes the
// per-ProviderEntity scope). category 'billing' (the cost report is a revenue-cycle surface).
export const M27_CONTRIBUTED_PERMISSIONS = {
  "cost_report.create": {
    resource: "cost_report",
    action: "create",
    category: "billing",
    abac: "none",
  },
  "cost_report.read": {
    resource: "cost_report",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "cost_report.read_snapshot_detail": {
    resource: "cost_report",
    action: "read_snapshot_detail",
    category: "billing",
    abac: "none",
  },
  "cost_report.read_rules": {
    resource: "cost_report",
    action: "read_rules",
    category: "billing",
    abac: "none",
  },
  "cost_report.edit": {
    resource: "cost_report",
    action: "edit",
    category: "billing",
    abac: "none",
  },
  "cost_report.edit_mappings": {
    resource: "cost_report",
    action: "edit_mappings",
    category: "billing",
    abac: "none",
  },
  "cost_report.edit_bad_debt": {
    resource: "cost_report",
    action: "edit_bad_debt",
    category: "billing",
    abac: "none",
  },
  "cost_report.edit_any_provider": {
    resource: "cost_report",
    action: "edit_any_provider",
    category: "billing",
    abac: "none",
  },
  "cost_report.override_validation": {
    resource: "cost_report",
    action: "override_validation",
    category: "billing",
    abac: "none",
  },
  "cost_report.approve_for_submit": {
    resource: "cost_report",
    action: "approve_for_submit",
    category: "billing",
    abac: "none",
  },
  "cost_report.submit": {
    resource: "cost_report",
    action: "submit",
    category: "billing",
    abac: "none",
  },
  "cost_report.submit_past_deadline": {
    resource: "cost_report",
    action: "submit_past_deadline",
    category: "billing",
    abac: "none",
  },
  "cost_report.record_acknowledgment": {
    resource: "cost_report",
    action: "record_acknowledgment",
    category: "billing",
    abac: "none",
  },
  "cost_report.reopen_submitted": {
    resource: "cost_report",
    action: "reopen_submitted",
    category: "billing",
    abac: "none",
  },
  "cost_report.manage_rules": {
    resource: "cost_report",
    action: "manage_rules",
    category: "billing",
    abac: "none",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M27 contributed permission keys (fifteen). */
export type M27ContributedPermissionKey = keyof typeof M27_CONTRIBUTED_PERMISSIONS;

// M24 — Module 24's twenty-six Billing — Medicaid permission keys registered into M3's catalog (§4.7). The
// route-level §4.8 ABAC predicates (provider_entity_medicaid_billing_scope / medicaid_claim_in_billing_
// manager_caseload / medicaid_override_role_eligible / regulatory_required_rule_protected_medicaid /
// rb_arrangement_visible_in_scope / state_trading_partner_credential_admin) are composed at the route layer;
// the per-key `abac` here is the DEFAULT only ('none' — RBAC-gated; the route additionally composes the
// per-ProviderEntity scope). category 'billing' (Medicaid is a revenue-cycle surface); the two platform-only
// keys carry 'platform' (the M26 cap.platform_constant.* precedent).
export const M24_CONTRIBUTED_PERMISSIONS = {
  "medicaid.claim.assemble": {
    resource: "medicaid_claim",
    action: "assemble",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.read": {
    resource: "medicaid_claim",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.update_draft": {
    resource: "medicaid_claim",
    action: "update_draft",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.delete_draft": {
    resource: "medicaid_claim",
    action: "delete_draft",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.submit": {
    resource: "medicaid_claim",
    action: "submit",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.replace": {
    resource: "medicaid_claim",
    action: "replace",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.void": {
    resource: "medicaid_claim",
    action: "void",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.read_ar_dashboard": {
    resource: "medicaid_claim",
    action: "read_ar_dashboard",
    category: "billing",
    abac: "none",
  },
  "medicaid.claim.read_metrics": {
    resource: "medicaid_claim",
    action: "read_metrics",
    category: "billing",
    abac: "none",
  },
  "medicaid.validation.read_run": {
    resource: "medicaid_validation_run",
    action: "read_run",
    category: "billing",
    abac: "none",
  },
  "medicaid.validation.run": {
    resource: "medicaid_validation_run",
    action: "run",
    category: "billing",
    abac: "none",
  },
  "medicaid.validation.override": {
    resource: "medicaid_validation_override",
    action: "override",
    category: "billing",
    abac: "none",
  },
  "medicaid.validation.read_override": {
    resource: "medicaid_validation_override",
    action: "read_override",
    category: "billing",
    abac: "none",
  },
  "medicaid.rule_config.read": {
    resource: "medicaid_validation_rule_config",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "medicaid.rule_config.edit": {
    resource: "medicaid_validation_rule_config",
    action: "edit",
    category: "billing",
    abac: "none",
  },
  "medicaid.rule_config.platform_admin": {
    resource: "medicaid_validation_rule_config",
    action: "platform_admin",
    category: "platform",
    abac: "none",
  },
  "medicaid.eligibility.check": {
    resource: "medicaid_eligibility_check",
    action: "check",
    category: "billing",
    abac: "none",
  },
  "medicaid.eligibility.read": {
    resource: "medicaid_eligibility_check",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "medicaid.rb_arrangement.read": {
    resource: "rb_arrangement",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "medicaid.rb_arrangement.create": {
    resource: "rb_arrangement",
    action: "create",
    category: "billing",
    abac: "none",
  },
  "medicaid.rb_arrangement.edit": {
    resource: "rb_arrangement",
    action: "edit",
    category: "billing",
    abac: "none",
  },
  "medicaid.rb_arrangement.activate": {
    resource: "rb_arrangement",
    action: "activate",
    category: "billing",
    abac: "none",
  },
  "medicaid.rb_day.override": {
    resource: "rb_day",
    action: "override",
    category: "billing",
    abac: "none",
  },
  "medicaid.trading_partner.read": {
    resource: "state_medicaid_trading_partner_credential",
    action: "read",
    category: "billing",
    abac: "none",
  },
  "medicaid.trading_partner.admin": {
    resource: "state_medicaid_trading_partner_credential",
    action: "admin",
    category: "billing",
    abac: "none",
  },
  "medicaid.rate_schedule.platform_admin": {
    resource: "state_rate_schedule",
    action: "platform_admin",
    category: "platform",
    abac: "none",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M24 contributed permission keys (twenty-six). */
export type M24ContributedPermissionKey = keyof typeof M24_CONTRIBUTED_PERMISSIONS;

// M15 — Module 15's twenty Discipline Care Plans permission keys registered into M3's catalog (§4.4). The
// four §4.5 predicates M15 OWNS (aide_supervisor_eligible / volunteer_compliance_active /
// family_violence_disclosure_allowed / volunteer_coordinator_role) are named as the per-key DEFAULT where the
// key has exactly one; the routes compose the rest (the §4.1 inventory's `caseload_or_scope` ∧
// `discipline_scope` ∧ the two disclosure gates) at the route layer, since a key can carry only one default.
// category 'clinical' for the plan/assessment/supervisory surface, 'compliance' for the 418.78 volunteer-gate
// + hour-ratio surface (a Compliance Officer/DON reads those without a caseload), and the three
// `*_internal` seam keys are system-principal-only (M14's `idg.*` precedent for the shape).
export const M15_CONTRIBUTED_PERMISSIONS = {
  "discipline_plan.read": {
    resource: "discipline_care_plan",
    action: "read",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "discipline_plan.read_summary": {
    resource: "discipline_care_plan",
    action: "read_summary",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "discipline_plan.author": {
    resource: "discipline_care_plan",
    action: "author",
    category: "clinical",
    abac: "discipline_scope",
  },
  "discipline_plan.finalize": {
    resource: "discipline_care_plan_version",
    action: "finalize",
    category: "clinical",
    abac: "discipline_scope",
  },
  "discipline_plan.sign": {
    resource: "discipline_care_plan_version",
    action: "sign",
    category: "clinical",
    abac: "signer_role_match",
  },
  "discipline_plan.idg_revise": {
    resource: "discipline_care_plan_version",
    action: "idg_revise",
    category: "clinical",
    abac: "caseload_or_scope",
  },
  "discipline_assessment.author": {
    resource: "discipline_assessment",
    action: "author",
    category: "clinical",
    abac: "discipline_scope",
  },
  "discipline_assessment.sign": {
    resource: "discipline_assessment",
    action: "sign",
    category: "clinical",
    abac: "discipline_scope",
  },
  "discipline_assessment.amend": {
    resource: "discipline_assessment",
    action: "amend",
    category: "clinical",
    abac: "discipline_scope",
  },
  "aide_supervisory.author": {
    resource: "aide_supervisory_visit",
    action: "author",
    category: "clinical",
    abac: "aide_supervisor_eligible",
  },
  "aide_supervisory.sign": {
    resource: "aide_supervisory_visit",
    action: "sign",
    category: "clinical",
    abac: "aide_supervisor_eligible",
  },
  "volunteer_assignment.author": {
    resource: "volunteer_assignment",
    action: "author",
    category: "clinical",
    abac: "volunteer_coordinator_role",
  },
  "volunteer_compliance.read": {
    resource: "volunteer_compliance_gate",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  "volunteer_compliance.author": {
    resource: "volunteer_compliance_gate",
    action: "author",
    category: "compliance",
    abac: "volunteer_coordinator_role",
  },
  "volunteer_compliance.revoke": {
    resource: "volunteer_compliance_gate",
    action: "revoke",
    category: "compliance",
    abac: "none",
  },
  "volunteer_compliance.read_ratio": {
    resource: "volunteer_hour_ledger",
    action: "read_ratio",
    category: "compliance",
    abac: "none",
  },
  "volunteer_compliance.adjust_hours": {
    resource: "volunteer_hour_entry",
    action: "adjust_hours",
    category: "compliance",
    abac: "none",
  },
  // The three §4.1 `/internal/...` seam routes — system principals only (never granted to a role template).
  "discipline_plan.read_internal": {
    resource: "discipline_care_plan",
    action: "read_internal",
    category: "platform",
    abac: "none",
  },
  "volunteer_compliance.read_internal": {
    resource: "volunteer_compliance_gate",
    action: "read_internal",
    category: "platform",
    abac: "none",
  },
  "aide_supervisory.read_internal": {
    resource: "aide_supervisory_visit",
    action: "read_internal",
    category: "platform",
    abac: "none",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M15 contributed permission keys (twenty). */
export type M15ContributedPermissionKey = keyof typeof M15_CONTRIBUTED_PERMISSIONS;

/**
 * M16-T06 — the twenty-nine §4.7 Bereavement permission keys Module 16 registers into M3's catalog.
 *
 * `abac` names the DEFAULT predicate the M3 catalog records for the key; the §4.1 route table is what
 * actually binds a guard, and it may bind a different (or no) predicate per route. Four of the five §4.8
 * predicate names are M16-OWNED and registered by `registerBereavementAbacPredicates`:
 * `bereavement_window`, `discipline_can_provide_bereavement`, `org_scope_bereavement_oversight` and
 * `portal_self_service`. §4.8 calls the last two "reused / M3 §4.2 family", but no module on the platform
 * registers either name today — an UNREGISTERED predicate denies exactly like a typo, so M16 registers
 * them rather than binding a name nothing declares.
 *
 * `volunteer_gates_satisfied` is deliberately NOT a separate key here: §4.8 folds it INTO
 * `discipline_can_provide_bereavement` for the volunteer discipline, and M16 resolves it through M15's
 * published `VolunteerComplianceProvider` seam so there is one 418.78 gate implementation, not two.
 */
export const M16_CONTRIBUTED_PERMISSIONS = {
  "bereavement.plan.read": {
    resource: "bereavement_plan",
    action: "read",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.plan.assign_counselor": {
    resource: "bereavement_plan",
    action: "assign_counselor",
    category: "clinical",
    abac: "org_scope_bereavement_oversight",
  },
  "bereavement.plan.assign_volunteer": {
    resource: "bereavement_plan",
    action: "assign_volunteer",
    category: "clinical",
    abac: "org_scope_bereavement_oversight",
  },
  "bereavement.plan.activate": {
    resource: "bereavement_plan",
    action: "activate",
    category: "clinical",
    abac: "org_scope_bereavement_oversight",
  },
  "bereavement.plan.pause": {
    resource: "bereavement_plan",
    action: "pause",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.plan.resume": {
    resource: "bereavement_plan",
    action: "resume",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.plan.close_early": {
    resource: "bereavement_plan",
    action: "close_early",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.plan.close_cosign": {
    resource: "bereavement_plan",
    action: "close_cosign",
    category: "clinical",
    abac: "org_scope_bereavement_oversight",
  },
  "bereavement.plan.regenerate_schedule": {
    resource: "bereavement_plan",
    action: "regenerate_schedule",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact.create": {
    resource: "bereaved_contact",
    action: "create",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact.update": {
    resource: "bereaved_contact",
    action: "update",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact.confirm": {
    resource: "bereaved_contact",
    action: "confirm",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact.opt_out": {
    resource: "bereaved_contact",
    action: "opt_out",
    category: "clinical",
    abac: "portal_self_service",
  },
  "bereavement.contact.rescind_opt_out": {
    resource: "bereaved_contact",
    action: "rescind_opt_out",
    category: "clinical",
    abac: "portal_self_service",
  },
  "bereavement.contact.mark_deceased": {
    resource: "bereaved_contact",
    action: "mark_deceased",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact.mark_unreachable": {
    resource: "bereaved_contact",
    action: "mark_unreachable",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact.flag_complicated_grief": {
    resource: "bereaved_contact",
    action: "flag_complicated_grief",
    category: "clinical",
    abac: "discipline_can_provide_bereavement",
  },
  "bereavement.outreach.read": {
    resource: "bereavement_outreach",
    action: "read",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.outreach.start": {
    resource: "bereavement_outreach",
    action: "start",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.outreach.complete": {
    resource: "bereavement_outreach",
    action: "complete",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.outreach.cancel": {
    resource: "bereavement_outreach",
    action: "cancel",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.outreach.late_attempt": {
    resource: "bereavement_outreach",
    action: "late_attempt",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.contact_log.write": {
    resource: "bereavement_contact_log",
    action: "write",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.risk.read": {
    resource: "bereavement_risk_score",
    action: "read",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.risk.recompute": {
    resource: "bereavement_risk_score",
    action: "recompute",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.referral.create": {
    resource: "bereavement_contact_log",
    action: "refer_external",
    category: "clinical",
    abac: "bereavement_window",
  },
  "bereavement.dashboard.counselor": {
    resource: "bereavement_plan",
    action: "dashboard_counselor",
    category: "clinical",
    abac: "discipline_can_provide_bereavement",
  },
  "bereavement.dashboard.supervisor": {
    resource: "bereavement_plan",
    action: "dashboard_supervisor",
    category: "clinical",
    abac: "org_scope_bereavement_oversight",
  },
  // §4.1 route 33 — the D18-gated counselor first contact. §4.1 gates it on `bereavement.outreach.start`,
  // but the gate REFUSAL is the whole point of the route, so it carries its own key: a tenant that wants a
  // coordinator (and not every outreach-capable worker) to make first contact on an external-source plan
  // can grant one without the other. The route binds BOTH keys, so the §4.1 contract is not loosened.
  "bereavement.plan.initiate_contact": {
    resource: "bereavement_plan",
    action: "initiate_contact",
    category: "clinical",
    abac: "bereavement_window",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M16 contributed permission keys (twenty-nine). */
export type M16ContributedPermissionKey = keyof typeof M16_CONTRIBUTED_PERMISSIONS;

/**
 * M21-T05 — the twenty-nine Supplies / DME / Comfort-Kit permission keys Module 21 registers into M3's
 * catalog: §4.3's twenty-six, plus the three the §4.1 route inventory needs and §4.3 never named (see the
 * last block plus `caregiver_signature` beside `mark_delivered`, F-193/#248).
 *
 * `abac` names the DEFAULT predicate the M3 catalog records for the key; the §4.1 route table is what
 * actually binds a guard, and it may bind a different (or no) predicate per route. Both §4.4 predicate
 * names are M21-OWNED and registered by `registerSuppliesAbacPredicates`:
 * `controlled_substance_dispatcher_eligible` and `comfort_kit_return_reconciler_eligible`.
 *
 * TWO catalog decisions worth stating, because both are easy to get backwards:
 *
 *   1. `supplies.request.create` records `'none'` as its DEFAULT, even though §4.1 binds
 *      `controlled_substance_dispatcher_eligible` on the row. The §4.1 cell is CONDITIONAL —
 *      "(when kind=comfort_kit_deploy)" — and the catalog default is unconditional. Recording the
 *      predicate here would make every DME and wound-supply request require controlled-substance
 *      dispatch authority, which is strictly stricter than the spec and would ground the aides who file
 *      most requests. The conditional gate lives in the route guard (`ABAC_DISPATCHER_ON_KIT_KIND`), where
 *      the kind is actually in hand.
 *   2. The four catalog keys (`supplies.item.*`) are PLATFORM-only in §4.3 and their category is `admin`,
 *      not `clinical`: `supply_item` carries no organization_id at all (D11), so a tenant clinician role
 *      must never pick them up by category grant. The tenant's own overlay
 *      (`supplies.tenant_item.write`) is the org-scoped key beside them.
 */
export const M21_CONTRIBUTED_PERMISSIONS = {
  // ── supply requests (§4.1 rows 1-10) ────────────────────────────────────────────────────────────────
  "supplies.request.create": {
    resource: "supply_request",
    action: "create",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.read": {
    resource: "supply_request",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.assign_vendor": {
    resource: "supply_request",
    action: "assign_vendor",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.mark_ordered": {
    resource: "supply_request",
    action: "mark_ordered",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.mark_in_transit": {
    resource: "supply_request",
    action: "mark_in_transit",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.mark_delivered": {
    resource: "supply_request",
    action: "mark_delivered",
    category: "clinical",
    abac: "none",
  },
  // F-193 (#248) — the M21-owned caregiver-signature capture (§4.1 has no row for it; D7's "optional via
  // M22's signature flow" named a mechanism M22 was never going to build). Gated the same way
  // `mark_delivered` is: RBAC only, no ABAC — the route further requires the request to already be
  // `delivered` (a lifecycle guard, not an authorization predicate).
  "supplies.request.caregiver_signature": {
    resource: "supply_request",
    action: "caregiver_signature",
    category: "clinical",
    abac: "none",
  },
  // COP27 (42 CFR 418.24(c)) — set/change a dme/supply request's hospice coverage determination (the M6
  // election-statement addendum lists the not-covered items). A clinical determination, RBAC only like the
  // other request writes; the service refuses it on the comfort-kit kinds.
  "supplies.request.coverage_determine": {
    resource: "supply_request",
    action: "coverage_determine",
    category: "clinical",
    abac: "none",
  },
  // GAP-063 / D16 — record the vendor's actual invoice against the accrued quote (emits
  // `m21.supply_request.invoice_reconciled` to M27). A finance-adjacent write, RBAC only like the other
  // request writes; the service refuses a request that was never accrued or was already reconciled.
  "supplies.request.invoice_reconcile": {
    resource: "supply_request",
    action: "invoice_reconcile",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.confirm_received": {
    resource: "supply_request",
    action: "confirm_received",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.cancel": {
    resource: "supply_request",
    action: "cancel",
    category: "clinical",
    abac: "none",
  },
  "supplies.request.return": {
    resource: "supply_request",
    action: "return",
    category: "clinical",
    abac: "none",
  },

  // ── SKU catalog (§4.1 rows 11-16; D11 platform + tenant overlay) ────────────────────────────────────
  "supplies.item.read": {
    resource: "supply_item",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "supplies.item.write": {
    resource: "supply_item",
    action: "write",
    category: "admin",
    abac: "none",
  },
  "supplies.item.retire": {
    resource: "supply_item",
    action: "retire",
    category: "admin",
    abac: "none",
  },
  "supplies.tenant_item.write": {
    resource: "tenant_supply_item_extension",
    action: "write",
    category: "admin",
    abac: "none",
  },

  // ── comfort-kit templates (§4.1 rows 17-19; D3 floor-plus-overlay) ─────────────────────────────────
  "comfort_kit.template.read": {
    resource: "comfort_kit_template",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "comfort_kit.template.write": {
    resource: "comfort_kit_template",
    action: "write",
    category: "clinical",
    abac: "none",
  },

  // ── comfort-kit dispatch (§4.1 rows 20-23; D6 controlled-substance custody) ────────────────────────
  "comfort_kit.dispatch.create": {
    resource: "comfort_kit_dispatch",
    action: "create",
    category: "clinical",
    abac: "controlled_substance_dispatcher_eligible",
  },
  "comfort_kit.dispatch.read": {
    resource: "comfort_kit_dispatch",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "comfort_kit.dispatch.deploy": {
    resource: "comfort_kit_dispatch",
    action: "deploy",
    category: "clinical",
    abac: "none",
  },

  // ── comfort-kit return + reconciliation (§4.1 rows 24-27; D8 / DEA 21 CFR §1304) ───────────────────
  "comfort_kit.return.create": {
    resource: "comfort_kit_return",
    action: "create",
    category: "clinical",
    abac: "none",
  },
  "comfort_kit.return.read": {
    resource: "comfort_kit_return",
    action: "read",
    category: "clinical",
    abac: "none",
  },
  "comfort_kit.return.reconcile": {
    resource: "comfort_kit_return",
    action: "reconcile",
    category: "compliance",
    abac: "comfort_kit_return_reconciler_eligible",
  },

  // ── vendor routing + par stock (§4.1 rows 28-35; agency operations, no patient in them) ────────────
  "vendor_routing.read": {
    resource: "vendor_routing_rule",
    action: "read",
    category: "admin",
    abac: "none",
  },
  "vendor_routing.write": {
    resource: "vendor_routing_rule",
    action: "write",
    category: "admin",
    abac: "none",
  },
  "par_stock.read": {
    resource: "par_stock",
    action: "read",
    category: "admin",
    abac: "none",
  },
  "par_stock.write": {
    resource: "par_stock",
    action: "write",
    category: "admin",
    abac: "none",
  },
  "par_stock.observe": {
    resource: "par_stock",
    action: "observe",
    category: "admin",
    abac: "none",
  },

  // ── the two keys §4.1 implies but does not name a row for ──────────────────────────────────────────
  // §5.5 / §7.3's reconciliation screen and §8.1's `m21.controlled_substance.*` attestation trail are both
  // read surfaces over the DEA perpetual log — the lot-level custody chain, not the request. A surveyor or
  // compliance officer reads them without any need to touch a supply request, and a supply coordinator who
  // may file requests must not thereby acquire the controlled-substance ledger. Separate key, `compliance`
  // category.
  "comfort_kit.perpetual_log.read": {
    resource: "comfort_kit_dispatched_content",
    action: "read",
    category: "compliance",
    abac: "none",
  },
  // §2.6 — the 90-day assumption-of-loss disposition. §4.1 has no row (the escalation is a cron finding),
  // but §3.1.10's CHECK requires an attested reason from a named human, so there IS a route and it needs a
  // key. Deliberately NOT folded into `comfort_kit.return.reconcile`: writing off a kit that holds a CII
  // solution is a different authority from counting one that came back.
  "comfort_kit.return.declare_unreturnable": {
    resource: "comfort_kit_return",
    action: "declare_unreturnable",
    category: "compliance",
    abac: "comfort_kit_return_reconciler_eligible",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M21 contributed permission keys (twenty-nine). */
export type M21ContributedPermissionKey = keyof typeof M21_CONTRIBUTED_PERMISSIONS;

/**
 * Module 19 — On-Call Triage: the §4.6 permission keys the module contributes to this M3-owned catalog
 * (M19-T07). Seventeen keys, verbatim from §4.6's `M19_PERMISSION_KEYS`, in that block's order.
 *
 * THE `abac` FIELD IS THE CATALOG DEFAULT, NOT THE ROUTE BINDING. §4.1 binds a predicate per route and
 * several keys carry DIFFERENT predicates on different rows (`triage.read` is `caseload_or_scope` on the
 * list, `triage_call_owner_or_supervisor` on the detail, and org-scoped on the protocol catalog). The
 * default recorded here is the one an admin granting the key should assume; the route guard is the
 * authority. All six M19-owned names are registered by `registerOncallAbacPredicates`:
 * `oncall_eligible`, `triage_call_owner_or_supervisor`, `external_triage_actor`,
 * `escalation_recipient_scope`, `escalation_recipient`, `portal_session_consent_active`.
 *
 * FOUR catalog decisions worth stating, because each is easy to get backwards:
 *
 *   1. `triage.read` defaults to `caseload_or_scope` (M7's shared patient-scope predicate), NOT to
 *      M19's own `triage_call_owner_or_supervisor`. §6's "read call" row grants org-wide (broad) visibility
 *      to Sched / Clin Supv / DON / Med Dir / Comp Off / Surveyor, and `caseload_or_scope` is the predicate
 *      that already encodes "caseload OR the role's org scope". Defaulting to the owner predicate would
 *      make the supervisor board — the one surface that exists to catch a call nobody picked up — return
 *      nothing for the very roles it is for.
 *   2. THE TWO POLICY-ADMIN KEYS ARE `admin`, NOT `clinical`. `oncall.admin_policy` edits the escalation
 *      ladder and the vendor binding; §6 grants it to DON and Compliance Officer only. A clinical
 *      category grant would sweep it to every RN template that takes `category: clinical` wholesale.
 *   3. `triage.paper_reentry` is `compliance`, not `triage`. §2.7's back-dated `opened_at` is the one
 *      write in M19 that can hide a coverage gap (§8.3.2 names it as a tampering threat), so it is
 *      categorised with the audit/legal-hold keys a compliance template grants, and the route adds step-up.
 *   4. `portal.triage.read_recent` keeps §4.6's `oncall` category verbatim even though it is a PORTAL key.
 *      The category is the catalog's grouping for the admin UI, and §4.6 is explicit; re-categorising it
 *      to `portal` here would silently drop it out of whatever template §4.6's author grouped it into.
 */
export const M19_CONTRIBUTED_PERMISSIONS = {
  // ── triage calls (§4.1 rows 1-14) ───────────────────────────────────────────────────────────────────
  "triage.open": {
    resource: "triage_call",
    action: "open",
    category: "triage",
    abac: "oncall_eligible",
  },
  "triage.read": {
    resource: "triage_call",
    action: "read",
    category: "triage",
    abac: "caseload_or_scope",
  },
  "triage.write": {
    resource: "triage_call",
    action: "write",
    category: "triage",
    abac: "triage_call_owner_or_supervisor",
  },
  "triage.disposition": {
    resource: "triage_call",
    action: "disposition",
    category: "triage",
    abac: "triage_call_owner_or_supervisor",
  },
  // §4.1 row 14 — step-up + a per-access M4 audit row on top of the predicate.
  "triage.read_transcript": {
    resource: "triage_call",
    action: "read_transcript",
    category: "triage",
    abac: "triage_call_owner_or_supervisor",
  },
  "triage.close_abandoned": {
    resource: "triage_call",
    action: "close_abandoned",
    category: "triage",
    abac: "triage_call_owner_or_supervisor",
  },
  // F-224 — the explicit staff action that requests the caregiver/attending summary document
  // (`m19.triage.summary_requested` → M22). Granted to the same on-call clinician bands as
  // `triage.disposition` (RN/NP, Clinical Supervisor/DON, Medical Director); NOT on the vendor list.
  "triage.request_summary": {
    resource: "triage_call",
    action: "request_summary",
    category: "triage",
    abac: "triage_call_owner_or_supervisor",
  },
  // ── escalations (§4.1 rows 15-18) ───────────────────────────────────────────────────────────────────
  "triage.escalate": {
    resource: "triage_escalation",
    action: "create",
    category: "triage",
    abac: "triage_call_owner_or_supervisor",
  },
  "triage.read_escalations": {
    resource: "triage_escalation",
    action: "read",
    category: "triage",
    abac: "escalation_recipient_scope",
  },
  "triage.escalation_ack": {
    resource: "triage_escalation",
    action: "acknowledge",
    category: "triage",
    abac: "escalation_recipient",
  },
  "triage.escalation_resolve": {
    resource: "triage_escalation",
    action: "resolve",
    category: "triage",
    abac: "escalation_recipient",
  },
  // ── protocol catalog (§4.1 rows 29-32) ──────────────────────────────────────────────────────────────
  "triage.admin_protocol": {
    resource: "triage_protocol",
    action: "admin",
    category: "triage_admin",
    abac: "inOrg",
  },
  // ── on-call shifts + policy (§4.1 rows 19-26) ───────────────────────────────────────────────────────
  "oncall.read_schedule": {
    resource: "on_call_shift",
    action: "read",
    category: "oncall",
    abac: "caseload_or_scope",
  },
  "oncall.write_schedule": {
    resource: "on_call_shift",
    action: "write",
    category: "oncall",
    abac: "inOrg",
  },
  "oncall.read_policy": {
    resource: "tenant_oncall_policy",
    action: "read",
    category: "oncall",
    abac: "inOrg",
  },
  // Decision 2 — `admin`, not `clinical`/`oncall`: it edits the escalation ladder and the vendor binding.
  "oncall.admin_policy": {
    resource: "tenant_oncall_policy",
    action: "admin",
    category: "admin",
    abac: "inOrg",
  },
  // F-030 / #75 — binding an authenticated session to an `external_triage_vendor` (D3 Hybrid/Centralized).
  //
  // `admin`, alongside `oncall.admin_policy`, for exactly the reason that one is: the binding decides
  // which outside party may act on the agency's after-hours line, and §8.3.2 lists tampering with the
  // vendor binding as a named threat. It is the same authority as editing the policy that names the
  // vendor, so it carries the same category rather than the operational `oncall` one.
  "oncall.bind_vendor_session": {
    resource: "external_triage_vendor",
    action: "bind_session",
    category: "admin",
    abac: "inOrg",
  },
  // ── portal (§4.1 row 36) ────────────────────────────────────────────────────────────────────────────
  // Decision 4 — §4.6's `oncall` category kept verbatim.
  "portal.triage.read_recent": {
    resource: "triage_call",
    action: "portal_read_recent",
    category: "oncall",
    abac: "portal_session_consent_active",
  },
  // ── M19-F08 BCP paper-origin re-entry (DR-013/066) ──────────────────────────────────────────────────
  // Decision 3 — `compliance`: this is the one write that can back-date a call past a coverage gap.
  "triage.paper_reentry": {
    resource: "triage_call",
    action: "paper_reentry",
    category: "compliance",
    abac: "inOrg",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M19 contributed permission keys (seventeen). */
export type M19ContributedPermissionKey = keyof typeof M19_CONTRIBUTED_PERMISSIONS;

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

/** Project the M34 contributed keys into `permission`-table mirror rows (M34 §4.5). */
export function m34ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M34_CONTRIBUTED_PERMISSIONS);
}

/** Project the M33 contributed keys into `permission`-table mirror rows (M33 §4.6). */
export function m33ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M33_CONTRIBUTED_PERMISSIONS);
}

/** Project the M23 contributed keys into `permission`-table mirror rows (M23 §4.6). */
export function m23ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M23_CONTRIBUTED_PERMISSIONS);
}

/** Project the M25 contributed keys into `permission`-table mirror rows (M25 §4.6). */
export function m25ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M25_CONTRIBUTED_PERMISSIONS);
}

/** Project the M26 contributed keys into `permission`-table mirror rows (M26 §4.6). */
export function m26ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M26_CONTRIBUTED_PERMISSIONS);
}

/** Project the M27 contributed keys into `permission`-table mirror rows (M27 §4.6). */
export function m27ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M27_CONTRIBUTED_PERMISSIONS);
}

/** Project the M24 contributed keys into `permission`-table mirror rows (M24 §4.7). */
export function m24ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M24_CONTRIBUTED_PERMISSIONS);
}

/** Project the M15 contributed keys into `permission`-table mirror rows (M15 §4.4). */
export function m15ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M15_CONTRIBUTED_PERMISSIONS);
}

/** Project the M16 contributed keys into `permission`-table mirror rows (M16 §4.7). */
export function m16ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M16_CONTRIBUTED_PERMISSIONS);
}

/** Project the M21 contributed keys into `permission`-table mirror rows (M21 §4.3). */
export function m21ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M21_CONTRIBUTED_PERMISSIONS);
}

/** Project the M19 contributed keys into `permission`-table mirror rows (M19 §4.6). */
export function m19ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M19_CONTRIBUTED_PERMISSIONS);
}

/**
 * The full `permission`-table mirror: M3's own cross-cutting keys plus every contributed
 * (M1/M2 + M4 + M38 + M36) key. This is the row set the deploy-time sync writes to the read-only
 * `permission` table once the catalog goes real. Keys are single-owner across all sets — a
 * collision would be a registration bug, so the deploy sync (and the unit test) asserts uniqueness.
 */

/**
 * M30 HQRP & Quality — the §4.6 permission keys the module contributes to this M3-owned catalog.
 *
 * These existed in `apps/backend/src/modules/30-quality/permission-keys.ts` as M30's own source of truth,
 * but were never projected INTO the catalog — the "Integrate phase's job" its header names. The effect was
 * that no role could grant a quality permission and no screen could declare one as its
 * `requiredPermission` (the ui-parity gate rejects a key the catalog does not know). Mirrors the M33
 * precedent: the typed map lives here, the module keeps its own list, and the two are asserted equal.
 */
export const M30_CONTRIBUTED_PERMISSIONS = {
  // --- quality measures (§6.1) — aggregate-only, `inOrg`-scoped (R-01..R-05) ---
  // R-01/R-02 list + value series.
  "quality.measure.read": {
    resource: "quality_measure",
    action: "read",
    category: "quality",
    abac: "inOrg",
  },
  // R-04/R-05 enqueue + inspect recompute queue.
  "quality.measure.recompute": {
    resource: "quality_measure",
    action: "recompute",
    category: "quality_admin",
    abac: "inOrg",
  },
  // R-03 reproducibility snapshot for an emitted value.
  "quality.measure.audit": {
    resource: "quality_measure",
    action: "audit",
    category: "quality_admin",
    abac: "inOrg",
  },
  // --- CAHPS (§6.2) — `quality.cahps.system` is service-only (bound to the vendor adapter's mTLS
  // service account at boot, never granted to a human principal) ---
  // R-10/R-12/R-17 vendor binding, decedent sample, result summaries (read).
  "quality.cahps.read": {
    resource: "quality_cahps",
    action: "read",
    category: "quality",
    abac: "inOrg",
  },
  // R-11/R-13/R-14/R-15 bind vendor, exclude decedent, export, export status.
  "quality.cahps.admin": {
    resource: "quality_cahps",
    action: "admin",
    category: "quality_admin",
    abac: "inOrg",
  },
  // R-16 vendor-adapter result ingest (system route, mTLS).
  "quality.cahps.system": {
    resource: "quality_cahps",
    action: "system",
    category: "quality_admin",
    abac: "inOrg",
  },
  // --- QAPI (§6.3) — `qapi.close` (PIP) requires two-person co-sign (QAPI Coordinator + Medical
  // Director); the `qapiCloseAuthority` predicate enforces the role-difference at exercise time ---
  // R-20/R-23/R-26/R-29/R-33 list programs, indicators, projects, PIPs, governance minutes.
  "qapi.read": { resource: "qapi", action: "read", category: "quality", abac: "inOrg" },
  // R-27/R-28/R-30/R-32 charter projects, update phase, add PIP, record governance minutes;
  // R-28/R-30 add `ownsQapiProject` (project lead OR `qapi.admin`).
  "qapi.write": { resource: "qapi", action: "write", category: "quality", abac: "ownsQapiProject" },
  // R-21/R-22/R-24/R-25 adopt program, governance composition, create/update indicators.
  "qapi.admin": { resource: "qapi", action: "admin", category: "quality_admin", abac: "inOrg" },
  // R-31 close PIP (two-person co-sign).
  "qapi.close": {
    resource: "qapi",
    action: "close",
    category: "quality",
    abac: "qapiCloseAuthority",
  },
  // --- SRA (§6.4) — `sra.close` requires two-person co-sign (Security Officer + Compliance Officer);
  // the `sraCloseAuthority` predicate enforces the role split ---
  // R-40/R-42/R-48 list cycles, cycle detail, NIST export.
  "sra.read": { resource: "sra", action: "read", category: "quality", abac: "inOrg" },
  // R-43/R-44/R-45/R-46 add finding, update finding, plan/update remediation; all add `ownsSraCycle`.
  "sra.write": { resource: "sra", action: "write", category: "quality", abac: "ownsSraCycle" },
  // R-41 open new cycle.
  "sra.admin": { resource: "sra", action: "admin", category: "quality_admin", abac: "inOrg" },
  // R-47 close cycle (two-person co-sign).
  "sra.close": { resource: "sra", action: "close", category: "quality", abac: "sraCloseAuthority" },
  // --- incidents (§6.5) — visibility is gated so the `allegation_of_abuse` kind only reaches the
  // abuse-review queue; resolve/close/reopen enforce the M30-F03 separation-of-duties control ---
  // R-50/R-52 list + detail (PHI when patient-linked); `incidentVisibility` masks abuse rows.
  "incident.read": {
    resource: "incident",
    action: "read",
    category: "quality",
    abac: "incidentVisibility",
  },
  // R-51 create (draft, `inOrg`) / R-53 update draft fields (adds `ownsIncident`).
  "incident.write": {
    resource: "incident",
    action: "write",
    category: "quality",
    abac: "ownsIncident",
  },
  // R-54 submit (draft→submitted); reporter-owned.
  "incident.submit": {
    resource: "incident",
    action: "submit",
    category: "quality",
    abac: "ownsIncident",
  },
  // R-55 triage (submitted→triaged, assign owner + severity).
  "incident.triage": {
    resource: "incident",
    action: "triage",
    category: "quality",
    abac: "inOrg",
  },
  // R-56 append-only investigation note; assignee-owned.
  "incident.investigate": {
    resource: "incident",
    action: "investigate",
    category: "quality",
    abac: "assignedToIncident",
  },
  // R-57 open CAP / begin investigation (triaged→under_investigation); assignee-owned.
  "incident.cap": {
    resource: "incident",
    action: "cap",
    category: "quality",
    abac: "assignedToIncident",
  },
  // R-58 resolve / verify CAP (under_investigation→resolved); `capVerifyAuthority` enforces
  // resolver ≠ assignee (M30-F03 / ADR-0022).
  "incident.resolve": {
    resource: "incident",
    action: "resolve",
    category: "quality",
    abac: "capVerifyAuthority",
  },
  // R-59 close (resolved→closed_followup_complete).
  "incident.close": {
    resource: "incident",
    action: "close",
    category: "quality",
    abac: "capVerifyAuthority",
  },
  // R-60 reopen (closed/reopened→under_investigation).
  "incident.reopen": {
    resource: "incident",
    action: "reopen",
    category: "quality",
    abac: "capVerifyAuthority",
  },
  // R-61 abuse-allegation co-sign queue; `abuseAllegationAccess` is the only path to abuse rows.
  "incident.abuse_review": {
    resource: "incident",
    action: "abuse_review",
    category: "quality",
    abac: "abuseAllegationAccess",
  },
  // --- mortality (§6.6) — PHI; write/close are assignee-owned ---
  // R-70/R-71 list + review detail (3 dimensions).
  "mortality.read": {
    resource: "mortality_review",
    action: "read",
    category: "quality",
    abac: "inOrg",
  },
  // D19 — patient-identifying detail (display name + MRN suffix) on R-70/R-71. Without it the reads return the
  // patient id only. Grant is per-tenant role data (M3), like every other M30 key.
  "mortality.read_with_patient": {
    resource: "mortality_review",
    action: "read_with_patient",
    category: "quality",
    abac: "inOrg",
  },
  // R-72 update review fields.
  "mortality.write": {
    resource: "mortality_review",
    action: "write",
    category: "quality",
    abac: "assignedToMortality",
  },
  // R-73 complete review (target ≤30 days).
  "mortality.close": {
    resource: "mortality_review",
    action: "close",
    category: "quality",
    abac: "assignedToMortality",
  },
  // --- CoP compliance (§6.6) — org-scoped, no PHI ---
  // R-80 list 23 CoP citation rows.
  "cop.read": { resource: "cop", action: "read", category: "quality", abac: "inOrg" },
  // R-81/R-82 update status/evidence + record 6-month review attestation.
  "cop.write": { resource: "cop", action: "write", category: "quality", abac: "inOrg" },
  // --- infection (§6.6) — surveillance events are PHI; outbreak cases are aggregate ---
  // R-90/R-92 list surveillance events + outbreak cases.
  "infection.read": {
    resource: "infection",
    action: "read",
    category: "quality",
    abac: "inOrg",
  },
  // R-91/R-93 record event (auto-clusters) + update outbreak status.
  "infection.write": {
    resource: "infection",
    action: "write",
    category: "quality",
    abac: "inOrg",
  },
  // --- risk register (§6.6) — aggregate unified view ---
  // R-95 unified risk view.
  "risk.read": { resource: "risk_register", action: "read", category: "quality", abac: "inOrg" },
  // R-96 force materialized-view refresh.
  "risk.admin": {
    resource: "risk_register",
    action: "admin",
    category: "quality_admin",
    abac: "inOrg",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M30 contributed permission keys. */
export type M30ContributedPermissionKey = keyof typeof M30_CONTRIBUTED_PERMISSIONS;

/** Project the M30 contributed keys into `permission`-table mirror rows. */
export function m30ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M30_CONTRIBUTED_PERMISSIONS);
}

/**
 * Module 20 — Field Safety: the §4.6 permission keys the module contributes to this M3-owned catalog
 * (M20-T06). Twenty-five keys, verbatim from §4.6's table, in that table's order. §4.6 closes with "the
 * platform-floor 25 keys above are `is_system_locked=true`" — the count is the spec's own.
 *
 * THE `abac` FIELD IS THE CATALOG DEFAULT, NOT THE ROUTE BINDING (the M19 posture). §4.1 binds a
 * predicate per ROW, and four keys carry different predicates on different rows: `safety.check_in.read`
 * is `clinician_self` on `/me/today` and `clinician_self ∨ supervises_clinician` on the detail;
 * `safety.sos.read` adds `safety_supervisor_or_above` on the active list; `safety.sos.read_coords` is
 * `active_sos_responder` DURING and `safety_supervisor_or_above` AFTER; `safety_incident.edit_draft` is
 * `clinician_self` on a draft and `safety_supervisor_or_above` otherwise. The default recorded here is
 * the one an admin granting the key should assume; the route guard is the authority.
 *
 * FIVE CATALOG DECISIONS WORTH STATING, because each is easy to get backwards:
 *
 *   1. `safety.sos.read_coords` IS A SEPARATE KEY FROM `safety.sos.read`, and §4.6 says so in bold. The
 *      board answers "when did we last hear from her"; the coordinates answer "exactly where she is".
 *      §8.7's whole boundary is that the second is a distinct grant with a warn-severity read-audit and a
 *      self-service surface the clinician can review. Folding it into the read key would put a live map
 *      of a clinician's position behind the same grant as a dashboard tile.
 *   2. `org_scope` IS NOT A CATALOG DEFAULT ANYWHERE HERE — the two rows §4.1 marks `org_scope`
 *      (`GET /policy`, `GET /high-risk-areas`) default to M3's intrinsic `inOrg`, which is the SAME rule
 *      ("session.organization_id === target.organization_id") already registered platform-wide. M20
 *      registering a second name for it would create two predicates that must never disagree, and
 *      `arch:abac-predicates` would be satisfied by either. See ../../../apps/backend/src/modules/
 *      20-field-safety/abac-predicates.ts for the same decision at the route layer.
 *   3. THE THREE CONSENT KEYS ARE `self_service`, NOT `compliance`. `safety.consent.read_self` /
 *      `edit_self` govern the CLINICIAN's own consent row (§2.2.8: the workforce member is the data
 *      subject). A compliance-category grant would sweep them into the Compliance Officer template and
 *      make one person able to grant another's consent to be located — the coercion §2.2.8's
 *      `expired`-vs-`revoked` split exists to make visible.
 *   4. `safety.dashboard.read` IS `caseload_or_scope`, NOT `safety_supervisor_or_above`. §6's row grants
 *      every field discipline a SELF-ONLY view of the board; defaulting to the supervisor predicate would
 *      make an RN's own safety status unreadable to her. The route ORs the supervisor arm on top.
 *   5. `safety_incident.osha_signoff` AND `safety_policy.edit` ARE `compliance`, and both carry step-up
 *      at the route. Each is a write whose consequence leaves the platform — a state OSHA-equivalent
 *      filing, and the thresholds that decide how long a clinician in distress goes unwatched.
 */
export const M20_CONTRIBUTED_PERMISSIONS = {
  // ── check-ins (§4.1 rows 1-4) ───────────────────────────────────────────────────────────────────────
  "safety.check_in.create": {
    resource: "safety_check_in",
    action: "create",
    category: "field_safety",
    abac: "clinician_self",
  },
  "safety.check_in.read": {
    resource: "safety_check_in",
    action: "read",
    category: "field_safety",
    abac: "clinician_self",
  },
  "safety.check_in.amend": {
    resource: "safety_check_in",
    action: "amend",
    category: "field_safety",
    abac: "clinician_self",
  },
  // ── SOS (§4.1 rows 5-11) ────────────────────────────────────────────────────────────────────────────
  "safety.sos.raise": {
    resource: "safety_sos_alert",
    action: "raise",
    category: "field_safety",
    abac: "field_eligible_for_sos",
  },
  "safety.sos.cancel": {
    resource: "safety_sos_alert",
    action: "cancel",
    category: "field_safety",
    abac: "clinician_self",
  },
  "safety.sos.acknowledge": {
    resource: "safety_sos_alert",
    action: "acknowledge",
    category: "field_safety",
    abac: "active_sos_responder",
  },
  "safety.sos.resolve": {
    resource: "safety_sos_alert",
    action: "resolve",
    category: "field_safety",
    abac: "active_sos_responder",
  },
  "safety.sos.read": {
    resource: "safety_sos_alert",
    action: "read",
    category: "field_safety",
    abac: "clinician_self",
  },
  // Decision 1 — separate from `safety.sos.read`; §8.7's warn-severity read boundary.
  "safety.sos.read_coords": {
    resource: "safety_sos_alert",
    action: "read_coords",
    category: "field_safety",
    abac: "active_sos_responder",
  },
  // ── incidents (§4.1 rows 12-17) ─────────────────────────────────────────────────────────────────────
  "safety_incident.create": {
    resource: "safety_incident",
    action: "create",
    category: "field_safety",
    abac: "incident_subject_or_supervisor",
  },
  "safety_incident.read": {
    resource: "safety_incident",
    action: "read",
    category: "field_safety",
    abac: "incident_subject_or_supervisor",
  },
  "safety_incident.edit_draft": {
    resource: "safety_incident",
    action: "edit_draft",
    category: "field_safety",
    abac: "clinician_self",
  },
  "safety_incident.submit": {
    resource: "safety_incident",
    action: "submit",
    category: "field_safety",
    abac: "incident_subject_or_supervisor",
  },
  "safety_incident.transition": {
    resource: "safety_incident",
    action: "transition",
    category: "field_safety",
    abac: "safety_supervisor_or_above",
  },
  // Decision 5 — `compliance`, plus step-up at the route (§4.1 / §7.6).
  "safety_incident.osha_signoff": {
    resource: "safety_incident",
    action: "osha_signoff",
    category: "compliance",
    abac: "safety_supervisor_or_above",
  },
  // ── policy (§4.1 rows 18-19) ────────────────────────────────────────────────────────────────────────
  // Decision 2 — `inOrg`, not a second `org_scope` name.
  "safety_policy.read": {
    resource: "safety_policy",
    action: "read",
    category: "field_safety",
    abac: "inOrg",
  },
  // Decision 5 — `compliance` + step-up: this edits how long a clinician in distress goes unwatched.
  "safety_policy.edit": {
    resource: "safety_policy",
    action: "edit",
    category: "compliance",
    abac: "safety_supervisor_or_above",
  },
  // ── supervisor subscriptions (§4.1 rows 20-22) ──────────────────────────────────────────────────────
  "safety_supervisor.read": {
    resource: "safety_supervisor_subscription",
    action: "read",
    category: "field_safety",
    abac: "safety_supervisor_or_above",
  },
  "safety_supervisor.edit": {
    resource: "safety_supervisor_subscription",
    action: "edit",
    category: "field_safety",
    abac: "safety_supervisor_or_above",
  },
  // ── high-risk areas (§4.1 rows 23-25) ───────────────────────────────────────────────────────────────
  // Decision 2 again — §4.1's `org_scope` cell is M3's `inOrg`.
  "safety.high_risk_area.read": {
    resource: "safety_high_risk_area",
    action: "read",
    category: "field_safety",
    abac: "inOrg",
  },
  "safety.high_risk_area.create": {
    resource: "safety_high_risk_area",
    action: "create",
    category: "field_safety",
    abac: "safety_supervisor_or_above",
  },
  "safety.high_risk_area.edit": {
    resource: "safety_high_risk_area",
    action: "edit",
    category: "field_safety",
    abac: "safety_supervisor_or_above",
  },
  // ── dashboard (§4.1 row 26) ─────────────────────────────────────────────────────────────────────────
  // Decision 4 — `caseload_or_scope`; the supervisor arm is ORed at the route, not defaulted here.
  "safety.dashboard.read": {
    resource: "safety_dashboard",
    action: "read",
    category: "field_safety",
    abac: "caseload_or_scope",
  },
  // ── the clinician's own consent surface (§4.1 rows 27-29) ───────────────────────────────────────────
  // Decision 3 — `self_service`: the workforce member is the data subject (§2.2.8).
  "safety.consent.read_self": {
    resource: "safety_emergency_contact_consent",
    action: "read_self",
    category: "self_service",
    abac: "clinician_self",
  },
  "safety.consent.edit_self": {
    resource: "safety_emergency_contact_consent",
    action: "edit_self",
    category: "self_service",
    abac: "clinician_self",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M20 contributed permission keys (twenty-five). */
export type M20ContributedPermissionKey = keyof typeof M20_CONTRIBUTED_PERMISSIONS;

/** Project the M20 contributed keys into `permission`-table mirror rows (M20 §4.6). */
export function m20ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M20_CONTRIBUTED_PERMISSIONS);
}

/**
 * Module 32 (AI Platform) — the twenty-two §4.6 permission keys registered into M3's catalog.
 *
 * FIVE DECISIONS THIS TABLE ENCODES, each of which reads wrong if you skim it:
 *
 *   1. `ai.invocation.read` IS `compliance`, NOT `ai_platform`. §3.2.8 makes `ai_invocation` the
 *      §164.528 DISCLOSURE ledger — the row that says a named patient's chart context went to a model
 *      vendor. Reading it is an accounting-of-disclosures act, and filing it under the module's own
 *      category would sweep it into an AI-operations template rather than the Compliance Officer's.
 *   2. `ai.clinician_opt_out` / `.read` ARE `self_service`. §5.4 makes the CLINICIAN the data subject of
 *      her own opt-out row. A `compliance`-category grant would let one person set another's — which is
 *      exactly the coercion the per-clinician opt-out exists to make impossible.
 *   3. THE TWO KILL-SWITCH KEYS ARE ONE `activate` KEY AND ONE `read` KEY, not four. §4.1's R7/R8 are
 *      activate and DEACTIVATE, and §4.6's table gives them a single key on purpose: a deactivation is
 *      the same authority exercised in the other direction, and splitting it would let a tenant hold
 *      "may un-pause" without "may pause".
 *   4. `ai.tenant_opt_in` COVERS RECORD AND REVOKE (§4.1 R10/R11) — §10.6's withdrawal must never need a
 *      grant the opt-in did not, or a tenant could be walked into consent it cannot walk back out of.
 *   5. THE `abac` DEFAULT ON A ROW IS NOT THE ROUTE'S WHOLE GATE. §4.1 spells several cells as
 *      disjunctions (`ai_safety_owner` OR `tenant_admin`); the catalog names ONE default and the route
 *      composes the other arm (../../../apps/backend/src/modules/32-ai-platform/routes/guards.ts). The
 *      `inOrg` rows are §4.1's "`chartwarden.organization.member` unless explicitly noted" baseline — M32
 *      registers no second name for M3's intrinsic org-scope rule (the M20 precedent).
 */
export const M32_CONTRIBUTED_PERMISSIONS = {
  // ── capability registry + lifecycle (§4.1 R1-R6) ────────────────────────────────────────────────────
  "ai.capability.create": {
    resource: "ai_capability",
    action: "create",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  // §6's matrix grants this to every clinical role — a clinician may see WHAT the platform can do.
  "ai.capability.read": {
    resource: "ai_capability",
    action: "read",
    category: "ai_platform",
    abac: "inOrg",
  },
  "ai.capability.transition": {
    resource: "ai_capability",
    action: "transition",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  "ai.capability.calibrate": {
    resource: "ai_capability",
    action: "calibrate",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  // ── kill switch (§4.1 R7-R9) — decision 3 ───────────────────────────────────────────────────────────
  "ai.kill_switch.activate": {
    resource: "ai_kill_switch_state",
    action: "activate",
    category: "ai_platform",
    abac: "inOrg",
  },
  "ai.kill_switch.read": {
    resource: "ai_kill_switch_state",
    action: "read",
    category: "ai_platform",
    abac: "inOrg",
  },
  // ── tenant opt-in (§4.1 R10-R12, §5.3) — decision 4 ─────────────────────────────────────────────────
  "ai.tenant_opt_in": {
    resource: "ai_tenant_opt_in_record",
    action: "manage",
    category: "admin",
    abac: "inOrg",
  },
  "ai.tenant_opt_in.read": {
    resource: "ai_tenant_opt_in_record",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  // ── clinician opt-out (§4.1 R13-R15, §5.4) — decision 2 ─────────────────────────────────────────────
  "ai.clinician_opt_out": {
    resource: "ai_clinician_opt_out",
    action: "manage",
    category: "self_service",
    abac: "inOrg",
  },
  "ai.clinician_opt_out.read": {
    resource: "ai_clinician_opt_out",
    action: "read",
    category: "self_service",
    abac: "inOrg",
  },
  // ── the disclosure ledger (§4.1 R16-R17) — decision 1 ───────────────────────────────────────────────
  "ai.invocation.read": {
    resource: "ai_invocation",
    action: "read",
    category: "compliance",
    abac: "ai_invocation_same_org_or_safety_owner",
  },
  // ── hallucination report → triage (§4.1 R18-R20, D9/D16) ────────────────────────────────────────────
  // §4.6: "all clinical roles". The report button is the clinician's only write surface in this module.
  "ai.hallucination.report": {
    resource: "ai_hallucination_report",
    action: "report",
    category: "clinical",
    abac: "inOrg",
  },
  "ai.hallucination.triage": {
    resource: "ai_hallucination_report",
    action: "triage",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  // ── token spend (§4.1 R21-R22, W2) ──────────────────────────────────────────────────────────────────
  "ai.tokens.read": {
    resource: "ai_token_ledger",
    action: "read",
    category: "ai_platform",
    abac: "inOrg",
  },
  // ── routing sovereignty (§4.1 R23-R25, §5.3.2, W8) ──────────────────────────────────────────────────
  "ai.routing.override": {
    resource: "ai_routing_override",
    action: "override",
    category: "admin",
    abac: "inOrg",
  },
  "ai.routing.read": {
    resource: "ai_routing_override",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  // ── evaluation runs (§4.1 R26-R28, D10/W6) ──────────────────────────────────────────────────────────
  "ai.evaluation.run": {
    resource: "ai_evaluation_run",
    action: "run",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  "ai.evaluation.read": {
    resource: "ai_evaluation_run",
    action: "read",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  // ── prompt registry (§4.1 R29-R30, §4.5/§8.5) ───────────────────────────────────────────────────────
  "ai.prompt.read": {
    resource: "ai_prompt_template",
    action: "read",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  "ai.prompt.activate": {
    resource: "ai_prompt_template",
    action: "activate",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  // ── drift + health (§4.1 R31-R32, D11/§4.8) ─────────────────────────────────────────────────────────
  "ai.drift.read": {
    resource: "ai_evaluation_run",
    action: "read_drift",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
  "ai.health.read": {
    resource: "ai_model_backend",
    action: "read_health",
    category: "ai_platform",
    abac: "ai_safety_owner",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M32 contributed permission keys (twenty-two). */
export type M32ContributedPermissionKey = keyof typeof M32_CONTRIBUTED_PERMISSIONS;

/** Project the M32 contributed keys into `permission`-table mirror rows (M32 §4.6). */
export function m32ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M32_CONTRIBUTED_PERMISSIONS);
}

/**
 * Module 28 (FHIR Gateway) §4.6 — the twelve admin-surface permission keys the M28 routes gate on.
 *
 * The FHIR-spec surface (routes 1–22) authenticates with a SMART bearer token, not an M3 permission, so
 * NO key here governs it — these twelve gate the admin console (routes 23–39) only. The `abac` default is
 * `inOrg` for every org-scoped read/write; three rows name an M28-registered predicate instead:
 * `fhir_inbound_owner_module_match` (accept/reject a staged proposal only through the owner module's
 * native write path, D8) and `bulk_export_initiator_or_admin` (cancel/read a job by its initiator, the
 * bearer client, or a cancel-permitted operator). Every named default resolves to a predicate
 * `../../../apps/backend/src/modules/28-fhir/abac-predicates.ts` registers (M3 fails closed on an unknown
 * name — the `arch:abac-predicates` invariant).
 */
export const M28_CONTRIBUTED_PERMISSIONS = {
  // ── client registry + lifecycle (§4.1 R23-R30) ──────────────────────────────────────────────────────
  "fhir.client.read": {
    resource: "fhir_client",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "fhir.client.admin": {
    resource: "fhir_client",
    action: "admin",
    category: "admin",
    abac: "inOrg",
  },
  "fhir.client.session.read": {
    resource: "fhir_client_session",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  // ── inbound staged-proposal review (§4.1 R34-R36, D8) ───────────────────────────────────────────────
  "fhir.inbound.review": {
    resource: "fhir_inbound_resource",
    action: "review",
    category: "admin",
    abac: "inOrg",
  },
  "fhir.inbound.accept": {
    resource: "fhir_inbound_resource",
    action: "accept",
    category: "clinical",
    abac: "fhir_inbound_owner_module_match",
  },
  "fhir.inbound.reject": {
    resource: "fhir_inbound_resource",
    action: "reject",
    category: "admin",
    abac: "fhir_inbound_owner_module_match",
  },
  // ── bulk export operations (§4.1 R31-R33) ───────────────────────────────────────────────────────────
  "fhir.export.bulk.read": {
    resource: "fhir_bulk_export_job",
    action: "read",
    category: "compliance",
    abac: "inOrg",
  },
  "fhir.export.bulk.initiate": {
    resource: "fhir_bulk_export_job",
    action: "initiate",
    category: "compliance",
    abac: "inOrg",
  },
  "fhir.export.bulk.cancel": {
    resource: "fhir_bulk_export_job",
    action: "cancel",
    category: "compliance",
    abac: "bulk_export_initiator_or_admin",
  },
  // ── tenant config + capability (§4.1 R37-R39, R1) ───────────────────────────────────────────────────
  "fhir.config.read": {
    resource: "tenant_fhir_config",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "fhir.config.write": {
    resource: "tenant_fhir_config",
    action: "write",
    category: "admin",
    abac: "inOrg",
  },
  "fhir.capability.read": {
    resource: "fhir_capability_snapshot",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M28 contributed permission keys (twelve). */
export type M28ContributedPermissionKey = keyof typeof M28_CONTRIBUTED_PERMISSIONS;

/** Project the M28 contributed keys into `permission`-table mirror rows (M28 §4.6). */
export function m28ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M28_CONTRIBUTED_PERMISSIONS);
}

/**
 * Module 31 (Patient/Family Portal & Telehealth) — the forty-seven §4.6 permission keys registered into
 * M3's catalog (M31-T07). Two namespaces: the consumer-side `portal.*` keys held by portal accounts
 * (caregivers, patients-self, DPOA agents, bereaved contacts), scoped to a single
 * `(portal_account_id, patient_id)` pair by the §4.7 ABAC predicates M31 owns; and the `telehealth.*`
 * keys, split across the portal (patient/caregiver join) and staff (clinician join / recording / admin)
 * surfaces. The `abac` cell names the DEFAULT predicate the route composes — the six M31-owned predicates
 * (`portal_grant_active_for_patient` / `portal_account_active` / `portal_caregiver_is_primary_or_dpoa` /
 * `bereaved_portal_window_open` / `telehealth_consent_active` /
 * `state_two_party_recording_consent_present`), M5/M17's `caseload_membership`, or M3's intrinsic `inOrg`
 * for the org-scoped staff surfaces. It is CATALOG METADATA (mirrored to the DB `permission` row), not the
 * route's whole gate: §4.1 spells several cells as disjunctions the route composes at the guard layer.
 */
export const M31_CONTRIBUTED_PERMISSIONS = {
  // ── portal session (§4.1 rows 1-4; logout carries no key) ──────────────────────────────────────────
  "portal.session.select_patient": {
    resource: "portal_session",
    action: "select_patient",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.session.read_own": {
    resource: "portal_session",
    action: "read_own",
    category: "portal",
    abac: "portal_account_active",
  },
  "portal.session.step_up_own": {
    resource: "portal_session",
    action: "step_up_own",
    category: "portal",
    abac: "portal_account_active",
  },
  // ── portal lay-language read surfaces (§4.1) — each scoped to one active grant ──────────────────────
  "portal.care_summary.read": {
    resource: "portal_care_summary",
    action: "read",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.care_plan.read_summary": {
    resource: "portal_care_plan",
    action: "read_summary",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.discipline_plans.read_summary": {
    resource: "portal_discipline_plan",
    action: "read_summary",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.visits.read_upcoming": {
    resource: "portal_visit",
    action: "read_upcoming",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.visits.read_history": {
    resource: "portal_visit",
    action: "read_history",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.medications.read_summary": {
    resource: "portal_medication",
    action: "read_summary",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.administrations.read_summary": {
    resource: "portal_administration",
    action: "read_summary",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  // §4.1 — the only portal WRITE that touches a clinical record; TOTP step-up + the primary/DPOA gate.
  "portal.administration.attest": {
    resource: "portal_administration",
    action: "attest",
    category: "portal",
    abac: "portal_caregiver_is_primary_or_dpoa",
  },
  "portal.assessments.read_trend": {
    resource: "portal_assessment",
    action: "read_trend",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.hope.read_summary": {
    resource: "portal_hope",
    action: "read_summary",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.orders.read_summary": {
    resource: "portal_order",
    action: "read_summary",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.supplies.read_upcoming": {
    resource: "portal_supply",
    action: "read_upcoming",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.triage.read_log": {
    resource: "portal_triage",
    action: "read_log",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.triage.read_own": {
    resource: "portal_triage",
    action: "read_own",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.documents.read_list": {
    resource: "portal_document",
    action: "read_list",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.documents.download": {
    resource: "portal_document",
    action: "download",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  // §4.1 rows — upload-init + upload-complete share one key (both are the caregiver staging intake bytes).
  "portal.documents.upload": {
    resource: "portal_document",
    action: "upload",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  // §164.526 amendment request — TOTP step-up at the route.
  "portal.amendment.submit": {
    resource: "portal_amendment",
    action: "submit",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.amendment.read_own": {
    resource: "portal_amendment",
    action: "read_own",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.messages.read_channel": {
    resource: "portal_message",
    action: "read_channel",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  "portal.messages.send": {
    resource: "portal_message",
    action: "send",
    category: "portal",
    abac: "portal_grant_active_for_patient",
  },
  // ── bereavement surface (§4.1) — gated on the 13-month window ───────────────────────────────────────
  "portal.bereavement.read_program": {
    resource: "portal_bereavement",
    action: "read_program",
    category: "portal",
    abac: "bereaved_portal_window_open",
  },
  "portal.bereavement.read_resources": {
    resource: "portal_bereavement",
    action: "read_resources",
    category: "portal",
    abac: "bereaved_portal_window_open",
  },
  "portal.bereavement.opt_out_own": {
    resource: "portal_bereavement",
    action: "opt_out_own",
    category: "portal",
    abac: "bereaved_portal_window_open",
  },
  // ── notification preferences (§4.1) — the account's own settings ────────────────────────────────────
  "portal.preferences.read_own": {
    resource: "portal_preference",
    action: "read_own",
    category: "self_service",
    abac: "portal_account_active",
  },
  "portal.preferences.write_own": {
    resource: "portal_preference",
    action: "write_own",
    category: "self_service",
    abac: "portal_account_active",
  },
  // ── telehealth — portal side (§4.1) join/leave share one key ────────────────────────────────────────
  "telehealth.join_patient_or_caregiver": {
    resource: "telehealth_visit",
    action: "join_patient_or_caregiver",
    category: "telehealth",
    abac: "telehealth_consent_active",
  },
  // ── telehealth — staff side (§4.1) ──────────────────────────────────────────────────────────────────
  "telehealth.join_clinician": {
    resource: "telehealth_visit",
    action: "join_clinician",
    category: "telehealth",
    abac: "caseload_membership",
  },
  // D9-gated: only when consent + recording-default + the §3.8 state rule allow. Step-up at the route.
  "telehealth.record_start": {
    resource: "telehealth_visit",
    action: "record_start",
    category: "telehealth",
    abac: "state_two_party_recording_consent_present",
  },
  "telehealth.record_stop": {
    resource: "telehealth_visit",
    action: "record_stop",
    category: "telehealth",
    abac: "caseload_membership",
  },
  "telehealth.end_visit": {
    resource: "telehealth_visit",
    action: "end_visit",
    category: "telehealth",
    abac: "caseload_membership",
  },
  // Compliance-officer emergency stop — step-up at the route.
  "telehealth.record_halt_admin": {
    resource: "telehealth_visit",
    action: "record_halt_admin",
    category: "compliance",
    abac: "inOrg",
  },
  "telehealth.read_list": {
    resource: "telehealth_visit",
    action: "read_list",
    category: "telehealth",
    abac: "inOrg",
  },
  "telehealth.read": {
    resource: "telehealth_visit",
    action: "read",
    category: "telehealth",
    abac: "inOrg",
  },
  // ── staff admin — invitations (§4.1) ────────────────────────────────────────────────────────────────
  // Issue is on the patient's caseload (a clinician invites the family of a patient she serves).
  "portal.invitation.issue": {
    resource: "portal_invitation",
    action: "issue",
    category: "admin",
    abac: "caseload_membership",
  },
  "portal.invitation.read": {
    resource: "portal_invitation",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "portal.invitation.revoke": {
    resource: "portal_invitation",
    action: "revoke",
    category: "admin",
    abac: "inOrg",
  },
  "portal.invitation.invite_bereaved": {
    resource: "portal_invitation",
    action: "invite_bereaved",
    category: "admin",
    abac: "inOrg",
  },
  // ── staff admin — accounts (§4.1) — suspend/reinstate carry step-up at the route ────────────────────
  "portal.account.suspend": {
    resource: "portal_account",
    action: "suspend",
    category: "admin",
    abac: "inOrg",
  },
  "portal.account.reinstate": {
    resource: "portal_account",
    action: "reinstate",
    category: "admin",
    abac: "inOrg",
  },
  "portal.account.read_list": {
    resource: "portal_account",
    action: "read_list",
    category: "admin",
    abac: "inOrg",
  },
  "portal.account.read_grants": {
    resource: "portal_account",
    action: "read_grants",
    category: "admin",
    abac: "inOrg",
  },
  // §164.528 disclosure-accounting view — Compliance / Privacy Officer.
  "portal.account.read_audit": {
    resource: "portal_account",
    action: "read_audit",
    category: "compliance",
    abac: "inOrg",
  },
  // Engagement-scoped auditor surface (M3 engagement scope resolves the row set).
  "portal.engagement.read_auditor": {
    resource: "portal_engagement",
    action: "read_auditor",
    category: "compliance",
    abac: "inOrg",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M31 contributed permission keys (forty-seven). */
export type M31ContributedPermissionKey = keyof typeof M31_CONTRIBUTED_PERMISSIONS;

/** Project the M31 contributed keys into `permission`-table mirror rows (M31 §4.6). */
export function m31ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M31_CONTRIBUTED_PERMISSIONS);
}

/**
 * Module 35 (Subscription Billing) — the twenty-five §4.7 permission keys registered into M3's catalog
 * (M35-T06). Two surfaces: the tenant `subscription`/`payment_method`/`invoice`/`usage` keys held by an
 * agency's `org_admin` / `billing_admin` / `accounts_receivable` roles (org-scoped by `inOrg` or the
 * M35-owned `billing_scope_matches_org`), and the platform-ops `plan`/`subscription.admin`/`dunning`/
 * `refund`/`promo`/`revenue`/`usage.admin`/`stripe` keys held by the platform-billing roles (guarded by
 * the M35-owned `platform_billing_scope`, plus `refund_requires_step_up_approval` on refund approval and
 * `promo_applicable_to_subscription` on promo apply). The `abac` cell is CATALOG METADATA (mirrored to the
 * DB `permission` row) naming the DEFAULT predicate; the route layer composes the explicit §4.8 chain
 * (./abac-predicates) plus the §D14 step-up assertion on the mutating platform actions.
 */
export const M35_CONTRIBUTED_PERMISSIONS = {
  // ── tenant surface (§4.1) ───────────────────────────────────────────────────────────────────────────
  "subscription.read": {
    resource: "subscription",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "subscription.create": {
    resource: "subscription",
    action: "create",
    category: "billing",
    abac: "billing_scope_matches_org",
  },
  "subscription.update": {
    resource: "subscription",
    action: "update",
    category: "billing",
    abac: "billing_scope_matches_org",
  },
  "subscription.cancel": {
    resource: "subscription",
    action: "cancel",
    category: "billing",
    abac: "billing_scope_matches_org",
  },
  "payment_method.read": {
    resource: "payment_method",
    action: "read",
    category: "billing",
    abac: "inOrg",
  },
  "payment_method.write": {
    resource: "payment_method",
    action: "write",
    category: "billing",
    abac: "billing_scope_matches_org",
  },
  "invoice.read": { resource: "invoice", action: "read", category: "billing", abac: "inOrg" },
  "usage.read": { resource: "usage", action: "read", category: "billing", abac: "inOrg" },
  // ── platform-ops surface (§4.2) ─────────────────────────────────────────────────────────────────────
  "plan.admin.read": {
    resource: "plan",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "plan.admin.write": {
    resource: "plan",
    action: "admin_write",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "subscription.admin.read": {
    resource: "subscription",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "subscription.admin.write": {
    resource: "subscription",
    action: "admin_write",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "dunning.admin.read": {
    resource: "dunning",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "dunning.admin.override": {
    resource: "dunning",
    action: "override",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "refund.request": {
    resource: "refund",
    action: "request",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "refund.approve": {
    resource: "refund",
    action: "approve",
    category: "billing_admin",
    abac: "refund_requires_step_up_approval",
  },
  "refund.read": {
    resource: "refund",
    action: "read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "promo.admin.read": {
    resource: "promo",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "promo.admin.write": {
    resource: "promo",
    action: "admin_write",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "promo.admin.apply": {
    resource: "promo",
    action: "apply",
    category: "billing_admin",
    abac: "promo_applicable_to_subscription",
  },
  "promo.admin.revoke": {
    resource: "promo",
    action: "revoke",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "revenue.admin.read": {
    resource: "revenue",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "revenue.admin.write": {
    resource: "revenue",
    action: "admin_write",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "usage.admin.read": {
    resource: "usage",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "stripe.admin.read": {
    resource: "stripe_webhook",
    action: "admin_read",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
  "stripe.admin.replay": {
    resource: "stripe_webhook",
    action: "admin_replay",
    category: "billing_admin",
    abac: "platform_billing_scope",
  },
} as const satisfies Record<string, PermissionDef>;

export type M35ContributedPermissionKey = keyof typeof M35_CONTRIBUTED_PERMISSIONS;

/** Project the M35 contributed keys into `permission`-table mirror rows (M35 §4.7). */
export function m35ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M35_CONTRIBUTED_PERMISSIONS);
}

/**
 * Module 29 (External Interfaces) — the twenty-one §4.7 permission keys registered into M3's catalog
 * (M29-T08). Two audiences: the operator / compliance-officer surface (`external_interfaces.*` feed,
 * credential, proposal, message, nppes admin keys, `/api/admin/external-interfaces/*`) and the narrow
 * clinician surface (`external_interfaces.lab.*`, `/api/clinical/labs/*`). The `abac` cell names the
 * DEFAULT predicate the route composes — M3's intrinsic `inOrg` for the org-scoped feed/message/nppes-read
 * surfaces, and the six M29-owned predicates where §4.8 calls for a resource-level check
 * (`hl7_inbound_proposal_owner_module_match` on accept/reject, `external_feed_compliance_co_approver_distinct`
 * on revoke, `nppes_platform_job_caller` on the platform sync trigger, `lab_observation_patient_caseload_or_scope`
 * on the lab reads/writes). It is CATALOG METADATA mirrored to the DB `permission` row, not the route's whole
 * gate: several §4.1 routes layer a step-up gate + a second `requireAbac` the guard factory composes.
 */
export const M29_CONTRIBUTED_PERMISSIONS = {
  // ── feed onboarding + credential lifecycle (§4.1.1) ─────────────────────────────────────────────────
  "external_interfaces.feed.read": {
    resource: "external_feed",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "external_interfaces.feed.create": {
    resource: "external_feed",
    action: "create",
    category: "admin",
    abac: "inOrg",
  },
  "external_interfaces.feed.update": {
    resource: "external_feed",
    action: "update",
    category: "admin",
    abac: "inOrg",
  },
  "external_interfaces.feed.activate": {
    resource: "external_feed",
    action: "activate",
    category: "compliance",
    abac: "external_feed_baa_satisfied",
  },
  "external_interfaces.feed.suspend": {
    resource: "external_feed",
    action: "suspend",
    category: "compliance",
    abac: "inOrg",
  },
  "external_interfaces.feed.revoke": {
    resource: "external_feed",
    action: "revoke",
    category: "compliance",
    abac: "external_feed_compliance_co_approver_distinct",
  },
  "external_interfaces.credential.read": {
    resource: "external_feed_credential",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "external_interfaces.credential.rotate": {
    resource: "external_feed_credential",
    action: "rotate",
    category: "admin",
    abac: "inOrg",
  },
  // ── inbound ADT proposal review (§4.1.2) ────────────────────────────────────────────────────────────
  "external_interfaces.proposal.read": {
    resource: "hl7_inbound_proposal",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "external_interfaces.proposal.accept": {
    resource: "hl7_inbound_proposal",
    action: "accept",
    category: "clinical",
    abac: "hl7_inbound_proposal_owner_module_match",
  },
  "external_interfaces.proposal.reject": {
    resource: "hl7_inbound_proposal",
    action: "reject",
    category: "admin",
    abac: "hl7_inbound_proposal_owner_module_match",
  },
  "external_interfaces.proposal.defer": {
    resource: "hl7_inbound_proposal",
    action: "defer",
    category: "admin",
    abac: "inOrg",
  },
  // ── HL7 message search / replay / decrypt (§4.1.3) ──────────────────────────────────────────────────
  "external_interfaces.message.read": {
    resource: "hl7_message_inbound",
    action: "read",
    category: "compliance",
    abac: "inOrg",
  },
  "external_interfaces.message.read_plaintext": {
    resource: "hl7_message_inbound",
    action: "read_plaintext",
    category: "compliance",
    abac: "inOrg",
  },
  "external_interfaces.message.replay": {
    resource: "hl7_message_inbound",
    action: "replay",
    category: "compliance",
    abac: "inOrg",
  },
  "external_interfaces.message.retry": {
    resource: "hl7_message_outbound",
    action: "retry",
    category: "compliance",
    abac: "inOrg",
  },
  // ── NPPES administration (§4.1.4) ───────────────────────────────────────────────────────────────────
  "external_interfaces.nppes.read": {
    resource: "nppes_provider",
    action: "read",
    category: "admin",
    abac: "inOrg",
  },
  "external_interfaces.nppes.sync_trigger": {
    resource: "nppes_sync_run",
    action: "sync_trigger",
    category: "platform",
    abac: "nppes_platform_job_caller",
  },
  // ── clinician lab surface (§4.2) ────────────────────────────────────────────────────────────────────
  "external_interfaces.lab.read": {
    resource: "lab_observation",
    action: "read",
    category: "clinical",
    abac: "lab_observation_patient_caseload_or_scope",
  },
  "external_interfaces.lab.review_unmatched": {
    resource: "lab_observation",
    action: "review_unmatched",
    category: "clinical",
    abac: "lab_observation_patient_caseload_or_scope",
  },
  "external_interfaces.lab.acknowledge_abnormal": {
    resource: "lab_observation",
    action: "acknowledge_abnormal",
    category: "clinical",
    abac: "lab_observation_patient_caseload_or_scope",
  },
} satisfies Record<string, PermissionDef>;

/** Union of the M29 contributed permission keys (twenty-one). */
export type M29ContributedPermissionKey = keyof typeof M29_CONTRIBUTED_PERMISSIONS;

/** Project the M29 contributed keys into `permission`-table mirror rows (M29 §4.7). */
export function m29ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M29_CONTRIBUTED_PERMISSIONS);
}

/**
 * The permission keys Module 37 (Inpatient Unit / IPU Management) registers into Module 3's catalog (M37
 * §4.6). The catalog `abac` field is the DEFAULT base predicate per key — `inOrg` (canonical org scoping);
 * the route layer (M37-T11) additionally composes the fine-grained M37 predicates via requireAbac
 * (`m37.ipu.rn_coverage_active` on every mutation, `m37.irc_episode.within_cap` on IRC billing paths,
 * `m37.equipment.inspection_current` on assign, `m37.gip_criteria.attester_eligible` on attest,
 * `m37.ipu.staff_member` on unit-scoped reads). The step-up / break-glass posture (unit.create, gip attest,
 * IRC override, RN-coverage break-glass, restraint apply) is enforced at the route via requireStepUp — the
 * catalog carries only resource/action/category/abac (the M35 shape; no defaultRoles).
 */
export const M37_CONTRIBUTED_PERMISSIONS = {
  "m37.unit.read": {
    resource: "inpatient_unit",
    action: "read",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.unit.create": {
    resource: "inpatient_unit",
    action: "create",
    category: "admin",
    abac: "inOrg",
  },
  "m37.unit.update": {
    resource: "inpatient_unit",
    action: "update",
    category: "admin",
    abac: "inOrg",
  },
  "m37.room.read": { resource: "ipu_room", action: "read", category: "clinical", abac: "inOrg" },
  "m37.room.create": { resource: "ipu_room", action: "create", category: "admin", abac: "inOrg" },
  "m37.room.update": { resource: "ipu_room", action: "update", category: "admin", abac: "inOrg" },
  "m37.bed.read": { resource: "ipu_bed", action: "read", category: "clinical", abac: "inOrg" },
  "m37.bed.create": { resource: "ipu_bed", action: "create", category: "admin", abac: "inOrg" },
  "m37.bed.update": { resource: "ipu_bed", action: "update", category: "admin", abac: "inOrg" },
  "m37.bed.assign": { resource: "ipu_bed", action: "assign", category: "clinical", abac: "inOrg" },
  "m37.bed.cleaning_status_update": {
    resource: "ipu_bed",
    action: "cleaning_status_update",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.ipu_admission.read": {
    resource: "ipu_admission",
    action: "read",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.ipu_admission.create": {
    resource: "ipu_admission",
    action: "create",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.ipu_admission.transfer": {
    resource: "ipu_admission",
    action: "transfer",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.ipu_admission.discharge": {
    resource: "ipu_admission",
    action: "discharge",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.gip_criteria.attest": {
    resource: "gip_criteria",
    action: "attest",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.gip_criteria.reassess": {
    resource: "gip_criteria",
    action: "reassess",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.irc_episode.extend_override": {
    resource: "irc_episode",
    action: "extend_override",
    category: "compliance",
    abac: "inOrg",
  },
  "m37.shift.read": {
    resource: "ipu_shift",
    action: "read",
    category: "scheduling",
    abac: "inOrg",
  },
  "m37.shift.create": {
    resource: "ipu_shift",
    action: "create",
    category: "scheduling",
    abac: "inOrg",
  },
  "m37.shift.assign_staff": {
    resource: "ipu_shift",
    action: "assign_staff",
    category: "scheduling",
    abac: "inOrg",
  },
  "m37.rn_coverage.break_glass": {
    resource: "rn_coverage",
    action: "break_glass",
    category: "compliance",
    abac: "inOrg",
  },
  "m37.restraint.apply": {
    resource: "ipu_restraint",
    action: "apply",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.restraint.reassess": {
    resource: "ipu_restraint",
    action: "reassess",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.restraint.release": {
    resource: "ipu_restraint",
    action: "release",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.visitor.check_in": {
    resource: "ipu_visitor",
    action: "check_in",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.visitor.check_out": {
    resource: "ipu_visitor",
    action: "check_out",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.visitor_restriction.apply": {
    resource: "ipu_visitor_restriction",
    action: "apply",
    category: "compliance",
    abac: "inOrg",
  },
  "m37.visitor_restriction.lift": {
    resource: "ipu_visitor_restriction",
    action: "lift",
    category: "compliance",
    abac: "inOrg",
  },
  "m37.meal.log": { resource: "ipu_meal", action: "log", category: "clinical", abac: "inOrg" },
  "m37.equipment.read": {
    resource: "ipu_equipment",
    action: "read",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.equipment.create": {
    resource: "ipu_equipment",
    action: "create",
    category: "admin",
    abac: "inOrg",
  },
  "m37.equipment.update": {
    resource: "ipu_equipment",
    action: "update",
    category: "admin",
    abac: "inOrg",
  },
  "m37.equipment.maintenance_log": {
    resource: "ipu_equipment",
    action: "maintenance_log",
    category: "admin",
    abac: "inOrg",
  },
  "m37.equipment.inspection_record": {
    resource: "ipu_equipment",
    action: "inspection_record",
    category: "compliance",
    abac: "inOrg",
  },
  "m37.equipment.assign_bed": {
    resource: "ipu_equipment",
    action: "assign_bed",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.body_release.coordinate": {
    resource: "ipu_body_release",
    action: "coordinate",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.body_release.release_body": {
    resource: "ipu_body_release",
    action: "release_body",
    category: "clinical",
    abac: "inOrg",
  },
  "m37.census.read": {
    resource: "ipu_census",
    action: "read",
    category: "clinical",
    abac: "inOrg",
  },
} as const satisfies Record<string, PermissionDef>;

/** Union of the M37 contributed permission keys. */
export type M37ContributedPermissionKey = keyof typeof M37_CONTRIBUTED_PERMISSIONS;

/** Project the M37 contributed keys into `permission`-table mirror rows (M37 §4.6). */
export function m37ContributedPermissionMirrorRows(): PermissionMirrorRow[] {
  return mirrorRowsFor(M37_CONTRIBUTED_PERMISSIONS);
}

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
    ...m34ContributedPermissionMirrorRows(),
    ...m33ContributedPermissionMirrorRows(),
    ...m23ContributedPermissionMirrorRows(),
    ...m25ContributedPermissionMirrorRows(),
    ...m26ContributedPermissionMirrorRows(),
    ...m27ContributedPermissionMirrorRows(),
    ...m24ContributedPermissionMirrorRows(),
    ...m30ContributedPermissionMirrorRows(),
    ...m15ContributedPermissionMirrorRows(),
    ...m16ContributedPermissionMirrorRows(),
    ...m21ContributedPermissionMirrorRows(),
    ...m19ContributedPermissionMirrorRows(),
    ...m20ContributedPermissionMirrorRows(),
    ...m32ContributedPermissionMirrorRows(),
    ...m28ContributedPermissionMirrorRows(),
    ...m31ContributedPermissionMirrorRows(),
    ...m35ContributedPermissionMirrorRows(),
    ...m29ContributedPermissionMirrorRows(),
    ...m37ContributedPermissionMirrorRows(),
  ];
}
