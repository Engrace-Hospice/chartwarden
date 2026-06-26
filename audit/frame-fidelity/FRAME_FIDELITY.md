# WardenX — Frame-Fidelity Report

> **Generated, advisory report** (`bun run frame:fidelity`). Tracks how much of the built
> web surface has been visually matched to its Pencil frame — the layout-fidelity gap the
> Lantern reconciliation left open. Do not hand-edit; edit the registry and regenerate.
> Process: `docs/design/FRAME_FIDELITY_PLAYBOOK.md`.

**Coverage:** 10 screen(s) mapped to frames · 120 frames in the design ledger.
**By status:** 🟢 3 matched · 🟡 7 partial · ⚪ 0 pending.

## Mapped screens

| Status | Screen | Module | Frame | `.pen` | Notes |
|:--|---|:--:|---|---|---|
| 🟡 partial | App Shell & Role Home | M01 | `node:AQAhY` | wardenx-P0-foundation.pen | Role-home launcher reconciled to Lantern (Fraunces headline, No-Line tiles on warm paper). Role-curated dashboard widgets (My Patients, AR snapshot, cosign queue) await their modules. |
| 🟢 matched | Authentication & Session — Sign in | M02 | `node:a1dbhD` | wardenx-P0-foundation.pen | Rebuilt to the frame's 'Card Sign in': gold hearth mark + Fraunces 'WardenX' lockup, Sign in title + subtitle, filled fields, full-width pill button, and a 'Forgot password? · Use a passkey' links row. Fully real — email/password + passkey both go through Better Auth; no placeholders. |
| 🟢 matched | Authentication & Session — Two-factor verification | M02 | `node:a1dbhD` | wardenx-P0-foundation.pen | Rebuilt to the frame's 'Card Two-factor verification' (same a1dbhD frame as Sign in): branded card, Fraunces title + subtitle, a segmented 6-digit mono OTP input (auto-advance + paste), full-width pill Verify. Fully real (TOTP + backup code via Better Auth). The frame's 'Resend code' link — which implies SMS/email OTP — is replaced by the functional backup-code toggle (our 2FA is authenticator/TOTP, which has no resend). |
| 🟡 partial | Care Plan | M07 | `node:UaKVf` | wardenx-P1-clinical.pen | Rebuilt to the frame's Patient Workspace: patient banner + module nav rail | a document-style 'Interdisciplinary care plan' card (every problem with its goals + interventions inline) | a right rail (IDG review + AI suggestion), over a sticky footer (IDG-quorum guard + actions). REAL: problems/goals/interventions, version+signers, patient banner. Honest substitutions — AI suggestion is a placeholder (M29 Clinical Copilot not built, no fabricated suggestion); no next-review date in the API (CoP note + signers shown instead); footer uses the real nav actions (Version history / summary / open draft) rather than the frame's unbuilt Save-draft / Submit-for-IDG write paths. |
| 🟡 partial | Global Search Results | M01 · M33 | `node:Cp053` | wardenx-P0-foundation.pen | Rebuilt to the frame's centered results column: per-scope No-Line cards with avatar + name + meta + status + chevron rows that navigate to the record. Patient + staff scopes are REAL (RLS/caseload + member.manage scoped); documents/orders/visits/commands are honest 'available when <module> ships' rows. |
| 🟡 partial | Notifications & Tasks | M01 · M36 | `node:mK4co` | wardenx-P0-foundation.pen | Rebuilt to the frame: Fraunces title, Notifications/Tasks/Mentions pill tabs + an inline stats strip, and a §6.2 No-Line card of rows (severity glyph + summary + source chip + status pill + relative time). The Notifications tab is the REAL alert inbox (GET /api/v1/alerts/inbox) with live Unread/Urgent/Failed stats; Tasks & Mentions are honest placeholders (Tasks/worklist module). |
| 🟡 partial | Patient Chart | M05 | `node:fQjjh` | wardenx-P0-foundation.pen | Banner (avatar + Fraunces name + DOB·age meta + MRN/status chips + Message action), icon nav rail, and Summary card composition + right Alerts/Tasks rail all match the frame. Problems / benefit-period / alerts / tasks cards are honest placeholders (Care Plan, Admission, Tasks modules). |
| 🟡 partial | Patient List / Census | M05 | `node:DNqXm` | wardenx-P0-foundation.pen | Header (title + Admit action), KPI strip, work table, and right detail panel match the frame. Census KPI is the REAL active count (GET /patients/census-metrics); Admissions/Discharges/GIP/Recerts KPIs are honest '—' placeholders noting their owning module (M6 / billing). |
| 🟡 partial | Staff Messaging | M36 | `node:A016Y` | wardenx-P0-foundation.pen | Rebuilt to the frame's Conversation View: a 'Messages' list (avatar + title + scope + unread dot, active row indigo-tinted) | a thread of chat bubbles (mine right/indigo via the real session user id, others left/paper) under a patient-scoped chip header, over a rounded composer. All real M36 data; the list's last-message preview/time isn't exposed by the channels read yet, so the secondary line shows the channel's real scope instead. |
| 🟢 matched | System / Utility Pages | M01 | `node:dT1Bt` | wardenx-P0-foundation.pen | All 7 chromeless states (404/403/500/offline/maintenance/session-expired/suspended) render the System Page pattern matched to the frame: a circular tonal icon badge holding a Lantern inline-SVG Glyph (replacing the old emoji — §10.10), Fraunces headline, muted explanation, forward action, mono correlation id. CenteredStatusLayout enhanced to draw the badge. |

## Hard-fail consistency checks

- ✅ Every mapped frame node exists in SCREENS.md, no duplicate screen mappings, every screen id resolves.
