# Frontend Reconciliation — Scope

Wiring the reviewed **Lantern** design corpus (113 screens · ~370 frames, all `●` on `main`) into
`apps/web`. Grounded in a live audit of `@wardenx/ui`, the 19 implemented module screen-sets, and
the design↔implementation coverage gap (2026-06-24).

> **The key reframing: "reconciliation" is two efforts, not one.**
> **(A) Align** the *existing* surface (the `@wardenx/ui` library + 91 built screens) to Lantern.
> **(B) Build** the *missing* surface (~53 designed screens in 21 modules with no web yet).
> (A) is bounded design/frontend work and should go first — it makes Lantern real in code and
> unblocks every screen. (B) is feature build, gated on backend modules landing, and is phased.

---

## Current state (audited)

| Layer | Status | Detail |
| :-- | :-- | :-- |
| **Design tokens** | ✅ done | Lantern colors/radius/shadow in `packages/ui/src/core/theme/colors.ts` + `apps/web/src/index.css` `@theme` (+ `.dark`). Done earlier this session. |
| **Webfonts** | ✅ **done (R0.1)** | Self-hosted via `@fontsource-variable/fraunces`, `@fontsource-variable/inter`, `@fontsource/ibm-plex-mono` (400/500), imported in `apps/web/src/main.tsx`; `index.css` `--font-*` vars name the registered families (`"Fraunces Variable"` / `"Inter Variable"` / `"IBM Plex Mono"`) first. No CDN (PHI). Build emits the font assets; typographic identity restored. |
| **`@wardenx/ui` layout primitives** | ✅ **Lantern-enforced (R0.2)** | 8 Tier‑1 regions + 8 Tier‑2 layouts now use a web token helper (`packages/ui/src/web/theme/tokens.ts`: `t` CSS-var pointers + `ghostBorder` + `cardSurface`) — **zero hardcoded hex** (theme-reactive incl. dark mode), No-Line edges (tonal surfaces / ghost border ≤15%), Fraunces on titles/names/KPI-labels, Inter `tabular-nums` on KPI values, IBM Plex Mono on identifiers. Type-scale utilities (`.wx-display-lg`…`.wx-data-md`) added to `index.css`. Components (empty-state, correlation-id-badge, error-boundary) tokenized too. |
| **WardenX system primitives** | ✅ **built (R0.3)** | `packages/ui/src/web/system/`: Guardrail (`GuardChip`, `GateStepper`, `BlockingDialog`, `CeremonyModal` + step-up/EPCS, `CountdownChip`), Sensitivity (`MaskedIdentifier` + reveal, `SealedBlock`, `BreakGlassBanner`, `ConsentBadge`), Provenance (`AiSuggestionCard` halo + Accept/Edit/Dismiss + citation, `DerivedBadge`). Dependency-free inline-SVG `Glyph` set (non-color partners, §10.10); focus-trapped `Modal` scaffold; `wx-ai-pulse` halo + `wardenx-spin` keyframes added to `index.css` (reduced-motion guarded). Token-driven, biome+tsc+arch clean. Maps 1:1 to D1–D3. |
| **Missing layout patterns** | 🟡 **8 built (R0.4)** | `packages/ui/src/web/layouts/domain-patterns.tsx`: `MarGridLayout` (M13), `SchedulingCalendarLayout` (M17), `StatusBoardLayout`, `AdminHierarchyLayout`, `AdminSettingsLayout`, `PortalDashboardLayout` (Portal family — single-column/large-type/sticky safety), `GatedActionFlowLayout`, `DocumentViewerLayout` — slot-based, token-driven, No-Line, matching the glossary structures. **Deferred to first-use waves:** Bed Board, Media Room, Assistant, Portal List, Admin Console. |
| **Visual reference (Storybook)** | ✅ **done (R0.5)** | Storybook 10 (`@storybook/react-vite`) hosted in `apps/web` (reuses the Lantern `index.css` + self-hosted fonts + Tailwind v4 plugin); light/dark toolbar via `@storybook/addon-themes`. Stories under `apps/web/src/stories/` cover Regions, Guardrail, Sensitivity, Provenance, and filled Layouts. `bun run storybook` (dev) / `bun run build-storybook` (CI). |
| **Implemented screens** | ✅ real | **91 screens across 19/40 modules**, all live-wired to backends (62% substantial, 38% lean read-surfaces, **0 stubs**). Write surfaces (modals/forms/mutations) systematically deferred. Every screen references its design spec. |
| **Build backlog** | — | **~53 designed screens in 21 modules have no web surface at all.** |

**Implemented modules (19):** M02 identity, M03 authz, M04 audit, M05 patient, M06 admission,
M07 care-plan, M08 encounters, M09 assessments, M10 hope, M11 orders, M12 dosespot, M13 emar,
M14 idg, M17 scheduling, M18 evv, M22 documents, M36 messaging, M38 terminology, M40 mdm.

**Zero-web modules with designs (build backlog), by domain:**
- **Revenue (0% built):** M23 Medicare (5), M24 Medicaid (6), M25 Remittance/Denials (2), M26 Cap (2), M27 Cost Report (1) — **16 screens**.
- **Compliance (0%):** M30 HQRP/Quality (8), M39 Consent (5) — **13 screens**.
- **Portal (0%):** M31 Patient/Family Portal + Telehealth — **9 screens**.
- **Admin/Platform (≈7%):** M34 SaaS Tenant Platform (13), M29 External Interfaces (7), M28 FHIR (2), M37 IPU (2), M35 Subscription (1) — **25 screens**.
- **Clinical remainder:** M16 Bereavement (2), M19 On-Call (2), M20 Field Safety (2), M21 Supplies/DME (3), M32 AI Platform (3) — **12 screens**.
- **Core:** M33 Reporting/Dashboards (4); M01 Foundation specs (app shell/help/notifications) are largely *shell infrastructure*, partly already in `apps/web/src/shell/`.

> **Note on counts:** several clinical modules have **more** built screens than designed (e.g. M13
> eMAR: 1 spec → 7 built; M18 EVV: 2 → 9) because the implementation built the sub-views directly
> that the design only later captured as D6 depth frames. So the 91↔113 gap is not a clean join —
> the *reconcile* set is "every built screen," the *build* set is "the 21 zero-web modules."

---

## Phased plan

### Phase R0 — Foundation (make Lantern real in code) · ✅ **COMPLETE** · unblocks everything
Bounded, high-leverage, no backend dependency. **All five items landed** (branch
`feat/r0-frontend-foundation`); each step's status is in the Current-state table above.
1. **Self-host the 3 webfonts** — `@fontsource/fraunces`, `@fontsource-variable/inter`, `@fontsource-variable/ibm-plex-mono`, imported in `apps/web/src/main.tsx`. *(small, immediate visible win — restores the whole typographic identity)*
2. **Refactor `@wardenx/ui` to enforce Lantern** — replace every hardcoded hex with the CSS-variable tokens; apply the No-Line rule (tonal surface shifts, drop 1px section borders); Fraunces on titles/names/KPI-labels, Inter on data, IBM Plex Mono on identifiers (mirror exactly the review fixes: Inter on KPI *values*, alert-not-gold for controlled-substance). Add type-scale utilities.
3. **Build the WardenX system primitives** — the components the corpus is built on:
   `GuardChip`, `BlockingDialog`, `GateStepper`, `CeremonyModal` (+ step-up/EPCS), `CountdownChip`;
   `MaskedIdentifier` (+ reveal/step-up), `SealedBlock` (+ break-glass), `BreakGlassBanner`;
   `AiSuggestionCard` (halo + Accept/Edit/Dismiss + citation), `DerivedBadge`.
   These map 1:1 to D1–D3 and are reused by dozens of screens.
4. **Build the missing layout patterns** as `@wardenx/ui` components, prioritized by what the built
   modules need now: MAR Grid (M13), Scheduling Calendar (M17), Status Board, Admin Hierarchy/Settings,
   Portal Dashboard, Gated Action Flow, Document Viewer. (Bed Board, Media Room, Assistant later.)
5. **Storybook/visual reference** of the library against the Pencil boards, so future screens compose on-system by construction.

### Phase R1 — Reconcile the 91 built screens
Module-by-module: adopt the refactored library + add the per-spec Guardrail/Sensitivity/Provenance
treatments the screens currently lack (e.g. real masked MBI, guard chips on blocked actions, AI
halos). Recommended order = highest-traffic first: **M05 patient → M06 admission → M08–M14 clinical
→ M17/M18 scheduling/EVV → M22 documents → admin (M03/M04/M38/M40)**. Each module is a small PR;
screenshot vs the corresponding Pencil board.

### Phase R2 — Build the ~53-screen backlog (gated on backend modules)
Phase by domain priority + backend readiness. Each zero-web module needs both a backend surface and
a frontend build, so sequence with the backend waves. Suggested priority:
1. **M34 SaaS Tenant Platform (13)** + **M33 Reporting (4)** — foundational for multi-tenant + the role dashboards already designed in P10/D5.
2. **M39 Consent (5)** + **M30 HQRP/Quality (8)** — regulatory/compliance.
3. **M23–M27 Revenue (16)** — the full revenue cycle (confirm build-vs-integrate first).
4. **M31 Portal (9)** — patient/family-facing (AA→AAA accessibility bar).
5. **Clinical remainder** (M16/M19/M20/M21/M32, 12) + **M28/M29/M37** interop/IPU.

---

## Effort shape & sequencing

- **R0 is the unlock** and is mostly self-contained design-system code (no backend). It's the right
  first investment: it turns the corpus into a usable library and makes R1 mechanical.
- **R1** is many small, parallelizable module PRs once R0 lands — low risk, high visible polish.
- **R2** is genuine feature build, gated on the staged backend waves — scope it per-module with its
  module spec, not as one push.
- **Fonts (R0.1) is a one-hour, high-impact starter** — it restores the Lantern identity across the
  *entire* existing app immediately, and is a clean first PR to validate the workflow.

## Recommended first step
**R0.1 + R0.2 on a pilot:** self-host the fonts, then refactor **one** `@wardenx/ui` layout (e.g.
`WorkQueueLayout` + `PageHeader` + `KpiStrip`) to enforce tokens/No-Line/Fraunces, and reconcile
**one** built screen (M05 Patient Census) against its Pencil board as the reference implementation.
That proves the reconciliation loop end-to-end before scaling it across the library and the 19 modules.
