# WardenX — Frame-Fidelity Report

> **Generated, advisory report** (`bun run frame:fidelity`). Tracks how much of the built
> web surface has been visually matched to its Pencil frame — the layout-fidelity gap the
> Lantern reconciliation left open. Do not hand-edit; edit the registry and regenerate.
> Process: `docs/design/FRAME_FIDELITY_PLAYBOOK.md`.

**Coverage:** 3 screen(s) mapped to frames · 120 frames in the design ledger.
**By status:** 🟢 0 matched · 🟡 3 partial · ⚪ 0 pending.

## Mapped screens

| Status | Screen | Module | Frame | `.pen` | Notes |
|:--|---|:--:|---|---|---|
| 🟡 partial | App Shell & Role Home | M01 | `node:AQAhY` | wardenx-P0-foundation.pen | Role-home launcher reconciled to Lantern (Fraunces headline, No-Line tiles on warm paper). Role-curated dashboard widgets (My Patients, AR snapshot, cosign queue) await their modules. |
| 🟡 partial | Patient Chart | M05 | `node:fQjjh` | wardenx-P0-foundation.pen | Banner (avatar + Fraunces name + DOB·age meta + MRN/status chips + Message action), icon nav rail, and Summary card composition + right Alerts/Tasks rail all match the frame. Problems / benefit-period / alerts / tasks cards are honest placeholders (Care Plan, Admission, Tasks modules). |
| 🟡 partial | Patient List / Census | M05 | `node:DNqXm` | wardenx-P0-foundation.pen | Header (title + Admit action), KPI strip, work table, and right detail panel match the frame. Census KPI is the REAL active count (GET /patients/census-metrics); Admissions/Discharges/GIP/Recerts KPIs are honest '—' placeholders noting their owning module (M6 / billing). |

## Hard-fail consistency checks

- ✅ Every mapped frame node exists in SCREENS.md, no duplicate frame/screen mappings, every screen id resolves.
