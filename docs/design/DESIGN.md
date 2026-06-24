# WardenX Design System — "Lantern"

Version: 1.0
Status: Design Language (authoritative for the *visual* layer)
Scope: The token system, component patterns, and hard rules for every WardenX surface
(staff web, admin, patient/family portal, Capacitor mobile).

> **How this fits the corpus.** WardenX already specifies the *structural* layer — the
> [layout-pattern glossary](./WARDENX_UI_LAYOUT_PATTERNS.md) (regions, base patterns,
> compositions) and the [69 screen specs](./WARDENX_UI_COMPLETE_SCREEN_INDEX.md). This
> document is the *visual* layer those screens render in: color, type, spacing, elevation,
> and the component/behavior systems that make WardenX feel like WardenX. A screen spec says
> *which pattern and which fields*; the glossary says *what that pattern is*; **this document
> says what it looks like and how it behaves.**
>
> **Implementation source of truth:** the tokens below are mirrored in
> [`packages/ui/src/core/theme/colors.ts`](../../packages/ui/src/core/theme/colors.ts) and the
> Tailwind v4 `@theme` block in [`apps/web/src/index.css`](../../apps/web/src/index.css). Those
> files currently carry **bootstrap-grade placeholders** (`--color-brand: #1d4ed8`, generic
> greys); adopting Lantern means replacing them with the values in §11. When code and this doc
> disagree, this doc is the design intent and the code should be reconciled to it.

---

## 1. Creative North Star

**"Lantern"** — *calm vigilance through the hardest passage.*

WardenX is the **warden**: the system holds the rails — the invariants, the consent gates, the
compliance clocks, the signature ceremonies — so the care team doesn't have to hold them in
their head. That is the whole emotional thesis. A hospice clinician is doing the most human
work there is, often at 2am, often grieving alongside a family. The software's job is to be a
**lantern**: quiet, steady, and trustworthy — lighting the next right step without ever
shouting, and carrying the weight of "did we miss a requirement?" so the human can be present.

Three commitments fall out of that:

1. **Calm over dense.** Reject the cluttered, bureaucratic legacy-EHR aesthetic. Generous
   space, editorial rhythm, one clear focus per screen. Information *arrives* when needed
   rather than crowding in all at once.
2. **The rails are visible, never nagging.** Guards, gates, and deadlines are first-class,
   legible, and *explained* — disabled actions say *why*, blockers say *what to fix*. We make
   compliance feel like a handrail, not a gauntlet.
3. **Dignity in the details.** A patient is a person with a name and a story, not a row. Warm
   neutrals, a humanist display voice, and compassionate copy — especially in death,
   discharge, and bereavement surfaces, and across the entire patient/family portal.

Lantern descends from the Apple-minimal "clinical precision + editorial breathability" school,
but it is **its own identity**: warm paper instead of cool grey, a humanist serif for the
human moments, a designed *twilight* dark mode, and — because WardenX literally is the warden —
a formalized **Guardrail, Provenance, and Sensitivity** system that no generic design kit ships.

---

## 2. Color Tokens

WardenX color is **warm-neutral canvas + twilight-indigo brand + strictly-semantic accents.**
Hue carries meaning: indigo = the product/navigation/primary action; green/amber/red = state;
gold = brand warmth only (never status). Every value ships a light and a dark value.

### 2.1 Primary — Twilight Indigo (brand, navigation, primary action)

| Token | Light | Dark | Usage |
| :-- | :-- | :-- | :-- |
| `primary` | `#3B45A8` | `#AEB4F0` | Primary CTAs, active nav, links, focus accent |
| `primary-strong` | `#2B338A` | `#8E95E0` | Gradient CTA end, pressed, emphasis fills |
| `primary-tint` | `#ECEDFB` | `#262A52` | Tinted backgrounds, info surfaces, active-nav fill |
| `primary-dim` | `#AEB4EC` | `#3A4080` | Subdued primary, hairlines on tint |
| `on-primary` | `#FFFFFF` | `#13163A` | Text/icons on primary |

### 2.2 Accent — Lantern Gold (brand warmth — **non-semantic**)

| Token | Light | Dark | Usage |
| :-- | :-- | :-- | :-- |
| `accent` | `#C98A1F` | `#E7B35A` | The "light": logo mark, the *now*-marker on timelines, empty-state warmth, selected-step glow |
| `accent-tint` | `#FBF1DD` | `#3A2F16` | Accent background wash |

> **Hard rule:** Lantern Gold is **never** a status color. It does not mean "warning," "pending,"
> or "selected-as-success." It is brand warmth. Warnings use `warning` (§2.3), which is a
> deliberately browner, deeper amber so the two never read as the same signal.

### 2.3 Semantic — state and outcome

| Token | Light fg / bg | Dark fg / bg | Usage |
| :-- | :-- | :-- | :-- |
| `success` | `#1F8A5B` / `#E3F4EC` | `#5FD6A0` / `#10331F` | Validation passed, AI-accepted, complete, on-time, posted |
| `warning` | `#9A5B00` / `#FFF4E0` | `#E0A24A` / `#3A2A0E` | Deadline approaching, advisory, geofence-soft, degraded-input |
| `error` | `#C12B3B` / `#FBE7E9` | `#F2939E` / `#3A1418` | Validation errors, billing blocks, denials, failed |
| `alert` | `#E0413F` / `#FCEBEA` | `#FF6B68` / `#3E1513` | **Critical clinical/safety:** DNR/code-status, allergy, controlled-substance, cap **breach**, break-glass, mandatory-report |

> **`error` vs `alert`.** `error` is "this form/claim/transition is wrong — fix it." `alert` is
> "this is clinically or legally dangerous — stop and look." Allergy banners, DNR/code-status,
> EPCS/controlled-substance, cap breach, and break-glass use `alert`. A failed field validation
> uses `error`. Never use `alert` for routine validation — it must keep its weight.

### 2.4 System health — degraded mode (must mirror code exactly)

These align 1:1 with `statusColors` in
[`packages/ui/src/core/theme/colors.ts`](../../packages/ui/src/core/theme/colors.ts) and drive the
degraded-mode banner (App Shell / System Health). Do not redefine them per screen.

| Token | fg | bg | border | Meaning |
| :-- | :-- | :-- | :-- | :-- |
| `health-operational` | `#065F46` | `#D1FAE5` | `#6EE7B7` | All systems normal |
| `health-degraded` | `#92400E` | `#FEF3C7` | `#FCD34D` | Reduced capability (queue lag, integration slow) |
| `health-outage` | `#991B1B` | `#FEE2E2` | `#FCA5A5` | Subsystem down; degraded-mode active |

### 2.5 Surfaces — warm paper hierarchy

WardenX's canvas is **warm paper**, not cool clinical grey. Boundaries come from tonal shifts
in this ramp (see the No-Line rule, §10), never from default 1px lines.

| Token | Light | Dark | Usage |
| :-- | :-- | :-- | :-- |
| `background` | `#F6F5F2` | `#15151B` | Page canvas (warm paper / twilight ink) |
| `surface` | `#F6F5F2` | `#15151B` | Base layer |
| `surface-container-lowest` | `#FFFFFF` | `#1C1C24` | **Cards / primary content** |
| `surface-container-low` | `#F1F0EC` | `#21212B` | Secondary sectioning, zebra rows, input rest |
| `surface-container` | `#ECEAE5` | `#272732` | Default container, hover |
| `surface-container-high` | `#E5E3DD` | `#30303C` | Secondary buttons, active tabs |
| `surface-container-highest` | `#DEDBD4` | `#3A3A47` | Critical/selected emphasis only |

### 2.6 Text & border

| Token | Light | Dark | Usage |
| :-- | :-- | :-- | :-- |
| `on-surface` | `#1C1B1A` | `#ECEAE6` | Primary text (warm near-black) |
| `on-surface-variant` | `#56524C` | `#B8B4AD` | Secondary text, labels, metadata |
| `muted` | `#8C877F` | `#7E7A72` | Disabled, placeholder |
| `outline` | `#6E6A62` | `#8A857C` | Active borders, focus rings |
| `outline-variant` | `#D7D3CB` | `#45444E` | Ghost borders (apply at ≤15% opacity) |

> **No pure black.** Text is `on-surface` (`#1C1B1A`) or `on-surface-variant`. `#000000` is
> prohibited. The dark base is **twilight ink** (`#15151B`, a hair of indigo), not pure black —
> the lantern glows warmest against dusk, not void.

---

## 3. Typography

WardenX speaks in **three voices**: a humanist serif for the *human*, a precision sans for the
*work*, and a mono for *identity codes*. This serif/sans/mono split is the most recognizable
part of the Lantern identity.

### 3.1 Font stack

| Role | Family | Fallback | Voice |
| :-- | :-- | :-- | :-- |
| **Display** | **Fraunces** (variable, opsz) | Georgia, serif | The human: patient names, page titles, KPI labels, empty states, portal/compassion copy |
| **UI / Body** | **Inter** (variable) | system-ui, sans-serif | The work: tables, forms, nav, dense clinical data, all functional text |
| **Mono** | **IBM Plex Mono** | ui-monospace, monospace | The codes: MRN, MBI, NPI, claim/control numbers, ICD-10/HCPCS, correlation IDs |

> Fraunces is reserved for editorial/human moments — **never** for table data or numeric KPIs
> (its variable numerals aren't tabular). Numbers live in Inter with `tabular-nums`. Identifiers
> live in IBM Plex Mono so an MBI or claim control number is unmistakable and copy-safe.

### 3.2 Type scale

| Token | Font | Size | Weight | Line-height | Usage |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `display-lg` | Fraunces | 3.25rem | 540 | 1.05 | Hero outcome / KPI figure context, marketing-grade moments |
| `display-md` | Fraunces | 2.25rem | 540 | 1.15 | Page titles, portal greetings |
| `headline-lg` | Fraunces | 1.75rem | 500 | 1.2 | Section headers, modal titles |
| `headline-md` | Fraunces | 1.375rem | 500 | 1.3 | Card headers, patient name in banner |
| `title-lg` | Inter | 1.25rem | 600 | 1.35 | Clinical data headers |
| `title-md` | Inter | 1rem | 600 | 1.4 | Sub-section headers, table captions |
| `body-lg` | Inter | 1rem | 400 | 1.5 | Primary body, portal body |
| `body-md` | Inter | 0.875rem | 400 | 1.5 | Standard body, form fields |
| `body-sm` | Inter | 0.8125rem | 400 | 1.5 | Dense body, table cells |
| `label-lg` | Inter | 0.875rem | 500 | 1.4 | Buttons, nav labels |
| `label-md` | Inter | 0.75rem | 500 | 1.4 | Badges, metadata |
| `label-sm` | Inter | 0.6875rem | 600 | 1.4 | All-caps metadata, timestamps, KPI eyebrow |
| `data-md` | IBM Plex Mono | 0.8125rem | 400 | 1.4 | Identifiers, codes, control numbers |

### 3.3 The Big/Small editorial rule

Pair a large figure or name with small metadata to create rhythm. A KPI is a Fraunces-context
label (`label-sm`, all-caps) above an Inter `tabular-nums` figure above a `body-sm` trend line.
A patient banner is the name in `headline-md` Fraunces beside `data-md` mono identifiers. Use
`display-*` sparingly — at most one true display moment per screen.

---

## 4. Spacing, Radius, Elevation

### 4.1 Spacing scale (4px base)

| Token | rem | px | Usage |
| :-- | :-- | :-- | :-- |
| `1` | 0.25 | 4 | Tight icon gaps |
| `2` | 0.5 | 8 | Inline element spacing |
| `3` | 0.75 | 12 | Dense list/row padding |
| `4` | 1 | 16 | Standard card padding |
| `5` | 1.5 | 24 | Card internal sections |
| `6` | 1.75 | 28 | List-item separation (no divider) |
| `7` | 2 | 32 | Section gaps |
| `8` | 2.5 | 40 | Major section separation |
| `9` | 3 | 48 | Page vertical rhythm |

### 4.2 Radius

| Token | rem | Usage |
| :-- | :-- | :-- |
| `sm` | 0.375 | Table cells, tiny chips |
| `md` | 0.5 | Buttons, inputs, small cards |
| `lg` | 0.75 | Secondary containers |
| `xl` | 1 | **Primary cards / content containers** |
| `2xl` | 1.5 | Hero cards, feature/empty-state panels |
| `full` | 9999px | Pills, badges, avatars |

### 4.3 Elevation (shadow + glass)

| Token | Value | Usage |
| :-- | :-- | :-- |
| `shadow-soft` | `0 4px 24px rgba(28, 27, 26, 0.05)` | Cards, content containers |
| `shadow-float` | `0 12px 48px rgba(28, 27, 26, 0.10)` | Dropdowns, popovers, ceremonies |
| `shadow-ambient` | `0 8px 32px rgba(59, 69, 168, 0.06)` | Indigo-tinted float (primary surfaces) |

**Glassmorphism** — floating chrome only (nav, modals, command palette, toasts, the
break-glass banner). Warm white glass in light, twilight glass in dark:

```css
.wx-glass {
  background: rgba(255, 255, 255, 0.78);
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
  backdrop-filter: blur(20px) saturate(1.1);
}
.dark .wx-glass { background: rgba(28, 28, 36, 0.72); }
```

**Shadow budget:** ≤3 shadowed elements per screen. Beyond that, separate with tonal shifts.

---

## 5. Iconography

**System:** Google **Material Symbols — Rounded** (softer terminals than Outlined; warmer, more
humane — a deliberate departure from the legacy-EHR Outlined look).

```css
.material-symbols-rounded {
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  vertical-align: middle;
}
```

- Default 24px; inline/dense 20px. Active/selected → `'FILL' 1`.
- **Minimum touch target 44px** (the icon may be 20–24px inside a 44px hit area).
- Every color-coded icon needs a non-color signal too (shape, fill, or text) — see §10.

---

## 6. Core Component Patterns

These are the shared visual primitives. Pattern-specific composition (Work Queue, Dashboard,
Stepper, etc.) lives in the [layout glossary](./WARDENX_UI_LAYOUT_PATTERNS.md); this is how the
pieces inside them look.

### 6.1 Navigation

**Top Navigation** — glass header, 64px, sticky. Left: org/tenant context + brand mark
(`wx-brand`, the lantern). Center: global search (`⌘K` command palette). Right: notifications,
help, user menu. A **Support / Degraded-mode Banner** slot sits directly beneath it.

**Left Nav Rail** — role-filtered module groups; active item = `primary` text on `primary-tint`
fill, `md` radius. Icon + label; collapsible groups. Distinct from in-screen left rails
(step lists, worksheet trees), which belong to the Stepper/Admin patterns.

### 6.2 Cards

The **Lantern Card**: `surface-container-lowest` (#FFFFFF), radius `xl`, `shadow-soft`, padding
≥`5` (24px), sitting on the warm `background`/`surface-container-low`. No border. Header in
Fraunces `headline-md`; body in Inter.

### 6.3 KPI / Metric Card

`label-sm` all-caps eyebrow → Inter `tabular-nums` figure (`headline-lg`/`display-md`) → trend
in `success`/`error` with an arrow **and** a sign (non-color signal). Each KPI may double as a
saved filter into the queue/table below it.

### 6.4 Buttons

| Variant | Background | Text | Radius |
| :-- | :-- | :-- | :-- |
| Primary | Gradient `primary` → `primary-strong` (135°) | `on-primary` | `full` |
| Secondary | `surface-container-high` | `on-surface` | `md` |
| Tertiary | transparent | `primary` | `md` |
| Destructive | `error` (solid) | `#FFFFFF` | `full` |
| Ghost | transparent → hover `surface-container` | `on-surface` | `md` |
| **Guarded** | as its base variant, but **disabled + reason** | `muted` | — |

> The **Guarded** state is core to WardenX — see §7. A primary action whose guard is unmet
> renders disabled with a `reason chip` immediately adjacent; it never silently no-ops.

### 6.5 Inputs

Field bg `surface-container-low`; focus → `surface-container-lowest` + 2px `primary` focus ring
(offset 1px). Label `label-md` above. Error → `error` ring + `error` helper text below + an icon
(non-color). Masked sensitive inputs (SSN/MBI) show `xxx-xx-####` in `data-md` mono with a
reveal affordance gated by step-up (§8).

### 6.6 Badges / Pills (status taxonomy)

Radius `full`, padding `0.25rem 0.75rem`, `label-md`. **Every status pill pairs color with a
glyph or text** so it survives color-blindness and grayscale print.

| Family | Background | Text | Glyph |
| :-- | :-- | :-- | :-- |
| Success / complete / posted | `success` bg | `success` fg | check |
| In-progress / pending | `primary-tint` | `primary` | progress |
| Warning / due-soon | `warning` bg | `warning` fg | schedule |
| Error / failed / denied | `error` bg | `error` fg | error |
| Critical / safety | `alert` bg | `alert` fg | priority_high |
| Neutral / draft | `surface-container` | `on-surface-variant` | circle |

Canonical lifecycles render with this taxonomy: **patient** (Prospective · Active · On Hold ·
Discharged · Deceased · Merged), **claim** (draft → scrubbing → scrubbed → submitted →
accepted/rejected → paid/denied → closed/voided), **order/visit** (draft → active/published →
signed → cosigned), **document/render** (queued → rendering → rendered → failed).

### 6.7 Tables

No row borders. Zebra `surface` / `surface-container-lowest`; hover `surface-container-low`.
Header `label-sm` all-caps `on-surface-variant`. **Financial and dose columns use
`tabular-nums`** and right-align. Identifier columns use `data-md` mono. Row → opens the Right
Detail Panel (Work Queue pattern). Always spec empty / loading / error / no-permission /
zero-after-filter states.

### 6.8 Conversation bubbles (Messaging / Portal)

```css
.wx-bubble-me    { background: var(--color-primary); color: var(--color-on-primary);
                   border-radius: 1rem 1rem 0.25rem 1rem; }
.wx-bubble-other { background: var(--color-surface-container-low); color: var(--color-on-surface);
                   border-radius: 1rem 1rem 1rem 0.25rem; }
```

### 6.9 Headless primitives

Interactive components use accessible headless primitives (Radix-style contracts) + Lantern
tokens via a `cn()` class-merge helper (the repo's `wx-*` system; see
[`apps/web/src/index.css`](../../apps/web/src/index.css)): dialog, alert-dialog (destructive +
ceremonies), dropdown, tooltip, tabs, select, combobox, popover, command palette (`⌘K`),
progress, switch. Never ship an unstyled primitive — always apply Lantern tokens.

---

## 7. The Guardrail System *(WardenX-defining)*

WardenX **is the warden**. Where a generic EHR scatters validation ad hoc, WardenX gives
guards, gates, and ceremonies one consistent, legible visual language. This is the system that
most distinguishes Lantern.

### 7.1 Guard Chip (the "why")

Whenever an action is blocked by an unmet invariant, the disabled control is paired with a
**Guard Chip**: `warning`/`error`-toned, lock or block glyph, terse reason + a deep-link to fix
it. *"2 unsigned notes block submission →"*. Guards explain; they never just gray out.

### 7.2 Gate Stepper

For multi-condition gates (admission, recertification, claim submission, episode closure),
render the conditions as a checklist/stepper: each row `not-started` / `in-progress` /
`complete` / `blocked`, with the blocking ones surfaced first and individually actionable. The
primary action enables only when all gates clear.

### 7.3 Blocking Dialog (invariant blockers)

The six canonical blockers — **Admission**, **Order Signature**, **Recertification
Completion**, **Claim Submission**, **Episode Closure**, **Cap Warning/Override** — use one
`alert-dialog` template: `alert`-toned header, the precise unmet invariants as a checklist, and
exactly two paths (Fix → deep-link, or Override → only where policy permits, always captured to
audit with actor + reason). No bare "cannot proceed" toasts for invariants.

### 7.4 Signature Ceremony

Critical state transitions — admission, election, discharge, death pronouncement, order
signing, EPCS, IDG adjournment, cosignature — are **modal ceremonies**, never inline
confirmations. The ceremony shows *what is being attested*, the legal text, the signer
identity, a **step-up auth** challenge where required (EPCS / SSN write / death / break-glass),
and a single deliberate commit. `shadow-float`, glass scrim, focus-trapped.

### 7.5 Deadline & clock affordances

WardenX is full of regulatory clocks (recert windows, F2F, 5/15-day care-plan reviews, HIPAA
60-day amendment, breach 60-day, grievance 5/30-day, verbal-order 48h, NOE/NOTR). Render each as
a **countdown chip**: neutral when ample → `warning` as the threshold nears → `alert`/`error` at
expiry. Always show the absolute due date on hover, not just "in 3 days."

---

## 8. Sensitivity & Consent Layer *(WardenX-defining)*

Multi-tenant PHI with **42 CFR Part 2 / SUD**, consent gating (M39), envelope-encrypted
identifiers (M05), and **break-glass** (M34) demand a consistent treatment for "you may not see
this, or not yet."

- **PHI masking.** SSN / state ID / MBI render `xxx-xx-####` in `data-md` mono. Full reveal is a
  step-up-gated, audited action (`phi.read_ssn`), shown as a reveal affordance — never
  auto-revealed.
- **SUD / 42 CFR Part 2 redaction.** Consent-gated SUD content renders as a **sealed block**:
  a neutral placeholder with a lock glyph and *"Protected — Part 2 consent required"*, not a
  blank. Unsealing is consent-checked (M39 `ConsentEvaluator`) and audited. Redaction is visible
  as redaction (so clinicians know something exists), never a silent omission.
- **Consent-gated badges.** Privacy flags on the Patient Banner are `neutral`/`primary-tint`
  chips with a shield glyph; hover explains the gate and its authority.
- **Break-glass.** An active break-glass session paints a **persistent `alert` banner** across
  the top for the entire session ("Emergency access active — all actions audited"), with the
  grant reason and a one-tap end-session. This is the one place `alert` is ambient.

---

## 9. Provenance & AI Governance Layer *(WardenX-defining)*

WardenX has heavy AI surfaces (M32 platform, Clinical Copilot, DocLens extraction, AI order
suggestions, IDG packet) under a real governance regime. Lantern answers the layout glossary's
open question — *AI presentation is its own system, not ad-hoc per screen.*

**Three provenance states, always visually distinguishable:**

| Provenance | Treatment |
| :-- | :-- |
| **Human-authored** | Default. No special treatment. |
| **AI-suggested** (needs review) | `success`-tinted container with a soft halo, `auto_awesome` glyph, and a **provenance line** (*model · confidence · "suggestion — review before relying"*). Carries **Accept / Edit / Dismiss** and a **citation** back to source. Nothing AI-authored is committed without a human action. |
| **System-derived** (computed/imported) | Quiet `info` chip ("derived from …" / "imported via HL7 ADT") — factual, not celebratory. |

```css
@keyframes wx-ai-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(31, 138, 91, 0.35); }
  70%  { box-shadow: 0 0 0 10px rgba(31, 138, 91, 0); }
  100% { box-shadow: 0 0 0 0 rgba(31, 138, 91, 0); }
}
```

**Governance affordances present wherever AI appears:** the suggestion cites its grounding;
the human acts (suggest → review → accept); per-surface **opt-out** and a global **kill-switch**
are reachable; **hard-block categories** never render as actionable suggestions; and a
**HITL feedback** control (accept/reject + reason) is always available. The assistant *suggests*;
the clinician *decides*.

---

## 10. Hard Rules

1. **No-Line.** Never section content with default 1px solid borders. Use surface-hierarchy
   shifts and space. Boundaries are tonal.
2. **No-Divider in lists.** Patient/work lists separate items with spacing `6` (1.75rem) and
   zebra surfaces, not rules.
3. **Ghost-Border fallback.** If a divider is truly required for accessibility, use
   `outline-variant` at ≤15% opacity — never a 100%-opaque line.
4. **No pure black.** Text is `on-surface`/`on-surface-variant`; base dark is twilight ink.
5. **Shadow budget ≤3** per screen; beyond that, use tonal shifts.
6. **Guardrail-first.** Every guarded transition shows its guard (§7): disabled + reason, gate
   stepper, or blocking dialog. No silent disables, no dead-end errors.
7. **Ceremony for the irreversible.** Admission, discharge, death, signing, EPCS, break-glass →
   modal ceremony with step-up where required (§7.4). Never inline.
8. **Provenance is mandatory.** AI-suggested and system-derived content is always visually
   marked and cited (§9). No unattributed machine text in the chart.
9. **Sensitivity is visible.** Masked, redacted, and consent-gated content reads *as* gated,
   never as blank or silently dropped (§8).
10. **Color needs a partner.** Every color-coded signal carries a second non-color cue (glyph,
    fill, text, shape). Financial/dose data uses `tabular-nums`.
11. **Accessibility floor.** WCAG **2.2 AA** everywhere (contrast ≥4.5:1, full keyboard path,
    SR labels, 44px targets). The **portal family targets AA→AAA** — large type, high contrast,
    plain compassionate language, a persistent after-hours safety affordance (the population
    skews elderly / low-vision / grieving).

---

## 11. Dark Mode & Tailwind v4 Tokens

Dark mode is **first-class, not inverted** — a designed *twilight*: `#15151B` ink, indigo
lifted to `#AEB4F0`, gold to `#E7B35A` so the lantern actually glows. Enabled via the `class`
strategy (`.dark` on `<html>`).

WardenX is **Tailwind v4 (CSS-first `@theme`)** — tokens are CSS custom properties, not a JS
config. Replace the bootstrap block in [`apps/web/src/index.css`](../../apps/web/src/index.css)
with the Lantern tokens (light shown; wrap dark values under `.dark`):

```css
@import "tailwindcss";

@theme {
  /* Brand */
  --color-primary: #3b45a8;
  --color-primary-strong: #2b338a;
  --color-primary-tint: #ecedfb;
  --color-primary-dim: #aeb4ec;
  --color-on-primary: #ffffff;
  --color-accent: #c98a1f;
  --color-accent-tint: #fbf1dd;

  /* Semantic */
  --color-success: #1f8a5b;
  --color-warning: #9a5b00;
  --color-error:   #c12b3b;
  --color-alert:   #e0413f;

  /* Surfaces (warm paper) */
  --color-background: #f6f5f2;
  --color-surface: #f6f5f2;
  --color-surface-lowest: #ffffff;
  --color-surface-low: #f1f0ec;
  --color-surface-container: #eceae5;
  --color-surface-high: #e5e3dd;
  --color-surface-highest: #dedbd4;

  /* Text & line */
  --color-on-surface: #1c1b1a;
  --color-on-surface-variant: #56524c;
  --color-muted: #8c877f;
  --color-outline: #6e6a62;
  --color-outline-variant: #d7d3cb;

  /* Type */
  --font-display: "Fraunces", Georgia, serif;
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;

  /* Radius */
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-xl: 1rem;
  --radius-2xl: 1.5rem;

  /* Elevation */
  --shadow-soft: 0 4px 24px rgba(28, 27, 26, 0.05);
  --shadow-float: 0 12px 48px rgba(28, 27, 26, 0.10);
  --shadow-ambient: 0 8px 32px rgba(59, 69, 168, 0.06);
}

.dark {
  --color-primary: #aeb4f0;  --color-primary-strong: #8e95e0;
  --color-primary-tint: #262a52; --color-on-primary: #13163a;
  --color-accent: #e7b35a;
  --color-success: #5fd6a0; --color-warning: #e0a24a;
  --color-error: #f2939e;   --color-alert: #ff6b68;
  --color-background: #15151b; --color-surface: #15151b;
  --color-surface-lowest: #1c1c24; --color-surface-low: #21212b;
  --color-surface-container: #272732; --color-surface-high: #30303c;
  --color-surface-highest: #3a3a47;
  --color-on-surface: #eceae6; --color-on-surface-variant: #b8b4ad;
  --color-muted: #7e7a72; --color-outline: #8a857c; --color-outline-variant: #45444e;
}
```

The `statusColors` triad (§2.4) stays in `colors.ts` as the source of truth for the degraded
banner; mirror it here only for reference.

---

## 12. Surface coverage

Lantern governs all four WardenX surfaces, with the portal family inheriting the stricter
accessibility/compassion constraints:

| Surface | App | Notes |
| :-- | :-- | :-- |
| Staff / clinical web | `apps/web` | The bulk of the corpus; dense data, full Guardrail/Provenance/Sensitivity systems |
| Internal admin / ops | `apps/admin` | Admin Console/Hierarchy/Split/Settings patterns; same tokens |
| Patient / family portal | `apps/portal` | Portal family: AA→AAA, single-column, Fraunces warmth, safety affordance |
| Mobile (field) | Capacitor wrap of `apps/web` (ADR-0035) | Mobile Task Flow; offline/EVV; 44px targets are doubly load-bearing |

---

## 13. How to use this with the screen specs and Pencil

1. A screen spec ([`screens/**`](./WARDENX_UI_COMPLETE_SCREEN_INDEX.md)) declares its **layout
   pattern** and fields.
2. The [glossary](./WARDENX_UI_LAYOUT_PATTERNS.md) resolves that pattern into **regions**.
3. **This document** supplies the **visual tokens + component/behavior systems** (§2–§9) and the
   **hard rules** (§10) that the regions render under.
4. The [Pencil prompts](./pencil-prompts/) (§ corpus) fuse all three into per-screen generation
   prompts whose preamble is the Lantern design-system summary, so every generated screen is
   on-system by construction.

> **Authority note.** Per repo convention, architecture docs win over UI/screen specs in any
> conflict. This design system is authoritative for the *visual* layer; where a screen spec's
> visual choice conflicts with a hard rule here, this document governs the look — but neither
> overrides `docs/architecture/`.
