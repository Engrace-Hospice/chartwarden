# ChartWarden Design Corpus

The single home for ChartWarden's **design language**, **screen specifications**, and **Pencil**
generation. Design (this folder) is kept separate from architecture (`docs/architecture/`) and
module specs (`docs/modules/`), but it is grounded in them.

> **Moved here from `docs/ui/`** (v6). The UI screen-spec corpus + layout glossary now live
> alongside the visual design system and Pencil prompts so the whole design surface is one place.
> The arch-fitness gates (`docs:ui`, `ui:parity`) point here; all repo references were updated.

## What's here

| Layer | File(s) | Answers |
| :-- | :-- | :-- |
| **Visual design system** | [`DESIGN.md`](./DESIGN.md) | *What does it look like and how does it behave?* The "Lantern" identity — color/type/spacing/elevation tokens, component patterns, and the ChartWarden-defining Guardrail / Sensitivity / Provenance systems + hard rules. |
| **Structural patterns** | [`CHARTWARDEN_UI_LAYOUT_PATTERNS.md`](./CHARTWARDEN_UI_LAYOUT_PATTERNS.md) | *What is each named layout?* The glossary of regions, base patterns, modifiers, and composition rules. |
| **Screen specs** | [`screens/**`](./CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md) | *What does each screen contain?* 113 specs across core / clinical / revenue / admin / portal / platform / compliance / integration / mobile / staffing, each declaring a layout pattern + fields + states + `Pencil Notes` variants. |
| **Screen index** | [`CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md`](./CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md) | The canonical list (drives the `docs:ui` parity gate). |
| **Module ↔ Pencil ledger** | [`SCREENS.md`](./SCREENS.md) | *Which module owns it, and is it designed yet?* Maps every screen to M1–M40 + pattern + Pencil status. |
| **Pencil prompts** | [`pencil-prompts/`](./pencil-prompts/) | *How do we generate it?* Phase-batched (P0→P14 core+breadth, D1→D7 depth) per-screen prompts fusing design system + pattern + spec, plus the Pencil MCP workflow. |
| **Frontend status** | [`DEFERRED_SCREENS.md`](./DEFERRED_SCREENS.md) | *Is it built in the app?* Implementation tracking (Track B / ADR-0030). |
| **Per-spec status** | [`SCREEN_SPEC_STATUS.md`](./SCREEN_SPEC_STATUS.md) | *Which specs have no screen?* One row per indexed spec, built / partial / deferred, with the reason (enforced by `docs:ui`). |
| **Frame fidelity** | [`FRAME_FIDELITY_PLAYBOOK.md`](./FRAME_FIDELITY_PLAYBOOK.md) | *Does a built screen's layout match its Pencil frame?* The repeatable process + the `bun run frame:fidelity` tracker (`audit/frame-fidelity/`). |

## The four-layer model

A finished screen is the composition of four layers — each owned by a different doc:

```
spec (screens/**)        →  which pattern + which fields/states/variants
glossary (LAYOUT_*)      →  what that pattern's regions are
DESIGN.md (Lantern)      →  the tokens + component look + Guardrail/Sensitivity/Provenance/rules
pencil-prompts/**        →  the three above, fused into a generation prompt for Pencil
```

## Working order

1. **Read [`DESIGN.md`](./DESIGN.md) first** — it is the visual source of truth. The implementation
   mirror (`packages/ui/src/core/theme/colors.ts` + `apps/web/src/index.css` + the `@chartwarden/ui`
   web layer) is **reconciled to Lantern** (R0/R1): self-hosted fonts, CSS-var tokens incl. twilight
   dark mode, the §6.6 StatusPill + Guardrail/Sensitivity/Provenance primitives, and No-Line rules.
2. To **add or change a screen**: edit/author its spec under `screens/**` (keep the
   `## Layout Pattern` + `Use <name>.` heading — the `docs:ui` gate enforces it), add it to the
   index, and add a row to `SCREENS.md`.
3. To **generate designs**: follow [`pencil-prompts/README.md`](./pencil-prompts/README.md) —
   open a `.pen` file, install the Lantern variables, run the phase prompts, record node ids in
   `SCREENS.md`.

## Authority

Per repo convention, **architecture (`docs/architecture/`) wins** over UI/screen specs in any
conflict. Within the *visual* layer, `DESIGN.md` is authoritative (look & behavior); it never
overrides architecture. Screen specs remain implementation proposals.

## Gates

- `bun run docs:ui` — corpus consistency (index parity · layout-heading hygiene · pattern
  resolution) over `docs/design/`.
- `bun run ui:parity` — documented (here) vs implemented (registered web screens) parity.
