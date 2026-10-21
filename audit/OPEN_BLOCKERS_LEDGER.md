# ChartWarden — Consolidated Open-Blockers Ledger (June-13 re-audits)

**Compiled:** 2026-06-13
**Source:** the 12 per-module re-audit files modified 2026-06-13 under `audit/AUDIT_*.md`
(M02_M03, M07_M15, M09_M10, M14_M16, M18_M20, M19_M36, M22, M26, M30, M34, M35, M39 — 18 modules).
**Companion docs:** `audit/AUDIT_CONSOLIDATED_FINAL.md` (2026-06-11 baseline), `docs/REMEDIATION_SUMMARY.md`,
`docs/adr/README.md` (ADR-0001…0023).

---

## ⚠️ Read this before applying any "Recommended fix"

The June-13 re-audits were graded against the raw auditor criteria and **do not consistently
credit the ADR remediations and spec edits already applied** (the ADRs and Phase-0…6 remediation
landed 2026-06-11; some re-audits re-flag issues those ADRs already settled). **Several findings are
therefore FALSE-OPEN, and at least one audit "Fix" would re-introduce a regulatory bug if applied
verbatim.** Every finding must be triaged against the *current* spec text + the 23 ADRs **before**
editing.

**Proven example — M26-F01 (graded BLOCKER):** the audit says "revert the cap year to Nov 1–Oct 31
until an ADR exists." But **ADR-0002 already ratifies Oct 1–Sep 30** (federal FY, BBA-2018 §51005(b)),
the M26 spec already cites it (`CHARTWARDEN_MODULE_26…v0_3.md` lines 16–18, 68), and Oct 1–Sep 30 is the
*correct* regulatory value. Applying the audit's fix would **reintroduce the pre-2017 bug.** → Status:
**RESOLVED (cite ADR-0002); do not act on the audit recommendation.**

→ Treat the "Recommended fix" column as the auditor's proposal, not an instruction. Disposition codes
are assigned per finding in the triage pass (see §Triage status).

---

## Triage status legend

| Code | Meaning |
|---|---|
| **OPEN** | Genuinely unresolved in current spec; fix needed. |
| **RESOLVED-VERIFY** | Already addressed by an ADR / prior spec edit; action = confirm citation, no behavioral change. |
| **STALE-FIX** | Finding's *recommended fix* conflicts with a ratified ADR; do **not** apply verbatim. |
| **(untriaged)** | Not yet triaged against current spec — default assumption until checked. |

## Fix-type legend

| Type | Meaning |
|---|---|
| **SPEC-EDIT** | Fixable by editing the module spec markdown. |
| **ADR-NEEDED** | Needs a new/updated ADR or architecture-owner sign-off first. *(Note: many dependsOn-expansion findings are already governed by ADR-0005 — reword to cite it instead of opening a new ADR.)* |
| **CROSS-MODULE** | Fix spans/depends on another module's spec. |
| **OUT-OF-BAND** | Needs a legal/operational action outside the docs (BAA/ZDR/QSOA execution, vendor security review, Security-Owner approval) — **cannot be closed by editing markdown.** |

---

## Severity roll-up (as graded June-13, before triage)

| Module | Spec file | Grade | BLOCKER | MAJOR | MINOR | Total |
|---|---|---|--:|--:|--:|--:|
| M02 Identity | `…MODULE_02_IDENTITY_SPEC_v0_4.md` | FAIL | 2 | 8 | 9 | 19 |
| M03 Authorization | `…MODULE_03_AUTHORIZATION_SPEC_v0_3.md` | FAIL | 1 | 7 | 5 | 13 |
| M07 Care Plan | `…MODULE_07_CARE_PLAN_SPEC_v0_3.md` | FAIL | 1 | 6 | 8 | 15 |
| M09 Clinical Assessments | `…MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_3.md` | FAIL | 1 | 4 | 7 | 12 |
| M10 HOPE Engine | `…MODULE_10_HOPE_ENGINE_SPEC_v0_2.md` | FAIL | 2 | 9 | 9 | 20 |
| M14 IDG | `…MODULE_14_IDG_SPEC_v0_4.md` | FAIL | 2 | 8 | 9 | 19 |
| M15 Discipline Care Plans | `…MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md` | FAIL | 1 | 6 | 5 | 12 |
| M16 Bereavement | `…MODULE_16_BEREAVEMENT_SPEC_v0_5.md` | FAIL | 1 | 7 | 8 | 16 |
| M18 EVV | `…MODULE_18_EVV_SPEC_v0_2.md` | FAIL | 2 | 7 | 8 | 17 |
| M19 On-Call Triage | `…MODULE_19_ONCALL_TRIAGE_SPEC_v0_3.md` | FAIL | 3 | 6 | 6 | 15 |
| M20 Field Safety | `…MODULE_20_FIELD_SAFETY_SPEC_v0_3.md` | PASS w/ MAJOR GAPS | 0 | 7 | 10 | 17 |
| M22 Documents | `…MODULE_22_DOCUMENTS_SPEC_v0_5.md` | FAIL | 3 | 16 | 8 | 27 |
| M26 Cap Management | `…MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md` | FAIL | 4 | 9 | 7 | 20 |
| M30 HQRP & Quality | `…MODULE_30_HQRP_QUALITY_SPEC_v0_5.md` | FAIL | 3 | 9 | 9 | 21 |
| M34 SaaS Tenant Platform | `…MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md` | FAIL | 3 | 11 | 3 | 17 |
| M35 Subscription Billing | `…MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md` | FAIL | 3 | 7 | 8 | 18 |
| M36 Secure Messaging | `…MODULE_36_MESSAGING_SPEC_v0_4.md` | FAIL | 1 | 8 | 5 | 14 |
| M39 Consent | `…MODULE_39_CONSENT_SPEC_v0_3.md` | FAIL | 3 | 6 | 6 | 15 |
| **TOTAL** | | **17/18 FAIL** | **~39** | **~141** | **~127** | **~307** |

## Cross-cutting patterns (recur in most modules → fix once, apply everywhere)

| Pattern | Governing ADR / rule | Recurs in |
|---|---|---|
| `dependsOn` "manifest patch" over-claims edges | **ADR-0005** (seam/outbox/foundation = no edge) — reword spec to cite, don't open new ADR | M02, M03, M07, M09, M10, M14, M15, M16, M18, M19, M22, M26, M30, M34, M35, M36, M39 |
| Wrong RLS session var / missing 3-column (`org_id`,`provider_entity_id`,`location_id`) | **ADR-0010** | M02, M03, M07, M09, M10, M14, M16, M19, M22, M30, M34, M36 |
| Cross-module table access (import/FK/trigger raw-SQL) | **ADR-0011** | M10, M26, M30, M35, M39 |
| §164.528 disclosure accounting mis-owned | **ADR-0013** | M39, M30, M34, M22 |
| 42 CFR Part 2 as write-gate instead of disclosure-gate | **ADR-0014** | M09, M19, M30 |
| AI capability missing catalog/kill-switch/BAA-gate | **ADR-0012** | M07, M14, M16, M19, M22, M36 |
| Uninventoried PHI vendor integration (INT-002/INT-014) | **ADR-0020** — **OUT-OF-BAND** (BAA execution) | M18, M19, M22, M26, M30 |
| Illegal DDL (CHECK subquery, partition-vs-unique, dup enum) | **ADR-0022** | M14, M15, M16, M20, M26, M36 |
| Missing §20.B template sections (idempotency/queue-DLQ/STRIDE/DR-tier/SEC-052/cursor) | **ADR-0021** | every module |
| Phase tag vs §20.A cut without ADR | **ADR-0009** | M15, M18, M19, M20, M26 |
| Retention class invented outside §24 matrix | **ADR-0004** | M02, M03, M10, M16, M19, M22, M30, M35, M36, M39 |

---

## Findings — M02 Identity & Org

| Finding ID | Sev | Title | Spec sections | Recommended fix (auditor proposal) | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M02-F01 | BLOCKER | Claims/mutates M1-owned tables | §8.1.1, §4.4.1/2, mig 0002/0036 | Manifest edit moving `session` into M2, or route session mutations through M1 repo; drop ownership claim | ARCH-143/146/147/235 | ADR-NEEDED |
| M02-F02 | BLOCKER | Notification delivery breaks adapter mandate | §4.6, §4.2, D2 | Move mail/SMS primitive into M1 foundation (VENDOR_ADAPTERS) or emit outbox events for M36 dispatch | ARCH-145/142, SD-017 | ADR-NEEDED |
| M02-F03 | MAJOR | Invents unregistered `packages/foundation` | header, §4.3.1/4.4.1/3.1 | Use `packages/shared`/`packages/auth`; new package needs manifest edit | ARCH-141/021/144, ADR-0005 | SPEC-EDIT |
| M02-F04 | MAJOR | New table not in manifest; no ADR for step-up primitive | §3.7/3.9, mig 0036, §12 | Propose `ownedTables` edit for `tenant_step_up_policy_override`; ADR per SEC-006 | ARCH-143/146/001 | ADR-NEEDED |
| M02-F05 | MAJOR | `ClinicianPreferences`/`TenantConfiguration` absent | §1.1/4.1/5.1 | Add both entities (AI flags on `organization.settings`; per-clinician AI opt-out) | ARCH-151, AI-059–061 | SPEC-EDIT |
| M02-F06 | MAJOR | Account-takeover control set incomplete | §2.4/7.12 | Add captcha@3, velocity/defensive mode, 15-min lockout, re-auth triggers | SEC-033/012/034 | SPEC-EDIT |
| M02-F07 | MAJOR | No org-status gate at login | §2.3/8.1.1 | Define org status machine; gate session issuance; contract lifecycle events | OPS-054, ARCH-186/232 | SPEC-EDIT |
| M02-F08 | MAJOR | Mobile offline auth ticket absent | §5.3 | Specify ticket issuance/lifetime/binding/revocation | SD-047, ARCH-274 | SPEC-EDIT |
| M02-F09 | MAJOR | No STRIDE threat model | (new section) | Add STRIDE per SEC §3.4 identity threats | SEC-007 | SPEC-EDIT |
| M02-F10 | MAJOR | HIBP not in Integration Catalog | D5, §4.6 | INT-002 addition; adapter w/ breaker + DegradedError (no BAA — SHA-1 prefixes) | INT-001/002/007, SEC-029 | SPEC-EDIT |
| M02-F11 | MINOR | RLS var inconsistent | §3.8, mig 0036, §4.3.2 | Normalize to `app.org_id`/`withOrgContext()` | ADR-0010, SD-029 | SPEC-EDIT |
| M02-F12 | MINOR | Invents `security` retention class | §8.1 | Map auth events to `compliance` (or M4 adds class) | ARCH-250, ADR-0004 | CROSS-MODULE |
| M02-F13 | MINOR | Queue/idempotency/error-shape/route gaps | §4.6/4.2/4.4.1 | Declare queue params, idempotency semantics, std error envelope, reconcile route path | ARCH-262/263, SD-053 | SPEC-EDIT |
| M02-F14 | MINOR | Sample-code/schema drift | §3.3/3.4/4.4.1/8.1 | Fix bad column refs, path inconsistencies, move audit emit into tx | ARCH-265, SEC-082 | SPEC-EDIT |
| M02-F15 | MINOR | MFA scope narrower than arch | §2.3/1.3 | Restate MFA as all-roles-except-read-only | ARCH-050 | SPEC-EDIT |
| M02-F16 | MINOR | Residual auditor surfaces contradict D4 | §5.1/6/7.7 | Re-home auditor screen to M3; align issuing role | ARCH-059 | CROSS-MODULE |
| M02-F17 | MINOR | Cross-org read needs ADR | §3.8 | Capture `listMembershipsForUser` as ADR; allowlist query shape | ARCH-086/001 | ADR-NEEDED |
| M02-F18 | MINOR | Password recovery under-specified | §4.1/7.4 | Add 15-min TTL, TOTP-at-click, OOB verify for privileged | SEC-031 | SPEC-EDIT |
| M02-F19 | MINOR | No DR tier / degraded mode | (absent) | Tier-1 downtime note; all-locations membership flag | DR-010/064, ARCH-013 | SPEC-EDIT |

## Findings — M03 Authorization

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M03-F01 | BLOCKER | Step-up contract has no implementor in M3 | §4.2/3.3 | Add `step_up_recent` predicate + `step_up.override.manage` key; bind `requirePredicate`; re-lock w/ M2 counter-sign | ARCH-232/233, SEC-006 | CROSS-MODULE |
| M03-F02 | MAJOR | `dependsOn` excludes M1 despite M1 use | header/1.1/3.7 | `dependsOn:[1,2]` reviewed edit (per ADR-0005 reword) | ARCH-142/235 | ADR-NEEDED |
| M03-F03 | MAJOR | 5 ABAC predicates read non-dep modules w/o seam | §4.2/1.2 | Define typed provider seams w/ boot-validated deny stubs in `REQUIRED_SEAMS` | ARCH-147/233/234 | SPEC-EDIT |
| M03-F04 | MAJOR | Break-glass notifications bypass M36 | §4.4/4.5/8.1 | Emit typed outbox events in same tx; M36 routes | SD-017, ARCH-184/185 | SPEC-EDIT |
| M03-F05 | MAJOR | Join tables lack `organization_id` | §3.4/3.7/3.6 | Add `organization_id`+indexes or bespoke EXISTS RLS, exempt from generator explicitly | ADR-0010, ARCH-011/080 | SPEC-EDIT |
| M03-F06 | MAJOR | Role catalog/`system_locked` floor not enumerated | §3.1/3.7/2.4/7.6 | Enumerate 60 default roles + per-locked-role floor before foundation freeze | ARCH-052/232 | SPEC-EDIT |
| M03-F07 | MAJOR | Permission-key compile-time mechanism undefined | §3.3 | Specify per-module `permissions.ts` aggregation + CI naming check | ARCH-233/232 | SPEC-EDIT |
| M03-F08 | MAJOR | No STRIDE | (new) | Add STRIDE (priv-esc, IDOR, predicate bypass, cache-stale, break-glass abuse) | SEC-007 | SPEC-EDIT |
| M03-F09 | MINOR | Auditor-mode gaps | §4.4/5.2/2.1 | First-chart notify, locked auditor role, typed scope, default windows | ARCH-058/060 | SPEC-EDIT |
| M03-F10 | MINOR | Namespace/stale-ref drift in §8.1 | §8.1/4.4/3.3 | Re-prefix audit actions to `m3.*`; fix §11/D2 + "M2 §4.5" refs | D9 | SPEC-EDIT |
| M03-F11 | MINOR | Queue/idempotency/retention gaps | §4.5/8.1 | Declare queue params/idempotency; map retention to §24 | ARCH-262/263, ADR-0004 | SPEC-EDIT |
| M03-F12 | MINOR | D8 registry ownership contradicts ARCH-234 | §11 D8 | Reword: M1 owns registry/gate; M3 owns seam-decl schema, registers at init | ARCH-234 | SPEC-EDIT |
| M03-F13 | MINOR | `consent_ref` untyped; audit sampling unspecified | §3.5, D5 | Type `consent_ref` once M34 specced; pin sampling policy | ARCH-190/186 | SPEC-EDIT |

## Findings — M07 Care Plan (IPOC)

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M07-F01 | BLOCKER | NP permitted in IDG physician seat (CoP) | §11 D5, §4.5, enum | Remove `nurse_practitioner` from physician quorum slots; align M14 D3 | 42 CFR §418.56(a), ARCH-164 | CROSS-MODULE |
| M07-F02 | MAJOR | `ownedTables` undeclared; transitive imports | header/1.2/12 | Fill `ownedTables`; move M9 seams to `packages/domain` deny-stubs (per ADR-0005) | ARCH-141/143/146 | ADR-NEEDED |
| M07-F03 | MAJOR | No plan-before-care control; wrong CFR cite | §1.1/1.3/7.1, D2 | Add admission-time POC gate on first encounter; fix CFR cite | 42 CFR §418.56(b) | SPEC-EDIT |
| M07-F04 | MAJOR | IPOC missing drugs/treatments & supplies | §1.2/2.1/1.3 | Add meds/supplies section via M11/M12/DME seam; drug-profile attestation | 42 CFR §418.56(c) | CROSS-MODULE |
| M07-F05 | MAJOR | 15-day clock resets on any version; quorums undefined | §2.1/4.6/7.2/9.1 | Reset only on `idg_review`; define interim/discharge quorums; anchor to meeting date | 42 CFR §418.56(d) | SPEC-EDIT |
| M07-F06 | MAJOR | PHI tables miss `provider_entity_id`/`location_id` | §3.3/2.1 | Add NOT NULL (from admission) + composite indexes | ADR-0010 | SPEC-EDIT |
| M07-F07 | MAJOR | Layer-2 AI summary ungoverned | D7, §1.1/5.2/8.2/12 | Drop Layer-2 or register AI capability through full lifecycle | ADR-0012, AI-011–014 | ADR-NEEDED |
| M07-F08 | MINOR | Wrong RLS var | §3.4/3.6 | `app.org_id` + WITH CHECK | ADR-0010 | SPEC-EDIT |
| M07-F09 | MINOR | PATCH routes lack Idempotency-Key | §4.1 | Add 24h/409 idempotency | ADR-0021, SD-053 | SPEC-EDIT |
| M07-F10 | MINOR | Queue params absent | §4.6 | Declare priority/retry/backoff/concurrency/DLQ | ADR-0021, SD-059 | SPEC-EDIT |
| M07-F11 | MINOR | No STRIDE | (absent) | Add STRIDE | SEC-007 | SPEC-EDIT |
| M07-F12 | MINOR | No DR tier/degraded | (absent) | Tier-2; gate fail-open + degraded marker | DR-010/064 | SPEC-EDIT |
| M07-F13 | MINOR | Retention class ambiguous; no eraser | §2.2.1/3.5 | Cite OPEN-021; state eraser hookup; legal-hold note | ADR-0004, ARCH-251 | SPEC-EDIT |
| M07-F14 | MINOR | Indexes not org-leading | §3.3 | Prefix `organization_id`; fix `sql` import | SD-028 | SPEC-EDIT |
| M07-F15 | MINOR | Validation gaps; immutable UPDATE grant | §1.3/2.3/3.6/4.4 | Patient-understanding capture; warn validation; INSERT/SELECT-only grant; fix cites | 42 CFR §418.56(c) | SPEC-EDIT |

## Findings — M09 Clinical Assessments

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M09-F01 | BLOCKER | Leaf package imports feature package | §2.4/3.1/12 | Define seam types natively in `packages/domain`; `packages/assessments` implements | ARCH-141/091/146 | SPEC-EDIT |
| M09-F02 | MAJOR | `dependsOn` contradicts manifest; locked pre-ADR | changelog/§10/§12 | Hold lock until ADR approves M8↔M9 inversion (per ADR-0005/0007) | ARCH-142/146/001 | ADR-NEEDED |
| M09-F03 | MAJOR | PHI tables omit PE/location | §3.3/3.4 | Add nullable PE/location from admission; composite indexes | ADR-0010 | SPEC-EDIT |
| M09-F04 | MAJOR | Offline drafts in IndexedDB not sqlcipher | §5.3 | Use sqlcipher; evict PHI on logout | SEC-075 | SPEC-EDIT |
| M09-F05 | MAJOR | Part 2 misencoded as write gate | §1.1/2.3, D10/7.6 | Always permit AIMS (`sud_context=true`); enforce at disclosure only | ADR-0014, SEC-046 | SPEC-EDIT |
| M09-F06 | MINOR | PATCH routes lack Idempotency-Key | §4.1 | Add 24h/409 | ADR-0021 | SPEC-EDIT |
| M09-F07 | MINOR | Internal drift checklist/schema/routes | §12 et al | One reconciliation pass | ARCH-003 | SPEC-EDIT |
| M09-F08 | MINOR | PPS license not in BAA register | §1.1/3.3 | Register instruments in BAA register or ADR | ARCH-159/201 | ADR-NEEDED |
| M09-F09 | MINOR | Overstates compliance scope; illegal split ref | §1.3/7.8/1.2 | Reword to "supports"; delete Module 9b ref or ADR | ARCH-157/140 | ADR-NEEDED |
| M09-F10 | MINOR | No DR tier; no BCP re-entry | §2.3/7.10 | Tier-2; paper-origin marking + 72h re-entry | DR-010/064-067 | SPEC-EDIT |
| M09-F11 | MINOR | Internal batch routes lack service-token auth | §4.1 | Service-token+mTLS + min-necessary projection, or drop HTTP | SEC-039/049 | SPEC-EDIT |
| M09-F12 | MINOR | PPS-drop alert too weak; queue params | §4.9/2.2.2/4.8 | Map to clinical-urgent; declare queue params | ARCH-184/262 | SPEC-EDIT |

## Findings — M10 HOPE Engine

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M10-F01 | BLOCKER | Direct cross-module schema imports | §3.3 | FK as plain uuid in raw SQL; resolve context via M5/M6 readers | ADR-0011, ARCH-141/147 | SPEC-EDIT |
| M10-F02 | BLOCKER | SFV clock anchored to signature not visit date | §1.1/D3/2.1/2.3/7.2 | Anchor `due_at` to assessment `target_date`, TZ-aware; remove grace | ADR-0018, SD-015 | SPEC-EDIT |
| M10-F03 | MAJOR | `dependsOn` contradicts manifest; locked pre-ADR | header/§10/§12 | ADR for M8↔M10 inversion (per ADR-0005/0007) | ARCH-142/146/001 | ADR-NEEDED |
| M10-F04 | MAJOR | Partitioning contradicts SD-027 | §3.4/3.6 | Conform to SD-027 or ADR amend | SD-027, ADR-0022 | ADR-NEEDED |
| M10-F05 | MAJOR | Invented 10-yr retention vs matrix | §1.1/3.4/3.6/8.4 | Use §24.1 (6 yr from submission) via M4 | ADR-0004 | ADR-NEEDED |
| M10-F06 | MAJOR | No iQIES inactivation workflow | §1.1/D7/4.10 | Add inactivation flow + adapter method + reconcile | CMS iQIES | SPEC-EDIT |
| M10-F07 | MAJOR | J-item code/label mismatch vs CMS HOPE | §1.1/4.3/1.3 | Re-derive Section J from CMS HOPE v1.00 + golden-file test | Dim I | SPEC-EDIT |
| M10-F08 | MAJOR | Section matrix contradictory; snapshot misplaced | §1.1/D1/§10/12/D8/3.3/4.3 | Single normative matrix; snapshot in dedicated column | ARCH-003/092 | SPEC-EDIT |
| M10-F09 | MAJOR | PHI tables omit PE/location | §3.3 | Add PE (+location); index for per-PE batch | ADR-0010 | SPEC-EDIT |
| M10-F10 | MAJOR | Queue topology vs SD-059; no retry/DLQ | §4.8/4.10/7.13 | Conform/extend SD-059; outbox or ADR submission-table equivalence | SD-059, ADR-0021 | ADR-NEEDED |
| M10-F11 | MAJOR | No instrument version pin | §3.3/1.1/D11 | Add `instrument_version`; version-keyed validation | ARCH-004 | SPEC-EDIT |
| M10-F12 | MINOR | SECURITY DEFINER triggers bypass RLS | §3.4 | Drop SECURITY DEFINER or Security-Owner approval | SEC-026/056 | OUT-OF-BAND |
| M10-F13 | MINOR | Alert payload PHI for push/SMS | §4.9 | PHI-strip at OOB boundary; prefer `patient_id` | SEC-048, ARCH-185 | SPEC-EDIT |
| M10-F14 | MINOR | Invented 7-day grace risks suppressing late HOPE | §1.1/D2/4.6 | Grace = tenant policy; escalating friction not rejection | Dim I, ARCH-268 | SPEC-EDIT |
| M10-F15 | MINOR | Day-counting convention unspecified | §1.1/9.1 | Pin to CMS HOPE manual + boundary tests | Dim I | SPEC-EDIT |
| M10-F16 | MINOR | iQIES creds from undeclared M34 dep | §1.2/4.10 | Store per-PE creds in platform secret (INT-013) | OPS-036, SD-024 | SPEC-EDIT |
| M10-F17 | MINOR | Adapter resilience/envelope storage under-spec | §4.10/3.3/8.5 | Breaker config + DegradedError; per-tenant prefix + lock | INT-009, SD-075 | SPEC-EDIT |
| M10-F18 | MINOR | Fabricated cross-refs; entity drift | D6/2.4/3.3 | Correct refs; note jsonb-vs-entity vs ARCH-092 | ARCH-092 | SPEC-EDIT |
| M10-F19 | MINOR | No BCP re-entry; mobile storage; SFV alert weak | §5.3/7.13/4.9 | Paper-origin marking; sqlcipher; clinical-urgent SFV alert | DR-066/067, SEC-075 | SPEC-EDIT |
| M10-F20 | MINOR | HQRP 90% threshold not on dashboard | §5.2/1.2 | State 90%/30-day threshold; cross-check M30 | ARCH-182 | CROSS-MODULE |

## Findings — M14 IDG

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M14-F01 | BLOCKER | CoP 15-day review clock not enforced per patient | §1.3/2.2/4.3/4.8/4.10/8.1 | Per-patient floor guard on CANCEL/RESCHEDULE; stamp `last_idg_reviewed_at`; escalate | ADR-0018, ARCH-157/164 | SPEC-EDIT |
| M14-F02 | BLOCKER | Consumes M32/M26 but omits from manifest patch | §4.8/2.4/12/§10 | Add 32/26 to dependsOn (per ADR-0005 reword); reconcile lists | ARCH-141/142/235 | ADR-NEEDED |
| M14-F03 | MAJOR | RN coordinator mandate not encoded; wrong cite | §1.3/2.1/4.6 | Model per-patient designated RN coordinator; fix to 418.56(a)(1) | Dim I, ARCH-052 | SPEC-EDIT |
| M14-F04 | MAJOR | M14 claims platform-global notification role | §1.1/3.5/4.11, D15/16 | Move template catalog + recipient resolution to M36 (or producers); ADR if retained | SD-017, ARCH-184/185 | ADR-NEEDED |
| M14-F05 | MAJOR | Patient names in CRITICAL alert bodies → SMS/email | §3.5.1/4.11.2/3/7.14 | `body` in-app-only; OOB generic + deep link; add test | ARCH-185, SEC-048 | SPEC-EDIT |
| M14-F06 | MAJOR | Queue catalog declares no params | §4.9 | Full SD-059 tuple; DLQ triage | ADR-0021, SD-059 | SPEC-EDIT |
| M14-F07 | MAJOR | Monthly partition incompatible w/ UNIQUE index | §3.3/D5/D12 | Include `built_at` in key + delete+insert, or drop partitioning | SD-027/028, ADR-0022 | SPEC-EDIT |
| M14-F08 | MAJOR | Valkey projection is build-input to frozen artifact | §4.5/7.2 | Make cache read-through; re-derive on miss from seams | DR-021/030, SD-032 | SPEC-EDIT |
| M14-F09 | MAJOR | No STRIDE; no per-role authz test matrix | whole/§12 | Add STRIDE + authz matrix w/ negatives | SEC-007/013/014 | SPEC-EDIT |
| M14-F10 | MAJOR | Layer-2 AI ships Phase 1 w/o gates | D6/7.2/8.2/8.3 | Triple gate + kill-switch + report-output; phase-cut ADR | ADR-0012, AI-042/043 | OUT-OF-BAND |
| M14-F11 | MINOR | Wrong RLS var | §3.5.1 (mig 0036) | `app.org_id` + positive RLS assertion | ADR-0010 | SPEC-EDIT |
| M14-F12 | MINOR | Internal HTTP routes contradict §2.8/D11 | §2.8/4.1/D11 | Remove internal HTTP routes or amend transport claim | ARCH-272 | SPEC-EDIT |
| M14-F13 | MINOR | PATCH/DELETE lack Idempotency-Key | §4.1 | Add alongside If-Match | ADR-0021, SD-053 | SPEC-EDIT |
| M14-F14 | MINOR | Auto-close triggers on wrong membership match | §2.7/4.5/D8 | Require `linked_artifact_id`/patient+window match | D8 | SPEC-EDIT |
| M14-F15 | MINOR | Table count drift; no retention class | §3.3/3.4/3.5/12 | Reconcile to 11 tables; assign retention; declare SD-036 pattern | ADR-0004, SD-036 | SPEC-EDIT |
| M14-F16 | MINOR | Role/discipline token set inconsistent | §2.5/D3/7.3 | Single M40-anchored token set; widen RN quorum to discipline=RN | ARCH-052 | CROSS-MODULE |
| M14-F17 | MINOR | No DR tier/degraded/offline | §5 | Tier-2; packet read-availability; mobile offline posture | DR-010/064 | SPEC-EDIT |
| M14-F18 | MINOR | Route accepts `Type.Any()` for care-plan mutation | §4.2 | Express discriminated union at boundary | SEC-061/065 | SPEC-EDIT |
| M14-F19 | MINOR | 17-module dependsOn treated as self-ratifying | §12/§10 | Architecture-lead sign-off (per ADR-0005) | ARCH-235/146 | ADR-NEEDED |

## Findings — M15 Discipline Care Plans

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M15-F01 | BLOCKER | Boundary-violating seam imports vs fitness-green claim | §4.3/13/header/D14 | Relocate seams to `packages/domain` deny-stubs; extend D14; fix claim | ARCH-141/146/235 | ADR-NEEDED |
| M15-F02 | MAJOR | Phase tag vs §20.A w/o ADR | header/D12 | ADR or retag Phase 2 | ADR-0009, ARCH-231 | ADR-NEEDED |
| M15-F03 | MAJOR | Aide POC gate absent; annual observation clock missing | §1.1/2.2.4/7.1/D3/D10 | Gate `chha_visit` on signed Aide POC; annual per-aide observation + cap | 42 CFR §418.76 | SPEC-EDIT |
| M15-F04 | MAJOR | Volunteer 5% ratio denominator mismatch | §1.2/2.2.7/7.6/D8 | Denominator = patient-care hours (M27/M23); dollars only for cost-savings | 42 CFR §418.78(e) | CROSS-MODULE |
| M15-F05 | MAJOR | PHI tables lack PE/location | §3.3 | Add PE/location from admission + composite indexes | ADR-0010 | SPEC-EDIT |
| M15-F06 | MAJOR | Partitioning incoherent; unique constraints uncreatable | §3.3/3.6/D13 | Un-partition or re-key unique to include partition col | SD-027, ADR-0022 | SPEC-EDIT |
| M15-F07 | MAJOR | IDG decision contract mismatch vs M14 envelope | §1.1/4.6/7.7 | Propose M14 envelope extension cross-spec; align topics | ARCH-146 | CROSS-MODULE |
| M15-F08 | MINOR | `family_violence_disclosure` consent not in M39 | §4.5/D9 | File M39 catalog addition or re-base on M5 PrivacyFlag | ARCH-190 | CROSS-MODULE |
| M15-F09 | MINOR | Seam/consumer drift; `CarePlanReader` not in M7 | header/§4.3 | Add consumer-manifest note; reconcile with M7 owner | ARCH-146 | CROSS-MODULE |
| M15-F10 | MINOR | List routes lack cursor; queue/alert schema | §4.1/4.6 | Cursor pagination; full queue params; alert-as-code | ADR-0021, SD-052 | SPEC-EDIT |
| M15-F11 | MINOR | No STRIDE; no DR tier | (absent) | Add STRIDE + DR (Tier-2); fail-closed gate w/ audited override | SEC-007, DR-010 | SPEC-EDIT |
| M15-F12 | MINOR | Quality nits | §3.3/3.6/1.1/2.4 | Normalize boolean; reconcile narrative ownership; align names | ARCH-003 | SPEC-EDIT |

## Findings — M16 Bereavement

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M16-F01 | BLOCKER | Invented 13-month retention destroys clinical records | header/3.4.1/8.5 | Assign clinical-record class (6y) via M4; ADR if distinct class ≥6yr | ADR-0004, ARCH-250/253 | ADR-NEEDED |
| M16-F02 | MAJOR | Manifest patch incomplete; illegal `phase` field | §6/13/4.5/3.1 | Add 1–4; remove `phase`; move types to non-leaf pkg (per ADR-0005) | ARCH-141/142/146 | ADR-NEEDED |
| M16-F03 | MAJOR | M14 `bereavement_risk_flag` seam has no consumer | §4.5 | Add `idg.decision_recorded` consumer + dep 14, or retire in M14 | ARCH-146 | CROSS-MODULE |
| M16-F04 | MAJOR | No timeliness enforcement eligibility→activation | §2.2/4.9/14.3 | Platform-floor activation clock + escalation; measure 14-day from death | 42 CFR §418.64(d) | SPEC-EDIT |
| M16-F05 | MAJOR | Pervasive DDL↔workflow schema drift | §3.3 et al | Reconcile DDL to workflows (history table, columns, unified scale) | ARCH-003 | SPEC-EDIT |
| M16-F06 | MAJOR | LLM risk-narrative missing AI gates | D3/§10/8.1/4.3 | Register capability; triple gate; kill switch; report-output | ADR-0012, AI-011/012/014 | OUT-OF-BAND |
| M16-F07 | MAJOR | Queue catalog no retry/backoff/DLQ | §4.9 | SD-059 tuple per queue; fix HTTP vs job idempotency | ADR-0021, SD-059 | SPEC-EDIT |
| M16-F08 | MAJOR | No STRIDE; inadequate authz matrix | whole/§9.3 | Add STRIDE + per-role authz enumeration | SEC-007/013/014 | SPEC-EDIT |
| M16-F09 | MINOR | Route namespace missing version segment | §4.1 | Normalize to `/api/v1/bereavement/...` | SD-049/050 | SPEC-EDIT |
| M16-F10 | MINOR | CHECK embeds sub-SELECT; off-by-one | §3.3.4 | Trigger/denormalized column; fix 425/426 | ADR-0022, SD-030 | SPEC-EDIT |
| M16-F11 | MINOR | Consent verified after outreach; email mechanics | §2.5/7.6/4.4 | Gate consent at `startContact`; route via M36 + opt-out | SEC-047, ARCH-190 | SPEC-EDIT |
| M16-F12 | MINOR | Channel `archives_at` anchor inconsistent | §1.1/1.2/2.2 | Standardize on `death_date` | D4 | SPEC-EDIT |
| M16-F13 | MINOR | Migration inserts into M1/M4 tables; wrong RLS var | §3.4.1/2/8.5 | Seed via owner APIs; `app.org_id`; align eraser path | ADR-0010/0011 | SPEC-EDIT |
| M16-F14 | MINOR | Platform-floor touchpoints stated 3 ways | §1.1/changelog/D4 | Single normative floor table | D4 | SPEC-EDIT |
| M16-F15 | MINOR | Coverage low; no DR tier/cron catch-up | §9.1 | ≥90% coverage; DR tier; cron catch-up semantics | ARCH-211, DR-010 | SPEC-EDIT |
| M16-F16 | MINOR | Four CFR citations wrong | §1.3 | Correct to 418.56(c)/418.56(e)/164.502(f)/418.64 | Dim I | SPEC-EDIT |

## Findings — M18 EVV

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M18-F01 | BLOCKER | State-EVV aggregator not in Integration Catalog | §1.1/1.2/3.1/4.5/7.8-9 | INT-002 five-step + BAA/trading-partner + Security-Owner before lock | ADR-0020, INT-014, SEC-099 | OUT-OF-BAND |
| M18-F02 | BLOCKER | M39 consent import outside dependsOn | §4.4/13 | Add M39 (reviewed) or remove direct consent eval | ARCH-141/146 | ADR-NEEDED |
| M18-F03 | MAJOR | dependsOn 1→9 lacks ADR | header/D16/13 | ADR (per ADR-0005); decide outbox-only M8 representation | ARCH-001/142/146 | ADR-NEEDED |
| M18-F04 | MAJOR | EVV applicability/launch-state undefined | §1.1/1.3/3.1/7.8-9/12 | Per-(state×payer×service) matrix; Oregon launch (ADR-0008) | ADR-0008, ARCH-168 | SPEC-EDIT |
| M18-F05 | MAJOR | Invented M23 EVV gate + false HQRP measure | header/§1.1/4.3 | Gate = tenant-operational not regulatory; rename M30 surface | ADR-0008, ARCH-174/182 | SPEC-EDIT |
| M18-F06 | MAJOR | Load-bearing M2 surfaces not in manifest | §1.1 D8/2.2.3/3.3 | Verify vs locked M2; patch or propose owners; DEK helper→M1 | ARCH-143/233/234 | CROSS-MODULE |
| M18-F07 | MAJOR | Outside-geofence contract deviates SD-014 | §2.2.1/3.3/7.5 | Enforce SD-014 (422 w/o reason); add breach columns; align Socket event | SD-014/057 | SPEC-EDIT |
| M18-F08 | MAJOR | System closure recorded as clinician attestation | §2.4/2.2.4 | Distinct system-closure status; reserve attestation for real reasons | ARCH-041, 42 CFR §455.20 | SPEC-EDIT |
| M18-F09 | MAJOR | 15+ internal contradictions | many | Single reconciliation pass | ARCH-003/043 | SPEC-EDIT |
| M18-F10 | MINOR | No DR tier (Tier-1 service) | §8/9 | DR/degraded subsection; offline continues; queue submissions | DR-010/064 | SPEC-EDIT |
| M18-F11 | MINOR | Idempotency-Key missing | §4.1 | Declare on every mutating route | ADR-0021, SD-053 | SPEC-EDIT |
| M18-F12 | MINOR | Module-local rate limit invented | §8.3 | Platform limiter config | SEC-019, SD-055 | SPEC-EDIT |
| M18-F13 | MINOR | M18 payload in M36 codePath | §4.9 | Keep in `packages/evv`; register via M36 API | ARCH-141 | SPEC-EDIT |
| M18-F14 | MINOR | Missing §8 audit section + DLQ | §4.8/8/12 | Add §8; declare retry/backoff/DLQ | ADR-0021, SD-059 | SPEC-EDIT |
| M18-F15 | MINOR | Phase-1 scope exceeds §20.A | phase/§12 | Note deviation in F03 ADR or split behind flag | ADR-0009 | ADR-NEEDED |
| M18-F16 | MINOR | Alert PHI lacks OOB restriction | §4.9 | In-app only sentence | ARCH-185, SEC-048 | SPEC-EDIT |
| M18-F17 | MINOR | Data-scoping pattern not declared | §3.3/3.5 | Add pattern-1 line per table | SD-036 | SPEC-EDIT |

## Findings — M19 On-Call Triage

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M19-F01 | BLOCKER | Imports seams from modules absent from patch | §4.4/4.5/13 | Remove M6/7/9/16 consumption or add w/ justification (per ADR-0005) | ARCH-141/142/146 | ADR-NEEDED |
| M19-F02 | BLOCKER | No `location_id` on PHI tables | §2.1/3.3 (9 tables) | Add `location_id`; scope `on_call_shift` by Location | ADR-0010, ARCH-010/011 | SPEC-EDIT |
| M19-F03 | BLOCKER | Module-local vendor SSO outside Better Auth | §7.5/8.2/9.8 | Route vendor identity through M2 + ADR + Security-Owner | SEC-006 App.A.3, ARCH-050 | ADR-NEEDED |
| M19-F04 | MAJOR | External triage-vendor PHI not catalogued | §1.1/7.5/7.10/8.5 | INT-002 + SEC-099 before merge; gate on ADR-013 | ADR-0020, INT-014 | OUT-OF-BAND |
| M19-F05 | MAJOR | Phase-1 self-declaration vs §20.A Phase-2 | header | ADR or read Phase 2 | ADR-0009, ARCH-231 | ADR-NEEDED |
| M19-F06 | MAJOR | Pervasive internal contradictions | many | Single-source every enum/predicate/key/route/column | ARCH-003/004 | SPEC-EDIT |
| M19-F07 | MAJOR | Two AI capabilities missing governance | §1.1/4.4/8.6/7.8 | Catalog + lifecycle + kill-switch + opt-out + report-output | ADR-0012, AI-011/012/014 | ADR-NEEDED |
| M19-F08 | MAJOR | Tier-1 module no DR; boot-refusal hazard | §1.3/2.4/5.2 | Tier-1 + degraded; BCP re-entry; delete boot-refusal | DR-010/013/064-067 | SPEC-EDIT |
| M19-F09 | MAJOR | Part 2 not filtered at vendor boundary | §7.5/D13/1.3 | Run vendor payload through M5/M39 gate; redact by default | ADR-0014, SEC-046 | OUT-OF-BAND |
| M19-F10 | MINOR | Retention class self-contradiction | §1.1 vs §8.4 | `clinical_record` + state override; cite OPEN-021 | ADR-0004 | SPEC-EDIT |
| M19-F11 | MINOR | Three CFR citations incorrect | §1.1/1.3/2.1 | Fix to 418.100(c)(2)/418.64(b)/418.52 | Dim I | SPEC-EDIT |
| M19-F12 | MINOR | Queue catalog missing params; cadence 3 ways | §4.8/4.10/7.4 | Full SD-059 params; one cadence; unify topics | ADR-0021, SD-059 | SPEC-EDIT |
| M19-F13 | MINOR | `triage_protocol` mixes platform/tenant rows | §3.3/3.5/D7 | Specify mixed-read DDL or split per pattern 3 | SD-036 | SPEC-EDIT |
| M19-F14 | MINOR | Manifest codePaths conflict §3.1 | §13 vs 3.1 | Reconcile to one package set; regen seams from boot | ARCH-146/141 | SPEC-EDIT |
| M19-F15 | MINOR | Missing §8 audit catalog; local rate limits | §8/8.3 | Add audit catalog; platform limiter config | ARCH-003, SD-055 | SPEC-EDIT |

## Findings — M20 Field Safety (no BLOCKERs)

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M20-F01 | MAJOR | Phase tag vs §20.A; no ADR | header/D1/2.2.4/1.3/4.5 | ADR moving M20 to Phase 1; reconcile §20.A | ADR-0009, ARCH-231 | ADR-NEEDED |
| M20-F02 | MAJOR | dependsOn 2→10 lacks ADR | D16/13 | Same ADR as F01 (per ADR-0005); fix false rationale | ARCH-142/146/235 | ADR-NEEDED |
| M20-F03 | MAJOR | Platform-floor rows violate notNull/RLS | §3.2/3.3/3.5/2.2.7 | Pattern-2 platform-shared tables or code constants | SD-036, ADR-0010 | SPEC-EDIT |
| M20-F04 | MAJOR | Unique index forbids multiple check-in rows | §3.3/D3/2.6/7.1 | Re-key to `(visit_id,kind,expected_at)` | ADR-0022 | SPEC-EDIT |
| M20-F05 | MAJOR | Life-safety escalation no terminus; SOS rate-limitable | §2.2.2/3.3/8.3/D10 | Add tier-3-exhausted terminus; SOS cap = flag-only, never suppress | ARCH-170/184, INT-031 | SPEC-EDIT |
| M20-F06 | MAJOR | Unregistered M2 emergency-contact surfaces | header/D10/2.2.2 | Verify vs M2; assign to M20 tables or manifest edit | ARCH-143 | CROSS-MODULE |
| M20-F07 | MAJOR | PostGIS introduced without ADR | §3.2/3.3 | ADR for PostGIS or implement without; fix false claim | ADR-0022, ARCH-027 | ADR-NEEDED |
| M20-F08 | MINOR | Socket.IO room taxonomy deviation | header/§5.1 | Use `safety:<orgId>` per SD-057 | SD-057/058 | SPEC-EDIT |
| M20-F09 | MINOR | No DR tier for life-safety path | §8/9 | Tier-1 SOS + DR-013 caveat; degraded table | DR-010/013, INT-031 | SPEC-EDIT |
| M20-F10 | MINOR | SOS idempotency deviation undocumented | §4.1/4.2 | One sentence citing SD-053; accept key for retry dedup | SD-053 | SPEC-EDIT |
| M20-F11 | MINOR | GPS-spoof badge in instance memory | §7.7 | Use Valkey | SD-062 | SPEC-EDIT |
| M20-F12 | MINOR | Partition claim unimplemented; retention outside §24 | §2.2.2/3.2/3.7 | Implement/drop partition; register rotate; M4 retention extension | SD-027, ADR-0004 | SPEC-EDIT |
| M20-F13 | MINOR | Consumed package names match no codePaths | §4.4/8.5 | Align to patched codePaths; fix `evv-client`→`evv` | ARCH-141 | SPEC-EDIT |
| M20-F14 | MINOR | PHI indexes missing leading org_id | §3.3 | Prefix `organization_id` | SD-028 | SPEC-EDIT |
| M20-F15 | MINOR | §8 template section replaced | §8/10.J | Restructure to template §8 | ARCH-003 | SPEC-EDIT |
| M20-F16 | MINOR | Consent-coercion posture needs HR/legal review | §2.2.2/5.2/8.7 | HR/legal language; allow SOS without coords | SEC-001 | OUT-OF-BAND |
| M20-F17 | MINOR | Producer updating locked M36 rule unverified | §4.5 | Verify vs M36; resolver may need M36-side seed | ARCH-185 | CROSS-MODULE |

## Findings — M22 Documents

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M22-F01 | BLOCKER | Proposed dependsOn creates cycles | §13.1/13.5/header/D18 | Event-only consumption (no edge) per ADR-0005; re-run cycle analysis | ADR-0005, ARCH-142/146 | ADR-NEEDED |
| M22-F02 | BLOCKER | Patient last name in signed-URL filename (PHI) | §7.10 W10/D11 | Opaque `{documentType}-{shortVersionId}.pdf`; client-side name; negative test | SEC-015/048, SD-078 | SPEC-EDIT |
| M22-F03 | BLOCKER | Uninventoried print/mail vendor (Lob/PostalMethods) | §1.2/3.1/2.2.4/2.6/4.10 | Per D19: delete adapters/webhook/`delivered` from v1; INT-002+SEC-099 in Phase 2 | ADR-0020, INT-014 | SPEC-EDIT |
| M22-F04 | MAJOR | Confidence-floor bulk-approve gate missing | §1.1/1.4/2.3/4.2/4.7 | Bulk-approve only if low-risk ∧ conf≥floor; fix inverted prose; negative test | ARCH-114, AI-031 | SPEC-EDIT |
| M22-F05 | MAJOR | Mandated form templates missing | §4.5/3.3/3.1/D14 | Add NOE/NOTR/CMS-485/GIP templates; reconcile D14 count | ARCH-172 | SPEC-EDIT |
| M22-F06 | MAJOR | Retention-matrix nonconformance | §3.3/4.5/8.6/1.3/3.7 | Map every class to §24.1; remove 13-mo destruction; honor override | ADR-0004 | SPEC-EDIT |
| M22-F07 | MAJOR | Eraser/destruction contract defects | §3.7/4.4/D12/8.6/7.14 | Register `documents` eraser; fix M40→M4 attribution; no early log drop | ARCH-233/234/251 | SPEC-EDIT |
| M22-F08 | MAJOR | UPDATE granted on append-only tables | §3.2/8.1/12.2 | INSERT/SELECT-only grants; reconcile trigger column list | SEC-010, ARCH-055 | SPEC-EDIT |
| M22-F09 | MAJOR | RLS wrong column + ABAC in DB layer | §8.2/3.3/3.5 | Use M1 template on `app.org_id`; move ABAC to route layer | ADR-0010, ARCH-067/080 | SPEC-EDIT |
| M22-F10 | MAJOR | Encryption design contradictory/off-standard | §8.3/header/3.3/D1/D12 | Align LUKS+pgcrypto+SSE per SEC-023 (or Security-Owner sign-off); shred=key destroy | SEC-023, ARCH-081/200 | OUT-OF-BAND |
| M22-F11 | MAJOR | §164.524 export lacks bulk-export controls | §4.1/1.3/4.10 | SEC-052 workflow on export route | SEC-051/052/038 | SPEC-EDIT |
| M22-F12 | MAJOR | Upload lacks content-type/size/scan | §4.1/8.1/4.10 | Size limits + MIME allowlist + magic-byte; scan stage; platform limiter | SEC-065/061, SD-013 | SPEC-EDIT |
| M22-F13 | MAJOR | Auditor watermarking excluded for non-portal | §7.10 W10/4.7/3.3 | Watermark any auditor/survey download; accept M3 engagement context | ARCH-058 | SPEC-EDIT |
| M22-F14 | MAJOR | No DR/BCP posture (Tier 2) | (new) /5.2 | DR/BCP section; Weekly BCP Print for code-status/AD/DPOA | DR-010/064/070 | SPEC-EDIT |
| M22-F15 | MAJOR | AI-governance gaps (kill-switch/report/audit events) | D1/8.5/D7/4.9/4.10 | `ai.doclens_kill`; report-output; M32 emits audit events | ADR-0012, AI-066/070 | SPEC-EDIT |
| M22-F16 | MAJOR | Two contradictory permission/ABAC catalogs | §4.6/4.7/6.1-3/7.8 | Collapse to one canonical catalog; regen role-grants | ARCH-233, SEC-036 | SPEC-EDIT |
| M22-F17 | MAJOR | Undeclared M8 dependency via seam | §7.13/7.2/header/13 | M8 pushes render payload in event, or declare dep + cycle analysis | ARCH-141/147 | CROSS-MODULE |
| M22-F18 | MAJOR | Fax/email ingest uninventoried | §7.3/3.3/2.1 | Restrict v1 intake or add INT rows | INT-001/002/005 | SPEC-EDIT |
| M22-F19 | MAJOR | Status/event/column vocab inconsistent | §3.3/4.10 et al | One reconciliation pass; resolve soft-delete; align threshold | ARCH-043/260 | SPEC-EDIT |
| M22-F20 | MINOR | 21 CFR Part 11 mislabeled as required | §1.3 | Re-label "best practice (§23.7)" | ARCH-241 | SPEC-EDIT |
| M22-F21 | MINOR | Bucket layout diverges from canonical | D1/1.1/7.2/7.1 | Adopt `tenants/<org_id>/…`; versioning ON | SD-033, DR-019 | SPEC-EDIT |
| M22-F22 | MINOR | Perf budgets diverge SD-066 | §9.5 | Align p95 budgets or ADR | ARCH-117, SD-066 | SPEC-EDIT |
| M22-F23 | MINOR | §4.11.1 example contradicts schema | §4.11.1 et al | Rewrite example to insert `form_fill`, pass `tx` | ARCH-264/269 | SPEC-EDIT |
| M22-F24 | MINOR | Missing template sections | §4.1/4.8/9.2/9.3 | Add open-questions/idempotency/DLQ/OTel; PG18 | ADR-0021 | SPEC-EDIT |
| M22-F25 | MINOR | Mobile offline PHI cache unencrypted | §5.2 | sqlcipher + logout eviction + FLAG_SECURE | SEC-075 | SPEC-EDIT |
| M22-F26 | MINOR | Non-canonical app dir names | §5/5.4 | `apps/frontend`,`apps/mobile`,`apps/portal` | SD-001, ARCH-020 | SPEC-EDIT |
| M22-F27 | MINOR | Idempotency-Key undocumented; single-use URL claim | §4.1/1.3/2.6 | Add idempotency column; correct single-use claim | ADR-0021, SD-053 | SPEC-EDIT |

## Findings — M26 Cap Management

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M26-F01 | BLOCKER | **[STALE-FIX]** Cap-year window "overridden without ADR" | changelog/§1.3/D1/schema | **Do NOT revert.** ADR-0002 ratifies Oct 1–Sep 30; spec already cites it → RESOLVED | **ADR-0002** | RESOLVED-VERIFY |
| M26-F02 | BLOCKER | Cross-module Drizzle import + FK to M1 table | §3.3 (565/574) | Remove import/FK; `org_id` plain uuid via RLS | ADR-0011, ARCH-141/147 | SPEC-EDIT |
| M26-F03 | BLOCKER | Fabricated M36 `cap_watch` kind + M2 biometric class | §5/4.9/D12/5.4/13 | Route via M36 AlertEmitter; use M2 `STEP_UP_POLICY` (WebAuthn/TOTP/300s) | ARCH-141/184/233 | CROSS-MODULE |
| M26-F04 | BLOCKER | Append-only tables UPDATEd by eraser; bad audit API | §2.3/3.6/3.7/8.4 | Crypto-erasure or relax immutability (not both); use `audit()` to `audit_event` | ARCH-144/265, SEC-010 | SPEC-EDIT |
| M26-F05 | MAJOR | M23↔M26 cycle | §5/6/13 | M23 consumes cap projection via outbox/seam; arch ruling | ADR-0005, ARCH-235 | ADR-NEEDED |
| M26-F06 | MAJOR | Cap-period state machine contradictory | §2.2/3.2/3.3/4.1/4.5/4.7 | One canonical status/`cap_year` type; snapshot test | ARCH-092/260 | SPEC-EDIT |
| M26-F07 | MAJOR | Consumed seam/event names don't match producers | §5/4.4/7.1/7.13 | Bind to producers verbatim (`m25.remittance.advice_posted`, etc.) | ARCH-233, SD-061 | CROSS-MODULE |
| M26-F08 | MAJOR | No Idempotency-Key on mutating routes | §4.1/2.6 | Declare 24h/409 via M1 middleware | ADR-0021, SD-053 | SPEC-EDIT |
| M26-F09 | MAJOR | PS&R CSV upload lacks bulk-PHI controls | §3.3/4.1/1.2 | `tenants/<org>/cap/psr/` + IAM + audit + retention + step-up | SEC-038/052/051 | SPEC-EDIT |
| M26-F10 | MAJOR | MAC-region PS&R + CMS API not inventoried | §2.1/1.2/3.2/D9 | Remove pre-coded enum until INT-002; Phase-3 file-based via M29 | ADR-0020, INT-005/044 | OUT-OF-BAND |
| M26-F11 | MAJOR | No DR tier/degraded/BCP | §9.6 | Tier-3; degraded behavior; SLO ceiling | DR-010/011/013 | SPEC-EDIT |
| M26-F12 | MAJOR | Phase tag vs settlement/PS&R phase cut | header/§10/D9 | Gate behind Phase-3 flags or ADR | ADR-0009, ARCH-231 | ADR-NEEDED |
| M26-F13 | MAJOR | Inpatient cap mis-modeled; math imprecise | §2.1/7.5-6/3.3 | Define denominator per §418.302(f); explicit overage formula; SME review | ARCH-175 | SPEC-EDIT |
| M26-F14 | MINOR | Entity names diverge | §2.1/3.3 | Align to ARCH-092 canonical names | ARCH-092 | SPEC-EDIT |
| M26-F15 | MINOR | `finalizationSnapshot` referenced not in schema | §8.3 vs 3.3 | Add column or remove claim | internal | SPEC-EDIT |
| M26-F16 | MINOR | Audit-trigger denylist disagrees | §3.6 vs 8.4 | Consolidate to one list | internal | SPEC-EDIT |
| M26-F17 | MINOR | Queues lack DLQ; cron UTC vs local | §4.8 | Declare DLQ/concurrency; local-time cron | ADR-0021, SD-059 | SPEC-EDIT |
| M26-F18 | MINOR | Testcontainers PG16 not PG18 | §9.2 | PG18 | ARCH-270 | SPEC-EDIT |
| M26-F19 | MINOR | Route/ABAC state names contradict machine | §4.1/4.7/2.2 | Resolve under F06 canonical vocab | internal | SPEC-EDIT |
| M26-F20 | MINOR | AI catalog entry not closed for deterministic module | §8.7 | Remove AI-011 entry or mark deterministic | AI-011/087 | SPEC-EDIT |

## Findings — M30 HQRP & Quality

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M30-F01 | BLOCKER | Part 2 trigger reads 3 cross-module tables | §3.8.1 (1290-1324) | Move classification to service layer; compute via seams; pass as column | ADR-0011/0014, ARCH-147 | CROSS-MODULE |
| M30-F02 | BLOCKER | Unratified 5→23 dependsOn expansion | header/13.1/D25 | Reduce to seam-routed deps or ADR (per ADR-0005) | ARCH-140/146/235 | ADR-NEEDED |
| M30-F03 | BLOCKER | Contradictory incident state machines + table names | §2.2 vs D8; §3.8 vs 3.3 | Reconcile to one schema + one machine; downgrade until merged | ARCH-043/260 | SPEC-EDIT |
| M30-F04 | MAJOR | SFV window encoded 48h not 2 calendar days | §9.2/7.12 | Encode 2 calendar days; cite ADR-0018/M10 D4 | ADR-0018, ARCH-160 | SPEC-EDIT |
| M30-F05 | MAJOR | No Idempotency-Key on mutating routes | §4.1/2.6 | Add via M1 middleware | ADR-0021, SD-053 | SPEC-EDIT |
| M30-F06 | MAJOR | PHI lists not cursor-based | §9.6/4.1 | Cursor pagination on R-50/70/90 | SD-052 | SPEC-EDIT |
| M30-F07 | MAJOR | DR tier mis-declared (Tier 2 RTO) | §12.8 | Declare Tier-3; CAHPS Tier-4 | DR-010/013 | SPEC-EDIT |
| M30-F08 | MAJOR | Direct sync M12→M30 call bypasses outbox | §4.10 | M12 emits typed event; M30 subscribes | ADR-0011, ARCH-272 | CROSS-MODULE |
| M30-F09 | MAJOR | Module-local rate limiting | §8.4 | Platform limiter + quotas | SEC-019, SD-055 | SPEC-EDIT |
| M30-F10 | MAJOR | CAHPS vendor under-catalogued + ADR-jumped | D5/§4.5 | Reconcile to `packages/cahps-client`; INT-002; surface ADR-005 | ADR-0020, INT-005/026 | ADR-NEEDED |
| M30-F11 | MAJOR | Retention values internally inconsistent | WF-05/§8.5 | Map each class to §24.1; reconcile 7y vs 15y CAHPS | ADR-0004 | SPEC-EDIT |
| M30-F12 | MAJOR | risk_register_view/RLS missing PE scoping | §3.3/8.1/3.5 | Add `provider_entity_id` to view + RLS | ADR-0010, ARCH-011 | SPEC-EDIT |
| M30-F13 | MINOR | ABAC/CHECK reference nonexistent columns | §4.7/8.4 vs 3.3 | Align to `*_membership_id` columns | ARCH-003 | SPEC-EDIT |
| M30-F14 | MINOR | Part 2 redisclosure controls absent | D23/§8.1 | Add Part 2 segregation gate via M5/M39 | ADR-0014, SEC-046 | CROSS-MODULE |
| M30-F15 | MINOR | Error semantics inconsistent | WF-08/12/4.14.4 | 403 vs 422 discipline; std envelope | SD-051 | SPEC-EDIT |
| M30-F16 | MINOR | CAHPS export mislabeled "M40 object storage" | WF-05 | MinIO `tenants/<org>/exports/` + SEC-052 | ARCH-082, SD-033 | SPEC-EDIT |
| M30-F17 | MINOR | Job idempotency cites wrong validator | §4.8 | Fix V-8 ref; DLQ per queue | DR-022, OPS-035 | SPEC-EDIT |
| M30-F18 | MINOR | No degraded-mode/BCP | (new) | Add degraded-mode section | DR-064/070 | SPEC-EDIT |
| M30-F19 | MINOR | STRIDE unmapped; bad validator cites | §8.4 | Cross-check SEC §3.4; fix V-13/V-1 | SEC-007 | SPEC-EDIT |
| M30-F20 | MINOR | RLS test coverage not enumerated | §9.3/8.1 | Enumerate per-table RLS tests + admin-refresh cross-tenant | ARCH-211, SEC-009 | SPEC-EDIT |
| M30-F21 | MINOR | Future LLM deny-stub not gated | §1.2/D18 | Note AI lifecycle entry required | OPS-049, AI-082 | SPEC-EDIT |

## Findings — M34 SaaS Tenant Platform

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M34-F01 | BLOCKER | Support-session decouples PHI access from break-glass | §1.1/1.2/D8/D21/7.4/8.1 | Make support-session a break-glass variant + consent ref | ARCH-056/186, SEC-017 | SPEC-EDIT |
| M34-F02 | BLOCKER | Tenant PHI tables lack `organization_id` | §3.3-3.6/3.10 | Add `organization_id NOT NULL`+RLS+index; co-partition events | ADR-0010, ARCH-011/080 | SPEC-EDIT |
| M34-F03 | BLOCKER | Gates on nonexistent `platform_ops` session class | §1.1/4.1/4.5/6 | Re-base on M3 RBAC `platform_ops` on staff session; ADR if new class | ADR-needed, ARCH-014/066 | ADR-NEEDED |
| M34-F04 | MAJOR | dependsOn expansion not reviewed/merged | header/D23/13 | Land manifest patch as reviewed decision (per ADR-0005) | ARCH-235/146 | ADR-NEEDED |
| M34-F05 | MAJOR | Package rename orphans Stripe VENDOR_ADAPTERS | §1.1/D23/13 | Keep `packages/saas` or repoint VENDOR_ADAPTERS + arch tree | ARCH-145, OPEN-025 | CROSS-MODULE |
| M34-F06 | MAJOR | DSAR URL TTL 7 days (must be 24h) | §3.7/rule13/7.6 | 24h URL (object delete stays 7d); SEC-052 workflow | SEC-052, SD-052 | SPEC-EDIT |
| M34-F07 | MAJOR | Step-up invents factors not in M2 STEP_UP_POLICY | §6/D10 | Express vs M2 contract (webauthn/totp/300s); remove password factor | M2 STEP_UP_POLICY, OPEN-020 | CROSS-MODULE |
| M34-F08 | MAJOR | DEK destruction ignores Part 2 eraser-refusal | §3.5/7.2/7.7/2.5 | Condition DEK destroy on non-refusal; block + re-defer on refusal | ADR-0014, ARCH-251 | CROSS-MODULE |
| M34-F09 | MAJOR | DSAR PHI reads bypass authz via platform context | §4.1/3.10 | Break-glass+audit for cross-tenant; export under `withOrgContext` | ADR-0011, ARCH-085/186 | SPEC-EDIT |
| M34-F10 | MAJOR | Partitioned event tables miss org_id/rotate | §3.6/3.7/13 | Add org_id; co-partition; register `partition.rotate` | SD-027/028, OPS-021 | SPEC-EDIT |
| M34-F11 | MINOR | Permission-key count contradicts | §4.4/D7/12 | Reconcile to 41 | ARCH-003 | SPEC-EDIT |
| M34-F12 | MINOR | SupportTicket absent; DataExport names diverge | §2/D9 | Note omission; map arch entity names | ARCH-092 | SPEC-EDIT |
| M34-F13 | MINOR | Support/DSAR lack Part 2 classification | §8.2/8.4/3.6 | Classify PHI-Sensitive; DSAR honors Part 2 redaction | ADR-0014, SEC-046 | CROSS-MODULE |
| M34-F14 | MINOR | Not all M36 payloads verified PHI-free | §2.5/4.8/4.9 | Assert M36 sanitization wrapper for all 18 payloads | ARCH-185 | SPEC-EDIT |
| M34-F15 | MINOR | Invitation token hash in URL path | §4.1 | Move token to body/header | SD-052, SEC-015/048 | SPEC-EDIT |
| M34-F16 | MINOR | Migration omits two-phase/backup tag | §10/13 | Forward-only + expand/contract; backup tag | ARCH-271, OPS-016 | SPEC-EDIT |
| M34-F17 | MINOR | RLS tests cover only 4 cases | §9.3 | Expand per-table after F02; cross-tenant bypass tests | ARCH-211, SEC-053 | SPEC-EDIT |

## Findings — M35 Subscription Billing

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M35-F01 | BLOCKER | Stripe SDK outside registered adapter package | §3.1/8.7/13 | Place SDK in `packages/saas` or repoint VENDOR_ADAPTERS | ARCH-145/281, SEC-058 | ADR-NEEDED |
| M35-F02 | BLOCKER | Manifest M34→M35 edge inverted/dropped | §11 D23/D24/13 | Restore `34` to dependsOn; consume M34 seams/events | ADR-0005, ARCH-142/146 | CROSS-MODULE |
| M35-F03 | BLOCKER | Invented M5/M28/M29 deps/events/meters | §4.6/4.12/2.1/3.3/D21 | Drop invented deps; source via M5 seam + M34; ADR for FHIR metering | ARCH-142/272/235 | ADR-NEEDED |
| M35-F04 | MAJOR | Direct Drizzle import of other modules' tables | §3.3 | Use M1 helper + owner repos | ADR-0011, ARCH-147 | SPEC-EDIT |
| M35-F05 | MAJOR | M4 audit denylist redefined in M35 | §3.6/2.4/8.4 | Route via M4 `audit()`; reference not redefine | ARCH-144 | CROSS-MODULE |
| M35-F06 | MAJOR | Invoice retention via unsafe org_id rewrite | §3.7/D13/8.6 | First-class platform-retention table + M4 cert workflow | ARCH-186/085/251 | CROSS-MODULE |
| M35-F07 | MAJOR | Queues missing retry/backoff/DLQ | §4.9/4.13 | SD-059 params + DLQ triage | ADR-0021, SD-059 | SPEC-EDIT |
| M35-F08 | MAJOR | Idempotency-Key contract unspecified | §4.1/4.2/4.4/2.6 | All mutating routes accept key (M1 middleware) | ADR-0021, SD-053 | SPEC-EDIT |
| M35-F09 | MAJOR | 404/403 RLS discipline + error envelope absent | §4.4/7/9.4 | Std envelope + 404-for-hidden + IDOR tests | SD-051, SEC-036 | SPEC-EDIT |
| M35-F10 | MAJOR | No DR section (Tier 3 prose only) | §1.2/2.6 | DR section: Tier-3, degraded, statelessness | DR-010/013 | SPEC-EDIT |
| M35-F11 | MINOR | Invalid multi-command RLS policy | §3.5 | `FOR ALL` + command guard or separate policies | ADR-0022, SD-029 | SPEC-EDIT |
| M35-F12 | MINOR | `usage_event` retention not anchored | §2.2/8.6/3.2 | Assign §24 class; add to `partition.rotate` | ADR-0004, OPS-020 | ADR-NEEDED |
| M35-F13 | MINOR | INT-002 conformance absent | §1.2/8.7 | Cross-ref INT-005/§6.11/§8; reconcile adapter name | INT-002/005 | SPEC-EDIT |
| M35-F14 | MINOR | Valkey DB numbering/TTLs unstated | §2.6/4.9 | Reference M1 middleware; DB separation | SD-032 | SPEC-EDIT |
| M35-F15 | MINOR | Secret rotation bad line ref; inventory incomplete | §8.9 | Cite OPS §8.1; add secrets to inventory | OPS-036, INT-013 | SPEC-EDIT |
| M35-F16 | MINOR | New roles not framed as catalog additions | §4.7/6.1 | Document AR/billing/platform roles per ARCH-052 | ARCH-052 | SPEC-EDIT |
| M35-F17 | MINOR | Alerts not in OPS-043 YAML | §9.8/9.9/4.10 | Add `alerts/*.yaml` | OPS-043, SD-080 | SPEC-EDIT |
| M35-F18 | MINOR | DR/INT update obligations not flagged | §1.3/13 | Note DR-073/INT-048 obligations | DR-073, INT-048 | SPEC-EDIT |

## Findings — M36 Secure Messaging & Alerts

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M36-F01 | BLOCKER | dependsOn expansion creates cycles, inverts order | header/§12/3.12/4.6.1 | Revert to `[1,2,3,4]`; payload catalog = registration interface | ADR-0005, ARCH-142/230 | ADR-NEEDED |
| M36-F02 | MAJOR | Retention contradicts §24; author-delete destroys cipher | §2.3/2.4.2 | Default 6-yr; author delete = tombstone, retain cipher | ADR-0004, ARCH-185 | ADR-NEEDED |
| M36-F03 | MAJOR | Message-body integrity hashes missing | §3.4/4.4 | Add `body_sha256` + verification job | ARCH-206/240 | SPEC-EDIT |
| M36-F04 | MAJOR | Partitioning absent; org_id missing on 2 tables | §3.4/3.7/4.4 | Partition `message`+co-partition; add org_id+RLS; PE/location | SD-027/028, ADR-0010 | SPEC-EDIT |
| M36-F05 | MAJOR | Default routing misses clinical-urgent SMS | §3.10/2.5 | Add SMS to clinical-urgent rules; reconcile w/ AI-032 | ARCH-184, SD-015 | SPEC-EDIT |
| M36-F06 | MAJOR | Two parallel alert subsystems; broken DDL/enum | §3.2 vs 3.11.1 | Unify dispatch path; rename enum; fix CHECK via trigger | ADR-0022, ARCH-047 | SPEC-EDIT |
| M36-F07 | MAJOR | No SMS opt-out / TCPA consent | §4.1/3.5 | Twilio STOP/START/HELP webhook; `opted_out_at`; consent text | TCPA 47 CFR §64.1200 | OUT-OF-BAND |
| M36-F08 | MAJOR | Four Phase-1 AI features missing lifecycle | §1.1/3.1/D8 | Register all four; lifecycle gates; kill-switch | ADR-0012, AI-011-014 | ADR-NEEDED |
| M36-F09 | MAJOR | Vendor-adapter placement contradictory; no STRIDE | §3.1/4.7 | SDK inside `packages/messaging`; add STRIDE | ARCH-145, SEC-007 | SPEC-EDIT |
| M36-F10 | MINOR | Push-token retention contradicts §24 | §3.5 | 90-day TTL cleanup or ADR | ADR-0004 | ADR-NEEDED |
| M36-F11 | MINOR | Portal watermark + immediate revocation absent | §2.3/4.4 | Watermark; subscribe to M39 revocation events | ARCH-185/190 | SPEC-EDIT |
| M36-F12 | MINOR | Queue table omits params | §4.4 | Full SD-059/060 params; DLQ rule | ADR-0021, SD-059 | SPEC-EDIT |
| M36-F13 | MINOR | Webhook missing replay window; Postmark verify wrong | §4.1/9.2 | 5-min replay window; SD-056 verification | SD-056, INT-016 | SPEC-EDIT |
| M36-F14 | MINOR | Grab-bag (legal-hold/deny-stub/namespace) | §4.4/2.5/4.6.1 | Legal-hold skip; M19 deny-stub; lock namespace | ARCH-252/184/232 | SPEC-EDIT |

## Findings — M39 Consent & Authorization Management

| Finding ID | Sev | Title | Spec sections | Recommended fix | ADR/criteria | Fix-type |
|---|---|---|---|---|---|---|
| M39-F01 | BLOCKER | Owned Drizzle schema in pure-leaf `packages/domain` | §3.3/3.8/13.1 | Move schema to `packages/consent`; domain holds pure types only | ARCH-091/141 | SPEC-EDIT |
| M39-F02 | BLOCKER | dependsOn contradicts §20; M22↔M39 cycle | header/changelog/D22/13.1 | Keep `[1,2,3,4,5,22]` or ADR + remove `39` from M22 (per ADR-0005/0006) | ADR-0005/0006, ARCH-142 | ADR-NEEDED |
| M39-F03 | BLOCKER | `consent_eval_audit` mis-claimed as §164.528 feeder | D12/§1.4/12.9/route23 | Relabel as consent-decision audit; disclosing modules write §164.528 (ADR-0013) | ADR-0013, ARCH-240 | CROSS-MODULE |
| M39-F04 | MAJOR | Eraser data-class mismatch; deletes immutable audit | §3.8/8.6/4.4 | Register key `consent`; route eval-audit destruction via M4 | ARCH-251/234 | CROSS-MODULE |
| M39-F05 | MAJOR | HIV/MH/genetic redaction flags lack backing | §4.3 | Define each flag's source (consent/M5 PrivacyFlag) or delegate; default redact | ADR-0014, ARCH-190/154 | CROSS-MODULE |
| M39-F06 | MAJOR | Retention anchored to consent expiry not relationship end | §1.3/D20/8.6 | Anchor to relationship end + §164.530(j) floor; cite §24.1 | ADR-0004, OPEN-021/022 | ADR-NEEDED |
| M39-F07 | MAJOR | Manifest patch invents fields outside ModuleDef | §13.1 | Drop invented fields; registrations live in boot.ts/seam registry | ADR-0005, ARCH-235 | ADR-NEEDED |
| M39-F08 | MAJOR | DB triggers write `outbox_event` directly | §3.7 | Emit from service layer via M1 helper in same tx | ADR-0011, ARCH-272/264 | SPEC-EDIT |
| M39-F09 | MAJOR | Twilio Voice SOS repurposed for consent reminders | §4.10/W-CON-05 | Route via M36; reserve Twilio Voice for SOS; re-tier expiry | INT-031, OPS-043 | SPEC-EDIT |
| M39-F10 | MINOR | M3 SoD constraint asserted w/o citing M3 | §6 | Cite M3 decision ID or drop | SEC-038 | CROSS-MODULE |
| M39-F11 | MINOR | ABAC attribute set incomplete on PHI reads | §4.1 routes 17/21 | Make full ABAC set explicit per route | ARCH-053/066 | SPEC-EDIT |
| M39-F12 | MINOR | OPEN-022 retention-override ownership not cited | §1.3/D20 | Note M4 owns `state_retention_override` | OPEN-022, ARCH-253 | SPEC-EDIT |
| M39-F13 | MINOR | Draft 30-day TTL vs §24 retention class | §2.2.1/4.9 | Note draft TTL is UX housekeeping, not §24 | ADR-0004 | SPEC-EDIT |
| M39-F14 | MINOR | PHI list/audit routes lack cursor pagination | §4.1 routes 18/22/23 | Cursor pagination | SD-052 | SPEC-EDIT |
| M39-F15 | MINOR | Per-resource sync eval-audit on bulk export | §4.3/D12/9.7 | Batch eval-audit per recipient/request | ARCH-110 | SPEC-EDIT |

---

## Disposition summary (pre-triage counts by fix-type)

> These are auditor-assigned types before crediting ADRs. After triage, many ADR-NEEDED items
> collapse to SPEC-EDIT (reword to cite ADR-0005/0010/0011), and some BLOCKERs become RESOLVED-VERIFY.

- **OUT-OF-BAND (cannot be closed in markdown):** M10-F12, M14-F10, M16-F06, M18-F01, M19-F04, M19-F09, M20-F16, M22-F10, M26-F10, M36-F07 — plus every INT-014 BAA/ZDR/QSOA and Security-Owner sign-off. These need legal/operational action.
- **ADR-NEEDED but likely already governed by ADR-0005** (dependsOn-expansion / "manifest patch" findings — reword, don't open new ADR): M02-F01/F04, M03-F02, M07-F02, M09-F02, M10-F03, M14-F02/F19, M15-F01/F02, M16-F02, M18-F02/F03/F15, M19-F01/F05, M20-F01/F02/F07, M22-F01, M26-F05/F12, M30-F02/F10, M34-F03/F04, M35-F01/F03/F12, M36-F01/F08/F10, M39-F02/F06/F07.
- **RESOLVED-VERIFY (false-open):** M26-F01 (ADR-0002). *(More likely exist — full triage pending.)*
- **Everything else:** SPEC-EDIT or CROSS-MODULE — editable, but several carry regulatory judgment (CMS J-codes M10-F07, claim math M26-F13, CoP quorums M07-F01/M14-F03) that needs SME confirmation, not blind edits.

## Recommended remediation order

1. **Triage pass** — mark each finding RESOLVED-VERIFY / OPEN / STALE-FIX against current spec text + ADRs (M26-F01 done). This will materially shrink the open set.
2. **Tracking-doc drift** (safe, mechanical) — `REMEDIATION_SUMMARY.md` 447→451 + X9 re-lock contradiction; architecture v0.12 filename.
3. **Cross-cutting mechanical sweeps** (one rule, many files) — RLS var → `app.org_id`; wrong CFR citations (audit gives exact targets); PG16→PG18; canonical app-dir names; Idempotency-Key/queue-DLQ/STRIDE/DR-tier template sections.
4. **Foundation tier first** (M02/M03) — everything builds on it; close M03-F01 step-up + M03-F06 role catalog before any downstream module is coded.
5. **Per-module SPEC-EDITs** in dependency order, citing ADRs; **SME sign-off** for the regulatory-judgment subset.
6. **ADR drafts** for the genuinely-new decisions (M34-F03 session class, M20-F07 PostGIS, M10-F04 partitioning).
7. **OUT-OF-BAND tracking** — a checklist of BAA/ZDR/QSOA executions + Security-Owner sign-offs; these gate go-live but not spec completion.
