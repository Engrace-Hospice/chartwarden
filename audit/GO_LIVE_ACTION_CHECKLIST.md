# ChartWarden — Go-Live Action Checklist

**Compiled:** 2026-06-13 · **Branch:** `fix/manifest-spec-mismatches`

This is the punch-list of everything that gates go-live **but is NOT a closeable spec edit** — i.e.
the work that lives between "the spec corpus is clean" and "the platform may serve patients." Every
spec-editable BLOCKER from the June-13 re-audit is resolved (`arch:fitness` green); what remains here
requires a **human signature, decision, or build-out**. Each item names the **owner**, the **gating
authority**, **what it blocks**, and **where it's recorded**.

Status: ☐ open · ◐ in progress · ☑ done.

---

## 1. Architecture-Owner — ratifications & manifest hygiene

| ☐ | Item | Gating authority | Blocks | Recorded |
|---|---|---|---|---|
| ☐ | **Ratify ADR-0026** (M19-F03: vendor-operator auth via a new M2 `external_triage_vendor` session class) — then the M2 + M19 spec edits can be applied. | ADR-0026 (Proposed) + SEC-006 App. A.3 | M19 Hybrid/Centralized models | `docs/adr/ADR-0026-*.md` |
| ☐ | **Manifest foundation-edge consistency** — the manifest is inconsistent on whether foundation deps 1–4 are listed as edges (M34=`[2,3,4,36]` lists them; M22=`[1,5]`/M16=`[5,6,36]` don't). Normalize the convention corpus-wide; specs now mirror the manifest as-is. | ADR-0005 | dependency-cruiser determinism | `audit/TRIAGE_RESULTS.md` (Batch-3) |
| ☐ | **M18 `codePaths` += `packages/evv-aggregators`** (M18 owns the per-state adapter package; it's missing from `M18.codePaths` → no ownership coverage). | ARCH-141 / check-table-ownership | M18 ownership lint | `audit/RE_AUDIT_BLOCKERS_2026-06-13.md` |
| ☐ | **Architecture filename vs content** — `CHARTWARDEN_ARCHITECTURE_v0_11.md` is internally "v0.12"; rename the file (and ~15 references) or accept the divergence. | doc hygiene | discoverability | initial review |
| ☐ | **Banner-vs-body re-verification** before honoring any module "Locked" — this session caught M34's remediation banner over-claiming the org_id schema and the platform_ops re-base. Spot-check every module changelog claim against its body. | ADR re-lock gate | re-lock integrity | `audit/RE_AUDIT_BLOCKERS_2026-06-13.md` |

## 2. Legal / Contracts — BAA / ZDR / QSOA executions (INT-014 hard gate)

Per **ADR-0020 / INT-014**, an **executed** agreement is a hard runtime gate before PHI flows to each
external surface. The adapter must refuse production credentials until the BAA-register status is
`executed`.

| ☐ | Vendor / surface | Agreement needed | Blocks | Finding / ref |
|---|---|---|---|---|
| ☐ | **Anthropic** (Claude / AI Platform) | **BAA + ZDR** (AI Governance §9.2 says "in negotiation" — was falsely asserted "in place" in M08) | every cloud AI feature (M07/M14/M16/M19/M22/M30/M32/M36) | M08-F01, ADR-0012 |
| ☐ | **EVV state aggregator** (OR-PTC DCI / Sandata-class, Oregon launch) | BAA / trading-partner agreement | M18 Medicaid EVV submission | **M18-F01**, ADR-0008/0020 |
| ☐ | **External triage vendor** (TouchPoint / Hospice Triage / Acclivity) | **BAA + QSOA** (Part 2 re-disclosure) + SEC-099 vendor security review | M19 Hybrid/Centralized | M19-F04, M19-F09, ADR-0014/0020 |
| ☐ | **Print/mail vendor** (Lob / PostalMethods) | BAA + SEC-099 review | M22 print/mail delivery (Phase 2) | M22-F03, ADR-0020 |
| ☐ | **Fax / inbound-email ingest vendor** | BAA + INT-002 inventory | M22 fax/email intake | M22-F18, ADR-0020 |
| ☐ | **DME vendors + partner pharmacy** | BAA + SEC-099 | M21 supply/comfort-kit dispatch | M21 (audit), ADR-0020 |
| ☐ | **CAHPS vendor** (SHP default) | BAA + INT-002 (`packages/cahps-client`) | M30 CAHPS sampling/ingest | M30-F10, ADR-0020 |
| ☐ | **DoseSpot** (e-prescribing) | BAA + webhook-event-type INT review | M12 prescribing | M12 (audit), ADR-0020 |
| ☐ | **MAC-region PS&R / CMS API** | INT-002 inventory + trading-partner analysis (Phase 3) | M26 PS&R retrieval (Phase 3) | M26-F10, ADR-0020 |
| ☐ | **Twilio (SMS/voice) + Postmark (email)** | confirm BAA covers PHI-bearing channels (deep-link-only payloads minimize, but confirm) | M36 out-of-band delivery | M36 (audit) |
| ☐ | **HIBP** (HaveIBeenPwned) | **No BAA needed** — only SHA-1 password prefixes leave; confirm + record the no-PHI stance. | M02 breach check | M02-F10 |
| ☐ | **Stripe (M35) / Daily.co (M31)** | **No PHI by design** (Stripe = billing; Daily.co = opaque room IDs) — confirm + record. | — | M35, M31 D1 |

## 3. Security-Owner — sign-offs & vendor security reviews

| ☐ | Item | Gating authority | Blocks | Finding |
|---|---|---|---|---|
| ☐ | **ADR-0026 vendor-operator auth** sign-off (new M2 auth surface). | SEC-006 App. A.3 | M19 Hybrid/Centralized | M19-F03 |
| ☐ | **SEC-099 vendor security reviews** for each PHI-bearing vendor in §2 (triage, print/mail, DME, CAHPS, fax/email, EVV aggregator). | SEC-099 | each integration merge | ADR-0020 |
| ☐ | **M22 encryption design** — align to LUKS + pgcrypto DEK + MinIO SSE (SEC-023), OR Security-Owner sign-off for per-tenant object keys. | SEC-023 / ARCH-081 | M22 document storage | M22-F10 |
| ☐ | **M10 SECURITY DEFINER triggers** — drop (invoker rights) or Security-Owner approval. | SEC-026/056 | M10 HOPE migration | M10-F12 |
| ☐ | **Bulk-PHI export (SEC-052) controls** verified live on every >10-record egress (M04/M22/M26/M28/M33/M34). | SEC-052 | bulk export surfaces | S6 (consolidated audit) |

## 4. Compliance / Clinical SME — regulatory sign-offs

| ☐ | Item | Owner | Blocks | Finding |
|---|---|---|---|---|
| ☐ | **CFR-citation sign-off** — confirm the corrected citations (M07/M16/M19), esp. the M16 bereavement-plan anchor (`418.56(c)` vs `418.64(d)(2)`) and the M07 5-day rule (`§418.54(b)`). | Compliance SME | re-lock of M07/M16/M19 | CFR track (this session) |
| ☐ | **CMS HOPE Section-J item codes** — re-derive against the CMS HOPE v1.00 data dictionary (golden-file test). | Clinical/HQRP SME | M10 HOPE submission correctness | M10-F07 |
| ☐ | **Hospice cap math** — inpatient-cap denominator (§418.302(f)) + overage RHC-repricing formula, validated against a worked PS&R example. | Reimbursement SME | M26 settlement correctness | M26-F13 |
| ☐ | **IPOC content + review clock** — confirm the meds/supplies plan-of-care content (§418.56(c)) and the per-patient 15-day clock encoding. | Clinical SME | M07 / M14 re-lock | M07-F04/F05, M14-F01 |
| ☐ | **Aide POC gate + volunteer 5% ratio** (hours÷hours per §418.78(e)). | Clinical/Compliance SME | M15 re-lock | M15-F03/F04 |
| ☐ | **Medicare/Medicaid claim contracts** — the deep tabular build-out the ADRs pin but don't enumerate: CMS rate tables, full 837I field map, Medicaid state-rate schedules, the 28 cost-report rules. | Reimbursement SME + Eng | M23/M24/M27 build | REMEDIATION_SUMMARY |

## 5. AI Governance — per-capability activation gates (ADR-0012)

Each AI feature must register in the M32 capability catalog and pass the triple gate
(**tenant opt-in ∧ BAA+ZDR confirmed ∧ routing allows cloud**) + kill-switch + "Report this output"
before it can be switched on. All ship **flagged OFF** until then.

| ☐ | AI capability | Module | Finding |
|---|---|---|---|
| ☐ | Layer-2 narrative polish (HearthNote) | M07, M14 | M07-F07, M14-F10 |
| ☐ | Bereavement risk-narrative | M16 | M16-F06 |
| ☐ | Protocol suggestion + hospitalization-risk | M19 | M19-F07 |
| ☐ | DocLens SudDetector + extraction | M22 | M22-F15 |
| ☐ | Messaging AI (drafts/triage/summarize/categorize) | M36 | M36-F08 |
| ☐ | **M32 platform itself** — auto kill-switch at drift, eval-gated local model, mandatory `ai.*` audit events (verify live). | M32 | M32-F01/02/03, ADR-0012 |

## 6. HR / Legal — policy

| ☐ | Item | Owner | Finding |
|---|---|---|---|
| ☐ | **Field-safety consent-coercion posture** — HR/legal review of the SOS-coordinate consent; allow SOS without coordinates as the declined-consent fallback. | HR + Legal | M20-F16 |
| ☐ | **TCPA / SMS consent** — STOP/START/HELP handling + consent capture at SMS endpoint registration (47 CFR §64.1200). | Legal | M36-F07 |

## 7. Engineering — work pinned by ADRs / dependent on the above

| ☐ | Item | Depends on | Recorded |
|---|---|---|---|
| ☐ | Apply the **ADR-0026** M2 (`external_triage_vendor` session class) + M19 (remove module-local SSO) edits. | §1 ratification | ADR-0026 |
| ☐ | Stand up the **app source tree** (`apps/`, `packages/`) so `arch:boundaries` (dependency-cruiser) and the armed-inert fitness gaps (event-catalog `mN.`, seam-registry, PHI RLS/audit-trigger) actually run. | — | CLAUDE.md, `scripts/check-fitness-gaps.ts` |
| ☐ | Implement the **seam interfaces in `packages/types`** that the hygiene fixes now reference (M09/M15 et al.), with boot-registered deny-stubs + `validateSeams()`. | — | ADR-0005 D1/D2 |
| ☐ | **§20.B template sections → CI lints** (ADR-0021) once app source lands (idempotency-key, queue-DLQ, STRIDE, DR-tier, cursor, sqlcipher). | app source | ADR-0021 |
| ☐ | **Weekly BCP Print** feed for safety-critical classes (code-status / AD / DPOA) wired from M22 + the owning modules. | — | DR-070, M22-F14 |

---

## Cross-reference (durable record)

- **Open-blockers ledger:** `audit/OPEN_BLOCKERS_LEDGER.md` (all 307 June-13 findings)
- **Triage + remediation log:** `audit/TRIAGE_RESULTS.md` (every fix, by batch)
- **BLOCKER re-audit:** `audit/RE_AUDIT_BLOCKERS_2026-06-13.md` (~39 → 0 spec-editable)
- **Decisions:** `docs/adr/README.md` (ADR-0001…0026; 0026 Proposed)
- **Remediation capstone:** `docs/REMEDIATION_SUMMARY.md`

## Bottom line
No spec-editable BLOCKERs remain. **Go-live is now gated on §1 ratifications, §2 contract signatures,
§3 Security-Owner sign-offs, §4 SME confirmations, §5 AI activation gates, and §6 policy** — then the
§7 engineering build-out (most of which depends on the app source tree, not the spec corpus). Nothing
in §2–§6 is a spec edit; each is a human decision the corpus now cleanly surfaces.
