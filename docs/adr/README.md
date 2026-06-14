# WardenX Architecture Decision Records (ADRs)

These ADRs are the authoritative decision records produced by the **Phase 0 remediation**
of the WardenX architecture corpus, in response to the consolidated compliance audit
(`audit/AUDIT_CONSOLIDATED_FINAL.md`, 2026-06-11) and the per-module audits
(`audit/AUDIT_M*.md`).

**Authority.** Per the auditor protocol, *architecture documents are authoritative and module
specs are proposals.* Several BLOCKER findings originate in the architecture documents
themselves; those documents have been corrected in place, and each correction is recorded
here as an ADR. Where an ADR and an older sentence in a spec disagree, **the ADR wins** until
the spec is re-locked against it.

**How corrections are recorded.** Each touched document carries an in-place edit plus a dated
*Remediation Changelog* section that cites the relevant ADR(s) and audit finding ID(s). The
ADRs below are the normative rationale those changelogs point to.

## Index

| ADR | Title | Resolves | Status |
|----|-------|----------|--------|
| [0001](ADR-0001-rhc-two-tier-rate.md) | Medicare RHC two-tier (day-60) rate; remove HIPPS-on-hospice construct; SIA mechanics | M23-F01/F02/F03, X-Medicare, BB#9 | Accepted |
| [0002](ADR-0002-hospice-cap-year.md) | Hospice aggregate-cap accounting year = Oct 1 – Sep 30 | M23-F14, M26, ARCH-178, BB#9 | Accepted |
| [0003](ADR-0003-room-and-board-revenue-code.md) | Hospice room & board revenue code 0658 (replace 0294) | M24, BB#9 | Accepted |
| [0004](ADR-0004-retention-and-session-conflicts.md) | OPEN-020 session lifetimes; OPEN-021 clinical retention = 7 yr; OPEN-022 retention-override owner = M4 | OPEN-020/021/022, M01-F03, M02-F11, X5 | Accepted |
| [0005](ADR-0005-manifest-single-source-of-truth.md) | Manifest as single source of truth: seam/outbox consumption needs no import edge; ban `packages/foundation`; seam interfaces in `packages/types`; foundation-helper reachability; consolidated-ADR-per-module rule | X1, X2, X12, M01-F01, M02-F03, M03-F02/F07, M09-F01, M10-F01, BB#1/#3/#4 | Accepted |
| [0006](ADR-0006-resolve-manifest-22-39-cycle.md) | Resolve the manifest's own 22↔39 dependency cycle | M22-DC1, M22-F01, X1, BB#1 | Accepted |
| [0007](ADR-0007-m8-m9-m10-read-direction.md) | M8↔M9/M10 read direction: M9/M10 are downstream of M8; M8 consults completeness via boot-registered seams (no inversion) | M09-F02/DC1, M10-F03, X10, BB#6/#9 | Accepted |
| [0008](ADR-0008-evv-applicability.md) | EVV applicability: Cures Act is Medicaid-only; Medicare-hospice EVV is operational and never claim-blocking; launch state is Oregon; HQRP has no EVV measure | M18-F04/F05, M24, X-Medicare, BB#9 | Accepted |
| [0009](ADR-0009-phase-dr-int-tier-discipline.md) | §20.A phase / DR-tier / INT-tier discipline; later-phase early-build requires ADR + flag + degraded fallback | M15/M17/M18/M19/M20/M21/M26/M27/M28/M30/M33/M37 phase-cut findings, BB#8 | Accepted |
| [0010](ADR-0010-tenancy-rls-invariants.md) | Tenancy & RLS invariants: 3-column rule, `app.org_id` canonical, generated-only policies, mixed-variable test (corpus-wide, CI-gated) | X3, X4, S1, S5, M34-F02, M33/M21/M24 RLS | Accepted |
| [0011](ADR-0011-ownership-inversion-rls-bypass.md) | Ownership inversion & RLS-bypass discipline: no direct cross-module table access by any mechanism; `withPlatformContext` needs an org predicate | X6, S8, M40-F01, M11-F03, M30-F01, M38-F01 | Accepted |
| [0012](ADR-0012-ai-governance-contract.md) | AI governance: auto kill-switch at drift, eval/calibration gate, mandatory `ai.*` audit events, BAA+ZDR gate; every AI feature registers + gates against M32 | X7, M32-F01/F02/F03, M08-F01 | Accepted |
| [0013](ADR-0013-disclosure-accounting-writer.md) | §164.528 accounting: M4 owns the sink; the disclosing module writes the record at each egress; consent-evaluation ≠ disclosure | H1, M39-F03, M32-F08, M28/M22/M29/M05 egress | Accepted |
| [0014](ADR-0014-part2-disclosure-gate.md) | 42 CFR Part 2: gate disclosure not creation; persist-after-redact at ingress; enforced re-disclosure gate | H2, S11, M29-F03, M39-F05, M09/M06/M19 | Accepted |
| [0015](ADR-0015-election-certification.md) | Hospice election & certification: addendum, verbal→written cert timing, one-statement-per-election, late-F2F, discharge order+NOMNC, transfer statement | M06-F02/F03/F04/F05/F09/F10 | Accepted |
| [0016](ADR-0016-medicare-claim-correctness.md) | Medicare claim correctness: base-rate+CBSA labor-share, CHC 15-min/IRC repricing, 837I wire content, late-NOE provider-liability | M23-F02/F04/F05/F09/F13/F15 | Accepted |
| [0017](ADR-0017-medicaid-rb-and-cap.md) | Medicaid R&B ≥95% NF (0658), patient liability, TPL/crossover/retro/timely-filing; Medicaid not to Medicare cap; cap composition | M24-F02/F04/F05/F06/F08, M26 | Accepted |
| [0018](ADR-0018-hope-idg-ipu-clocks.md) | HOPE SFV visit-date anchor + J-codes + iQIES; IDG 15-day per-patient clock + MD/DO seat; IPU LOC + RN-coverage fail-open | M10-F02/F06/F07, M30-F04, M14-F01, M07-F01, M37-F03/F08/F11/F12 | Accepted |
| [0019](ADR-0019-controlled-substance-go-live.md) | Lawful Phase-1 non-EPCS controlled-substance path; authenticated standing orders; SUPPORT Act disposal; witness scope | M12-F02, M13-F03/F04/F05, M11-F02 | Accepted |
| [0020](ADR-0020-integration-governance.md) | Integration governance: INT-002 mandatory before adapter merge; INT-014 BAA execution hard gate before PHI flows; SEC-099 vendor review; 8 surfaces catalogued | X8, H5, M18-F01, M21, M22, M19, M02-F10, M11, M30 | Accepted |
| [0021](ADR-0021-template-sweep.md) | §20.B template requirements CI-gated: per-route Idempotency-Key, queue DLQ/retry, STRIDE, DR tier+degraded-mode, SEC-052, cursor pagination, sqlcipher offline | X11 | Accepted |
| [0022](ADR-0022-postgresql-ddl-legality.md) | PostgreSQL DDL legality (partition-key in unique index; no CHECK subqueries; no duplicate enums) + one reconciliation pass per X9 incoherent spec | X9, BB#5, M14/M15/M16/M20/M22/M24, M21/M17/M36… | Accepted |
| [0023](ADR-0023-seam-pair-reconciliation.md) | Every consumer↔producer seam pair reconciled before "Locked"; M2 surface inflation adjudicated | X10, X12, M13/M14/M15/M19/M25 | Accepted |
| [0024](ADR-0024-m14-notification-composition-ownership.md) | Notification composition & recipient resolution for cross-module events → M36, not M14 (SD-017) | M14-F04 | Accepted |
| [0025](ADR-0025-m34-m35-dependency-direction.md) | M34↔M35 is a bidirectional seam relationship — no `dependsOn` edge either way | M35-F02 | Accepted |
| [0026](ADR-0026-m19-vendor-operator-auth-via-better-auth.md) | External triage-vendor operators authenticate via Better Auth (new M2 session class), not a module-local SSO | M19-F03 | **Proposed** (needs Security-Owner sign-off) |

*BB# = "Build Blocking Issues" item number in `audit/AUDIT_CONSOLIDATED_FINAL.md`.*

## Conventions

- ADRs are immutable once Accepted. A later decision **supersedes** rather than edits a prior one.
- Each ADR lists the documents it changes; those documents' Remediation Changelogs cite the ADR.
- Phase 1+ module re-locks must conform to these ADRs and cite them in their own changelogs.
