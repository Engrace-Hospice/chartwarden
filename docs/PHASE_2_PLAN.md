# ChartWarden — Phase 2 Plan (v1.1): AI Activation + Operational Depth

**Status:** Plan — sequencing of architecture §20.A Phase 2. Depends on Phase 1 in production.
**Authority:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §20.A Phase 2.
**Goal:** turn on the differentiating AI features and operational maturity that win against
FireNote/Axxess/WellSky. This is the "ChartWarden is competitively differentiated" moment.

> **Count: 10 new modules + 5 upgrades to Phase-1 modules.** ~3–6 months after Phase 1 ships.

---

## 1. Entry criteria

- All 28 Phase-1 modules at Definition of Done and in production.
- AI Platform (M32) capability shell exists from Phase 1; HearthNote Layer 1 live.
- The Phase-2 feature flags (`hearthnote.layer2`, `documents.doclens`,
  `scheduling.route_optimization`, `ai.full`) exist and are wired but default-off.

---

## 2. Part A — Upgrades to Phase-1 modules (flag activations)

These add capability to modules already at DoD. Each upgrade re-runs the full DoD gate for the new
surface (tests + UI + audit + RBAC) and flips its flag on.

| M | Module | Activation | Notes |
|---|---|---|---|
| 32 | AI Platform | **`ai.full`** — predictions, copilot, semantic search | The full AI Platform. Local models (Ollama default per architecture §10.7); cloud per-capability per-tenant. Gate by AI-governance (`CHARTWARDEN_AI_GOVERNANCE`). |
| 8 | Encounters | **`hearthnote.layer2`** — LLM note enhancement | Tenant-opt-in; per-encounter opt-out; shares M8's hard-block category list. Depends on M32 full. |
| 14 | IDG | **full HearthNote IDG aggregation** — packets + LLM polish | The no-prep IDG competitive feature. Depends on M32 full + M8 Layer 2. |
| 22 | Document Management | **`documents.doclens`** — intake document extraction | DocLens activated; `packages/intake-extraction`. Depends on M32 full. |
| 17 | Scheduling | **`scheduling.route_optimization`** | Mapbox/OSRM via `packages/routing-client`. |

> **Sequence within Part A:** M32-full first (others consume it), then M8 Layer 2, then M14 full;
> M22 DocLens and M17 route-opt are independent and parallel once M32-full lands.

---

## 3. Part B — New modules (dependency-ordered waves)

Deps are architecture §20 build-sequence deps; all their dependencies are satisfied by Phase 1.

### Wave P2-1 — independent operational modules (parallel)
| M | Module | Deps | Scope |
|---|---|---|---|
| 15 | Discipline Care Plans | 7,8 | MSW, chaplain, aide care plans (Phase 1 covered RN/MD). |
| 16 | Bereavement | 5,6,36 | 13-month bereavement workflow per CoP 418.64. |
| 21 | Supplies, DME & Comfort Kits | 11,40 | Inventory + ordering; comfort-kit dispatch. |
| 24 | Billing — Medicaid (Oregon adapter) | 23,40 | `packages/medicaid-adapters`; activates when first Medicaid patient enrolls. |

### Wave P2-2 — coordination depending on scheduling
| M | Module | Deps | Scope |
|---|---|---|---|
| 19 | On-Call Triage | 5,17,36 | After-hours workflows. Replaces the Phase-1 SOS degraded fallback. Vendor-operator auth per ADR-0026. |
| 20 | Field Safety | 17,36 | Field safety beyond basic EVV. |

### Wave P2-3 — finance + engagement + reporting (depend on broader surface)
| M | Module | Deps | Scope |
|---|---|---|---|
| 27 | Cost Report (CMS-1984-14) | 23,26,38 | Annual; first fiscal-year completion. Now feeds M30's `CostReportProvider` (was a deny-stub in Phase 1). |
| 31 | Patient/Family Portal & Telehealth | 5,7,8,22,36,39 | Patient engagement; `packages/telehealth-client`. Gated by M39 consent. `apps/portal`. |
| 33 | Reporting & Dashboards | all clinical + billing | Reporting beyond Phase-1 essentials. Consumes seams across modules (no-edge); broadest consumer in the graph. |
| 35 | Subscription Billing (Stripe) | 34 | Required when the first paying tenant beyond Engrace joins. `packages/subscription-billing`. |

---

## 4. Scope discipline (ADR-0009)

- Phase-2 modules ship Phase-2 scope; Phase-3 capabilities stay default-off:
  `dosespot.epcs`, `fhir.write`, `saas.multi_tenant`, `quality.cahps`/`quality.hvldl_hci`,
  `cap.full_projection`.
- M30 HQRP stays at "basic" in Phase 2 (HOPE status); CAHPS/HVLDL/HCI is Phase 3 — but M27 Cost Report
  landing here removes the Phase-1 deny-stub on `CostReportProvider`.
- M33 Reporting must consume every upstream module **only via seams/outbox** (no new `dependsOn`
  edges) — it is the canonical test of the no-edge discipline at scale.

---

## 5. Acceptance criteria (Phase 2)

1. All 10 new modules at Definition of Done; all 5 upgrades pass DoD for their new surface with flags on.
2. AI governance gates pass: every M32 capability is registered, prompt-registry validated, and the
   per-module AI-prohibited zones (`validate*AIBlock()`) hold at boot.
3. End-to-end "no-prep IDG" scenario: encounters (Layer 2) → discipline care plans → IDG full packet
   with LLM polish → signed minutes.
4. Medicaid (Oregon) produces a clean claim for a dual-eligible test patient.
5. Portal: a family member completes consented login and views permitted records; telehealth session
   connects.
6. Reporting dashboards render across clinical + billing with zero boundary violations
   (`arch:boundaries` green).
7. `bun run arch:fitness` green; RLS isolation tests pass for all new PHI tables.

---

## 6. Risks & mitigations

- **AI hallucination / clinical safety** → Layer 2 is narrate-around-existing-rows only; AI-prohibited
  zones enforced at boot; hard-block categories shared from M8.
- **Reporting fan-out tempting direct schema reads** → CI boundary gate; M33 must use seams/outbox.
- **Medicaid state-specific complexity** → start with the Oregon adapter only; additional states are
  Phase 4.
- **Route-optimization external dependency (Mapbox/OSRM)** → degraded fallback to unoptimized
  scheduling (the Phase-1 behavior) if the routing service is unavailable.

---

## 7. Exit → Phase 3

ChartWarden has paying tenants beyond Engrace and differentiated AI. Phase 3 scales multi-tenancy and adds
inpatient. See [`PHASE_3_PLAN.md`](./PHASE_3_PLAN.md).
