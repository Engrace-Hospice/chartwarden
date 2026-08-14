# WardenX Pencil Generation — Prompts & Workflow

How we turn the WardenX screen corpus into **Pencil** (pencil.dev) designs that are on-system
by construction. Every prompt here fuses three inputs:

1. the **Lantern design system** ([`../DESIGN.md`](../DESIGN.md)) — color/type/components/rules,
2. the screen's **layout pattern** ([`../WARDENX_UI_LAYOUT_PATTERNS.md`](../WARDENX_UI_LAYOUT_PATTERNS.md)),
3. the screen's **spec** ([`../screens/**`](../WARDENX_UI_COMPLETE_SCREEN_INDEX.md)) — fields,
   states, and the `Pencil Notes` variant list.

Status/ownership for every screen lives in [`../SCREENS.md`](../SCREENS.md).

---

## The Lantern preamble (prepend to every generation prompt)

> **WardenX "Lantern" design system.** Warm-paper canvas `#F6F5F2` (dark: twilight ink
> `#15151B`). Brand = twilight indigo `#3B45A8` (gradient to `#2B338A` for primary CTAs, pill
> radius). Lantern-gold `#C98A1F` is brand warmth only — **never** a status color. Semantic:
> success `#1F8A5B`, warning (burnt amber) `#9A5B00`, error `#C12B3B`, critical/safety `alert`
> `#E0413F`. White cards `#FFFFFF`, radius 1rem, soft shadow `0 4px 24px rgba(28,27,26,.05)`.
> **No 1px section borders** — separate with tonal surface shifts (`#F1F0EC` vs `#FFFFFF`) and
> space. Type: **Fraunces** (humanist serif) for titles/names/KPI labels & compassion copy;
> **Inter** for all UI/table/form text; **IBM Plex Mono** for identifiers & codes (MRN, MBI,
> NPI, claim/control numbers). Numbers use tabular-nums. Pill badges (radius 9999px) always pair
> color with a glyph. Material Symbols **Rounded** icons. Glass nav header (backdrop blur 20px).
> 44px min touch targets, WCAG 2.2 AA. **Guardrail-first:** blocked actions render disabled with
> a reason chip; never silent. **AI-suggested content** = success-tinted halo + provenance line +
> Accept/Edit/Dismiss + citation. **Sensitive content** (SSN/MBI masked, SUD/Part-2 redaction,
> consent gates, break-glass) renders *as* gated, never blank.

Each per-screen prompt below assumes this preamble; the phase files restate a one-line version.

---

## Pencil MCP workflow

Pencil is a desktop editor for `.pen` files; the MCP operates on the **currently open file**.

1. **Open** a WardenX `.pen` file in the Pencil app. (The MCP errors with *"A file needs to be
   open"* until then — this is the one manual step.)
2. **Learn the schema** — `mcp__pencil__get_app_state({ include_schema: true })` and
   `mcp__pencil__get_guidelines()`. Always do this before any design call.
3. **Install the design variables once** — `mcp__pencil__execute(...)` with the Lantern
   tokens (colors §2, type §3, radius/spacing §4 from `DESIGN.md`) so every frame references
   variables, not hard-coded hex. This is the single most important step for on-system output.
4. **Generate per screen** — `mcp__pencil__execute(...)` to lay out the screen's regions
   and its `Pencil Notes` variant frames, following the prompt for that screen.
5. **Verify** — `mcp__pencil__get_screenshot(...)` / `get_screenshot(...)`; check against the
   hard rules (no 1px borders, provenance on AI, guard chips on blocked actions, masking on PHI).
6. **Record** the returned node id back into [`../SCREENS.md`](../SCREENS.md) (`⬚` → `node:<id>`).
7. **Export** when a batch is approved — `mcp__pencil__export_nodes(...)`.

> Generate **frames as variants** within one node per screen (the spec's `Pencil Notes` lists
> them — e.g. Patient Chart: active / just-admitted / discharged / deceased / merged /
> SSN-masked-vs-revealed). Variant count (~250+ frames), not screen count (113), is the real size.

---

## Per-screen prompt template

When a screen below isn't fully written out, generate its prompt from this template:

```
[Lantern preamble — one line]

Design "<Screen Name>" for WardenX, a multi-tenant hospice EHR. Owning module: <Mxx>.
LAYOUT PATTERN: <pattern from glossary> — render its regions:
  <list regions from the glossary entry for that pattern>.
CONTENT (from spec ../screens/<path>):
  <the spec's section headers / key fields / table columns / actions>.
WARDENX SYSTEMS that apply on this screen:
  - Guardrails: <which actions are guarded + their blocking conditions>
  - Provenance/AI: <any AI-suggested or system-derived content>
  - Sensitivity: <PHI masking / SUD redaction / consent gates / break-glass>
  - Deadlines: <any regulatory countdown chips>
STATES: empty, loading, error, no-permission, zero-after-filter (+ pattern-specific).
VARIANTS (frames): <the spec's "Pencil Notes" list>.
Apply the Lantern design variables. No 1px section borders; tonal separation only.
```

---

## Phase plan

Generate in this order — each phase reuses chrome/components proven in the prior one.

| Phase | File | Scope | Screens |
| :-- | :-- | :-- | :-- |
| **P0** | [`P0-foundation-core.md`](./P0-foundation-core.md) | App shell, auth, patient chart/list, system pages **+ the cross-cutting overlays** (Guardrail blockers, Signature ceremony, Provenance, Sensitivity) | 10 + overlays |
| **P1** | [`P1-clinical-core.md`](./P1-clinical-core.md) | Care plan, encounters, assessments, wound, allergy, HOPE, orders, meds/eMAR, IDG, timeline, copilot | 13 |
| **P2** | [`P2-operational-regulatory.md`](./P2-operational-regulatory.md) | Scheduling, EVV, on-call, field safety, supplies, bed board, HQRP, volunteer, bereavement, death, discharge | 11 |
| **P3** | [`P3-revenue-cycle.md`](./P3-revenue-cycle.md) | Claims, eligibility, prior auth, remittance, denials, cap, cost report | 7 |
| **P4** | [`P4-admin-platform.md`](./P4-admin-platform.md) | Org/roles/staff/tenant/flags/audit/AI-gov/MDM/terminology/content/FHIR/integration/CRM/onboarding + ops/subscription/support/health | 18 |
| **P5** | [`P5-portal-mobile.md`](./P5-portal-mobile.md) | Portal dashboard/messages/docs/schedule/telehealth + mobile field/EVV variants | 5 + mobile |
| **P6–P10** | [`P6-P10-expansion.md`](./P6-P10-expansion.md) | Missing-domain expansion: compliance/privacy/quality, EPCS+staffing+patient-billing, external portals, mobile/integration/ops, cert+billing-ops+note-lifecycle+role-dashboards | 28 |
| **P11** | [`P11-core-clinical-cleanup.md`](./P11-core-clinical-cleanup.md) | Deferred-screen cleanup: the 7 index entries never authored into a P0–P5 prompt block — help/training, user profile, admissions intake, election & cert, eligibility/CTI, document mgmt, DocLens | 7 |
| **D1–D6** | [`D1-D6-depth.md`](./D1-D6-depth.md) | **Depth track** — the ~500 unbuilt sub-views/variants the 97 screens' specs call for: ceremonies, masking/consent states, universal empty/error/no-perm states, expanded steppers, role/discipline variants, heavyweight sub-views | 137 frames |
| **P12–P14** | [`P12-P14-breadth.md`](./P12-P14-breadth.md) | **Breadth track** — 16 NEW whole screens for thin/zero-coverage modules: M12 DoseSpot prescribing, M39 staff-side consent, M24 Medicaid billing, M26 cap settlement, M19/M20/M21/M28/M40 ops/gateway/MDM | 16 |

> **Why overlays are in P0.** The Guardrail blocking dialogs, signature ceremonies, AI-provenance
> treatment, and sensitivity/masking are *components reused across dozens of screens*. Designing
> them once in P0 as a shared symbol set means every later screen composes them rather than
> re-inventing — and keeps the rails visually identical everywhere, which is the whole point of
> the warden.
