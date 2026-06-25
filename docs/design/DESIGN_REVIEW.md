# WardenX "Lantern" — Design Review (round 1)

Review of the generated Pencil corpus (~370 frames across 22 `.pen` files) against the
[Lantern design system](./DESIGN.md) — the §10 Hard Rules, the §2 color contract, the §3
type system, and the WardenX systems (Guardrail §7 / Sensitivity §8 / Provenance §9).

**Date:** 2026-06-24 · **Reviewer:** automated self-review against DESIGN.md · **Scope:** P0–P14
top-level screens + D1–D7 depth/variant frames.

> **Verdict: HOLD wholesale `◐ → ●` promotion.** The WardenX *systems* and *layout patterns*
> conform well, but there are **3 systemic primitive-level violations** (KPI typography, gold-as-
> status, token drift) that touch nearly every screen via the reused components. These are cheap to
> fix at the component/token level and should be remediated before promotion. Findings below.

---

## Conformance scorecard

| Rule (DESIGN.md §10 + §2/§3) | Verdict | Notes |
| :-- | :-- | :-- |
| §10.6 Guardrail-first (disabled + reason) | ✅ Pass | Blocked actions show reason chips/banners everywhere (D1, cap sign-off, override gates, EPCS blocks). |
| §10.7 Ceremony for the irreversible | ✅ Pass | D1 ceremonies (signature/step-up/EPCS/witness/destructive) built + instanced. |
| §10.8 Provenance mandatory | ✅ Pass | AI-suggested halos + citations (recert/CTI); AI-prohibited notes (consent/med/billing). |
| §10.9 Sensitivity visible | ✅ Pass | Part-2 renders *as* sealed → break-glass; masking shows masked value, not blank (D2). |
| §10.10 Color needs a partner | ✅ Pass | Every badge pairs color + glyph; identifiers/money use IBM Plex Mono. |
| §10.4 No pure black | ✅ Pass | Foreground `#1C1B1A` (twilight ink), never `#000`. |
| §10.5 Shadow budget ≤3 | ⚠️ Minor | Showcase boards stack many shadowed cards (acceptable for a board; real screens stay ≤3). |
| **§3 type — Fraunces never on numeric KPIs** | ❌ **Fail (F1)** | The shared KPI component renders its value in Fraunces. Systemic. |
| **§2 — Lantern Gold never a status color** | ❌ **Fail (F2)** | Accent-gold used for EPCS / controlled-substance / NOTR status. Systemic. |
| **§2 — token values match DESIGN.md** | ❌ **Fail (F3)** | Pencil `SetVariables` hex drifted from the authoritative tokens. Systemic. |
| §10.1/§10.3 No-Line (no 100%-opaque 1px dividers) | ⚠️ **Partial (F4)** | Console chrome uses hairline `--border` dividers; spec wants tonal shift or ≤15% opacity. |
| §10.11 Accessibility — contrast ≥4.5:1, 44px targets | ⚠️ **Partial (F5)** | `muted` on white fails AA at small sizes; some chips/buttons < 44px. |

---

## Findings

### F1 — Fraunces on numeric KPI values · **Critical · systemic**
- **Rule:** §3 — *"Fraunces is reserved for editorial/human moments — **never** for table data or numeric KPIs."*
- **What:** The reused **KPI** component sets its value text to `--font-primary` (Fraunces). Every KPI strip across the corpus (P0–P14) shows its number in Fraunces. Also affects large numeric displays (PPS %, cap obligation $, assessment scores).
- **Scope:** ~12 `.pen` files (every file with a KPI component) + bespoke big-number displays.
- **Fix:** Change the KPI component's *value* font to `--font-secondary` (Inter), with `tabular-nums`. Fraunces stays on the KPI *label*/eyebrow and on titles/names only. One `Update` per file's KPI `Value` node.

### F2 — Lantern Gold used as a status color · **High · systemic**
- **Rule:** §2 hard rule — *"Lantern Gold is **never** a status color."* And §2 taxonomy assigns **EPCS/controlled-substance → `alert`** (red), not gold.
- **What:** Accent-gold (`--accent` / `--accent-tint`) was used to mark EPCS, Schedule-II/controlled-substance, comfort-kit, and NOTR — i.e. as a category/status signal.
- **Scope:** P12 refill C-II + prescriber EPCS, P10 NOE/NOTR, D5 MAR/comfort-kit, D7 controlled-substance + EPCS variant cards.
- **Fix:** Recolor controlled-substance / EPCS / break-glass markers to **`alert`** (red bg/fg) per the §2 taxonomy. Reserve gold for its sanctioned uses only (logo, timeline *now*-marker, selected-step glow, empty-state warmth).

### F3 — Pencil token values drifted from DESIGN.md · **High · systemic**
- **Rule:** §2/§11 — tokens are the single source of truth; Pencil variables must mirror them.
- **What:** `SetVariables` in the `.pen` files used approximate hex:
  | token | Pencil used | DESIGN.md authoritative |
  | :-- | :-- | :-- |
  | `--muted` | `#8A8784` | `#8C877F` |
  | `--primary-tint` | `#EAEBF6` | `#ECEDFB` |
  | `--accent-tint` | `#F7ECD8` | `#FBF1DD` |
  | `--surface-low` | `#F1F0EC` | (use surface ramp `surface-low`) |
- **Scope:** All 22 `.pen` files.
- **Fix:** Re-run `SetVariables` with the exact DESIGN.md hex in each file — this propagates to every `$--token` reference automatically (no per-node edits). Cheapest high-impact fix; also add the missing dark-mode values.

### F4 — Hairline section dividers vs No-Line · **Medium**
- **Rule:** §10.1 *"Never section content with default 1px solid borders"*; §10.3 if required, `outline-variant` at **≤15% opacity**, never 100%-opaque.
- **What:** The admin-console chrome uses 100%-opaque `--border` (`#E5E3DE`) for the sidebar-right, topbar-bottom, table-header, and input borders.
- **Mitigation:** White cards already sit on warm canvas, so much of the separation is tonal — the borders are redundant. Recommend dropping the chrome dividers (rely on surface shift) or dropping border opacity to ≤15%.

### F5 — Accessibility: contrast & touch targets · **Medium**
- **Rule:** §10.11 WCAG 2.2 AA (contrast ≥4.5:1, 44px targets); portal family → AAA.
- **What:** `muted` (`#8C877F`) on white ≈ **3.5:1** — fails AA for the 10–13px labels it's used on (table headers, KPI eyebrows, field keys). Several chips/secondary buttons are < 44px tall.
- **Fix:** Use `muted-foreground` (`#56534F`, ~7:1) for small text that must be readable; reserve `muted` for genuinely disabled/placeholder. Bump interactive chip/button min-height to 44px (esp. mobile suite P5/P9 and the portal family).

---

## Promotion decision

No screens promote to `●` this round — F1–F3 are systemic and visible on essentially every screen.
After the remediation pass (F1 + F2 + F3 are the must-fix set; F4/F5 are polish), re-screenshot a
sample per pattern and promote by pattern family.

## Recommended remediation order
1. **F3 tokens** (one `SetVariables` per file — propagates; fixes color fidelity everywhere).
2. **F1 KPI font** (one `Update` per file's KPI value node).
3. **F2 gold→alert** (recolor controlled-substance/EPCS markers).
4. **F4/F5 polish** (chrome dividers, muted-text contrast, 44px) — can batch with F1/F2.

Each `.pen` file must be opened in Pencil.app to edit (one at a time), so remediation is ~22
open/fix/save cycles, or scoped to the highest-traffic files first.
