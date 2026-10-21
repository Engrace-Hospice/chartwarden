# ADR-0026 — External triage-vendor operators authenticate through Better Auth (M2), not a module-local SSO

- **Status:** Proposed (requires **Security-Owner sign-off** per SEC-006 App. A.3 + an M2 spec change before the M19 edit lands)
- **Date:** 2026-06-13
- **Phase:** dispute/blocker resolution (post June-13 re-audit)
- **Resolves:** M19-F03 (BLOCKER); `audit/RE_AUDIT_BLOCKERS_2026-06-13.md`
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md); relates to [ADR-0020](ADR-0020-integration-governance.md) (vendor BAA gate)
- **Changes (on acceptance):** `CHARTWARDEN_MODULE_02_IDENTITY_SPEC_v0_4.md` (new session class + invite/issue surface), `CHARTWARDEN_MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md` (§7.5/§8.2/§9.8, task #36 — remove the module-local SSO). No `module-manifest.ts` change (M19 already consumes M2 as foundation).

## Context

M19 (On-Call Triage) supports Hybrid/Centralized deployment models where an **external triage-vendor
operator** (TouchPoint, Hospice Triage, Acclivity, etc.) takes after-hours calls and documents them
in the chart with PHI minimization (D13). These operators need to authenticate to reach a
PHI-minimized triage surface.

The v0.3 M19 spec **invented a module-local vendor-operator SSO binding** — short-lived, org-scoped,
single-use-per-session tokens minted and validated inside M19 (§7.5/§8.2/§9.8, task #36). This is
"roll-your-own authentication" outside Better Auth, which violates:
- **ARCH-050 / SD-044** — Better Auth (M2) is the single authentication surface; no module mints its
  own session tokens.
- **SEC-006 App. A.3** — any new authentication mechanism requires **Security-Owner approval**.

M2 already owns **four session classes** (`staff`, `auditor`, `external_collaborator`, `funeral_home`).
The closest, `external_collaborator`, is a **per-patient** magic-link session (a DB CHECK requires
`scope.patientId`; 8-hour default). A vendor triage operator handles **many patients across a shift**,
so the per-patient class does not fit — which is presumably why M19 reached for a bespoke token. But
the right answer is to extend M2, not to bypass it.

## Decision (recommended — pending Security-Owner sign-off)

**All external triage-vendor-operator authentication goes through Better Auth (M2). M19 mints no
session tokens.** Specifically:

1. **M2 adds a new session class `external_triage_vendor`** (the §7.6 external-collaborator pattern,
   ARCH-061/062, generalized to a vendor-shift scope): org-scoped + **vendor-bound**
   (`scope.externalTriageVendorId`) + **shift-bound** (`scope.onCallShiftId`, time-boxed to the shift
   window), MFA-enforced per SEC-006, issued/revoked by M2's standard session machinery and audited
   by M4. It is **not** per-patient (distinct from `external_collaborator`'s `scope.patientId` CHECK).
   *(M2 may instead extend `external_collaborator` with a vendor-shift scope variant if the M2 owner
   prefers — but the per-patient CHECK must not apply to the vendor case. The choice is M2's; the
   binding rule is: M2 issues it, Better Auth validates it.)*
2. **M19 retains only its authorization + projection layer** — the `external_triage_actor` ABAC
   predicate (registered with M3) and the D13 PHI-minimization projection (name + DOB + chief
   complaint + active meds with SUD redaction; never the full chart). M19 reads the M2-issued session;
   it does not issue, store, or validate any auth token.
3. The vendor↔hospice relationship that authorizes issuance is the `external_triage_vendor` row
   (M19-owned, M40-canonical vendor identity) plus the **executed vendor BAA** (ADR-0020 / INT-014).

## Alternatives considered

- **Keep the module-local SSO (status quo).** *Rejected:* roll-your-own auth violates ARCH-050 and
  SEC-006 App. A.3; it duplicates session issuance/validation/revocation outside the audited Better
  Auth surface and is a HIPAA access-control liability.
- **Reuse `external_collaborator` as-is.** *Rejected:* it is per-patient (`scope.patientId` CHECK); a
  vendor operator needs a shift-scoped, many-patient (PHI-minimized) surface.

## Consequences (on acceptance)

- **M2 spec:** add the `external_triage_vendor` session class (scope = org + vendor + shift; MFA;
  issue/revoke/list surface), or the equivalent `external_collaborator` extension. Cross-module change
  — M2 owner counter-signs.
- **M19 spec:** remove the module-local vendor SSO (§7.5/§8.2/§9.8, task #36); the vendor operator
  authenticates via the M2-issued `external_triage_vendor` session; M19 keeps `external_triage_actor`
  + the D13 PHI-minimization projection. Update the §8.3 STRIDE vendor-impersonation row to reference
  the M2 session, not a module-local token.
- **Phase gate:** the Hybrid/Centralized models stay **feature-flagged OFF** until (a) this ADR is
  Accepted with Security-Owner sign-off, **and** (b) the vendor BAA is executed (ADR-0020 / M19-F04).
- **Authority note:** until ratified, SEC-006 App. A.3 governs and M19-F03 stays OPEN; the module-local
  SSO must not ship.
