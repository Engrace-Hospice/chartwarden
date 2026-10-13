# 09 — UI gap register (to be built)

> Source: two read-only audits on 2026-10-12 (UI vs `06-ux-design.md`; Phase 0/1 backend work vs screens).
> "Unconfirmed" = the audit did not verify it; check before scheduling. Phase 4–6 scope was not read.
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
| Retention / legal hold | weekly plan-only job | none | WP 5.6 (confirm it includes a screen) |
| Key custody / rotation | none | none | platform concern (M34), unscheduled |
| DR / restore status | CLI drill + runbook | none | runbook only; screen probably not needed |

Unconfirmed: whether `apps/web/src/modules/*/clinician-preferences.tsx` overlaps preferences.

## F. Browser pass (not done)

- Feasible: a local Docker stack is up (api :3000) and :5173 answers HTTP 200 (not confirmed to be the wardenx4 web app).
- Needs a seeded test login supplied by the user; no credentials entered so far.
- Scope: thread panel, rich message with link and mention, reactions/pins/drafts/templates/announcements after Tranche B merges.
