# 08 — Screen & UI Inventory

**Audit date:** 2026-08-03 · Sources: `audit/ui-parity/UI_PARITY.md`, `audit/frame-fidelity/FRAME_FIDELITY.md`, `docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`, and the three SPA registries.

## Inventory summary

| App | Built | Documented-unbuilt | Unreachable | Duplicated | Gate-visible? |
|---|---|---|---|---|---|
| `apps/web` | **242** screens (35 module sets + 7 system pages); 156 nav-eligible routes | see report 09 | 6 of 7 system pages (`/403 /error /offline /maintenance /expired /suspended`) have zero inbound nav (FLOW-006) | none (registry throws on dup id/path) | Yes |
| `apps/portal` | **13** screens | 6 of 11 portal specs (physician/consulting/referral-source/facility-nurse/DME-vendor/surveyor portals) | — | — | **No** (UI-011) |
| `apps/admin` | **14** screens (all M35) | 4 of 5 platform specs (ops console, support/impersonation audit, system health, workflow-event ops) | — | — | **No** (UI-011) |

- **Documented corpus:** 113 screen specs; **no gate joins spec → built screen**.
- **Parity + frame-fidelity gates scan `apps/web` only** (verified: `scripts/report-ui-parity.ts:68,71-72,90`, `scripts/report-frame-fidelity.ts:51,54`), so the 27 portal+admin screens are invisible to every UI gate — the built M35 admin console reads as a "documentation gap" (UI-011).
- **Frame fidelity:** only **17 of 242 built screens (7%)** are mapped (3 matched, 14 partial). The design *language* is reconciled; each screen's *composition* is largely unverified.
- **Thinnest built modules:** M30 (60 routes / 2 screens), M37 (45 / 4), M28/M29/M32 (headless or admin-only). **~198 backend routes across M28/M29/M31-admin/M32 have zero web UI.**

## Screen implementation-status classes (representative)

| Status | Examples |
|---|---|
| Complete (wired, states present) | M20 field-safety dashboard, M34 feature-flags, M35 subscription screens (retry + aria-live patterns) |
| Functionally complete, visually inconsistent | M15/M16/M19/M21/M24 screens (per-module UI kits, UI-006) |
| Partial / read-only shell | M6 admission, M8 encounters, M23 claim editor (reads over full backends — FLOW-001/008) |
| Placeholder / always-empty | `my-drafts.tsx` (no producer event), M31 bereavement-resources (empty seam, ARCH-018) |
| Unwired backend (route missing) | `/referrals/:id` (FLOW-002) |
| Built but unreachable | 6 system pages (FLOW-006) |
| Backend present, no screen | M29 interfaces, M30 CAHPS/SRA/QAPI depth, M37 bed board, M28 FHIR clients, M31 staff-admin (report 09) |
| Registered without permission | `/admin/staff` (UI-012) |

## Backend ↔ frontend mismatches
- **Backend with no consumer (module-level, from API inventory):** M29 0/29 routes, M32 0/25, M30 4/49 (8%), M37 4/36 (11%), M25 5/31, M27 6/37, M22 6/32. 650 of 1,035 paths (63%) have no frontend caller. Some are headless-by-design (M28 FHIR, M32 while `ai.full` OFF) and should be marked so via ADR; the rest are missing surfaces (report 09).
- **Frontend calling weak/failing backend:** M23 claim writes (400, FLOW-008); M31 bereavement-resources (empty, ARCH-018); the M39 consent write-lifecycle screens depend on 9 routes that 501 (API-002).
- **Zero orphan frontend calls** — every client call maps to a real route (good).

## UI state-completeness gaps (against report 31's definition)
Failure and emptiness share one unannounced `EmptyState` (`role="note"`); the clinical core has **no retry affordance** (UI-002); KPI strips render `0`/`100%` during load failure (UI-003); no toast/success primitive and no destructive-action confirmation exist (UI-010); queue/wizard state is not URL-synced (UI-009). The system pages that *would* serve permission-denied/offline/expired states are built but unreachable (FLOW-005/006).

## Positive
Registry hard-fails on duplicate ids/paths; all 242 `requiredPermission`s resolve; design tokens genuinely enforced (zero raw hex in `apps/web` tsx, dark mode wired); the shared Modal/KpiCard/LoadingSpinner primitives are correct; the chromeless auth flow and org-select pre-guard are well-built and only need runtime wiring.
