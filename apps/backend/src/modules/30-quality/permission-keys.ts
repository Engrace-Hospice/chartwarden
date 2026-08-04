// apps/backend/src/modules/30-quality/permission-keys.ts — M30 (§4.6 / §6).
//
// The THIRTY-THREE permission keys Module 30 (HQRP & Quality) registers into Module 3's catalog —
// the §4.6 binding cross-module handshake (M30 spec §4.6, mirrored verbatim from the pure
// `M30_PERMISSIONS` tuple in `@wardenx/quality`). M3 must include these before M30's measure / CAHPS /
// QAPI / SRA / incident / mortality / CoP / infection / risk routes (§4.1) can be authorized; those
// routes gate on `requirePermission(key)`. The catalog `abac` field is the DEFAULT predicate per key;
// the route layer additionally composes the explicit §4.7 chain M30 owns (./abac-predicates) — every
// route also passes the M3-base `inOrg` predicate, and the PHI routes layer `requirePatientScope()` +
// the row-level `part2Redisclosure` redaction on Part-2-promoted rows (§6.7).
//
// Categories (admin-UI grouping): the operator keys are `quality`; the platform/admin keys
// (recompute, audit, the two CAHPS-admin/service keys, and the `*.admin` keys) are `quality_admin`.
// (The M33 `reporting` / `reporting_admin` split precedent.)
//
// Same `resource.action` shape and DB-mirror contract as M3's own `PERMISSIONS`; kept in a dedicated
// const so each module's contribution stays attributable (§3.3 ownership). The KEYS here are kept in
// lock-step with `@wardenx/quality`'s `M30_PERMISSIONS` tuple (the pure source of truth) and the §4.1
// route inventory — `M30_PERMISSION_KEYS` below is asserted equal to `M30_PERMISSIONS` in test.
//
// REGISTRATION: this map is consumed by `@wardenx/auth`'s contributed-permission registry exactly as
// the M33 `M33_CONTRIBUTED_PERMISSIONS` map is (packages/auth/src/permissions/contributed.ts —
// `m33ContributedPermissionMirrorRows` / `allPermissionMirrorRows`). The companion mirror-row projector
// + wiring lives in that M3-owned file; this typed list is the M30-owned source of truth those rows
// project from. (Adding the `m30ContributedPermissionMirrorRows` projector is the Integrate phase's job.)
import type { PermissionDef } from "@wardenx/auth";
import { M30_PERMISSIONS } from "@wardenx/quality";

/**
 * The §4.6 permission keys M30 owns (registered into M3). Single-owner across the platform registry.
 * `as const satisfies` pins the literal keys while validating each value against `PermissionDef`; the
 * `abac` default is the dominant §4.7 predicate per key (the route composes it after the base `inOrg`).
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

/** Union of the M30 contributed permission keys (thirty-three). */
export type M30ContributedPermissionKey = keyof typeof M30_CONTRIBUTED_PERMISSIONS;

/**
 * The §4.6 permission-key names M30 owns, as an ordered literal tuple ready for registration.
 * Convenience projection of `M30_CONTRIBUTED_PERMISSIONS` keys (the boot path / auth-package mirror-row
 * projector consumes the full map; this is the flat name list for assertions/tests).
 */
export const M30_PERMISSION_KEYS = Object.keys(
  M30_CONTRIBUTED_PERMISSIONS,
) as readonly M30ContributedPermissionKey[];

/**
 * Compile-time guarantee that the contributed-catalog keys are exactly the pure `@wardenx/quality`
 * `M30_PERMISSIONS` tuple (the §4.6 source of truth). If a key is added/removed/renamed in one place
 * but not the other, the bidirectional `satisfies` below fails to type-check at build.
 */
type _KeysMatchDomainTuple = (typeof M30_PERMISSIONS)[number];
const _assertCatalogCoversDomain = M30_PERMISSION_KEYS satisfies readonly _KeysMatchDomainTuple[];
const _assertDomainCoversCatalog = M30_PERMISSIONS satisfies readonly M30ContributedPermissionKey[];
void _assertCatalogCoversDomain;
void _assertDomainCoversCatalog;

/** Back-compat alias — the spec refers to the registered array as `M30_PERMISSIONS` (the §4.6 list). */
export const M30_PERMISSION_KEY_LIST = M30_PERMISSION_KEYS;
