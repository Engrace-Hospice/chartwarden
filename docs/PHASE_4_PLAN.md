# WardenX — Phase 4 Plan (v2): State Expansion, Enterprise & Certifications

**Status:** Forward-looking — out of the v1 horizon. Architecture §20.A names this phase but does not
enumerate a fixed module cut; scope is **demand-driven** by WardenX customers.
**Authority:** `WARDENX_ARCHITECTURE_v0_11.md` §20.A Phase 4 / v2.
**Goal:** grow WardenX from a multi-agency SaaS into a multi-state, enterprise-grade, independently
certified platform. Unlike Phases 1–3, this is a **backlog of tracks**, not a single dependency chain —
each track is pulled forward by a specific customer or compliance need with its own ADR.

> No new logical modules beyond the 40 are assumed. Phase 4 is mostly **depth** on existing modules
> plus platform-level certification and analytics tracks.

---

## 1. Entry criteria

- Phases 1–3 in production across multiple tenants (some operating IPUs).
- A concrete demand signal exists for any track below (a customer, a contract, or a compliance
  deadline). Per ADR-0009, no Phase-4 capability is early-built into an earlier phase without an ADR +
  default-off flag.

---

## 2. Candidate tracks (demand-driven, each gated by its own ADR)

| Track | Touches | Trigger | Notes |
|---|---|---|---|
| **Additional state Medicaid adapters** | 24 (`packages/medicaid-adapters`) | A WardenX customer operating in a new state | One adapter per state behind the existing `MedicaidAdapter` interface — additive PRs, no core change. |
| **Advanced analytics / data warehouse** | 33, + a new analytics surface | Enterprise reporting demand | Read-only, seam/outbox-fed; must not introduce direct schema reads. Consider a separate read-model store. |
| **Multi-CCN agencies** | 2, 5, 6, 23, 34 | A customer operating multiple CCNs under one org | Provider-entity/CCN modeling depth; billing routing per CCN. |
| **Additional integrations** | 29 (+ targets) | Per-customer system (e.g., payroll, GL, labs, HIE) | Each via the external-interfaces seam pattern + INT inventory entry. |
| **HITRUST certification** | platform-wide | Enterprise sales requirement | Control mapping, evidence automation; leans on M4 audit + M30 SRA. |
| **SOC 2 (Type II)** | platform-wide | Enterprise sales requirement | Continuous-controls evidence; ops-runbook + audit-log driven. |
| **CHAP-verified-for-WardenX** | platform-wide | Market credibility | Distinct from tenant CoP compliance (M30) — this certifies the platform vendor. |
| **Mobile native shell** | `apps/mobile/` (Capacitor) | Field-staff native delivery | Architecture §10 notes Capacitor wrapping the mobile-optimized frontend; offline store already exists (`@wardenx/mobile-offline`). |
| **Local-LLM at scale** | 32 (`ml-worker`/`llm-worker`) | Sustained AI throughput demand | vLLM replaces Ollama default per architecture §10.7.6.2; split `llm-worker` VM when scale demands. |

---

## 3. Discipline for Phase 4

1. **Each track is its own ADR + phase entry.** No track starts without a recorded decision capturing
   the trigger, scope, and any module phase moves.
2. **The 40-module boundary model still holds.** New surfaces (analytics store, mobile app, new
   adapters) get manifest `codePaths`/`ownedTables` entries and pass the same fitness gates. A new
   logical module (beyond 40) requires an architecture change, not just a spec.
3. **Certifications are gate tasks, not code deliverables.** Code can be ready; the track isn't "done"
   until the external certification is granted.
4. **No regressions to Phases 1–3.** Every Phase-4 PR keeps `arch:fitness` green and the full
   cross-tenant RLS isolation suite passing.

---

## 4. Acceptance (per track, not per phase)

Phase 4 has no single "done." Each track closes when:

- Its ADR is accepted and its trigger is satisfied.
- The capability meets the universal Definition of Done (roadmap index) for any code it adds.
- For certification tracks: the external attestation is issued and filed.
- `bun run arch:fitness` and the corpus RLS isolation suite remain green.

---

## 5. Relationship to the rest of the roadmap

Phase 4 is open-ended by design. The fixed, dependency-ordered build is **Phases 0–3**; Phase 4 is the
standing backlog WardenX draws from as customers and compliance needs arrive. See
[`IMPLEMENTATION_ROADMAP.md`](./IMPLEMENTATION_ROADMAP.md) for the full picture.
