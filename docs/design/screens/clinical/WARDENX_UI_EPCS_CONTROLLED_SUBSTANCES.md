# WARDENX_UI_EPCS_CONTROLLED_SUBSTANCES

Version: 1.0
Status: Screen Specification
Module: DoseSpot Prescribing (M12)

---

## Purpose

The EPCS & Controlled Substances console is the compliance surface for electronic prescribing
of controlled substances. It governs DEA-mandated identity proofing, the per-prescription
second-factor ceremony, prescriber privileges, PDMP/PDMP-state query logging, and a tamper-
evident audit trail of every Schedule II–IV action. This is the agency's evidence that its
EPCS program meets 21 CFR 1311.

---

## Primary Users

- Prescriber (MD / DO / NP / PA with DEA registration)
- Medical Director
- Compliance / Privacy Officer
- EPCS Administrator (Office Manager)
- Pharmacist

---

## Layout Pattern

Use Work Queue.

```text
Page Header (EPCS program status · last DEA audit)
KPI Strip
Filter Bar (schedule · prescriber · action · date)
Controlled-Substance Work Table  |  Right Detail Panel (prescriber / Rx / proofing)
```

---

## KPI Cards

- Prescribers EPCS-Enabled
- Identity Proofing Expiring (≤60d)
- 2FA Failures (24h)
- PDMP Checks Pending
- Voided / Modified CS Rx (7d)

---

## Identity Proofing

- IAL2 identity-proofing status per prescriber (`Verified` / `In Progress` / `Expired`)
- Proofing method (institutional credential / third-party in-person / remote IAL2)
- Proofing date · expiration (countdown chip; warning ≤60d, alert at expiry)
- Logical-access-control approver (two-person credential grant) + grant date
- Re-proofing deep-link when expired or revoked

---

## Second-Factor Ceremony

- Per-Rx signing requires a Signature Ceremony with **step-up auth** (§7.4) — never inline.
- Two-factor of two kinds enforced: knowledge (password) **plus** one of biometric / hard
  token (FIPS 140-2) / soft token (TOTP / push). The ceremony shows which factors are bound.
- Ceremony body attests the controlled-substance content, schedule, quantity, days supply,
  and PDMP-checked confirmation before the single deliberate commit.
- Failed/abandoned 2FA renders a Guard Chip and is written to the audit trail.

---

## Prescriber Privileges

- DEA registration number (masked, last-4) + DEA schedules authorized (II / IIN / III–V)
- State license + state CDS registration (where required) with expiration countdowns
- EPCS status (`Enabled` / `Suspended` / `Not Enrolled`) and supervising-physician link for NP/PA
- Privilege mismatch (e.g., Schedule II Rx by a III–V-only prescriber) is a Blocking Dialog

---

## PDMP Query Log

- Pre-prescription PDMP check per controlled Rx: queried-by, state, timestamp, result token
- Unchecked Schedule II–IV Rx surfaces a Guard Chip deep-linking to run the check
- Multi-state query rows when patient state differs from prescriber state

---

## Controlled-Substance Audit Trail

- Immutable, hash-chained rows: `prescribed` / `modified` / `voided` / `dispensed` / `2fa_failed`
- Each row: actor, schedule, drug + quantity, factors used, PDMP token, PBM response
- Schedule II–IV rows render with `alert`-tone treatment; export to DEA audit package

---

## PBM Integration Status

- Eligibility/formulary + Surescripts controlled-substance routing health (`Connected` /
  `Degraded` / `Down`); degraded state shows a System Health-style banner, never silent failure

---

## Statuses

Rx action: `Drafted`, `PDMP-Checked`, `Signed`, `Transmitted`, `Dispensed`, `Modified`,
`Voided`, `2FA-Failed`. Prescriber EPCS: `Enabled`, `Suspended`, `Not Enrolled`, `Proofing-Expired`.

---

## Edit Rules & Sensitive Data

- DEA number and state CDS render `xx-xxxxx####`; full reveal is step-up-gated and audited.
- Signing a Schedule II–IV Rx **always** requires the two-factor Signature Ceremony; the
  commit is blocked until identity proofing is current and PDMP is checked.
- Audit-trail rows are immutable and hash-chained; no edit, no delete — corrections are new rows.
- EPCS enable/suspend is a two-person control; the granting and approving actors are both captured.
- SUD-context controlled Rx honors the §8 sealed-block redaction (M39 consent) before reveal.

---

## Actions

- Run PDMP check (step-up where state requires)
- Sign controlled Rx (2FA ceremony)
- Modify / void controlled Rx (reason captured)
- Enroll / re-proof prescriber (IAL2)
- Suspend / re-enable EPCS
- Export DEA audit package

---

## Empty State

Agency not yet EPCS-enrolled: console shows "EPCS not configured — no prescriber has completed
IAL2 proofing", with a deep-link to begin enrollment and a note that Schedule II–IV e-prescribing
is blocked until at least one prescriber is enabled.

---

## Pencil Notes

Create versions for:

- Program overview (KPIs + queue, all green)
- Prescriber detail with proofing expiring (warning countdown)
- Privilege-mismatch Blocking Dialog (Schedule II by unauthorized prescriber)
- 2FA Signature Ceremony — hard-token vs biometric vs soft-token factor
- 2FA-failed audit row (`alert` tone) + Guard Chip
- DEA number masked vs revealed (step-up)
- PDMP unchecked Guard Chip on a Schedule II draft
- PBM/Surescripts degraded-mode banner
