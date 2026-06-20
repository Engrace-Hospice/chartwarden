# WardenX — Frontend Integration Plan (Foundation + dedicated backlog + per-module)

How WardenX starts shipping UI **without disrupting the backend-first wave workflow**. The backend
has been built wave-by-wave (A→C done; D…P3 planned), and at the end of nearly every module task the
screens were **deferred** ("screens defer — no UI codePath"). This plan turns that backlog on, and
defines how every *future* module ships its screens, using **one mechanism** and **zero changes to the
existing loop/worktree/wave machinery**.

> **Conventions, determinism rules, the validate gate, and the legend are inherited from
> `M01-M02_VERTICAL_SLICE_PLAN.md`** — read its header first. The gate here is the same:
> `bun run build && bun run arch:fitness && bun run test` all green (lint is separate CI, pre-existing-red).

> **Governing ADRs (read first).**
> - **[ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md)** already ratifies the *placement*
>   model this plan uses: `apps/web` carved by sub-path; **M1 owns `apps/web/src/shell`** = routing
>   host + layout + `packages/ui` mount + a **screen registry** that lazily mounts each module's
>   screens (so the shell never imports a feature module — frontend analogue of M1's seam registry);
>   each module owns **`apps/web/src/modules/NN-*`**, which is the target of the reusable template's
>   **N-T08 UI row**. → **Track B below is already the ratified convention, not a new decision.**
>   Mobile = Capacitor wrapping `apps/web` (no separate app).
> - **[ADR-0032](../adr/ADR-0032-frontend-api-transport-and-client.md)** (Proposed — ratify before F0)
>   decides *transport*: OpenAPI generated from the existing TypeBox schemas → a typed client in the
>   `packages/ui` leaf; **no `apps/web`→`apps/backend` import edge**; reject tRPC; drop the
>   `trpc-provider` placeholder. This refines ADR-0030's boundary clause (the "published surface" a web
>   slice imports = the **generated client methods**, not backend source).
> - **Guardrail:** `docs/plans/**` is read-only to automated runs (`arch:plan-integrity`); intentional
>   human/agent plan edits set `ALLOW_PLAN_EDITS=1` (ADR-0030 consequences).

---

## 0. The one mechanism (read first)

The entire "defer screens" behavior keys on a **single fact**: whether a module declares an
`apps/web/src/modules/NN-slug` (or `apps/admin` / `apps/portal`) codePath in
`architecture/module-manifest.ts` (+ `.cjs`). No web codePath → the UI-screen slot no-ops and the
screen task defers. Add the codePath → the screen slot is **armed** and screens are built there.

So we do **not change the workflow** — we **activate the terminal screen task that already exists at
the end of every module's ladder**. Same `archon`/`/loop` + worktree + gate machinery.

### Three invariants that keep this non-disruptive

1. **Frontend is an additive read-layer — it never compile-imports the backend.** Web slices talk to
   the API over a **generated typed REST client** (see §1). → **zero new `dependsOn` edges, zero cycle
   risk, no edits to already-green backend code.** A frontend PR cannot break a backend gate.
2. **A module's web slice lives in that module's own codePath** (`apps/web/src/modules/NN-*`,
   ADR-0030), registered into the M1 **screen registry** so the shell never imports it directly. It
   imports the **leaves** (`packages/ui`, `packages/types`) — and, per ADR-0030 as refined by ADR-0032,
   its "published backend surface" = the **generated client methods** for its routes (reached via the
   `packages/ui` leaf), **never** backend source, another module's screens, or the shell internals.
   App-wide infra (client, providers, layout) is exposed from the `packages/ui` leaf and composed in
   the M1 shell, so no web slice needs a new dependency edge.
3. **Turning screens on is opt-in per module.** Nothing retroactively breaks when one module is
   enabled; the other modules keep deferring cleanly. Backend-first invariant is preserved: a screen
   is only built **after its module's routes/seams are merged to `main`**.

---

## 1. Transport decision (ADR-0032 — Proposed, ratify before F0)

- **Backend is Fastify 5 REST with TypeBox per-route schemas** (`apps/backend/src/modules/*/routes/
  *-typebox.ts`). **There is no tRPC in the backend.** The `trpc-provider` currently in
  `packages/ui/src/providers` is a Phase-0 placeholder **mismatch** and is replaced in F0.
- **Contract surface: OpenAPI generated from the existing TypeBox schemas** via `@fastify/swagger`
  (TypeBox JSON Schemas serialize to OpenAPI for free — no hand-written spec).
- **Client: a generated, fully-typed REST client** (e.g. `openapi-typescript` + `openapi-fetch`)
  emitted into the `packages/ui` leaf (`packages/ui/src/api/`). Type-only + a thin `fetch` wrapper, no
  runtime deps → stays a leaf. Regenerated from the OpenAPI doc; never hand-edited.
- **No shared-type import edge:** the client is generated from the *serialized* OpenAPI contract, not
  by importing `apps/backend`. The backend and frontend agree through the contract, not through code.

---

## Phase F0 — Frontend Foundation (one-time; unblocks both tracks)

Isolated to `apps/web` + `packages/ui` (+ a non-behavioral `@fastify/swagger` registration in the
backend bootstrap). **No module codePath flips, no screens.** Because it touches only
frontend-foundation files, it cannot disturb any backend fitness gate. Land as one reviewable PR.

### F0-T01 — OpenAPI generator (standalone; no backend route changes) ✅ done
- files: `scripts/openapi/` (`scan-routes.ts`, `enrichments.ts`, `emit.ts`), `docs/api/openapi.json`,
  `package.json` · deps: none
- **Reality (verified):** routes validate via a manual `parse()` and do **not** attach TypeBox to
  Fastify's `schema:`, so `@fastify/swagger` can't auto-generate the contract (see ADR-0032). Chosen
  path (Option 1): a standalone generator — **no backend route file is touched.**
- do: `scan-routes.ts` auto-discovers every `app.<method>("…")` (coverage source of truth);
  `enrichments.ts` adds request/response bodies from the **same exported TypeBox schemas** the handlers
  use (M5 Patient enriched first); `emit.ts` assembles OpenAPI 3.1 → `docs/api/openapi.json`. Scripts
  `openapi:emit` / `openapi:check`; `openapi:check` added to `arch:fitness`.
- validation (CI fails on): duplicate operationIds; an enrichment targeting a non-existent route;
  an invalid (non-TypeBox) schema; a stale committed `openapi.json`.
- accept: 97 routes emitted, M5 bodies embedded; `openapi:check` green; `arch:fitness` green; no
  manifest/codePath change. **Follow-up:** wire schemas into Fastify routes (see "Backend follow-up").

### F0-T02 — Generated typed client (leaf)
- files: `packages/ui/src/api` · deps: F0-T01
- do: `bun run client:gen` runs `openapi-typescript` over `docs/api/openapi.json` → typed client in
  `packages/ui/src/api` (`openapi-fetch` wrapper + correlation-id/auth headers + the degraded-state
  hooks already in `packages/ui`). Delete the placeholder `trpc-provider`.
- accept: `arch:boundaries` green (`packages/ui` stays a leaf); client type-checks against the doc.

### F0-T03 — App shell + screen registry + build tooling (M1 codePath)
- files: `apps/web/src/shell`, `apps/web` (Vite), `packages/types` (registry contract) · spec:
  `docs/ui/WARDENX_UI_LAYOUT_PATTERNS.md`, ADR-0030
- do: Vite app + entry; router; auth/session/tenant-org context; the **screen registry** (ADR-0030) —
  the shell lazily mounts each module's screens via a registry contract in `packages/types` (leaf), so
  the shell **never imports a feature module**. Compose the existing `packages/ui` providers
  (feature-flag, system-status, socket) + the new API client; wire `correlation-id-badge` /
  `degraded-banner` / `error-boundary`. The M1 `apps/web/src/shell` codePath already exists — this fills it.
- accept: `arch:parity` + `arch:boundaries` green (shell imports only `packages/ui` + the registry
  contract, never a module); shell renders an empty authenticated layout; `bun run build`.

### F0-T04 — Layout patterns as reusable components ✅ done
- files: `packages/ui/src/layouts/` (`regions.tsx`, `patterns.tsx`, `index.ts`) · spec:
  `WARDENX_UI_LAYOUT_PATTERNS.md` (authoritative glossary)
- **Scope (deliberate):** the glossary has ~24 base patterns, many domain/surface-specific (MAR Grid,
  Bed Board, Scheduling Calendar, Admin/Portal variants, Assistant, …). Building all now — with zero
  consuming screens — would be speculative. F0-T04 ships the **Tier-1 region primitives** (every
  pattern is defined in terms of them) + the **foundational pattern layouts with near-term consumers**;
  each remaining specialized pattern ships with its first screen (Track A/B).
- do: Tier-1 regions — `PageHeader`, `KpiStrip`/`KpiCard`, `FilterBar`, `LeftNavRail`,
  `RightDetailPanel`, `StickyFooterActions`, `PatientBanner`. Foundational patterns —
  `CenteredCardLayout` (Auth Flow → M2), `CenteredStatusLayout` (System Page), `WorkQueueLayout`,
  `DashboardLayout`, `StepperWorkflowLayout`, `PatientWorkspaceLayout` (→ M5), `DetailPageLayout`.
  Slot-based, presentational, no business logic; exported from the `@wardenx/ui` barrel.
- accept: `bun run build` + `arch:fitness` + `test` green; `docs:ui` still green (no spec change);
  Vite bundles. Specialized patterns tracked to their module screens.

### F0-T05 — Backlog ledger
- files: `docs/ui/DEFERRED_SCREENS.md` · source: `docs/ui/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`
- do: derive a screen→module table of every screen whose backend module is **already merged** but whose
  screen was deferred (M3, M4, M5, M36, M38, M39, M40). One row per screen: module, spec path, layout
  pattern, status (`deferred` | `in-progress` | `done`). This is the **single coordination point** for
  both tracks.
- accept: ledger parity with the screen index for merged modules; doc-only, gate unaffected.

> After F0, both tracks below are **purely additive** per screen.

---

## Track A — Dedicated backlog wave (the deferred screens)

Sweep the screens deferred across already-merged backend modules. Runs as its own wave
(`feat/frontend-backlog` worktree, same archon/`/loop` machinery). Per module, the loop is small,
mechanical, and read-only against a **stable** API:

### A-TNN — Screens for module NN (repeat per backlog module)
- deps: F0 complete · module NN routes/seams already on `main`
- do:
  1. Add `"apps/web/src/modules/NN-slug"` to module NN's `codePaths` in **both**
     `module-manifest.ts` and `module-manifest.cjs`; `bun run scaffold` → `arch:parity` green.
  2. Build the screens from `docs/ui/screens/` against module NN's generated client methods, composing
     F0-T04 layout patterns. Import only `packages/ui` + `packages/types` (leaves).
  3. Mark the rows `done` in `docs/ui/DEFERRED_SCREENS.md`.
- accept: `bun run build && bun run arch:fitness && bun run test` green; screens listed in the spec
  exist and call real client methods; ledger updated.

Suggested order (value + dependency): **M2 identity** (login/MFA/session — gates everything) →
**M5 patient** (the clinical spine UI) → **M3/M4** (authz/audit admin) → **M36 messaging** →
**M38 terminology / M39 consent / M40 mdm** (admin + platform screens).

---

## Track B — Per-module, going forward (new UI-owning modules)

> This track is **already the ratified convention** (ADR-0030): each module owns
> `apps/web/src/modules/NN-*` and that path is the target of the reusable template's **N-T08 UI row**.
> Track B just means *using* it from the start instead of deferring — no workflow change.

For every **new** module (Wave D onward) that owns UI, include the web codePath **from T01** so the
terminal screen task fires **in-task** instead of deferring.

- **Manifest:** add `"apps/web/src/modules/NN-slug"` (or `apps/admin` / `apps/portal`) to the module's
  `codePaths` when the module is first specced into the manifest.
- **Task ladder:** the module's existing final rung (the template's **N-T08 UI row**, ADR-0030)
  becomes a **real** screen task (no deferral note): *"Screens: build `docs/ui/screens/...` against the
  module's generated client methods, registered into the M1 screen registry; ledger → done."*
- **Backend-first within the module is preserved:** the screen task still depends on the module's
  routes/seams task, so backend lands first, UI last — same ordering as today, just not deferred.
- Modules with **no** UI (pure platform/infra) keep the deferral note and add no web codePath — the
  mechanism is opt-in, so nothing changes for them.

---

## Coordination & governance (keeps the two tracks from colliding)

- **`docs/ui/DEFERRED_SCREENS.md` is the single source of truth** for screen status. Track B marks a
  module `done` so Track A skips it; Track A marks the backlog down as it clears. No screen is owned by
  both tracks.
- **Backend-first invariant (unchanged):** a screen PR may only target a module whose routes/seams are
  merged to `main`. Frontend never blocks or races a backend wave.
- **Gate interactions (all already in `arch:fitness`):**
  - `arch:parity` — flipping a web codePath requires `bun run scaffold`; the generated tree must match
    the manifest (forces the slice dir to exist).
  - `arch:boundaries` — web slices may import only leaves + their own codePath; `packages/ui` and the
    generated client must stay leaves. This is what *mechanically* prevents a frontend→backend edge.
  - `docs:ui` — validates the screen-spec corpus (index parity, layout-pattern resolution); unaffected
    by implementation, but keeps specs↔patterns honest as we build.
  - PHI screens reuse the backend's permission keys via the client; **no new authz surface** is created
    on the frontend — the server remains the only enforcement point.

---

## Backend follow-up (deferred — own task/PR, not part of F0)

The F0-T01 generator is the contract source of truth **for now**. Separately, as a backend task:

- **Wire TypeBox into Fastify routes** (`@fastify/type-provider-typebox` + `@fastify/swagger`): attach
  `{ schema: { body, params, querystring, response } }` to each of the 14 route files so Fastify
  validates at the edge and the OpenAPI document is produced from the routes themselves.
- **Preserve the M1 error envelope** — add a schema-error formatter so Fastify validation failures still
  return `VALIDATION_FAILED`, not Fastify's default shape.
- **Reconcile** `@fastify/swagger` output against `docs/api/openapi.json`, then **retire** the standalone
  enrichment registry (keep the route-scan coverage check, or replace it with Swagger's own route set).
- Re-green every route test. This is a real backend behavior change across shipped, gate-green modules —
  hence it is **out of F0** and scheduled deliberately (own ADR amendment + PR). Tracked here + ADR-0032.
- **Interim obligation:** every new backend route requires `bun run openapi:emit` (else `openapi:check`
  fails) and, for non-trivial bodies, an `enrichments.ts` entry. Add this to the per-module template.

## Why this is low-disruption (summary)

| Concern | How it's avoided |
|---|---|
| Changing the build/wave workflow | We only **activate** the existing terminal screen task via a manifest codePath; loop/worktree/gate machinery is untouched. |
| Breaking green backend code | Frontend is additive-only and never imports the backend (generated client over OpenAPI). |
| New dependency cycles | No `dependsOn` edges added; web slices import only leaves. |
| Backlog vs per-module collision | One ledger (`DEFERRED_SCREENS.md`) + backend-first rule. |
| Big upfront cost | One-time F0 foundation; every screen after is small and mechanical. |

## Sequencing

1. **F0** (one PR/worktree) — foundation + ledger.
2. **Track A** backlog wave — clears merged-module screens, M2→M5→rest.
3. **Track B** — folded into Wave D onward as a per-module convention (no separate effort).
