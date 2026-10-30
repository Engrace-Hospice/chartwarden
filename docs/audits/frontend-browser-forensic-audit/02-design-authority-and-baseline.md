# 02 — Design authority and baseline

Status: **in progress** (session 1). Nothing here is a fidelity claim; Pencil frames have not yet been rendered or diffed.

## Sources inspected

| Source | Role | Notes |
|---|---|---|
| `CLAUDE.md` | Authority rule | Architecture wins over module/screen specs. Generated reports under `audit/` are the truth for counts. |
| `docs/design/DESIGN.md` | Visual design system, "Lantern" | Status line: ADOPTED 2026-08-14. Palette: warm-neutral canvas + **twilight indigo** (`primary` `#3B45A8` light / `#AEB4F0` dark). |
| `docs/UI-UX/redesign-plan.md` (French) | Redesign of the shared kit + three pilot screens | Intent: deep-blue action colour, light airy surfaces, dark theme designed intentionally; extend the Lantern base, do not create a second design system. |
| `docs/design/CHARTWARDEN_UI_LAYOUT_PATTERNS.md`, `…SCREEN_INDEX.md`, `screens/**` | Structural patterns, 113 screen specs | Specs are proposals; architecture wins on conflict. |
| `docs/design/*.pen` (P0–P14, D1–D7) | Pencil frames | Readable only through the `mcp__pencil__*` tools. Not yet rendered. |
| Repo memory note | Redesign target | Match the ChatGPT mockup PNGs; mockup blue palette. The PNGs themselves are **not in the repo** (`image/` holds only a credentials file). |

## Design-authority conflicts (recorded, not resolved)

| ID | Conflict | Evidence | Decision needed |
|---|---|---|---|
| DA-1 | `DESIGN.md` documents primary `#3B45A8` (twilight indigo, warm-neutral canvas); the live app computes `--color-primary: #1a56eb` (pure blue) | `getComputedStyle(documentElement)` on `http://localhost:5173/` | Which is authoritative? The redesign plan and the repo memory point at the mockup blue; `DESIGN.md` still states ADOPTED/Lantern. One of them is stale. |
| DA-2 | The mockup PNGs referenced as the redesign target are not available to the auditor | `image/` contains only `CREDENTIALS.local` | Supply the PNGs (or the Pencil frames that supersede them) before any pixel-fidelity claim. |

**DA-1 RESOLVED (2026-10-22, user decision): primary `#1a56eb` is authoritative.** Supporting evidence: `#1a56eb` entered `apps/web/src/index.css` in commit `35296b25d` (2026-09-25, redesigned shell); `DESIGN.md`'s Lantern palette dates from 2026-08-14 and has had only rename commits since; `#3B45A8` appears nowhere in `index.css` or `tokens.ts`. Consequence: the `DESIGN.md` colour section is **stale documentation** (doc-drift finding D-1, not an app defect). Other `DESIGN.md` sections (type, spacing, radii, dark theme) are unverified and must be checked against live tokens, not assumed.

**DA-2 UPDATE (Pencil inspected, 2026-10-22).** The Pencil MCP now works against `docs/design/*.pen` (pen.dev app). Findings: `chartwarden-P0-foundation.pen` and `…P1-clinical.pen` both define `--primary #3b45a8`, `--font-primary Fraunces` (serif headings), `--font-secondary Inter`, warm-neutral surfaces (`--surface #eceae5`), accent `#c98a1f`. The exported shell frame (`evidence/pencil-lantern-ref/AQAhY.png`, 1440 px) shows a serif greeting, a cream canvas, indigo active nav/CTA and a "CLINICAL / WORK / REVENUE" grouped sidebar. All 24 `.pen` files were last changed on 2026-10-21 by rename commits only. So **the `.pen` corpus is the older Lantern design, not the new `#1a56eb` design.** The ChatGPT mockups are not in the repo (searched: no file named or mentioning "mockup"/"chatgpt"/`1a56eb`). Live differences already visible vs the Pencil shell: blue not indigo; Inter only (no serif display); cool white canvas; flat sidebar with different groupings (Home … Administration, then "Clinical tools", "System"). These are **expected under the user's DA-1 decision**, not defects.

Consequence: the Pencil frames remain useful for information architecture, screen inventory and layout patterns, but **not** for colour/typography fidelity. A pixel-fidelity audit against the NEW design still needs the mockup PNGs (or re-baselined frames). Fidelity claims in this audit are therefore limited to internal consistency (tokens, shared components, cross-screen drift).

**DA-2 ACTION (2026-10-22, user: "create them").** Independent mockups of the new design do not exist, so a baseline was created: `docs/design/chartwarden-NEW-live-baseline.pen` (copy of P0 with the Lantern frames removed). It holds 38 variables read from the live app (`apps/web` `:root` and `.dark`: colours themed light/dark, radii 6/8/12/16/24, Inter, IBM Plex Mono), four 1440×723 captures (Home, Patients Census, Patient Chart overview, Billing/Claims; images in `docs/design/exports/new-live/`, copies under `screenshots/WEB-*-001-desktop-1440-baseline.jpg`) and a light-theme swatch strip. **Limits, stated plainly:** it is a frozen capture of the implemented design, not independently authored intent. It can detect drift from 2026-10-22, not whether the implementation matches what the designer meant; the dark theme has tokens but no captured screens; only four screens are captured. If the real ChatGPT mockups surface, they replace it as the reference. The original `.pen` files were not modified (P0 was re-saved by the Pen app on open and restored with `git checkout`).

Until real mockups exist, design-conformance findings in this audit are limited to: internal inconsistency between screens, tokens vs hardcoded values, documented component rules (`docs/UI-UX/ui-ux-rules.md`, `component-catalog.md`), and old-vs-new drift visible within the app itself.

## Baseline observed live (desktop, signed in as seeded Administrator)

- Font stack: Inter Variable (`document.body`).
- `--color-primary`: `#1a56eb`.
- Shell: left sidebar (Home … Administration, then Clinical tools, System), top search (`⌘K`), alert bell, theme toggle, actor menu, primary "New admission" CTA.
