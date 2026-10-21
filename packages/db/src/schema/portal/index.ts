// @chartwarden/db — M31 Patient/Family Portal & Telehealth schema barrel (§3.1/§3.3, M31-T02). The central
// ../index.ts re-exports this barrel; the five pgEnums live in ../../enums.ts.
//
// SCOPE (authority: architecture/module-manifest.ts wins over the spec §2 15-entity ERD — ADR-0005). The
// manifest owns exactly THREE tables, so this barrel ships exactly three:
//   • portal_account       — D2's account root (one per org × M2 user × relationship). NOT patient-scoped
//                            (per-patient access is a separate grant), so no PE/location; contact PHI is
//                            envelope-encrypted + §3.6 audit-denylisted.
//   • portal_access_grant  — D5/D6/D7's per-patient authorization (scope set + M39 consent provenance).
//                            Patient-bearing → carries the ARCH-011 provider_entity_id + location_id.
//   • telehealth_visit     — D8/D14's video-visit root, unique per M17 visit. Patient-bearing → carries
//                            provider_entity_id + location_id; M8 attaches the encounter on visit_ended.
//
// TENANCY: all three carry organization_id NOT NULL and RLS keys on app.org_id ALONE (0139). The two
// patient-bearing tables add provider_entity_id NOT NULL + location_id (nullable) per ARCH-011 — the spec
// §3.3 sketch omits them, but the three-column rule is authoritative (check-tenancy enforces it).
//
// MIGRATIONS: enums + the three tables + indexes/CHECKs land in 0138; RLS, grants and the M4 write-audit
// triggers (D11 §3.6 denylists) in 0139. The spec's wider §2.1 entities (invitations, sessions, uploads,
// recordings, webhook events, …) were NOT manifest-owned in that reduced scope. GAP-092 (migrations 0422–0424) adds the
// three the portal's write surfaces cannot do without — invitations (account + grant creation), encrypted upload
// staging, and notification preferences — each registered in the manifest `ownedTables` (the manifest is authoritative).

export * from "./portal-accounts"; // portal_account
export * from "./portal-access-grants"; // portal_access_grant
export * from "./telehealth-visits"; // telehealth_visit
export * from "./portal-invitations"; // portal_invitation (0424)
export * from "./portal-document-uploads"; // portal_document_upload (0423)
export * from "./portal-notification-preferences"; // portal_notification_preference (0422)
