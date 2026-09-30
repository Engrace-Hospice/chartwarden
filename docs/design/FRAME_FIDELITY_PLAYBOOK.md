# Frame-Fidelity Playbook — matching built screens to their Pencil frames

Version: 1.0
Status: Process playbook (design ↔ implementation fidelity)

> **What this is.** The `.pen` files in `docs/design/` are the **visual target** (hi-fi mockups).
> The web app in `apps/web` is the **implementation**. The R0/R1 reconciliation made built screens
> speak the Lantern *design language* (tokens, type voices, No-Line, status pills) — it did **not**
> rebuild each screen's *composition* to match its frame. This playbook is the repeatable process
> for closing that remaining **layout-fidelity** gap, one screen at a time, the way the
> App-Shell Home, Patient Chart, and Patient List / Census were done.
>
> Track progress with `bun run frame:fidelity` → `audit/frame-fidelity/FRAME_FIDELITY.md`.

---

## The non-negotiable rule: match the layout, never fabricate the data

A Pencil frame shows **plausible sample data** (a problem list, "BP3 · day 41", "Census 128").
The app must show **real data or an honest absence** — never invented clinical/financial content.

So for every region of a frame, classify its data:

- **Real & available** → render it from the live API (e.g. patient status, MRN, the active census count).
- **Real but owned by an unbuilt module** → render the *layout* with an honest placeholder that
  names the owning module ("Problem list populates with the Care Plan module", a muted `—` KPI
  labelled `M6 Admission`). The composition matches the frame; the data tells the truth.
- **Needs data the backend doesn't expose yet, but the module IS built** → add the read endpoint
  (see step 5) so the value is real. This is how the census KPI's active count was made real.

A green frame-fidelity status means **the layout matches and every value is honest** — not that
every number from the mockup is present.

---

## The steps

### 1. Locate the frame
Find the screen's row in [`SCREENS.md`](./SCREENS.md) — it gives the Pencil **node id** and the
**`.pen` file** (e.g. Patient Chart → `node:fQjjh` in `wardenx-P0-foundation.pen`). Find the built
screen in `apps/web/src/modules/<module>/` (its `screens.ts` registration names the component).

### 2. See the frame
Use the Pencil MCP tools (never `Read`/`Grep` on `.pen` files — they're encrypted):
- `mcp__pencil__get_screenshot` with the `filePath` + `nodeId` for the visual.
- `mcp__pencil__export_nodes` with `readDepth` + `resolveVariables: true` for the exact structure
  (regions, gaps, fills, type faces, the real token values).

### 3. Read the current implementation
Read the screen component and note what's already there. Most built screens already use the
`@wardenx/ui` layout kit (`PatientWorkspaceLayout`, `WorkQueueLayout`, `PageHeader`, …) and Lantern
tokens — prefer **extending** those shared components over re-implementing inline.

### 4. Match the composition with Lantern primitives
Rebuild the screen's layout to the frame using **tokens only** (no hex), via `t` / `cardSurface` /
`ghostBorder` from `@wardenx/ui` (DESIGN.md §2/§3/§10):
- §6.2 **Lantern cards**: `surface-lowest` + `radius-xl` + `shadow-soft`, **No-Line** (§10.1).
- Type voices (§3): **Fraunces** for names/titles/empty-states, **Inter** (`tabular-nums`) for data
  and **KPI numerals**, **IBM Plex Mono** for identifiers.
- §6.6 **StatusPill** for lifecycle status; tonal chips for categories.
- If a shared component is missing a slot the frame needs (e.g. the patient banner's avatar/chips/
  actions), add it as an **optional** prop so existing call sites stay unchanged.

### 5. Add a backend read only when the data is real but unexposed
If a region needs genuine data the API doesn't return yet (and the owning module is built):
1. Response schema in the module's `*-typebox.ts`.
2. Service method on the `*RouteService` interface + the in-memory slice + the Drizzle impl
   (org-scoped under `withOrgContext`, RLS-backed).
3. Route in the module's `*-routes.ts` (gate with the right permission; static paths beat `/:id`).
4. OpenAPI enrichment in `scripts/openapi/enrichments.ts`, then
   `bun run openapi:emit && bun run client:gen` to regenerate the typed client.
5. A route test in `apps/<api>/__tests__/`.

### 6. Validate
- `bun run build` (whole-repo `tsc -b`) green.
- `bun run openapi:check` in sync (if you touched the contract).
- Relevant module tests pass.
- Eyeball it without a backend: `apps/web/clinical-preview.html` (and `hope-preview.html`) are
  dev-only mock-API harnesses. They are **not** production build inputs (`vite.config.ts` builds
  `index.html` only) but they are typechecked/linted with `src/`. From `apps/web`, run `bunx vite`
  and open `http://localhost:5173/clinical-preview.html?<mode>` (add `&dark` for dark theme).
  Modes: `?idg=live|detail|minutes|packet|schedule|actions` (M14 IDG screens; variants `&cf=N`
  carry-forward count, `&noquorum=1`, `&status=scheduled|packets_building|packets_ready|live|adjourned`,
  `&f2f=error`, packet content `&sud=1` (Part 2 redacted) / `&nocontent=1` (snapshot null); patient 0 has a
  rich packet, the others a sparse one with HOPE not captured); `?meds`, `?cp`, `?orders`, `?docs`, `?sched`, `?billing`, `?pclaims`, `?explorer`,
  `?home`; no flag = patient chart. The IDG mock data is synthetic (no PHI). `hope-preview.html` has no modes.


### 7. Record + commit
Update the fidelity status in [`scripts/frame-fidelity/registry.ts`](../../scripts/frame-fidelity/registry.ts)
(`pending` → `partial` / `matched`, with a note on what's real vs. placeholder), run
`bun run frame:fidelity` to refresh the report, and commit screen + registry together.

---

## Fidelity status vocabulary

| Status | Meaning |
| :-- | :-- |
| `pending` | Built screen, not yet matched to its frame's composition. |
| `partial` | Composition matches; some regions are honest placeholders awaiting other modules' data. |
| `matched` | Composition matches and every region renders real data (no module-gated placeholders left). |

A `partial` screen is **done for now** — it advances to `matched` automatically as the modules it
waits on land and their placeholders are swapped for real reads.
