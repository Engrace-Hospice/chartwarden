# 10 — UI/UX & Design-System Report

**Audit date:** 2026-08-03 · Scope: `apps/web`, `apps/portal`, `apps/admin`, `packages/ui`.

## Does it feel like one coherent modern product?
Partly. The **Lantern** design token system is genuinely enforced (zero raw hex in `apps/web` tsx; dark mode wired via `data-theme`; `design-tokens` gate green), and the shared Modal/KpiCard/LoadingSpinner primitives are correct and accessible. But three systemic issues break coherence: **duplicated per-module UI kits**, a **flat unstructured navigation**, and **inconsistent/absent system-status feedback** (retry, toast, empty-vs-error).

## Findings

### UI-001 — Sidebar: ~156 flat ungrouped links; `Link` not `NavLink`; dead active-state CSS
- High / P1. `layout.tsx:7,46-53` renders a flat map with `Link` only; `index.css:293-299` styles `a[aria-current="page"]`/`a.active` — nothing ever sets either, so there is no "where am I" signal and no `aria-current` for assistive tech. `navGroup` exists on 35 module screen-sets but only `role-home.tsx:23` consumes it. Fix: `NavLink` (CSS already ships) + group by `navGroup` with collapsible sections.

### UI-002 — Failure and emptiness share one unannounced state; clinical core has no retry
- High / P1. `packages/ui/src/web/components/empty-state.tsx:15` is `role="note"` (not announced); errors and emptiness both render `EmptyState`. 228 files call `setError`; only 16 (all M20/M34) offer a reload — the M5–M18 clinical core has **zero** retry affordances. Fix: split `ErrorState` (`role="alert"` + retry wired to the existing `load()`) from `EmptyState`, adopt app-wide.

### UI-003 — False-zero / false-perfect statistics
- High / P1 (blocker for the EVV metric). KPI strips render outside the error branch (`cosignature-queue.tsx:66-71`, `orders-sign-inbox.tsx:78-81`) so an outage shows "Pending 0". `evv-route-service-db.ts:899-903` hardcodes `complianceRate:1`/`lateCheckoutRate:0` and ignores the 30-day window. Fix: gate KPI strips on load/error (render "—"); implement or remove the EVV metric; render 0/0 as "no data", never 100%.

### UI-004 — Single 1.53 MB JS chunk; no code-splitting; effectively no responsive design
- High / P1 (blocker for the ADR-0035 Capacitor mobile target). `apps/web/dist/app/assets/index-*.js` = 1,531,069 B; zero `lazy(` across the three SPAs; `vite.config.ts` has no `manualChunks`; exactly one `@media` (`index.css:477`, prefers-reduced-motion) and no width breakpoints; fixed 14 rem sidebar. Fix: route-level `React.lazy` per registry (mechanical); shell breakpoints + collapsible nav; `overflow-x` containers on tables. Acceptance: initial chunk < 350 kB; shell usable at 390px.

### UI-005 — Two parallel modal implementations; the widely-copied one has no focus trap
- High / P1 (WCAG failure on ceremony dialogs). The correct shared modal (`packages/ui/src/web/system/modal.tsx:38-72` — trap/Escape/restore) is deliberately unexported; a module-local `Modal` (`20-field-safety/safety-ui.tsx:502-527`) with `role="dialog" aria-modal` but **no trap, no Escape, no initial focus, no restore** is copied into ≥9 module dirs. Fix: export the shared Modal/ConfirmDialog; migrate the 9 copies.

### UI-006 — Per-module duplicated UI kits (6+ hand-rolled style systems; 1,690 inline style objects)
- Medium / P2. `modules/{15,16,19,20,21,24}*/[*]-ui.tsx` each re-export table/card/button/input/modal styles; 1,690 `style={{` in modules. Tokens are respected (zero raw hex), but the component layer is fragmented. Fix: promote Button/Table/Card/Field/Notice into `@wardenx/ui`; add a fitness check forbidding module-local style kits.

### UI-007 — Form accessibility: errors rarely associated; no skip link; write feedback not announced
- Medium / P2. 20 total `aria-invalid|aria-describedby|aria-errormessage` app-wide vs 77 `<label`; no skip link; `staff-management.tsx:160-165` success/error are plain spans (no `role`/`aria-live`, never cleared). Positive: M16/M20/M21/M24/M35 do use `aria-live`. Fix: field-level association in shared Field primitives; skip link; announce write outcomes.

### UI-008 — Clickable-row keyboard support: good canonical pattern, 3 stragglers
- Low / P3. Canonical pattern correct (`cosignature-queue.tsx:98-107`); click-only in `13-emar/patient-emar.tsx`, `20-field-safety/sos-detail.tsx`, `21-supplies/dispatch-create.tsx`. Fix: a shared `ActionableRow`.

### UI-009 — Queue/wizard state never URL-synced
- Medium / P2. Filters, selection, pagination, and the 4-step claim wizard live in `useState`; refresh loses everything; cursors never used (`claim-workbench.tsx:96-98`). Fix: `useSearchParams` in queues; persist wizard drafts; wire cursors.

### UI-010 — No success-feedback primitive; destructive actions lack confirmation
- Medium / P2. No toast/notification primitive in `packages/ui`; remove-member is one unconfirmed click; address save is silent; claim submit "success" just reloads. Fix: a shared `aria-live` toast region + `ConfirmDialog`, **before** scaling the write surfaces (FLOW-001).

### UI-011 — Parity + frame-fidelity gates blind to `apps/portal` and `apps/admin`
- Medium / P2. `report-ui-parity.ts:68,71-72,90` and `report-frame-fidelity.ts:51,54` hardcode `apps/web`; 27 portal+admin screens have no dup-route/permission/parity gate. Fix: iterate all three registries; add portal/admin sections to the reports.

### UI-012 — `/admin/staff` registered without `requiredPermission`
- Medium / P2. Appears in every signed-in user's Admin nav; only fails on the `member.manage` GET. Fix: set `requiredPermission: "member.manage"`.

### UI-013 — Hardcoded status colors bypass Lantern theming
- Low / P3. `packages/ui/src/core/theme/colors.ts:6-8` — operational/degraded/outage colors are raw hex outside the token pipeline (used by DegradedBanner); won't follow the dark override. Fix: move to token vars.

## Design-system conformance matrix

| Component / pattern | Existing implementations | Canonical | Drift | Consolidation |
|---|---|---|---|---|
| Modal / dialog | shared (correct, unexported) + ≥9 module copies (no trap) | `packages/ui/.../system/modal.tsx` | High (a11y) | export + migrate (UI-005) |
| Button/Table/Card/Field | 6+ module `*-ui.tsx` kits | none promoted | High | promote to `@wardenx/ui` (UI-006) |
| Empty vs Error state | one `EmptyState` for both | none | High | split ErrorState + retry (UI-002) |
| Toast / success feedback | none | none | Missing | add shared region (UI-010) |
| Confirm dialog | ad-hoc / none | none | Missing | add ConfirmDialog (UI-010) |
| Nav item | flat `Link` | should be `NavLink`+groups | High | UI-001 |
| Status colors | token vars + raw-hex outliers | tokens | Low | UI-013 |

## Experience-principle violations (report 16)
- *Every long-running action shows progress* — claim submit is 202-async with no indication (FLOW-008). ✗
- *Every failure has a recovery path* — clinical core has no retry; outage → logout (UI-002, FLOW-004). ✗
- *Every destructive action requires confirmation* — remove-member is one click (UI-010). ✗
- *Every saved change gives visible feedback* — silent address save; no toast (UI-010). ✗
- *Users can leave and resume long workflows* — wizard/queue state lost on refresh (UI-009). ✗
- *Permission limits are explained, not shown as broken UI* — 403s render as generic "Unavailable" (UI-002; the built `/403` is unreachable). ✗
- *Navigation preserves context* — no URL sync (UI-009). ✗

## Consolidation plan (summary)
1. Export the shared Modal/ConfirmDialog and add a toast region (unblocks safe write surfaces).
2. Split Error/Empty states with retry; adopt across the clinical core.
3. `NavLink` + `navGroup` sections.
4. Promote the per-module UI kits into `@wardenx/ui`; add a fitness check.
5. Route-level code-splitting + responsive shell.
6. Extend the UI gates to portal/admin.
