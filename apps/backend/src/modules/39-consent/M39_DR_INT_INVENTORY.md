# M39 Consent — DR Posture, Integration Inventory, STRIDE (M39-T10)

## 1. Disaster-Recovery posture — **Tier 1 (critical path)**

M39 is the disclosure/redaction gate every PHI-egress module consults synchronously (M28 FHIR, M22
disclosure subsetter, M5 right-of-access, M27/M30/M33 aggregates, M29 interop) and the source of the
eleven ABAC predicates the clinical stack gates on. A `ConsentEvaluator` outage **fails closed**: an
unresolved seam denies (the M1 deny-stub throws; the §4.3.1 redaction flags default to `redact`), so
a degraded M39 over-restricts rather than leaking PHI. Targets: **RPO ≤ 5 min**, **RTO ≤ 15 min**.

- `consent_record` + its joins are the system of record — restored from the M1 Postgres PITR stream.
- `consent_eval_audit` is monthly-partitioned, INSERT-only, and append-heavy; partition loss degrades
  *historical reconstruction* but not the live gate (the gate reads `consent_record`, not the audit).
- The `delegated_access` projection is rebuildable from `consent_record_recipient` (D10) — a lost
  projection is re-derived by the projector, not restored.

## 2. Integration inventory

M39 has **no direct external (off-perimeter) integration** — it is an internal platform gate. Its
cross-module touchpoints are all in-perimeter seams / outbox:

| Counterparty | Direction | Mechanism | PHI | Tier |
|---|---|---|---|---|
| M5 Patient | consume `PatientReader`; publish `m39.consent.signed/revoked` → snapshot recompute | seam + outbox | yes (patient id) | 1 |
| M22 Documents | consume `DocumentRenderer` (D15 signed PDF); consume `m22.document.rendered` | forward seam (deny-stub) + outbox | yes | 1 |
| M28 FHIR Gateway | consumes `evaluateForDisclosure` on every egress | seam | yes | 1 |
| M36 Messaging | publish 5 typed alert payloads (§4.10) | alert registry | no (PHI-free by §4.7) | 2 |
| M3 Authorization | register 15 permission keys + 11 ABAC predicate resolvers | catalog + registry | no | 1 |
| M4 Audit | write-audit triggers + the `consent` destruction-cert eraser + `m39.*` action catalog | trigger + registry | yes | 1 |

No third-party API, no scheduled external feed (contrast M40's NPPES). The only background jobs are
internal crons (§4.9: reminder / expiration / cascade-retry / partition rotation). **Built (F-216):** the two
hourly outbox-producing crons — `m39.consent_expiration` (active + lapsed → `expired`, emits
`m39.consent.expired` in the same tx) and `m39.expiration_reminder` (90/30/14/7/1-day windows per the type's
cadence floor → `consent_expiration_reminder` row + `m39.consent.expiring_soon`) — live under
`apps/backend/src/modules/39-consent/jobs/`, fan out per active org under the allowlisted platform job id
`m39.platform_crons`, and bound a first-run backlog (`M39_CRON_BOUNDS`). Cascade-retry, renewal-cycle-close,
draft-auto-expire and eval-audit-partition remain unbuilt.

## 3. STRIDE highlights (§8.5)

- **Spoofing** — every route binds org server-side (`request.context`, never the body); cross-tenant
  reads/writes blocked by RLS (`app.org_id`) proven on real Postgres (T03 live suite). DPOA grantor
  authority is chain-validated (D5) — a forged agent cannot self-appoint (self-FK refusal + DB CHECK).
- **Tampering** — `consent_eval_audit` is INSERT-only (trg_cea_immutable); consent records are
  append-only with supersession chains (no in-place edit); write-audit triggers capture every mutation
  with PHI/ciphertext scrubbed off the diff (denylist).
- **Repudiation** — the consent-version-aware `consent_eval_audit` reconstructs *what the system knew
  about consent on date X when staff accessed record Y* (D12); signed-PDF artifact via M22 (D15).
- **Information disclosure** — the §4.3.1 redaction flags are **fail-closed** (SUD decided by M39;
  HIV/MH/genetic delegated to M5 PrivacyFlag → default redact); 42 CFR Part 2 per-recipient gating;
  `internal_notes_cipher` is per-tenant DEK envelope-encrypted; the eraser **refuses** to destroy a
  Part 2 consent during the patient's lifetime.
- **Denial of service** — eval path indexed for p95 ≤ 30 ms; PHI list/audit routes are cursor-paginated
  (§4.12, never offset) so a large `consent_eval_audit` cannot be walked into a quadratic scan.
- **Elevation of privilege** — sign/supersede/revoke/overlay/admin routes require step-up
  (`consent_management` profile); canonical platform writes (catalog) locked to the
  `consent_catalog_writer` role (DB grant + route omission); the D17 AI-block validator refuses any
  M32 prompt template that would create/modify/revoke/evaluate consent.

## 4. Screens — DEFERRED

The §5 web + Capacitor screens DEFER: the M39 manifest has no `apps/web` codePath (the Wave-A
deferral rule — a screen needs a manifest UI codePath to land). The consent-capture wizard, the
version-chain viewer, the overlay console, and the eval-audit surface are tracked for the ADR-0030
`apps/web` follow-up. The portal variants (§5.3) are Phase 2 (M31).
