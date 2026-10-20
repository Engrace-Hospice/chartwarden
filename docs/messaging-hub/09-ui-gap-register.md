# 09 — UI gap register (to be built)

> Source: two read-only audits on 2026-10-12 (UI vs `06-ux-design.md`; Phase 0/1 backend work vs screens).
> "Unconfirmed" = the audit did not verify it; check before scheduling. Phase 4–6 scope was not read in that audit; it is specified in [`10-ui-spec-phases-4-to-6.md`](./10-ui-spec-phases-4-to-6.md) (see section G).
> Add accepted rows to the WP tables in `03-phases-0-to-3.md` when a phase is planned.

## A. Staff workspace (covered by existing WPs)

| Gap | Today | WP |
| --- | --- | --- |
| Three-panel layout, collapsible patient context column, 768–1279 px slide-over | Two panes; breakpoints 1000/760 px only | 2.11 (stub), 3.1 |
| Inbox filters Direct / Care teams / Urgent | All/Unread/Mentions exist; others unconfirmed | 2.11 |
| Members/Presence column | Absent | 2.12 (presence), 2.11 |
| `Ctrl/⌘+F` in-conversation search, `Ctrl/⌘+K` global jump | Absent | 2.7a, 2.7b |
| Schedule send | Absent | 2.6 |
| Draft status indicator ("Saved" / "Saved on this device only") | Absent | 2.5 |
| Template menu | Absent | 2.8 |
| Urgency toggle, `#`/`+` clinical link picker, camera on mobile | Absent | 3.2, 3.3, 3.10 |
| AckCard, HandoffSheet, TaskDrawer, PatientContextPanel, urgent badge | Absent | 3.1, 3.4, 3.5, 3.10 |
| Empty state actions "Start a conversation / Browse channels" | Unconfirmed | 2.11 |
| Mention wording | Needs clinical-lead sign-off | 2.3 |

## B. Required states (06 §4) — not scheduled as their own item; fold into 2.11

- Loading uses a spinner, not skeleton rows (inbox, thread).
- Load-failed alerts have no retry control or correlation id (`conversation-inbox.tsx`, `conversation-thread.tsx`, `thread-panel.tsx`).
- No dedicated "You no longer have access" panel; `conversation-thread.tsx` only inspects an error string.
- No offline banner or "Not sent" offline state (send-failure handling exists).
- No "Live updates paused — refreshing every N s" banner in the thread (inbox has "Refresh paused").
- Urgent-pending state: Phase 3/4.

## C. Accessibility evidence — Phase 2 gate (keyboard-only, axe)

- No axe run, keyboard walk or screen-reader script on record.
- Touch targets: many `min-height` values are 2–2.5 rem (< 44 px); measure before fixing.
- No per-panel landmark set or focus-order evidence; no urgent-arrival announcer.

## D. Hygiene (no WP names these)

- `staff-messaging.css` is 1194 lines (over the 800 ceiling); `notifications-inbox.tsx` is 595; `conversation-thread.tsx` is 798. File split: 2.11.
- `notifications-inbox.tsx` has 35 inline `style={}` uses (against "no old-style inline UIs").
- Module-local `wx-messaging-*` CSS vs shared `list-chrome`: unconfirmed.
- Screen index (`bun run docs:ui`) may need updating: unconfirmed.
- `WARDENX_UI_NOTIFICATIONS_TASKS.md` (KPI cards, Tasks/Worklist, Preferences) vs built inbox: unchecked.

## E. Phase 0/1 backend work with no screen

`apps/admin` has no M36 module. Everything in WP 1.1–1.9 is backend only.

| Capability | Backend | Screen | Proposal |
| --- | --- | --- | --- |
| Member list, add/remove, roles | add/remove routes only; **no member-list route**, no roles route | none (`thread-header.tsx` shows `archivedAt` only) | member-list route first; UI in 2.11 or 2.9 |
| Channel create / archive | DM and care-team create only; no archive route | DM dialog only | archive route + UI in 2.9 |
| Integrity jobs (hash_verify) status | BullMQ jobs, audit rows `m36.integrity.*` | none | admin ops tile or M4 integrity-report filter (unscheduled) |
| Messaging audit / read-audit view | logging only (WP 1.8) | none | M4 audit screens with an M36 filter (unscheduled) |
| Alert rules admin | `GET/PATCH /alert-rules` | none | settings WP, Phase 4 candidate |
| Alert receipts | WP 1.6 backend | none found | with 3.5 / Phase 4 |
| Delivery endpoints + notification preferences | `/notifications/preferences`, `/notifications/endpoints` | none (not called by any app) | Phase 1 follow-up or Phase 4 (NE-10 sits in WP 4.7) |
| Admin alert-delivery view | `GET /admin/messaging/alert-deliveries` | none | new `apps/admin` 36-messaging module |
| Attachment quarantine review/release | user-side only | none | route + screen (unscheduled; SG-05) |
| Tenant erase | eraser + `messaging_erase_block`, no route | none | platform admin (M34), unscheduled |
| Retention / legal hold | weekly plan-only job | none | WP 5.6 (built (holds, overlay, scan, routes, screen); NOT built: destruction executor, redaction of held messages, thread chip, real staff names in 'placed by' (ADR-0086, proposed)) |
| Key custody / rotation | none | none | platform concern (M34), unscheduled |
| DR / restore status | CLI drill + runbook | none | runbook only; screen probably not needed |

Unconfirmed: whether `apps/web/src/modules/*/clinician-preferences.tsx` overlaps preferences.

## F. Browser pass (not done)

- Feasible: a local Docker stack is up (api :3000) and :5173 answers HTTP 200 (not confirmed to be the wardenx4 web app).
- Needs a seeded test login supplied by the user; no credentials entered so far.
- Scope: thread panel, rich message with link and mention, reactions/pins/drafts/templates/announcements after Tranche B merges.

## G. Phase 4–6 screens (spec in 10)

Specified 2026-10-18 in [`10-ui-spec-phases-4-to-6.md`](./10-ui-spec-phases-4-to-6.md): screen, route, owning app, permission, flag, endpoints,
states, accessibility, PHI rules and acceptance for WP 4.5–4.11, 5.1–5.10, 6.1–6.6, the two built-but-incomplete Phase 4.1/4.2 gaps, and proposed WPs
(4.13, 5.11, 6.7–6.10) from the TigerConnect comparison. Status re-verified against `origin/main` on 2026-10-19 (per-screen evidence in 10 §3); rows below say what changed.

| Gap | Today | Spec / WP |
| --- | --- | --- |
| Reassign dialog on the ack card | **Built** (PR #488, ADR-0078): `ack-reassign-dialog.tsx` | 10 §4 G1 |
| `important` ("Needs a response") composer control | Backend built; no composer control | 10 §4 G2 |
| Unacknowledged-urgent queue, escalation ladder visualiser | Queue built (`unacknowledged-queue.tsx`, ADR-0076, supervisor reassign); ladder visualiser absent | 4.9 |
| Delivery-failure / unreachable state | Card state built (ADR-0071); per-route attempts log absent | 4.5 |
| Notification policy, quiet-hours safety floor (tenant, web) | Backend floor built (ADR-0073); admin preferences/quiet-hours exist; no web policy or preferences screen | 4.6 |
| On-call "who is covering now" directory, role-based send | Backend built flag-off (ADR-0080 and ADR-0081, Accepted by the product owner 2026-10-19); web screen absent; M19 router not bound | 4.12 (built flag-off) |
| Snooze, fallback card, drill log, deep-link landing | Deep-link landing (ADR-0075) and snooze/reminders (ADR-0077) built; fallback card and drill-log screens absent (runbook only) | 4.8, 4.10, 4.11 |
| Offline outbox states, reconnect chip, camera capture | `use-outbox` exists; no IndexedDB queue, chip or camera | 5.1–5.3 |
| Device/session manager | Built (ADR-0083, proposed): `/messaging/devices` and `/messaging/governance/sessions`; no app lock, no bulk "sign out everywhere", the officer page takes a user id (no user picker) | 5.5 |
| Retention and legal-hold admin | Absent (`/legal-holds` generic route only) | 5.6 (built (holds, overlay, scan, routes, screen); NOT built: destruction executor, redaction of held messages, thread chip, real staff names in 'placed by' (ADR-0086, proposed)) |
| Export approval, break-glass review | Absent | 5.7, 5.8 |
| Offboarding workflow | Built (ADR-0084, proposed): `/messaging/governance/offboarding/:userId`; no per-row Reassign dialog, no stored Mark complete (derived), the officer reaches it by user id (no user picker) | 5.9 |
| Recovery rehearsal report | CLI drill only | 5.10 |
| Smart inbox, analytics, voice, language, AI panel, partner share | Absent | 6.1–6.6 |
| Phase 4-6 accessibility evidence (measured targets, axe, SR script) | Not on record | 10 §2.2, §6 5.4 |
