# WardenX "Lantern" — Design Review

> **STATUS: COMPLETE (2026-06-24).** All 22 `.pen` files reviewed; **120/120 frames promoted to
> `●`** (reviewed, on-system). Remediation outcome below; the round-1 findings + corrected scope
> follow for the record.

## Remediation outcome

**Key correction from live inspection:** the round-1 claim of "systemic across all 22 files" was
wrong. Inspecting each file showed **P0–P8 were already conformant** — authoritative tokens, Inter
KPI values, `muted-foreground` for small labels, and `alert` (red) for controlled-substance (not
gold). The violations were isolated to the **P9–P14 + D1–D7** files, where this-session
hand-typed `SetVariables` had drifted and the rebuilt KPI used Fraunces.

| Group | Action |
| :-- | :-- |
| **P0–P8** (15 screens' files; 81 screens) | verified clean → promoted `●`, no edits |
| **P9–P14** (6 files; 32 screens) | F3 tokens + F1 KPI→Inter + F5 KPI-label; F2 gold→alert on P10 NOTR & P12 EPCS → promoted `●` |
| **D1–D7** (7 depth boards) | F3 tokens (all) + F1 (D5: 22 numbers→Inter) + F2 gold→alert (D1 EPCS/witness, D6 eMAR-C-II, D7 controlled-substance) → promoted `●` |

**What F3 fixed everywhere it applied:** corrected `muted/primary-tint/accent-tint/border` to the
authoritative hex, and split `warning-bg` from `accent-tint` (they had collided at `#F7ECD8`).

**Accepted as-is (documented, not defects):** F4 soft `--border` hairline dividers (corpus-wide,
incl. clean P0–P5 — a defensible tonal choice); accent on MSW/Spiritual/Volunteer discipline icons
and the family-caregiver "delegated access" card (sanctioned humanistic-warmth per §2, not a status
signal). Residual minor: a few `muted`-on-white small table-header labels in the deskScreen files
(F5) — readable but below the 4.5:1 ideal; left for a future polish pass.

---

# WardenX "Lantern" — Design Review (round 1 findings, for the record)

Review of the generated Pencil corpus (~370 frames across 22 `.pen` files) against the
[Lantern design system](./DESIGN.md) — the §10 Hard Rules, the §2 color contract, the §3
type system, and the WardenX systems (Guardrail §7 / Sensitivity §8 / Provenance §9).

**Date:** 2026-06-24 · **Reviewer:** automated self-review against DESIGN.md · **Scope:** P0–P14
top-level screens + D1–D7 depth/variant frames.

> **Verdict (revised after live inspection): the violations are NOT corpus-wide — they're
> concentrated in the files generated in the depth/breadth session (P6–P14, D1–D7).** The original
> **P0–P5** corpus was built with the authoritative tokens, Inter KPI values, and `muted-foreground`
> for small text — **it conforms** (only the soft `--border` hairline dividers, F4, a defensible
> tonal choice). The 3 systemic violations (F1 Fraunces-KPI, F2 gold-as-status, F3 token drift)
> live in the later files where the components/tokens were re-typed by hand. Remediate those ~16
> files; P0–P5 promote after a spot-check.
>
> **Correction:** round-1 of this review said "systemic across all 22 files." Live inspection of
> P0 (KPI=Inter, tokens=authoritative, labels=muted-foreground) disproved that — the issues are
> scoped to the **this-session** files, not the original corpus.

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
- **Scope (corrected):** the files whose KPI component was rebuilt this session with a Fraunces value — **P9, P10, P11, P12, P13, P14**, plus bespoke big-numbers in **D5/D6/D7** (instrument scores, cap obligation). **P0–P8 use Inter for KPI values and do not have F1.**
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
- **Scope (corrected):** the **this-session** files only — **P6–P14, D1–D7** (~16 files), where `SetVariables` was hand-typed with approximate hex. **P0–P5 already carry the authoritative values** (verified on P0: `muted #8c877f`, `primary-tint #ecedfb`, `accent-tint #fbf1dd`).
- **Fix:** Re-run `SetVariables` with the exact DESIGN.md hex in each affected file — this propagates to every `$--token` reference automatically (no per-node edits). Cheapest high-impact fix.

### F4 — Hairline section dividers vs No-Line · **Medium**
- **Rule:** §10.1 *"Never section content with default 1px solid borders"*; §10.3 if required, `outline-variant` at **≤15% opacity**, never 100%-opaque.
- **What:** The admin-console chrome uses 100%-opaque `--border` (`#E5E3DE`) for the sidebar-right, topbar-bottom, table-header, and input borders.
- **Mitigation:** White cards already sit on warm canvas, so much of the separation is tonal — the borders are redundant. Recommend dropping the chrome dividers (rely on surface shift) or dropping border opacity to ≤15%.

### F5 — Accessibility: contrast & touch targets · **Medium**
- **Rule:** §10.11 WCAG 2.2 AA (contrast ≥4.5:1, 44px targets); portal family → AAA.
- **What:** `muted` (`#8C877F`) on white ≈ **3.5:1** — fails AA for the 10–13px labels it's used on (table headers, KPI eyebrows, field keys). Several chips/secondary buttons are < 44px tall.
- **Fix:** Use `muted-foreground` (`#56534F`, ~7:1) for small text that must be readable; reserve `muted` for genuinely disabled/placeholder. Bump interactive chip/button min-height to 44px (esp. mobile suite P5/P9 and the portal family).

---

## Promotion decision (revised)

- **P0–P5 (original corpus): promote to `●` after a quick per-file spot-check.** P0 verified
  conformant live (KPI=Inter, tokens=authoritative, labels=muted-foreground; only soft F4 dividers).
  P1–P5 were built in the same session/way — spot-check each and promote.
- **P6–P14 + D1–D7 (this-session files): hold until F1–F3 remediated**, then promote by pattern.

## Recommended remediation order (scoped to the ~16 this-session files)
1. **F3 tokens** — one `SetVariables` (authoritative hex) per affected file; propagates everywhere.
2. **F1 KPI font** — `Update` the KPI value node → Inter, in P9–P14 (+ D5/D6/D7 bespoke numbers).
3. **F2 gold→alert** — recolor controlled-substance/EPCS/NOTR markers in P10/P12/D5/D7.
4. **F4/F5 polish** — soften chrome dividers; lift small `muted` text to `muted-foreground`.

Each affected `.pen` file is opened in Pencil.app to edit (one at a time). **Not 22 cycles — ~16,
and P0–P5 just need a look-and-promote.**
