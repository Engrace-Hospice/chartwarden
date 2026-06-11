# WARDENX ARCHITECTURE COMPLIANCE AUDIT — CONSOLIDATED FINAL REPORT

**Scope:** All 40 module specifications audited against the authoritative architecture set — WARDENX_ARCHITECTURE_v0.11, SYSTEM_DESIGN_v0.3, SECURITY_HARDENING_v0.2, AI_GOVERNANCE_v0.2, DR_BCP_v0.1, OPS_RUNBOOK_v0.1, INTEGRATIONS_v0.1 — plus ARCHITECTURE_25_15_FITNESS, MODULE_MANIFEST (`module-manifest.ts`), TABLE_OWNERSHIP_CHECKER (`check-table-ownership.ts`), and the SEAM_REGISTRY.
**Method:** Per-module deep audits under the shared auditor protocol (`audit/_criteria/AUDITOR_INSTRUCTIONS.md` v1.0), dimensions A–J, BLOCKER findings verified against the source documents directly. Architecture documents are authoritative; where a module conflicts with architecture, the finding is recorded against the module.
**Per-module evidence:** `audit/AUDIT_M*.md` (29 files; finding IDs `M<NN>-F<seq>`).
**Date:** 2026-06-11

---

# Executive Summary

**The platform is not buildable or shippable as specified. 38 of 40 modules FAIL; 2 carry MAJOR gaps; none passes clean.** Across the corpus there are **~94 BLOCKER** and **~312 MAJOR** findings. The defects are not isolated module quality issues — they cluster into roughly a dozen **systemic patterns** that repeat in nearly every spec, which means the corpus must be remediated as a whole (architecture-level ADRs and a platform-wide sweep) before any module can be re-locked.

The five highest-order problems:

1. **The dependency manifest — the architecture's single source of truth for module boundaries — has been quietly rewritten by almost every module, designing in at least ten dependency cycles** (23⇄26, 12⇄28, 13⇄28, 24⇄26/28, 22→6→39→22, 36→5/11, 40⇄29, 6→29→11, 11→29, 37) that fail the `no-circular` CI fitness check by construction. The manifest *itself* contains a 22↔39 cycle. Most modules cite a "lock-time manifest patch precedent" that auditors verified **does not exist**.

2. **The foundation tier (M01–M04) FAILS, and it is the frozen surface all 36 other modules build against.** The seam bootstrap (`validateSeams()`, the `eraseFn`/`DataEraser` registry, `CaseloadProvider` wiring) — the boot-time gate the whole architecture relies on — is specified by **no module**. Two *locked* foundation specs (M02, M03) are mutually desynchronized on the step-up predicate contract. The permission-key compile-time contract and the role catalog/`system_locked` floor are undefined.

3. **The Medicare payment and election/certification model is encoded wrong in ways that produce noncompliant claims and care on day one.** The hospice RHC two-tier rate, SIA mechanics, wage-index basis, CHC unit model, the 837I claim wire-content, and the late-NOE consequence are all wrong or incomplete (M23, 6 blockers). The election-statement addendum (a condition of payment) is entirely absent (M06). The cap year is wrong (M23/M26). The HOPE SFV clock anchor silently under-reports HQRP non-compliance (M10). Several of these errors **originate in the architecture document itself** and need corrective ADRs.

4. **The controlled-substance path does not work at go-live.** EPCS is deferred to Phase 3, but no lawful Phase-1 non-EPCS path exists, so **no Schedule II–V medication — the core hospice comfort-kit opioids — can be ordered, signed, activated, or administered in-system** (M12, M13). The AI Platform that governs every AI feature (M32) itself FAILS: a mandatory automatic kill-switch is downgraded to human discretion, an un-evaluated local model ships hot in production, and mandatory AI audit events are renamed/omitted.

5. **HIPAA and security invariants are broken at the layers that define them.** The multi-tenancy module (M34) — which defines the `org_id`/RLS invariant every other table inherits — fails to put `organization_id` on most of its own tenant tables and decouples vendor PHI access from break-glass. The consent module (M39) conflates consent-evaluation with disclosure and does **not** capture all disclosure paths for §164.528 accounting. The reporting layer (M33) ships patient-identifiable bulk export with no de-identification. The Anthropic BAA is asserted "in place" (M08) when AI Governance says it is "in negotiation."

**Bottom line for the CMS / HIPAA / SOC 2 / security review:** this is an architecturally literate but pre-reconciliation corpus. The engineering skeletons (outbox, seams, append-only audit, RLS-by-default, AI-block zones, idempotency) are strong and largely reusable. But as written, the platform would **fail its own CI fitness pipeline**, **submit noncompliant Medicare/Medicaid claims**, **be unable to administer controlled comfort medications**, and **leak PHI through URLs, exports, and unexecuted-BAA AI calls**. Remediation is concentrated and sequenceable (below), but it is large and must start at the architecture/foundation layer, not the module layer.

---

# Module Grades

Counts are `BLOCKER / MAJOR / MINOR`. Grade rule: FAIL = ≥1 blocker; PASS WITH MAJOR GAPS = 0 blocker, ≥1 major; PASS WITH MINOR GAPS = minors only; PASS = none.

## PASS
*(none)*

## PASS WITH MINOR GAPS
*(none)*

## PASS WITH MAJOR GAPS
| Module | Name | B / M / m | Headline gap |
|---|---|---|---|
| **M20** | Field Safety | 0 / 7 / 10 | Strongest privacy posture in the corpus; unratified phase move, 2→10 dep expansion, life-safety SOS escalation has no terminus and is rate-limitable, schema-vs-design contradictions, PostGIS added without ADR. |
| **M28** | FHIR Gateway | 0 / 4 / 7 | Disciplined reader-seam-only data path, correct Part 2 egress redaction; Phase-3 R4 *write* shipped in Phase 1, `$export` missing SEC-052 bulk controls, no DR tier. |

## FAIL (38 modules)
| Module | Name | B / M / m |
|---|---|---|
| M01 | Foundation | 1 / 9 / 5 |
| M02 | Identity & Org | 2 / 8 / 9 |
| M03 | Authorization | 1 / 7 / 5 |
| M04 | Audit & Compliance Log | 1 / 6 / 5 |
| M05 | Patient & Demographics | 1 / 8 / 10 |
| M06 | Admission, Election & Certification | 6 / 17 / 13 |
| M07 | Care Plan (IPOC) | 1 / 6 / 8 |
| M08 | Encounters & Visit Notes | 3 / 10 / 10 |
| M09 | Clinical Assessments | 1 / 4 / 7 |
| M10 | HOPE Engine | 2 / 9 / 9 |
| M11 | Orders | 3 / 8 / 7 |
| M12 | DoseSpot Prescribing | 2 / 4 / 6 |
| M13 | eMAR & Med Administration | 1 / 7 / 3 |
| M14 | IDG | 2 / 8 / 9 |
| M15 | Discipline Care Plans | 1 / 6 / 5 |
| M16 | Bereavement | 1 / 7 / 8 |
| M17 | Scheduling & Routing | 2 / 7 / 10 |
| M18 | EVV | 2 / 7 / 8 |
| M19 | On-Call Triage | 3 / 6 / 6 |
| M21 | Supplies / DME / Comfort Kits | 5 / 10 / 6 |
| M22 | Document Management | 3 / 16 / 8 |
| M23 | Billing — Medicare | 6 / 9 / 19 |
| M24 | Billing — Medicaid | 2 / 11 / 13 |
| M25 | Remittance | 3 / 7 / 8 |
| M26 | Cap Management | 4 / 9 / 7 |
| M27 | Cost Report | 2 / 6 / 9 |
| M29 | External Interfaces | 4 / 7 / 9 |
| M30 | HQRP & Quality | 3 / 9 / 11 |
| M31 | Portal / Telehealth | 3 / 9 / 8 |
| M32 | AI Platform | 3 / 6 / 8 |
| M33 | Reporting | 5 / 9 / 11 |
| M34 | SaaS Tenant Platform | 3 / 7 / 8 |
| M35 | Subscription Billing | 3 / 7 / 8 |
| M36 | Secure Messaging & Alerts | 1 / 8 / 5 |
| M37 | IPU | 3 / 9 / 8 |
| M38 | Clinical Terminology | 1 / 6 / 7 |
| M39 | Consent | 3 / 6 / 7 |
| M40 | Master Data Management | 1 / 6 / 6 |

**Totals: 0 PASS · 0 PASS-MINOR · 2 PASS-MAJOR · 38 FAIL.**

---

# Cross Module Problems

These are systemic patterns that repeat across the corpus. Each must be resolved once, at the architecture/platform level, rather than module-by-module.

### X1 — Manifest rewrites and designed-in dependency cycles (nearly universal; the #1 build blocker)
`module-manifest.ts` is the authoritative seam/boundary registry; `dependsOn` *is* the cross-module contract list (ARCH-146). Almost every module rewrites its `dependsOn` far beyond the manifest, frequently without an ADR, and several create cycles that fail `no-circular` by design: **23⇄26** (M23-F06), **12⇄28** (M12-F01), **13⇄28** (M13-F01), **24⇄26 / 24⇄28** (M24-F01), **22→6→39→22** (M22-F01), **36→5 / 36→11** (M36-F01), **40⇄29** (M40-F03), **6→29→11→6** (M06-F01), **11→29** (M11-F01), **37** bidirectional reader pairs (M37-F01). The manifest *itself* encodes a **22↔39** cycle (M22 DC-1). Multiple specs justify the expansion with a "lock precedent that every module surfaces all its imports incl. foundation" — verified **false** against M11's actual lock (M13-F02, M21-F05, M09/M10). **Fix:** one consolidated ADR per module for all `dependsOn` deltas, transitive cycle analysis, and a ruling on whether outbox/seam consumption requires an import edge (it should not).

### X2 — Invented `packages/foundation` and domain-leaf pollution
M01, M02, M05, M11, M36, M40 invent a `packages/foundation` package present in **neither** the manifest nor architecture §4. Separately, FHIR mappers and module state machines/repositories are placed in the pure leaf `packages/domain` (M06 repos, M09 seam re-exports, M10 schema imports, M11 machines, M13 FHIR mapping, M39 schema) — violating `domain-is-pure`/`fhir-direction`/leaf-purity fitness checks **by design**. **Fix:** ban `packages/foundation`; pin seam *interfaces* in a real leaf (`packages/types`) implemented by the owning feature package; keep FHIR mapping only in `packages/fhir` (M28).

### X3 — PHI tenancy columns missing corpus-wide (ARCH-011)
Every PHI table must carry `organization_id` + `provider_entity_id` + `location_id`. Missing PE/location columns in M05, M07, M08, M09, M10, M11, M15, M21, M24, M36 — and most damningly in **M17 (Scheduling) and M19 (On-Call), which the architecture explicitly scopes by Location.** The tenancy-defining module **M34 is worse**: most tenant tables carry **no `organization_id` at all**, scoping via FK-join subqueries (M34-F02). **Fix:** corpus-wide schema sweep adding the three columns; treat M34 as the reference implementation it is supposed to be.

### X4 — Wrong RLS session variable / broken isolation
Canonical is `app.org_id` set by `withOrgContext()`. Specs variously use `app.organization_id` (M01, M02, M07, M14, M16), `app.tenant_id` (M22, M31), `app.current_org_id` (M33 — BLOCKER), `wardenx.org_id` (M21 — BLOCKER, all 11 tables), `app.current_organization_id` (M17). Most fail **closed** (deny all) — broken, not leaky. Worse: **M01** `USING(... OR org IS NULL)` lets a tenant write global kill-switch flags/platform audit rows; **M24** uses two *permissive* `FOR ALL` policies that **OR** together, so a stale PE session var can grant cross-tenant rows. **Fix:** mandate the M2 RLS template generator; ban hand-written policies; add the mixed-session-variable RLS test.

### X5 — Retention classes invented; clocks mis-anchored (OPEN-021)
The §24.1 matrix has exactly `operational / compliance / legal_hold` (+ `compliance_42cfr_part2`). Specs invent "class C / 10 years" (M06, M11, M12, M13), "10 years" (M10), "regulatory_dea / 7-yr operational" (M21), and **13-month destruction** of bereavement records (M16 — BLOCKER, M22) and a **10-year non-tightenable telehealth-recording floor inverting the 90-day default** (M31 — BLOCKER). Clocks anchored to the wrong event cause **premature destruction of part of the legal record** (M08, M13). The OPEN-021 6-vs-7-year clinical-retention ambiguity is unresolved corpus-wide. **Fix:** resolve OPEN-021 by ADR; map every table to a real §24 class with a correct anchor; bereavement/recording lifetimes are *display/program* windows, never retention.

### X6 — Direct cross-module table access evading the ownership checker
Ownership rules forbid reaching into another module's tables. Violations that fail the checker by design: **M40** reads M29's `nppes_provider` by **raw SQL** to dodge the import check (M40-F01); **M11** runs a daily **cross-tenant PHI sweep** under `withPlatformContext` with no org predicate (M11-F03); **M30** uses a PL/pgSQL trigger that `SELECT`s M5/M11/M22 tables (M30-F01); **M38**'s deprecation scan reads consumer tables (M38-F01); **M02** directly mutates M1's `session/organization/membership` (M02-F01); **M26** imports M1's Drizzle schema + FKs M1's table (M26-F02); **M10** imports M5/M6 schemas (M10-F01); **M16/M39** migrations `INSERT` into M1/M4 helper tables directly. **Fix:** invert via registered seams (the `CaseloadProvider`/`DataEraser` pattern); owner-published readers only.

### X7 — AI-governance gates under-implemented everywhere — including the platform itself
Every AI-touching feature outside M32 under-implements the mandated lifecycle: no capability-catalog registration, no `ai.<cap>_kill` switch, no "Report this output," no calibration thresholds, no BAA+ZDR activation gate (M07, M14, M16, M19, M22, M23, M24, M30, M36, M38). **M08 falsely asserts the Anthropic BAA is "in place"** when AI Governance §9.2 says "in negotiation" (M08-F01). **M32 — the governance platform every other module depends on — itself FAILS**: 30% drift does not auto-activate the kill-switch (downgraded to discretionary), an **un-evaluated `local-llama-3.1-8b` ships hot in production** for an approved clinical capability, and the mandatory `ai.phi_disclosed` / `ai.local_inference` / `ai.output_*` audit events are renamed/omitted — breaking §164.528 accounting for AI disclosures. **Fix:** fix M32 first; then make every AI feature register + gate against it; resolve the BAA reality before any cloud AI path is enabled.

### X8 — New external integrations shipped without INT-002 governance + BAA
INT-007 requires the five-step INT-002 addition (inventory row, §6 contract, BAA-register entry, degraded-mode row, cross-ref) **before build**. Shipped without it: EVV state aggregators / Sandata (M18 — BLOCKER), DME vendors + partner pharmacy (M21 — BLOCKER), print/mail vendor + fax/email ingest (M22 — BLOCKER), external triage vendor (M19), HIBP (M02), outbound HL7 ORM labs (M11), DoseSpot webhook event types (M12), CAHPS vendor (M30). Several carry PHI with **no BAA analysis** (INT-014 hard gate). **Fix:** run INT-002 + SEC-099 vendor review + BAA execution for each before the adapter merges.

### X9 — "Locked" specs internally incoherent (v0.2/v0.3/v0.4 consolidation debt)
Many locked specs contain two contradictory state machines / enum sets / permission catalogs / schema-vs-workflow vocabularies that the "consolidation" pass never reconciled: **M21** (SQL migration vs Drizzle = two different databases — BLOCKER), **M06** (broken migration, dead cancel-admit path), **M17** (two 8-state machines; front-half/back-half describe different modules), **M22** (16 majors, mostly drift), **M36** (two alert subsystems + a duplicate Postgres enum-type that fails migration), **M18/M19/M25/M26/M29/M30/M33**. **M14/M16/M20/M24** have partition-key-vs-unique-index impossibilities and CHECK-constraint subqueries that **cannot be created in PostgreSQL**. **Fix:** a single reconciliation pass per spec (schema ⇄ workflow ⇄ event-catalog ⇄ permissions) before re-lock; CI should reject duplicate enum definitions and illegal CHECK subqueries.

### X10 — Cross-spec contract phantoms (consumers bound to producers that don't deliver)
Modules bind to seams/events their producers never publish: **M12 lacks the reconciliation consumers + lineage column M13's locked workflow requires** (M13-F08); **M14's `bereavement_risk_flag` decision kind has no M16 consumer** (M16-F03); **M15's IDG decision flow has no producer** in M14's locked envelope (M15-F07); **M19 binds to seams/channels that don't exist** (M36 `voice_dial`, M16 reverse-lookup); **M25 writes M22's `packages/forms`** though M22 doesn't list M25 as a consumer; **M9/M10 depend on an M8 manifest inversion not yet approved.** **Fix:** the cross-module pass must reconcile every published-vs-consumed seam pair before any of the paired specs is honored as "locked."

### X11 — Idempotency, queue semantics, STRIDE, DR/BCP: template gaps in nearly every module
`Idempotency-Key` undeclared on mutating routes (M05/06/07/09/11/13/14/17/18/21/22/23/24/25/30/37). BullMQ queues declare no retry/backoff/concurrency/DLQ (virtually all). No STRIDE threat model (M01/02/03/05/06/07/08/11/14/15/16/21/36 …). No DR tier / degraded-mode / BCP-paper-fallback (most modules — critically the **Tier-1** services M02/M08/M11/M13/M18/M19, and the **Weekly BCP Print** feed is missing from owning modules M05/06/11/12/13). **Fix:** one cross-corpus sweep against the §20.B template; make STRIDE + DR-tier + per-route idempotency + full queue params CI-gated template requirements.

### X12 — M2 surface inflation; helper-reachability tension
M18, M20 (and others) build on M2 surfaces — `device_attestation`, `step_up_session`, emergency-contact rows, a "KMS path" — **absent from M2's authoritative `ownedTables`**. Separately, modules whose `dependsOn` omits 1–4 cannot mechanically import the mandated `packages/audit`/`packages/tenancy`/auth helpers, yet are required to call `audit()`/`withOrgContext()`/`requirePermission`. **Fix:** decide once whether M2 grew (manifest defect to fix) or these surfaces are vapor; declare the foundation helper packages implicitly importable, or add 1–4 uniformly.

---

# Security Gaps

| # | Gap | Modules | Severity |
|---|---|---|---|
| S1 | **Multi-tenancy invariant broken in the module that defines it** — most tenant tables lack `organization_id`; `platform_ops` session class invented (never evaluates true); WardenX-support PHI access decoupled from the mandated break-glass + tenant-consent dual control. | M34 | BLOCKER |
| S2 | **PHI in signed-URL filenames** (`{patientLastName}-…pdf`) — lands in proxy/CDN/MinIO logs (SEC-015). | M22 | BLOCKER |
| S3 | **Reporting bulk-export emits a CSV of patient-identifiable links**, and the load-bearing "no row-level PHI leaves M33" thesis is contradicted by its own drilldown/export. | M33 | BLOCKER |
| S4 | **Roll-your-own authentication** — module-local vendor-operator SSO binding outside Better Auth (SEC App. A.3 requires Security-Owner approval). | M19 | BLOCKER |
| S5 | **RLS broken**: wrong session variable (fail-closed) across ~12 modules; `OR org IS NULL` lets tenants write global kill-switch/audit rows (M01); permissive-OR policies weaken isolation (M24). | M01, M02, M07, M14, M16, M17, M21, M22, M24, M31, M33, M34 | BLOCKER/MAJOR |
| S6 | **Bulk-PHI export controls (SEC-052) absent** — no justification capture, 1/hr cap, 10k-record cap, 24-h URL, warn/critical severity — on the largest egress surfaces. | M04, M22, M26, M28 (`$export`), M33, M34 | MAJOR |
| S7 | **PHI in outbox payloads** — full decrypted clinical narrative (M08), SSN in PID payload (M05), patient names in alert payloads bound for SMS/email (M10, M14). | M05, M08, M10, M14 | MAJOR |
| S8 | **`withPlatformContext` RLS-bypass misused on PHI** — `SET ROLE` on the tenant pool (M01), daily cross-tenant PHI sweep with no org predicate (M11), DSAR reads without break-glass (M34). | M01, M11, M34 | BLOCKER/MAJOR |
| S9 | **Offline PHI in IndexedDB instead of encrypted SQLite (sqlcipher)**; mobile cache encryption/screen-capture posture unstated. | M08, M09 (+ M17, M22) | MAJOR |
| S10 | **Roll-your-own rate limiting** instead of the platform limiter on high-attack-surface routes (public portal, EVV, on-call, SOS). | M17, M18, M19, M30, M31 | MAJOR |
| S11 | **Persist-before-redact defeats the Part 2 ingress gate** — raw SUD wire bytes persisted before the consent gate runs. | M29 | BLOCKER |
| S12 | **New/over-privileged DB roles + SECURITY DEFINER** without Security-Owner sign-off; audit-writer trigger ownership ambiguous (runs over-privileged or cannot insert). | M04, M10, M38, M40 | MAJOR |
| S13 | **Life-safety SOS path is rate-limitable and has no escalation terminus** (tier-3-exhausted = sits unanswered; 11th SOS/hr may be suppressed). | M20 | MAJOR |
| S14 | **No TCPA/SMS opt-out (STOP/HELP)**, no inbound-SMS suppression, no consumer-consent capture, for caregiver/bereaved-family SMS. | M36 | MAJOR |
| S15 | **File-upload validation undefined** — no MIME allowlist / magic-byte sniffing / size limits; a `virus/quarantine` rejection reason references a scanning stage that doesn't exist. | M22 | MAJOR |
| S16 | **No STRIDE threat model** — being skipped corpus-wide (SEC-007). | ~14 modules | MAJOR |
| S17 | **Payment-card / PCI scope under-stated**; webhook signature/idempotency present but DLQ/retry on 11 queues absent. | M35 | MAJOR |

---

# HIPAA Gaps

| # | Gap | Modules | Notes |
|---|---|---|---|
| H1 | **§164.528 accounting-of-disclosures is broken or mis-owned, and does not capture all disclosure paths.** The consent module conflates consent-*evaluation* (fires on internal access) with *disclosure*; bulk FHIR export / signed-URL / §164.524 export disclose with no accounting record. M4 owns the trail but no module writes the disclosure record at each boundary. M32's AI disclosure accounting depends on an un-emitted `ai.phi_disclosed` event. | **M39 (BLOCKER)**, M04, M32, M29, M22 | System-wide design gap — assign the disclosure-record writer at every egress. |
| H2 | **42 CFR Part 2 (SUD) handling defective.** Mis-encoded as a *write gate* that blocks mandated clinical documentation (M09 AIMS, M06); raw Part 2 bytes persisted before the consent gate (M29 — BLOCKER); re-disclosure to external triage vendor without consent/QSOA (M19); M39's segmentation/re-disclosure prohibition handled only via retention promotion, no enforced gate. *(M28 egress redaction and M16 decedent-consent non-transfer are correct.)* | M29, M39, M09, M06, M19 | Part 2 restricts **disclosure/re-disclosure**, not creation by the treating program. |
| H3 | **Minimum-necessary failures.** Patient-identifiable bulk export + no §164.514 de-identification in the cross-module reporting layer (M33 — BLOCKER); SOGI/SSN field-gating claimed but not designed (M05); broad clinical read grants with no caseload ABAC (M21); per-patient Medicaid event ingest instead of aggregate counts (M35). | M33, M05, M21, M35 | |
| H4 | **Retention/destruction creates compliance exposure.** 13-month destruction of bereavement records (M16 — BLOCKER, M22); premature destruction of part of the clinical record via wrong retention anchor (M08, M13); access-log cascade-delete destroying §164.528 inputs (M22); DEK shred ignoring the Part 2 eraser-refusal (M34). | M16, M22, M08, M13, M34 | |
| H5 | **BAA gates missing / falsely asserted.** Anthropic BAA asserted "in place" when "in negotiation" (M08 — BLOCKER); print/mail vendor (M22), EVV aggregators (M18), triage vendor (M19), DME vendors (M21) all receive PHI with no BAA analysis (INT-014). | M08, M18, M19, M21, M22 | |
| H6 | **Right of access / amendment gaps.** §164.524 export route lacks SEC-052 controls (M22, M04); §164.526 missing the 30-day extension / rebuttal-statement / coded denial bases (M05); no patient-amendment workflow in encounters (M08). | M04, M05, M08, M22 | |
| H7 | **Vendor PHI access decoupled from break-glass dual control** (re-introduces the canonical vendor-PHI finding). | M34 | |
| H8 | **Audit-control integrity** — eraser/audit routed to non-existent helpers/tables; SECURITY DEFINER audit trigger may run over-privileged or be unable to insert; embeddings/vector diffs flood the 7-yr audit store. | M04, M26, M38 | |

---

# Medicare Hospice Gaps

The regulatory heart of the audit (dimension I). An incorrectly encoded regulation is at minimum MAJOR, usually BLOCKER, because it produces noncompliant claims or care.

### Election & Certification (M06 — 6 blockers)
- **Election-statement addendum (Patient Notification of Non-Covered Items, 42 CFR 418.24(c)) entirely absent** — a condition of payment; every election is noncompliant (M06-F02). The non-covered DME path in M21 has nowhere to terminate.
- **Verbal/written certification timing encoded backwards**, and the 15-day early-completion limit violated (M06-F03).
- **A signed election statement required per benefit period** instead of one per election (418.24(c)) — blocks recerts or induces fabricated re-signings (M06-F04).
- **Late/missed F2F substitutes an agency "override" CMS does not recognize → bills uncertified days**; exceptional-circumstances rule missing (M06-F05).
- Live-discharge missing physician discharge order for all reasons + NOMNC (M06-F09); transfer missing the 418.30 patient-signed statement (M06-F10).

### Medicare claims (M23 — 6 blockers; some trace to architecture errors)
- **RHC two-tier rate encoded as "first 7 days vs 8+"** instead of the day-60 high/low boundary with cumulative cross-stay/cross-hospice day count; **invents HIPPS codes that don't exist on hospice claims** → days 61+ systematically overpriced (M23-F01; architecture §11.A line 1803 is also wrong → ADR).
- **Payment-rate math wrong**: no CMS base-rate table; wage index applied to the full per-diem (should be labor share only) and keyed by CCN not site-of-service CBSA; CHC modeled as per-diem days not hourly 15-min units (M23-F02).
- **SIA wrong**: no RHC-day restriction, no 4-hr/day cap, no 15-min units, no G0299/G0155 lines → MAC pays no SIA (M23-F03).
- **Claim wire-content cannot produce a compliant 837I** — no claim-level ICD storage, no attending/certifying physician, no value codes 61/G8, occurrence/condition codes, patient status, or per-discipline visit G-code lines → every claim RTPs (M23-F04).
- **Late-NOE mis-encoded** — blocks then bills all days covered instead of provider-liable days (occ span 77) + exception path → overbilling (M23-F05).
- MA carve-out broken (M23-F09); IRC 5-day-then-RHC repricing unspecified (M23-F13); attending-on-claim not matched to election-designated attending (M23-F15).

### Cap, Cost Report, Medicaid (M24, M26, M27)
- **Cap year wrong (Nov 1–Oct 31)** — must be Oct 1–Sep 30 since FY2017 (M23-F14, M26; architecture ARCH-178 wrong → ADR). M26 corrected it in-spec via an **unauthorized override** (BLOCKER for the mechanism, regulatorily correct).
- **Medicaid R&B pricing internally contradictory; 95%-of-NF-rate floor not encoded; patient liability / share-of-cost entirely absent; TPL/crossover/retro-eligibility/timely-filing absent** (M24-F02/04/05/06); fabricated authority "42 CFR §418.318."
- **M24 accrues Medicaid payments to the Medicare aggregate cap** (wrong — Medicare cap = Medicare payments) (M24-F08); inpatient-cap numerator/denominator + overage math wrong (M26-F13).
- **Cost-report worksheet set conflicts with architecture and is internally incoherent; "28 default rules" asserted but never enumerated** — filing correctness unverifiable; a `regulatory_required` rule can `skip` and submit anyway (M27-F01/F02/F08).
- Cures Act EVV **over-encoded** as a federal mandate on hospice claims (M18, M24) — blocks payable claims; EVV applicability undefined; launch state is Oregon but every example is Texas (M18-F04).

### HOPE / HQRP / IDG (M10, M30, M14, M07)
- **HOPE SFV 2-calendar-day clock anchored to signature time instead of visit date** → delaying signature extends the federal deadline → silent HQRP non-compliance and 4-point APU exposure (M10-F02). HOPE J-item codes transposed (M10-F07); no iQIES inactivation flow (M10-F06).
- **HQRP SFV timely-follow-up window encoded as both 2-calendar-day (correct) and 48h (wrong)** (M30-F04).
- **IDG 15-day review clock encoded as a location cadence floor with escapable cancel/reschedule and no missed-review escalation** (M14-F01); **NP permitted in the IDG physician seat** (CoP 418.56 requires MD/DO) (M07-F01).

### IPU & controlled substances (M37, M12, M13, M21, M15)
- **IPU LOC errors**: GIP imminent-death bound 14 vs 7 days, invented IRC 30-day no-reset, IRC day-6+ **blocked instead of re-priced to RHC** (M37-F08/11/12); the **24/7-RN-coverage gate hard-blocks inpatient orders on stale data — a patient-safety hazard** over-encoding ARCH-188 (M37-F03).
- **No Schedule II–V medication can be ordered, signed, activated, or administered at go-live** because EPCS is Phase-3-deferred and **no lawful Phase-1 non-EPCS path exists** — the core hospice comfort meds (M12-F02, M13-F03). Standing-order engine can execute **unauthenticated** orders (M11-F02).
- **SUPPORT Act at-home controlled-substance disposal documentation missing**; physical-retrieval model conflicts with the on-site-destruction posture (M13-F05, M21).
- **Mandatory double-witness for every controlled administration is unworkable in solo home hospice** and creates a perverse caregiver-attested bypass (M13-F04).
- **Volunteer 5% ratio dimensionally incoherent** (minutes ÷ dollars) → false CoP compliance reporting (M15-F04); aide POC plan-before-care + annual aide-present observation gaps (M15-F03).

### Other
- DME/supplies encoded with a **DMEPOS separate-billing model** (NU/RR/UE/KX modifiers, separately billable lines) contrary to hospice per-diem bundling (M21-F01).
- Remittance redetermination appeal-clock anchor inconsistency risks late/dismissed appeals (M25-F04).

---

# Build Blocking Issues

These prevent the platform from building or make other modules unbuildable as specified. They must be cleared before any module is re-locked.

1. **Dependency cycles fail `no-circular` by design** (X1) — at least ten module-introduced cycles plus the manifest's own 22↔39. CI red on day one.
2. **The foundation tier (M01–M04) FAILS and is the frozen surface everything builds on.** Specifically: the **seam bootstrap is owned by no module** — `validateSeams()`, the `eraseFn`/`DataEraser` registry, and `CaseloadProvider` wiring (the boot-fail gate the architecture depends on) are absent (M01-F04, M04-F03); **M02 and M03 are mutually desynchronized** — M03 lacks the `step_up_recent` predicate + `step_up.override.manage` key that M02's locked spec requires, so M02's acceptance criteria cannot pass and M29's privileged routes are ungateable (M03-F01); the **permission-key compile-time contract mechanism is undefined** (M03-F07); the **role catalog + `system_locked` floor is undefined** (M03-F06).
3. **Direct cross-module table access that fails the ownership checker by design** (X6) — M40 raw SQL, M11 cross-tenant sweep, M30 trigger, M38 deprecation scan, M02 mutating M1 tables, M26/M10 schema imports.
4. **`packages/foundation` + domain-leaf violations fail fitness checks by design** (X2) — M01, M02, M05, M09, M11, M13, M36, M39, M40.
5. **Specs non-implementable as written** (X9) — M21 (two divergent schemas), M06 (broken migration `0036`, dead state machine), M17 (two state machines), M22/M25/M26/M29/M30/M36 (contradictory enums/permissions), and **PostgreSQL-illegal DDL**: partition-key-vs-unique-index conflicts (M14, M15, M16, M20, M24) and CHECK-constraint subqueries (M16, M22, M24).
6. **Cross-spec contract phantoms** (X10) — M13↔M12 reconciliation handshake, M14→M16 bereavement-risk seam, M15→M14 IDG decision target, M19 bound to non-existent seams/channels, M9/M10 awaiting an unapproved M8 inversion.
7. **M32 (AI Platform) FAILS** — every module that registers an AI capability or relies on the kill-switch / BAA gate / audit-event contract inherits a broken governance substrate.
8. **Phase-cut violations without ADR** — M15, M17, M18, M19, M20, M21, M26, M27, M28, M30, M33, M37 ship Phase-2 (or Phase-3) capabilities in Phase 1, several dragging other Phase-2 modules onto the Phase-1 critical path (e.g., M20→M19 for after-hours SOS).
9. **Architecture-document errors that must be fixed by ADR before the dependent modules can be correct** — RHC/HIPPS (§11.A line 1803), cap year (ARCH-178), R&B revenue code (line 1781), OPEN-021 (retention), OPEN-020 (session lifetimes), state_retention_override ownership (§25.9 vs §24.4), the M8↔M9/M10 read direction, the EVV applicability/tier/inventory tensions, and the manifest's own 22↔39 cycle.

---

# Recommended Remediation Order

Remediate top-down: architecture → foundation → platform invariants → governed subsystems → per-module reconciliation → systemic sweeps. Each phase unblocks the next.

### Phase 0 — Architecture ADRs (do first; architecture wins, and several blockers originate here)
1. Correct the **Medicare encodings in the architecture itself**: RHC day-60 tiering (delete the 7-day/HIPPS construct, §11.A line 1803), cap year Oct 1–Sep 30 (ARCH-178), R&B revenue code 0658 (line 1781).
2. Resolve the **manifest as single source of truth**: fix the 22↔39 cycle; rule that outbox/seam consumption needs no import edge; settle the leaf-located-seam-interface pattern; settle helper-package reachability (audit/auth/tenancy). Require one consolidated ADR per module for `dependsOn` deltas.
3. Close the open architecture conflicts: **OPEN-021** (clinical retention 6 vs 7 yr), **OPEN-020** (session lifetimes), state_retention_override ownership, the M8↔M9/M10 read direction, EVV applicability/tier/inventory, and the §20.A phase / DR-tier / INT-tier reconciliation.

### Phase 1 — Re-lock the foundation tier (M01–M04) correctly
4. Specify the **seam bootstrap** in M1 (`validateSeams()`, `eraseFn`/`DataEraser` registry, `CaseloadProvider` wiring, fail-at-boot on unregistered PHI-class erasers).
5. Define the **permission-key compile-time contract** mechanism and the **role catalog + `system_locked` floor** (M03); resync the **step-up predicate contract** between M02 and M03.
6. Fix the foundation security/retention defects: audit-writer trigger ownership/RLS (M04), `withPlatformContext` credential isolation (M01), retention constants to 7-yr compliance, ban `packages/foundation`.

### Phase 2 — Platform invariants, corpus-wide sweeps
7. **Tenancy:** add `organization_id`/`provider_entity_id`/`location_id` to every PHI table; canonicalize `app.org_id` + the M2 RLS generator; fix **M34** to be the reference tenancy implementation; eliminate permissive-OR and `OR org IS NULL` policies.
8. **Ownership:** invert every direct cross-module read to a registered seam (X6); remove raw-SQL and cross-tenant-sweep evasions.

### Phase 3 — Governed subsystems
9. **Fix M32 (AI Platform)** — auto-activate kill-switch at the drift threshold, gate the local model behind eval/calibration, restore the mandatory `ai.*` audit events — then make every AI feature register + gate against it; **resolve the Anthropic BAA** before enabling any cloud AI path.
10. **HIPAA disclosure + Part 2:** assign the §164.528 disclosure-record writer at every egress (M39/M04/M28/M22/M29); fix Part 2 to gate disclosure (not creation) and persist-after-redact (M29); enforce the consent seam (M39).

### Phase 4 — Medicare/Medicaid correctness (blocks compliant claims & care)
11. **Election/cert (M06):** addendum entity + 3/5-day clocks; correct verbal/written cert timing; one election statement per election; CMS late-F2F logic; discharge order + NOMNC.
12. **Claims (M23/M24):** real base-rate + labor-share + CBSA wage-index model; correct RHC/SIA/CHC/IRC; full 837I wire-content; late-NOE provider-liability; Medicaid R&B 95% basis + patient liability + TPL/crossover/retro/timely-filing.
13. **Cap/Cost/HQRP/IPU:** cap year + composition (M26); cost-report worksheets + rule library (M27); HOPE SFV visit-date anchor + J-codes + inactivation (M10); IDG 15-day per-patient clock + MD-only physician seat (M14/M07); IPU LOC + RN-coverage fail-open (M37).
14. **Controlled substances:** add a lawful Phase-1 non-EPCS path so Schedule II–V meds can be ordered/administered (M12/M13); authenticate standing orders (M11); SUPPORT Act at-home disposal; scope the administration-witness rule.

### Phase 5 — Integration governance
15. Run INT-002 additions + SEC-099 reviews + **BAA execution** for EVV aggregators (M18), DME/pharmacy (M21), print/mail + fax/email ingest (M22), triage vendor (M19), HIBP (M02), outbound HL7 ORM (M11), CAHPS (M30).

### Phase 6 — Per-spec reconciliation + systemic template sweeps
16. One reconciliation pass per incoherent spec (X9): M21, M22, M17, M06, M16, M25, M26, M29, M30, M36 — unify schema ⇄ workflow ⇄ events ⇄ permissions; fix PostgreSQL-illegal DDL.
17. Cross-corpus template sweep (X11): per-route `Idempotency-Key`; full queue retry/backoff/concurrency/DLQ; STRIDE per module; DR tier + degraded-mode + Weekly-BCP-Print feeds; SEC-052 bulk-export controls; cursor pagination on PHI lists; sqlcipher offline storage.
18. Resolve M2 surface inflation (X12); reconcile every consumer↔producer seam pair (X10) before honoring any "locked" status.

---

*Prepared as a consolidation of the 29 per-module audit files in `audit/AUDIT_M*.md`. Every BLOCKER cited was verified against the authoritative source document in the originating module audit. Where the architecture and a regulation conflict, the finding is recorded against the module per the audit protocol, with the architecture error flagged for an ADR.*
