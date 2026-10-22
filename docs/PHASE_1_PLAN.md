# ChartWarden — Phase 1 Plan (v1): Engrace Go-Live

**Status:** Plan — sequencing of architecture §20.A Phase 1. Depends on Phase 0 scaffold complete.
**Authority:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §20 (build sequence) + §20.A Phase 1 (the 28-module
cut). This file schedules the build into dependency-ordered waves; it does not restate module specs.
**Goal:** the minimum system to operate **Engrace Hospice LLC** as a real Medicare-certified hospice —
admit patients, document care, submit HOPE, prescribe, bill Medicare, and close the revenue loop.

> **Phase 1 module count: 29 of 40** (modules 1,2,3,4,5,6,7,8,9,10,11,12,13,14,17,18,22,23,25,26,28,
> 29,30,32,34,36,38,39,40). Scope cuts are deliberate (per §20.A): HearthNote Layer 2 off, no route
> optimization, EVV operational-only, FHIR read-only, SaaS in single-tenant mode, AI as a capability
> shell. Anything Engrace can work around for ~6 months is Phase 2.
>
> **Count reconciliation (resolved):** architecture §20.A previously read "28 of 40" in prose while
> its enumerated Phase-1 table listed **29** rows. That off-by-one has been corrected in
> `CHARTWARDEN_ARCHITECTURE_v0_11.md` (§20.A count → 29; changelog → "26 → 29 (added 38, 39, 40)"). This
> plan uses **29**. Phase 2 (10 new) + Phase 3 (1 new, M37) cover the remaining 11 modules, so
> 29 + 10 + 1 = 40 with each module built exactly once.

---

## 1. Entry criteria (from Phase 0)

- `bun install && bun run arch:fitness` green end-to-end; Vitest fixtures prove each gate red on
  violations.
- 33-package workspace + 40 empty module dirs exist and map 1:1 to the manifest.
- Seam registry + `validateSeams()`/`validateErasers()` wired at `apps/backend/src/bootstrap/`.
- `drizzle.config.ts` + empty migrations dir present.

---

## 2. Build waves (dependency-ordered)

Each wave may build internally in parallel; a wave starts only when the prior wave's modules meet the
Definition of Done (see roadmap index). Deps shown are the architecture §20 build-sequence deps.

### Wave A — Platform foundation (no clinical data yet)
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 1 | Foundation | — | Tenancy context, RLS generator, outbox dispatcher, seam registry, retention classes, `packages/db` schema host. The spine everything imports without an edge. |
| 2 | Identity & Org (3-tier tenancy) | 1 | Better Auth (ADR-0026), org/membership model, step-up auth vocabulary. |
| 3 | Authorization (RBAC + ABAC) | 2 | Permission catalog + named-predicate registry; `requirePermission`/`requireAbac`. |
| 4 | Audit & Compliance Log | 1,2,3 | Append-only audit, field-level denylist, eraser registry, retention enforcement. |

### Wave B — Early platform services (consumed by every clinical module)
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 36 | Secure Messaging & Alerts | 1,2,3,4 | Typed alert catalog, recipient resolution, in-app + push/SMS dispatch. Built early — many modules emit alerts from day one. |
| 38 | Clinical Terminology Service | 1,2,3,4 | Code validation/lookup (ICD-10, value sets). Every clinical/billing module consumes it. |
| 40 | Master Data Management | 1,2,3,4 | External physicians, facilities, pharmacies, payers, funeral homes — referenced from M5/11/12/23 onward. |

### Wave C — Patient + consent
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 5 | Patient & Demographics | 2,3,4,36,38,40 | Patient record, demographics, privacy-flag derivation, caseload. Required to admit anyone. |
| 39 | Consent & Authorization Mgmt | 1,2,3,4,5 | DPOA, advance directives, 42 CFR Part 2 consent, portal-access consent. Consumes M22 via **forward seam** deny-stub (no edge, ADR-0006). |

### Wave D — Admission + care plan + documentation spine
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 6 | Admission, Election & Certification | 5,38,40,39 | Medicare hospice election, CTI, F2F, benefit periods, level-of-care periods. |
| 7 | Care Plan (IPOC) | 6,38,39 | CoP 418.56 individualized plan of care. |
| 8 | Encounters & Visit Notes | 6,7,36,38 | **HearthNote Layer 1 only** (deterministic); Layer 2 toggled **off** (Phase 2). |

### Wave E — Clinical depth (assessments → meds)
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 9 | Clinical Assessments Suite | 8,38 | PPS/FAST/PAINAD/ESAS routine charting. Mobile offline drafts in `@chartwarden/mobile-offline` (manifest-exempt). |
| 10 | HOPE Engine | 8,9,36,38 | HOPE is live — **mandatory CMS submission**. iQIES submission path. |
| 11 | Orders | 6,8,36,38,40 | Medication + non-med orders, verbal-order co-sign. |
| 12 | DoseSpot Integration | 5,11,38,40 | Full integration, **no EPCS at launch** (deferred to Phase 3 pending DEA path). |
| 13 | eMAR & Med Administration | 12,36,38 | Medication administration tracking. |

### Wave F — Care coordination + scheduling + documents (basic cuts)
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 14 | IDG | 7,8,36 | **Basic** — HearthNote Layer 1 aggregation. CoP 418.56 IDG meetings. Full packets + LLM polish = Phase 2. |
| 17 | Scheduling & Route Optimization | 5,8,40 | **Basic** — no route optimization yet (Phase 2). |
| 18 | EVV | 17 | **Basic / operational** Medicare visits. ADR-0008: never a `regulatory_required` Medicare claim gate. |
| 22 | Document Management | 1,5,39 | Chart documents + consent PDFs. **DocLens off** (Phase 2). Publishes `DocumentRenderer`/`DocumentStorageProvider` seams M39 consumes. |

### Wave G — Revenue cycle (this is how money comes in)
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 23 | Billing — Medicare | 6,8,22,38,40 | **With full Pre-Submission Validation Framework (§11.A, 30+ rules).** Gates go-live. |
| 25 | Remittance & Denials | 23,36 | **Basic** — 835 posting + denial worklist. Closes the revenue loop. |
| 26 | Cap Management | 23,36 | **Basic projection only** to avoid cap overage. Full agency-wide watch = Phase 3. |

### Wave H — Interop + accounting + quality (basic cuts) + parallel platform
| M | Module | Deps | Phase-1 scope |
|---|---|---|---|
| 28 | FHIR Gateway | 5,6,7,8,11,12,13,38,40 | **Read-only US Core R4** (interoperability mandate). R4-write/R5 = Phase 3. |
| 29 | External Interfaces | 5,11,40 | Xero for GL; Gusto referenced not integrated. Required for accounting. |
| 30 | HQRP & Quality | 10,23,27,36,38 | **Basic** — HOPE submission status. CAHPS/HVLDL/HCI = Phase 3. *(M27 dep is a forward-seam read; Cost Report itself is Phase 2.)* |
| 32 | AI Platform | parallel from M5 | **Capability shell + HearthNote Layer 1 only.** Predictions/copilot/semantic-search = Phase 2. Start the shell early so consumers can wire deny-stubs. |
| 34 | SaaS Tenant Platform | 2,3,4,36 | **Single-tenant mode** for Engrace — multi-tenant infra running one tenant. Full mode = Phase 3. |

---

## 3. Phase-1 scope discipline (ADR-0009)

These feature flags **default off** in Phase 1 and only flip in their activation phase:

| Flag (default off) | Module | Activates |
|---|---|---|
| `hearthnote.layer2` | 8, 14 | Phase 2 |
| `documents.doclens` | 22 | Phase 2 |
| `scheduling.route_optimization` | 17 | Phase 2 |
| `ai.full` (predictions/copilot/search) | 32 | Phase 2 |
| `dosespot.epcs` | 12 | Phase 3 |
| `fhir.write` | 28 | Phase 3 |
| `saas.multi_tenant` | 34 | Phase 3 |
| `quality.cahps` / `quality.hvldl_hci` | 30 | Phase 3 |
| `cap.full_projection` | 26 | Phase 3 |

**Documented degraded fallbacks** (cross-phase critical path with a Phase-1 absence):
- After-hours SOS (M19 is Phase 2) → falls back to supervisor subscriptions + tenant emergency number.
- Cost Report (M27 is Phase 2) → M30 reads its `CostReportProvider` surface via a deny-stub returning
  "not-yet-available"; HQRP basic status does not require it.
- Medicaid (M24 is Phase 2) → M23 Medicare-only; Engrace day-one population is Medicare.

---

## 4. Cross-cutting requirements (every Phase-1 module)

- **§20.B template complete** before the module is "done" (see roadmap DoD).
- **DR tier declared** per `CHARTWARDEN_DR_BCP` — e.g., M10/M19-class capture paths are Tier 1/2; document
  the degraded-mode classes.
- **INT inventory** per `CHARTWARDEN_INTEGRATIONS` for every external touchpoint (iQIES, DoseSpot, MAC,
  Xero, Twilio, etc.).
- **PHI discipline:** RLS + `withOrgContext` on every PHI route; audit denylist for free-text/cipher
  columns; eraser registered.

---

## 5. Acceptance criteria (Phase 1 "go-live ready")

1. All 28 modules meet the universal Definition of Done.
2. An end-to-end Engrace scenario passes in integration tests: **admit → elect Medicare → care plan →
   encounter (Layer 1) → assessment → HOPE submit → order → eMAR → IDG → schedule visit → EVV →
   bill Medicare (pre-submission validation) → post 835 → cap projection.**
3. `bun run arch:fitness` green; RLS cross-tenant isolation tests pass for every PHI table.
4. All Phase-2/3 capabilities present only as **default-off** flags; no Phase-1 route depends on a
   flag being on.
5. A HOPE submission package passes the CMS Validation Utility Tool (iQIES has no test endpoint or API; upload is manual); Medicare 837I produces a clean claim
   through the §11.A validation framework.
6. DR/BCP degraded-mode paths tested for the Tier-1/2 modules (HOPE capture, messaging).

---

## 6. Risks & mitigations

- **HOPE/iQIES external dependency** → Tier-2 capture with offline drafts; never block charting on
  submission availability.
- **Medicare claim rejections** → the §11.A 30+ rule pre-submission framework is in-scope and gating,
  not deferred.
- **Scope creep from Phase 2 features** → ADR-0009 flag discipline; CI check that Phase-1 routes don't
  hard-depend on a default-off flag.
- **Single-tenant shortcuts hardening into the design** → M34 runs multi-tenant infra in single-tenant
  mode; RLS is on from day one, so Phase 3 multi-tenant is an activation, not a retrofit.

---

## 7. Exit → Phase 2

Engrace is operating in production on ChartWarden. The next phase turns on the differentiating AI features
and operational-depth modules. See [`PHASE_2_PLAN.md`](./PHASE_2_PLAN.md).
