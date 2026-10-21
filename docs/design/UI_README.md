# ChartWarden UI Documentation Complete Package v6

> **Corpus map note (2026-08-14):** the canonical folder index is [`README.md`](./README.md); the
> corpus is **113 specs across 10 directories** (the four added post-v5 — `compliance`,
> `integration`, `mobile`, `staffing` — are listed below).

The ChartWarden UI screen-specification corpus: every screen across clinical, revenue, admin,
core/app-shell, portal, and platform/ops, plus the shared layout-pattern glossary.

## Contents

- `CHARTWARDEN_UI_LAYOUT_PATTERNS.md` — **the layout-pattern glossary**. Every screen declares a
  named pattern (`Use <name>.`); this document defines them, the shared regions they are
  built from, and the composition rules. Start here.
- `CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md` — index of all screens.

## Structure

- `/screens/core` — cross-cutting app foundation: auth, app shell + role home, notifications
  & tasks, staff messaging, reporting, agency command center, global search, help & training,
  user profile, system/utility pages
- `/screens/clinical`
- `/screens/revenue`
- `/screens/admin`
- `/screens/portal`
- `/screens/platform`
- `/screens/compliance`
- `/screens/integration`
- `/screens/mobile`
- `/screens/staffing`

## History

- **v2** — initial package: clinical, revenue, admin, portal, platform/ops screens (30).
- **v3** — added the layout-pattern glossary; normalized all platform/portal screens to named
  patterns; added the P0 clinical-core set (patient chart/list, encounters, care plan, orders,
  medications/eMAR, IDG), the P1 operational/regulatory set (scheduling, EVV, claims/billing,
  HOPE, HQRP, IPU), and the P2 app-shell/core set (auth, shell+home, notifications/tasks,
  staff messaging, reporting, AI governance, MDM, terminology).
- **v4** — added the P3 completeness set: integration/interface monitoring, FHIR/API access,
  volunteer management, clinical content administration, user profile & preferences, and
  system/utility pages.
- **v5** — added the P4 depth set (wound care, allergy management, prior authorization, tenant
  onboarding wizard, help & training, global search) and the P5 product-feature set (DocLens
  extraction review, clinical copilot & chart search, CTI/eligibility worksheet,
  death/pronouncement, discharge/revocation/transfer, agency command center, patient clinical
  timeline, referral source CRM). 113 screen specs total.

These documents are written for Pencil wireframing and later frontend implementation.
