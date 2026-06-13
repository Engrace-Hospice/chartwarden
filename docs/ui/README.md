# WardenX UI Documentation Complete Package v3

The WardenX UI screen-specification corpus: every screen across clinical, revenue, admin,
core/app-shell, portal, and platform/ops, plus the shared layout-pattern glossary.

## Contents

- `WARDENX_UI_LAYOUT_PATTERNS.md` — **the layout-pattern glossary**. Every screen declares a
  named pattern (`Use <name>.`); this document defines them, the shared regions they are
  built from, and the composition rules. Start here.
- `WARDENX_UI_COMPLETE_SCREEN_INDEX.md` — index of all screens.

## Structure

- `/screens/core` — authentication, app shell + role home, notifications & tasks, staff
  messaging, reporting & analytics
- `/screens/clinical`
- `/screens/revenue`
- `/screens/admin`
- `/screens/portal`
- `/screens/platform`

## History

- **v2** — initial package: clinical, revenue, admin, portal, platform/ops screens (30).
- **v3** — added the layout-pattern glossary; normalized all platform/portal screens to named
  patterns; added the P0 clinical-core set (patient chart/list, encounters, care plan, orders,
  medications/eMAR, IDG), the P1 operational/regulatory set (scheduling, EVV, claims/billing,
  HOPE, HQRP, IPU), and the P2 app-shell/core set (auth, shell+home, notifications/tasks,
  staff messaging, reporting, AI governance, MDM, terminology).

These documents are written for Pencil wireframing and later frontend implementation.
