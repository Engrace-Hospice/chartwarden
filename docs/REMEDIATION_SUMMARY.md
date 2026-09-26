# WardenX Architecture Remediation — Summary (Phases 0–6)

**Date:** 2026-06-11
**Driver:** `audit/AUDIT_CONSOLIDATED_FINAL.md` (38/40 modules FAIL; ~94 BLOCKER + ~312 MAJOR across
12 systemic patterns X1–X12, plus S1–S17 security, H1–H8 HIPAA, Medicare, and build-blocking issues).
**Authoritative decisions:** 23 ADRs under [`docs/adr/`](adr/README.md).

This document is the capstone for the top-down remediation. Per the auditor protocol, *architecture
documents are authoritative and module specs are proposals* — several BLOCKERs originated in the
architecture documents, so the remediation began there and flowed down.

## The remediation model

Each phase used the same three tools, applied where each fits best:

1. **ADRs** — the durable, authoritative decision records. A correction that multiple modules share
   is pinned once as an ADR; the architecture docs and module specs cite it.
2. **Concrete spec edits** — where a BLOCKER is a clean single anchor (a wrong RLS variable, a clock
   anchored to the wrong field, a missing seam section), it is fixed in place with finding-ID + ADR
   citations and a per-module Remediation Changelog.
3. **CI-gated sweeps** — corpus-wide mechanical work (tenancy columns, illegal DDL, template
   sections) is made **enforceable** by a fitness check rather than hand-edited across ~50 large
   docs. The build stays red until each module conforms — the honest, durable form of "swept."

## Phase-by-phase

| Phase | Scope | Key deliverables |
|---|---|---|
| **0** | Architecture + manifest baseline | Medicare encodings (RHC day-60, cap year, R&B 0658); OPEN-020/021/022; manifest 22↔39 cycle; seam-no-import + `packages/foundation` ban + foundation-helper reachability. **ADR-0001…0009.** Architecture → v0.12. |
| **1** | Foundation tier M01–M04 re-lock | Seam registry + `validateSeams()` boot gate (M01 §3.18); `withPlatformContext` isolation; RLS `OR IS NULL` fix; retention 6→7; **step-up contract resync (M02↔M03 BLOCKER)**; permission-key contract + `system_locked` role floor; M04 seam inversion + SECURITY DEFINER + bulk-export. |
| **2** | Platform invariants | **ADR-0010/0011** + **`check-tenancy.ts` (#10)** + ownership-evasion checks (#11); **M34** fixed as the reference tenancy implementation (3 BLOCKERs); RLS-variable + ownership-evasion fixes on M33/M21/M40/M11/M30/M38/M24. |
| **3** | Governed subsystems | **ADR-0012/0013/0014**; **M32 AI Platform** (auto kill-switch, eval-gated local model, restored `ai.*` events); §164.528 disclosure-writer assignment; **M39** consent/disclosure separation; **M29** persist-after-redact; **M08** false-BAA struck. |
| **4** | Medicare/Medicaid correctness | **ADR-0015…0019**; M06 election/cert (6 BLOCKERs); M23 claim math + 837I + late-NOE; M24 Medicaid R&B/cap; M10 **HOPE SFV visit-date anchor** (swept); M14/M07 IDG clock + MD/DO seat; M37 IPU fail-open; M11/M12/M13 **lawful non-EPCS controlled-substance path**. |
| **5** | Integration governance | **ADR-0020**; 8 uncatalogued surfaces added to `WARDENX_INTEGRATIONS` (→ v0.2) with BAA register + degraded-mode; **INT-014 BAA execution as a hard gate** before PHI flows; banners on M18/M21/M22/M19/M02/M11/M12/M30. |
| **6** | Per-spec reconciliation + sweeps | **ADR-0021/0022/0023** + **`check-ddl-legality.ts` (#12)**; §20.B template requirements CI-gated; **every X9 incoherent spec the audit flagged (M16/M17/M36/M15/M25/M20) had its DDL/single-truth contradictions reconciled** (DDL-legal; gated by `check-ddl-legality.ts`). **They are not yet formally re-locked** — the 2026-06-13 re-audits still grade several FAIL on non-DDL findings (see `audit/OPEN_BLOCKERS_LEDGER.md`). |
| **post-6** | Layout reorg + worked reconciliations | Fitness kit moved to `architecture/` + `scripts/` with a root `package.json`; `arch:fitness` runs end-to-end. **All six flagged X9 specs fully reconciled:** **M16 Bereavement** (v0.5 — 16 findings), **M17 Scheduling** (v0.3 — 19; two contradictory 8-state machines unified), **M36 Messaging** (v0.5 — 14; two alert subsystems unified, migration-breaking duplicate enum fixed), **M15 Discipline Care Plans** (v0.3 — 12; CoP volunteer ratio fixed to hours÷hours, illegal partitioning removed), **M25 Remittance** (v0.3 — 18; all 3 BLOCKERs cleared, §2/§3/§4 made the single truth, redetermination clock fixed), and **M20 Field Safety** (v0.3 — 17; the life-safety **SOS terminus + non-suppressible delivery (S13)** added, the feature-forbidding unique index re-keyed, PostGIS-on-frozen-M1 removed). |

## CI fitness surface (the enforcement backbone)

`arch:fitness` = `arch:boundaries` + `arch:tables` + `arch:tenancy` + `arch:ddl`. Checks (see
[`ARCHITECTURE_25_15_FITNESS.md`](../ARCHITECTURE_25_15_FITNESS.md)):

1–7 module boundaries / adapter mandate / domain+FHIR direction / leaves / helper-only tables /
table ownership / no-cycles · 8–9 explicit-authz + read-audit (Biome) · **10 tenancy invariants
(ADR-0010)** · **11 ownership evasions + RLS bypass (ADR-0011)** · **12 PostgreSQL DDL legality
(ADR-0022)**. The §20.B template requirements (ADR-0021) are template-completeness lints.

## What is pinned vs. what remains module build-reconciliation

**Pinned and/or fixed now:** every systemic pattern (X1–X12) has an authoritative ruling; every
architecture-origin BLOCKER is corrected in the architecture docs; the foundation tier is re-locked;
the reference tenancy module (M34), the AI substrate (M32), and the HIPAA disclosure/Part 2 layer are
fixed; the Medicare/Medicaid regulatory contracts are pinned; the integration catalog is complete;
the CI checks that gate the remaining sweeps are in place and validated.

**Remains as per-module build reconciliation (now CI-gated, not hopeful):**
- the tenancy three-column rule (gated by `check-tenancy.ts`) is now **swept across every PHI module
  the audit flagged.** Worked, in order:
  - **M05 Patient (v0.5)** — 16 PHI tables, PE/location **nullable** (org-level until admission);
    `location_scope` now reads `patient.location_id` (M05-F04).
  - **M08 Encounters (v0.4)** — 10 PHI tables, PE/location **NOT NULL** (location-anchored clinical
    events), driving M23 site-of-service Q-codes + M33 multi-CCN reporting (M08-F03 **BLOCKER**).
  - **M11 Orders (v0.5)** — 7 PHI tables, **NOT NULL**, denormalized from admission (Q-code/claim
    attribution) (M11-F04).
  - **M07 Care Plan (v0.3)** — 6 PHI tables, **NOT NULL** from admission; enables Location-scoped IDG
    + overdue/quorum dashboards without illegal M5/M6 joins (M07-F06); RLS also fixed to `app.org_id`
    + `WITH CHECK` (M07-F08).
  - **M09 Clinical Assessments (v0.3)** — the **3 patient-level PHI tables** (`clinical_assessment`,
    `assessment_cosignature`, `significant_change_event`) **NOT NULL** from admission/parent; the 2
    org-level config tables (`scale_license`, `scale_policy`) correctly excluded (M09-F03).
  - **M10 HOPE (v0.3)** — the **4 PHI tables** **NOT NULL**; HOPE is per-ProviderEntity, so this
    removes the illegal join-through-M6 the per-PE batch assembler needed; `hope_submission` already
    had PE, `hope_submission_item` is a join row (M10-F09).
  - **M24 Billing-Medicaid (v0.2.3)** — the **5 primary patient-billing tables** get all three (PE NOT
    NULL where derivable, nullable on `medicaid_eligibility_check`; `location_id` nullable throughout —
    Medicaid is CCN-attributed); the claim-subtree children inherit PE from the PE-scoped root claim,
    the 2 config catalogs excluded; `medicaid_claim_line` also gains its F12 partition-key column
    (M24-F21).
  - **M21 Supplies/DME (v0.4)** — PE/location added to the patient-scoped tables in **both** schema
    halves (supply costs roll per-CCN to M27, dispatch is Location-scoped) (M21-F06), as part of the
    **F04 two-schema reconciliation now completed** (see below).
  - **M14 IDG** and **M31 Portal/Telehealth** — **no ARCH-011 finding**, correctly: M14's PHI tables
    are **Location-scoped** (`idg_meeting` carries `organization_id` + `location_id`, PE derivable from
    location) and M31's are **org-level** (`portal_account`) or **scope-inherited** (`telehealth_visit`
    soft-refs the M17 visit; `portal_access_grant` via patient). No columns added; instead the
    wrong-RLS-variable defects each carried were fixed — M14 `app.organization_id`→`app.org_id` +
    `WITH CHECK` on the notification-overlay policy; M31-F09 `app.tenant_id`/`tenant_id`→`app.org_id`
    in the §8.2 RLS prose.

  Pattern summary: M05 is the nullable (org-level-spine) case; M08/M11/M07/M09/M10 the NOT-NULL
  (clinical-event) case; M24/M21 the billing/supply case (PE-scoped root + selective columns); M14/M31
  the correctly-not-applicable case (defect-fix only).
- **M21-F04 two-schema reconciliation (BLOCKER → resolved).** M21 had defined "two materially
  different databases" — a §3.1 SQL migration and a §3.2 Drizzle schema that had drifted (dropped
  controlled-substance columns, forked enums + state machines). Resolved via a new normative **§3.0**:
  the **§3.1 SQL migration is the single source of truth**; §3.2 Drizzle is its generated 1:1 mirror
  (CI drift test W-M21-SCHEMA). Every audit-named divergence resolves in favor of §3.1's
  regulatorily-complete model (controlled-substance-only lot tracking, `medication_order_id`,
  `controlled_substance_handling_policy_digest`, witness-distinctness CHECKs, SUPPORT-Act
  `quantity_disposed_at_home`, the `m21_return_state` chain-of-custody machine, partition PKs); the one
  Drizzle-only load-bearing enum (`m21_comfort_kit_dispatch_status`) is folded **into** §3.1; the
  placeholder/`DROP` round-trip on `comfort_kit_returned_content` is collapsed to one clean definition;
  the `supply_request_status` (`cancellation_pending`) and `deployment_site` (`snf_residence`) enum
  forks and the `Type.Literal('snf')` payload are corrected; `vendor_routing_rule` follows D4
  single-resolution (fallback model removed); `par_stock` follows the `reorder_point` model
  (`currentSeverity` derived). F06 PE/location now present in **both** halves. (The `org_id`→
  `organization_id` rename stays tracked as a cosmetic normalization — both halves agree on `org_id`,
  so it was never part of the divergence.)
- **Manifest `ownedTables` pass (M07-F02 + analogues → CLOSED, all 40 modules).** `ownedTables` is now
  populated for **all 40 modules — 453 tables** (was 451; +2 M35 platform-retention tables per M35-F06,
  ADR-0011/ARCH-251) — in **both** `module-manifest.ts` and `.cjs` (verified
  byte-consistent), extracted directly from each spec's `pgTable` / `CREATE TABLE` declarations with a
  cross-module collision check (no table is claimed by two modules). `check-table-ownership` (#11) now
  **enforces the full corpus** rather than "enforcing only what is declared," and the suite stays
  **green** — confirming no module reaches into another's tables. The manifest header comment is updated
  to reflect the completed state.
- the illegal-DDL fixes + X9 single-truth reconciliation per spec (gated by `check-ddl-legality.ts`;
  M17/M16/M25/M36/M15/M20 are explicitly marked **NOT re-locked**);
- the §20.B template sections (idempotency/queue-DLQ/STRIDE/DR-tier/SEC-052/cursor/sqlcipher) per
  module;
- the deep tabular build-out the ADRs pin but do not enumerate (CMS rate tables, the full 837I field
  map, Medicaid state-rate schedules, the 28 cost-report rules, the §6 per-integration contract prose
  for the 8 new surfaces);
- the **out-of-band legal/operational actions** the docs now *gate on*: BAA/ZDR/QSOA execution
  (Anthropic, EVV aggregator, DME/pharmacy, print/mail, triage), and the Security-Owner sign-offs.

## Known pre-existing items (flagged)

- **Fitness-kit layout — RESOLVED (2026-06-11).** The kit now lives in its intended layout:
  `architecture/module-manifest.{ts,cjs}` + `architecture/.dependency-cruiser.cjs` (sibling require),
  and `scripts/check-{table-ownership,tenancy,ddl-legality}.ts` (importing `../architecture/module-manifest`),
  wired by the root `package.json` `arch:*` scripts. The three `bun`-run checks run **end-to-end
  today**; `arch:boundaries` (dependency-cruiser) additionally needs `bun install` and the
  `apps`/`packages` source tree.
- **`arch:boundaries` is structurally inapplicable to this corpus (confirmed 2026-06-11).** Running
  `bun run arch:fitness` here exits non-zero at its first step: `depcruise apps packages` fails with
  `ERROR: Can't open 'apps' for reading` because this repo is the **architecture/spec corpus**, not
  the implementation repo — there is no `apps/`/`packages/` TypeScript tree to scan. (`bun install`
  resolves `dependency-cruiser@16` fine, so the tool is not the blocker; the absent source tree is.)
  The boundary check is green-by-construction only in the code repo. The three spec-level checks
  (`arch:tables` #11, `arch:tenancy` #10, `arch:ddl` #12) — which carry all of this remediation —
  pass end-to-end here.
- **Corpus kept source-only (2026-06-11).** The `node_modules/` + `bun.lock` produced by that
  `bun install` were **removed** so the corpus stays spec-sources-plus-fitness-kit only; the
  `dependency-cruiser` devDep stays declared in `package.json`, so `bun install` reproduces the tool
  on demand in the implementation repo. The three `bun`-run checks need no installed deps and still
  pass after cleanup.
- `WARDENX_MODULE_21_…` has a pre-existing odd code-fence count (not introduced by the remediation).

## Re-lock gate

No module is honored as "Locked" until it (a) passes `arch:fitness` (checks 1–12), (b) carries its
§20.B template sections, (c) has a single coherent schema/workflow/event/permission story, and (d)
has every consumed seam matched by a producer (ADR-0023). The architecture docs (v0.12) and the
23 ADRs are the authoritative baseline every re-lock conforms to.
