# WardenX — BLOCKER Re-Audit (post-remediation), 2026-06-13

Re-verification of every June-13 BLOCKER-class finding against the **current reconciled spec text +
the 25 ADRs**, after this session's remediation (Batches 1/2/3/3b/5, ADR-0024/0025, CFR track).
Method: one verification agent per module group; **conservative** (RESOLVED only with hard current-spec
evidence). Two agent verdicts were **corrected by direct check** (noted below) — the re-audit caught the
same "banner says fixed, body not" trap that started this whole effort.

## Headline

**BLOCKER count: ~39 (June-13 baseline) → ~10 confirmed code/spec blockers remaining** (≈74% reduction),
plus a few OUT-OF-BAND / SME / manifest-hygiene items that can't be closed by editing a module spec.

## Per-module BLOCKER counts (was → now)

| Module | was | now | Notes |
|---|--:|--:|---|
| M02 | 2 | **0** | F01 (M1-table mutation) + F02 (notification adapter) — resolved (route via M1 repos / outbox). |
| M03 | 1 | **0** | F01 step-up predicate+key now implemented (§4.2/§3.3). |
| M07 | 1 | **0** | F01 closed this turn — `nurse_practitioner` removed from the `IDG_REVIEW` quorum (ADR-0018 D3). |
| M09 | 1 | **1** | **F01 OPEN** — seam interfaces still imported from feature packages, not `packages/types` (ADR-0005 D2). |
| M10 | 2 | **1** | F02 (SFV clock) resolved; **F01 OPEN** — cross-module Drizzle schema imports of M5/M6 remain (ADR-0011). |
| M14 | 2 | **1** | F02 resolved (manifest minimal `[7,8,36]` applied; M32/M26 are seam consumers — no edge); **F01 OPEN** — CoP §418.56(d) per-patient 15-day clock is prose-only (no `last_idg_reviewed_at` column / CANCEL guard). |
| M15 | 1 | **1** | **F01 OPEN** — seam import paths still `@wardenx/<feature>/seams`, not `packages/types`. (The agent's "new manifest blocker" is the same root cause, not separate.) |
| M16 | 1 | **0** | F01 resolved — 13-month class struck; tables on `clinical_record` (ADR-0004). |
| M18 | 2 | **0\*** | F02 resolved (M39 = deny-stub seam, no edge); F01 catalogued (ADR-0020) — **BAA execution is OUT-OF-BAND**. *Manifest-hygiene:* M18 `codePaths` should add `packages/evv-aggregators` (ownership coverage). |
| M19 | 3 | **1** | F01 (dependsOn/ADR-0005) + F02 (3-col rule satisfied by org_id+PE) resolved; **F03 OPEN** — module-local vendor-operator SSO outside Better Auth (needs ADR + Security-Owner; OUT-OF-BAND-adjacent). |
| M20 | 0 | **0** | confirmed clean. |
| M22 | 3 | **1** | F01 (cycle) + F03 (print vendor catalogued) resolved; **F02 OPEN** — patient name still in the signed-URL **filename** (SEC-015); the spec deferred it. |
| M26 | 4 | **3** | F01 resolved (ADR-0002 cap year); **F02 OPEN** (direct `@/modules/02-identity/schema` import — ADR-0011), **F03 OPEN** (`cap_watch` channel kind doesn't exist in M36's enum; "biometric class" ≈ WebAuthn — imprecise), **F04(b) OPEN** (`audit_log` table doesn't exist — it's `audit_event`). |
| M30 | 3 | **0** | F01 (trigger), F02 (dependsOn), F03 (state machine) all resolved. |
| M34 | 3 | **1 + 2 unverified** | **F02 OPEN (corrected from the agent's "RESOLVED")** — direct check: only ~2 of M34's 17 tenant tables actually carry an `organization_id` column in the Drizzle def; the rest still lack it (the agent trusted the §3.10 banner). F01/F03 are prose-decision fixes the banner describes but I did **not** body-verify — treat as banner-claimed-unverified. |
| M35 | 3 | **0** | F01 (Stripe adapter cruiser rule), F02 (ADR-0025), F03 (relationship-inventory) resolved. |
| M36 | 1 | **0** | F01 resolved — `dependsOn:[1,2,3,4]`; payload catalog is a registration interface. |
| M39 | 3 | **0** | F01 (codePaths) + F02 (cycle, ADR-0006) resolved; F03 closed this turn (the stale §12.9 sign-off line). |

\* M18 spec-blockers = 0; its open items are OUT-OF-BAND (BAA) + a manifest-hygiene codePath note.

## Remaining confirmed code/spec BLOCKERs (~10) — clustered

- **Cross-module ownership / leaf-seam paths (ADR-0005 D2 / ADR-0011):** M09-F01, M10-F01, M15-F01, M26-F02. (Move seam interfaces to `packages/types`; FK-as-uuid + readers instead of schema imports.)
- **Schema (ADR-0010):** M34-F02 — add `organization_id` to ~15 M34 tenant tables (the biggest single remaining schema job).
- **Cross-module fabrication:** M26-F03 (`cap_watch` not a real M36 channel kind → use M36 `AlertEmitter`), M26-F04(b) (`audit_log`→`audit_event`).
- **Regulatory/design:** M14-F01 (per-patient 15-day IDG clock — schema + guard, not prose), M22-F02 (opaque signed-URL filename).

## OUT-OF-BAND / SME / hygiene (cannot be closed by editing a module spec)
- **OUT-OF-BAND legal:** M18-F01 BAA execution; M19-F03 vendor-operator SSO (needs an ADR + Security-Owner sign-off).
- **SME:** the CFR citations corrected this session are pending a final compliance-SME pass (esp. M16 plan-content, M07 5-day anchor).
- **Manifest hygiene (architecture-owner):** M18 `codePaths` += `packages/evv-aggregators`; and the foundation-edge-listing inconsistency flagged in Batch 3.
- **Banner-vs-body caveat:** M34-F01/F03 (and any other module whose changelog claims a fix) should get a body-level verification before re-lock — this re-audit found M34-F02's "RESOLVED" banner was not backed by the Drizzle.

## Post-re-audit remediation (2026-06-13, same day) — remaining spec-editable BLOCKERs cleared

After the re-audit, the remaining spec-editable BLOCKERs were fixed (each `arch:fitness`-green):
- **M07-F01** — `nurse_practitioner` removed from the `IDG_REVIEW` quorum (ADR-0018 D3).
- **M09-F01 / M15-F01** — seam interfaces repointed to `packages/types` (ADR-0005 D2).
- **M10-F01 / M26-F02** — cross-module Drizzle schema imports dropped → plain-uuid logical FKs (ADR-0011).
- **M26-F03** — fabricated `cap_watch` M36 channel kind removed (route via `AlertEmitter`); "biometric class" → M2 `STEP_UP_POLICY`. **M26-F04(b)** — `audit_log`→`audit_event`.
- **M22-F02** — opaque signed-URL filename (no patient name in URL/object key; SEC-015).
- **M34-F02** — `organization_id` actually added to the 14 tenant-scoped tables (banner made real, ADR-0010). **M34-F03** — predicate bodies + route header re-based from the nonexistent `sessionClass==='platform_ops'` to the M3 `hasRole('platform_ops')` RBAC check. **M34-F01** — Pillar 5 / D21 / non-goal prose reconciled to the break-glass-*variant* model (no staff PHI access bypasses break-glass).
- **M14-F01** — per-patient 15-day IDG clock (`last_idg_reviewed_at` + CANCEL/RESCHEDULE floor guard + T-3/T-0/T+1 escalation; ADR-0018 D2).
- **M39-F03** — stale §12.9 sign-off line corrected (ADR-0013).

**Updated state: all spec-editable BLOCKERs from the June-13 set are now resolved.** What remains is **2 OUT-OF-BAND items only** (cannot be closed by editing a spec):
- **M18-F01** — execute the EVV state-aggregator BAA/trading-partner agreement (catalogued per ADR-0020; INT-014 hard gate).
- **M19-F03** — route vendor-operator identity through Better Auth via a new M2 session class. **ADR drafted: [ADR-0026](../docs/adr/ADR-0026-m19-vendor-operator-auth-via-better-auth.md) (Proposed)** — recommends a new M2 `external_triage_vendor` session class (org+vendor+shift scope, MFA), M19 keeping only the `external_triage_actor` predicate + D13 PHI-minimization. Awaiting **Security-Owner sign-off** (SEC-006 App. A.3) + the M2 spec change; Hybrid/Centralized stay feature-flagged OFF until then + BAA executed.

Plus the standing non-spec items: the **CFR-citation SME sign-off**, the **manifest foundation-edge hygiene** pass, and the general **banner-vs-body** caution for any not-yet-re-verified module changelog claim.

## Bottom line
9 modules are now BLOCKER-clean (M02, M03, M07, M16, M20, M30, M35, M36, M39); M18 is spec-clean
(pending BAA). The remaining ~10 blockers are concrete, well-scoped spec edits (cross-module seam/FK
hygiene, M34 org_id columns, two M26 fabrications, the M14 clock, the M22 filename) plus the
OUT-OF-BAND/SME items. The original "38/40 FAIL" picture is no longer accurate.
