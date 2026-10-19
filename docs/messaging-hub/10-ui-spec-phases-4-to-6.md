# 10 — UI specification, Phases 4–6 (and the Phase 4 UI that is still missing)

> Part of the [Messaging Hub plan](./README.md). Closes [`09` §G](./09-ui-gap-register.md#g-phase-46-screens-spec-in-10). Companion to
> [`04`](./04-phases-4-to-6.md) (scope), [`05`](./05-clinical-workflows-and-safety.md) (workflows, authorization),
> [`06`](./06-ux-design.md) (workspace, required states, accessibility). **Architecture wins on conflict** ([`CLAUDE.md`](../../CLAUDE.md)).
> This is a **proposal for review**: no code, route, permission or flag in this file exists unless it says "built". Wording, role maps,
> deadlines and thresholds are provisional until the clinical lead signs them ([`brief-clinical-lead-signoff.md`](./brief-clinical-lead-signoff.md)).

## 1. Scope and ground truth

**Built (re-verified against `origin/main` a47d04eb5, 2026-10-19; evidence in the §3 Status column):** WP 4.1 (`urgent-badge`, `urgent-wording.ts`),
4.2 (`ack-request-card`), 4.3 (seam, deny-stub, no UI), 4.4 (escalated / "could not be passed on" card note), 4.5 (`failed_unreachable` state on the card
and in the queue, ADR-0071), 4.6 backend only (platform floor for urgent alerts, ADR-0073; no web or policy screen), 4.7 backend guard only (ADR-0074;
no preview screen), 4.8 (`/n/:id` landing, ADR-0075), 4.9 queue (ADR-0076; no ladder visualiser), 4.10 (snooze and reminders, ADR-0077), and gap closure A
(reassign dialog on the card plus supervisor reassign on the queue, ADR-0078, so **G1 is built**). PR #489 added patient-chart links into the thread. Flags
(`messaging.urgent_clinical`, `messaging.ack_requests`, `messaging.escalation_timers`, `messaging.notification_policy`) are **off for every tenant**
by default: each is an ops flag documented "default off, absent = off" (`packages/types/src/messaging-ack.ts`, `messaging-snooze.ts`) and no migration or seed in the repo enables any of them. Whether a given deployed tenant has switched one on lives in tenant data, not the repo, and was not checked. Built beside them, from earlier phases: lifecycle review queue, handoffs, tasks,
promotions, notifications inbox, saved replies, global-search settings (web); alert deliveries, channel members, integrity tile, alert rules, notification
preferences, quiet hours, delivery endpoints (admin). **Not built:** the rows marked missing or partial in §3, G2, and §5.4 onward.

**Which app owns a screen.** `apps/web` = anything a tenant's staff, supervisors, compliance officers or tenant admins use (the existing
`navGroup: "Admin"` entry `messaging.global-search-settings` is the precedent). `apps/admin` = platform operators (M34 shell): cross-tenant
health, delivery plumbing, recovery. A tenant compliance screen is therefore **web**, never admin.

**Style (non-negotiable, [`06`](./06-ux-design.md)).** Shared `wx-*` chrome from `packages/ui/src/web/styles/list-chrome.css` and `app-shell.css`
(`wx-page-head`, `wx-list-toolbar`, `wx-kpi-strip`/`wx-stat-card`, `wx-work-queue`/`wx-work-split`, `wx-list-drawer`, `wx-list-state`,
`wx-modal-*`, `wx-segmented`, `wx-sr-only`); the mockup blue palette (`--color-primary` #1a56eb and the `*-pill-fg` text tokens); flat rail/drawer, no
inline `style={}` UIs, no new visual identity. Layout names come from [`WARDENX_UI_LAYOUT_PATTERNS.md`](../design/WARDENX_UI_LAYOUT_PATTERNS.md):
**Work Queue + Right Detail Panel** for queues, **Admin Settings Layout** for policy screens, **Conversation View** for thread-embedded UI. New
module-local CSS is capped at the 800-line ceiling; list-chrome additions go in `packages/ui`, not the module.

## 2. Shared contracts (every screen inherits these; blocks below list only deltas)

### 2.1 Required states (S0) — the same seven, everywhere

| State | Behaviour (all screens) |
|---|---|
| Loading | Skeleton rows (`skeleton-rows.tsx`), `aria-busy="true"`; never a bare spinner |
| Empty | Shown **only** when the server confirmed an empty, accessible result; says what would appear here and the next action |
| Error | `role="alert"`; plain sentence, **Try again** button, correlation id from the standard error envelope (copyable). Never rendered as empty |
| No access | "You no longer have access to this." No title, name, count or preview leak; no hint whether the object exists |
| Offline | Banner "You are offline. This list may be out of date." Reads show last data with its age; **every write control is disabled** unless the block says it queues. Acknowledge, take responsibility, reassign, approve, revoke and break-glass are **never queued** |
| Flag off | "This feature is not turned on for your organization." For safety screens add the agency telephone procedure line (tenant setting, cannot be blank) and keep any already-created record visible read-only. Nav entry hidden; a deep link shows this panel, not a 404 |
| Degraded realtime | "Live updates paused — refreshing every N s" (existing banner), and the queue keeps polling |

### 2.2 Accessibility (WCAG 2.2 AA) — applies to every screen

Landmarks per region (`main`, `nav`, `aside`, `region` with accessible name); focus order rail → list → detail → actions; visible focus (2.4.11);
targets **≥ 44 × 44 px** (the audit in [`09` §C](./09-ui-gap-register.md) found many 2–2.5 rem controls: new screens measure at build); no
drag-only interaction (2.5.7); 4.5:1 contrast, status by **icon + text + border, never colour alone**; 200 % text and 320 px reflow without
horizontal scroll; `prefers-reduced-motion` respected; every icon-only control has an accessible name; relative time with absolute time in
`wx-sr-only`; dialogs trap and restore focus to the invoking control; destructive or irreversible actions name their object in the confirm
button ("Revoke Pixel 7"). **Announcer:** one `aria-live="polite"` region per screen for list changes; one `aria-live="assertive"` region
**only** for urgent arrival, overdue, escalated-to-me and `failed_unreachable`, one message per event, de-duplicated by request id, never repeated on
refresh, and never carrying PHI ("Urgent clinical message needs your response").

### 2.3 PHI rules

No patient name, MRN, diagnosis or free text in: browser tab title, `document.title`, push, SMS, email, lock-screen text, URL (ids only), analytics
events, error text or correlation ids. Inside the authenticated app, patient identity appears only where the user is already authorized for that
patient and the read is audited (`auditRead` with `resourceIdParam`; see CLAUDE.md "A read-audit config needs a `resourceIdParam`"). Queue rows for
supervisors are proposed to show **patient initials + age band + room/team** by default (the shipped 4.9 rows show requester name and `request_ref` instead, ADR-0078); full name appears in the opened detail (audited read). Screens that
aggregate (analytics, ladder, drills) carry **ids and counts only**.

### 2.4 Acceptance template (every block adds specifics)

1. **axe**: `vitest-axe` run in the screen's `*.dom.test.tsx` for every S0 state, zero serious/critical.
2. **Keyboard**: scripted walk (Tab, Shift+Tab, Enter, Space, Esc, arrows in menus) completes the primary action and each destructive action without a
   pointer; follows the pattern of `keyboard-only.gate.dom.test.tsx`.
3. **Live check**: a `test:messaging-hub:<id>:live` suite on a private `pgvector/pgvector:pg18` container (never the shared cluster), connecting as the
   NOBYPASSRLS `wardenx_app` role, asserting the route's tenant isolation and that the audit row lands. Each new live suite needs a `package.json`
   script **and** a `ci.yml` job row (`arch:live-suites`).
4. **Screen index**: add the screen to `docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md` and `SCREEN_SPEC_STATUS.md` (`bun run docs:ui`); one
   `## Layout Pattern` line per screen spec.
5. **Manual evidence per phase**: a screen-reader script (VoiceOver + NVDA), recorded with the release gate ([`07`](./07-testing-release-governance.md)).

## 3. Screen inventory

`New` = route or permission does not exist yet (registered in M3, composed by a route, OpenAPI-enriched, `arch:error-envelope`-clean per
[`02` §7](./02-architecture-and-domain.md#7-api-additions-prefix-apiv1messaging-idempotency--audit--typebox-on-all)). Flags marked `+` are proposed.

| ID | Screen | Route | App | Permission | Flag | Endpoints | Status (origin/main) |
|---|---|---|---|---|---|---|---|
| G1 | Reassign dialog | (in thread; also the 4.9 queue) | web | `messaging.urgent.receive` (new assignee); sender or assignee acts; supervisors `messaging.review` | `ack_requests` | `POST /escalations/:id/reassign`, `GET /escalations/:id/reassign-candidates`, `POST …/supervisor-reassign`, `GET …/supervisor-reassign-candidates` (all built) | built. `ack-reassign-dialog.tsx`, `use-ack-reassign.ts`; candidates via `GET /escalations/:id/reassign-candidates` (not the proposed `assignee-options`); ADR-0078 |
| G2 | "Needs a response" composer control | (in composer) | web | `messaging.send` + `messaging.urgent.send` | `ack_requests` | `POST /channels/:id/messages` + `POST /escalations` built | built (web). `needs-response-control.tsx` in the composer (inline checkbox + radiogroup, flag + both permissions + options route); the sender posts the message, then `POST /escalations`. Two calls, not atomic: a failed request after a stored message is reported, not rolled back |
| 4.5 | Unreachable state + delivery log | card; `/admin/messaging/alert-deliveries` | web, admin | `messaging.read`; `messaging.admin.read` | `escalation_timers` | `GET /escalations/:id` built (add `route_attempts`); admin deliveries built | partial. Card state `failed_unreachable` (`ack-request-card.tsx`, `ACK_UNREACHABLE_TEXT`); no `route_attempts` anywhere; admin deliveries `GET /admin/messaging/alert-deliveries` built (status filter, default `failed`) |
| 4.6 | Notification policy + my preferences | `/messaging/preferences`; `/messaging/policy` | web | `messaging.read`; `messaging.policy.manage` **new** | — | `GET/PUT /notifications/preferences` built; `GET/PUT /notifications/policy` **new** | partial (backend only). `notification-policy-ports.ts`, ADR-0073; no `/notifications/policy` route, no web `/messaging/preferences` or `/messaging/policy`; admin `settings/notification-preferences.tsx`, `quiet-hours.tsx` exist |
| 4.7 | Template preview (PHI-free proof) | `/admin/messaging/templates-preview` | admin | `messaging.admin.read` | — | `GET /admin/messaging/notification-templates` **new** (synthetic data) | partial. Render guard and generic wording (ADR-0074); no preview screen or template-registry route |
| 4.8 | Deep-link landing + push opt-in | `/n/:id` (opaque delivery id) | web | `messaging.read` | — | `GET /deliveries/:id/target` built; `/notifications/endpoints` built | built, route differs. `notification-landing.tsx` at `/n/:id` (opaque delivery id, not `/messaging/c/…`); ADR-0075. Push opt-in UI: unverified |
| 4.9 | Unacknowledged-urgent queue + ladder | `/messaging/unacknowledged` | web | `messaging.review` (built) | — (ADR-0076: no flag) | `GET /escalations/unacknowledged` built; `…/supervisor-reassign` built; `GET /escalations/:id` built | partial. `unacknowledged-queue.tsx` at `/messaging/unacknowledged`, permission `messaging.review` (not the proposed `…escalation.supervise`), `GET /escalations/unacknowledged`, "Showing N of M", supervisor Reassign; no ladder visualiser, no Call, no take-over, read-only detail panel absent (flat list) |
| 4.10 | Reminders and snooze | inbox row, notification row | web | `messaging.read` | `notification_policy` (route 404s when tenant flag `messaging.notification_policy` is off) | `GET/PUT/DELETE /channels/:id/snooze`, `GET /reminders`, `PUT/DELETE /messages/:id/reminder` built; digest in preferences unverified | built. `snooze-control.tsx`, `message-reminder-button.tsx`, `use-channel-snooze.ts`; routes `…/channels/:id/snooze`, `/messages/:id/reminder`, `/reminders` (shape differs from `/alerts/:id/snooze`); ADR-0077. Digest switch: unverified |
| 4.11 | Drill log + fallback card | `/messaging/fallback`; `/messaging/governance/drills` | web | `messaging.read`; `messaging.drill.manage` **new** | — | `GET/POST /messaging/drills` **new** | partial. Runbook `docs/runbooks/messaging-escalation-fallback.md` only; no fallback card or drill-log screen |
| 4.12+ | On-call "who covers now" directory | `/messaging/on-call` | web | `messaging.oncall.read` **new** | `oncall_directory`+ | `GET /oncall/coverage` **new** (via `EscalationRouter`, real M19 router needed) | missing |
| 5.1 | Offline outbox | (composer, drawer) | web | `messaging.send` | — | `POST /channels/:id/messages` (`clientMessageId`) built | partial. `use-outbox.ts`, `pending-message-row.tsx` ("Not sent", Retry), `offline-banner.tsx`; IndexedDB encryption and the never-queue-urgent rule: unverified |
| 5.2 | Reconnect sync | (header chip) | web | `messaging.read` | — | `GET /channels/:id/messages?after=` built | partial. `realtime-banner.tsx` ("Live updates paused"); no Live / Catching up chip; `after` cursor use in `use-thread.ts` unverified |
| 5.3 | Camera capture | (composer sheet) | web | `messaging.send` | — | attachments routes built | missing (no `capture` input in `attachment-composer.tsx`) |
| 5.4 | Responsive/touch evidence | all | web | — | — | none | missing (evidence, not code) |
| 5.5 | Devices and sessions | `/messaging/devices`; `/messaging/governance/sessions` | web | self; `messaging.sessions.manage` **new** | — | `GET/DELETE /devices` **new**; `/notifications/endpoints` built | missing (no matching route, screen or web file found) |
| 5.6 | Retention and legal hold | `/messaging/governance/retention` | web | `messaging.retention.manage` **new** | — | `/legal-holds` built (generic); `GET/PUT /messaging/retention` **new** | missing (no matching route, screen or web file found) |
| 5.7 | Export request and approval | `/messaging/governance/exports` | web | `messaging.export.request`, `messaging.export.approve` **new** | `export`+ | `POST/GET /exports`, `…/{approve,deny,revoke}` **new** | missing (no matching route, screen or web file found) |
| 5.8 | Break-glass request and review | `/messaging/governance/break-glass` | web | `messaging.breakglass.request`, `…review` **new** | `breakglass`+ | `POST /break-glass`, `GET /break-glass/reviews`, `POST …/:id/review` **new** | missing (no matching route, screen or web file found) |
| 5.9 | Offboarding workflow | `/messaging/governance/offboarding/:userId` | web | `messaging.offboarding.manage` **new** | — | `GET /offboarding/:userId` **new**; reassign routes built; `review-items` built | missing (no matching route, screen or web file found) |
| 5.10 | Recovery rehearsal report | `/admin/messaging/recovery` | admin | `audit.read` | — | `GET /admin/messaging/recovery-runs` **new** (reads `m36-restore-drill` output) | missing (no matching route, screen or web file found) |
| 6.1 | Smart work inbox | `/messaging/work` | web | `messaging.read` | `work_inbox`+ | `GET /work-inbox` **new** (composes built sources) | missing (no matching route, screen or web file found) |
| 6.2 | Response analytics | `/messaging/analytics` | web | `messaging.analytics.read` **new** | `analytics`+ | `GET /analytics/response` **new** (via M33) | missing (no matching route, screen or web file found) |
| 6.3 | Voice notes and dictation | (composer) | web | `messaging.send` | `voice`+ | attachments routes; dictation per ADR | missing (no matching route, screen or web file found) |
| 6.4 | Language and translation review | `/messaging/settings/language`; `…/templates` | web | self; `messaging.template.translate` **new** | `i18n`+ | `template-admin` built + translations **new** | missing (no matching route, screen or web file found) |
| 6.5 | AI summary panel | (thread side panel) | web | `messaging.ai.use` **new** | `ai`+ | `POST /channels/:id/summaries` **new** (M32) | missing (no matching route, screen or web file found) |
| 6.6 | External partner share | `/messaging/partners`; partner view | web | `messaging.share.manage` **new** | `external_share`+ | `POST/GET/DELETE /external-shares` **new** | missing (no matching route, screen or web file found) |

## 4. Gaps in the built Phase 4.1 / 4.2 UI

### G1 — Reassign dialog (ack card): BUILT (PR #488, ADR-0078)

> Built: `ack-reassign-dialog.tsx`, `ack-reassign-wording.ts`, `use-ack-reassign.ts`, `ack-reassign.dom.test.tsx`; sender/assignee route `POST /escalations/:id/reassign` + `GET …/reassign-candidates`, supervisor route `…/supervisor-reassign` + `…/supervisor-reassign-candidates` (also reached from the 4.9 queue). The mock below is the original proposal, kept for comparison; the shipped wording and states live in the wording file. Open: clinical-lead sign-off (ADR-0078 status).

```
┌ Reassign this request ────────────────────────────┐
│ Pass responsibility to (choose one)               │
│ ( ) Dana K., RN case manager      on shift        │
│ ( ) Dr. Mehta, hospice physician  on shift        │
│ ( ) Sam T., RN                    not on shift    │
│ Reason (optional, not clinical advice)  [______]  │
│ The window restarts for them. Original time kept. │
│ This is not the emergency path.   [Cancel][Reassign] │
└───────────────────────────────────────────────────┘
```
- **States:** S0 plus *options loading* (skeleton radio rows), *no qualified colleague* ("Use the agency telephone procedure."), *conflict* (the request was
  taken or reassigned meanwhile: show the new state, no overwrite), *rate-limited* (existing 20/min wording), *indeterminate* (same reuse-safe text as
  `INDETERMINATE_TEXT`: resending the same idempotency key cannot duplicate).
- **Actions:** open from the card (sender or current assignee only; others see no button); choose one; submit with an idempotency key. Optimistic UI
  forbidden: the card changes only after the server answers. Success is announced politely ("Reassigned to Dana K.").
- **A11y/PHI:** radiogroup with legend; Esc closes; focus returns to the card's Reassign button. Options show staff names and role only. The reason is
  free text: stored encrypted, never in alerts or push; helper text says not to put clinical detail.
- **Acceptance:** axe + keyboard; live: a non-party gets 403 and no button; reassign restarts the window and keeps `requested_at`; replay of the same key = one event.
- **Sign-off:** reassign limits and who may reassign (brief §3, §5) — clinical lead (still open, ADR-0078).

### G2 — "Needs a response" (important) composer control: STILL MISSING

> Verified 2026-10-19: no such control in `composer-footer.tsx` / `message-composer.tsx`. The recipient list can reuse the built `GET /channels/:id/urgent-messages/options` or the reassign-candidates reader rather than a new endpoint. Whether the control should exist at all (versus the existing Urgent clinical dialog) is a product decision.

```
[B I • 1.  @  #  📎  SBAR  ⏱]  [ ] Needs a response ▸ Dana K., RN    [Send]
```
A checkbox in `composer-footer.tsx`, off by default, never remembered. Checked: a one-recipient picker (qualified care-team members, same list as G1);
Send then calls the message route and `POST /escalations` (class *important*, 60 min). Uncheck by Esc inside the picker.
- **States:** S0; *no qualified colleague* disables the box with the reason text; *flag off* hides the box. The sent message shows the existing ack card.
- **Wording:** "Needs a response" / "Ask Dana K. to take responsibility. This does not page anyone and is not the emergency path." (provisional).
- **A11y/PHI:** real `<input type="checkbox">`, 44 px row, described-by the notice. No PHI beyond the message itself.
- **Acceptance:** axe + keyboard (Space toggles, Tab to picker); live: unqualified recipient rejected; message and request atomic.

## 5. Phase 4 screens

### 4.5 Delivery-failure handling — "Could not reach anyone" state

> Status: **partial** (card state and queue pill built; delivery log of per-route attempts not built). See §3.

```
┌ Needs response · Escalated ──────────────────────────────┐
│ ⚠ No one could be reached. Every route failed.            │
│ Tried: in-app ✓ delivered · push ✗ failed · SMS ✗ failed  │
│ Supervisor has been told. Call: agency procedure.         │
└───────────────────────────────────────────────────────────┘
```
- **Where:** a state of the existing ack card (sender and assignee), a row state in the 4.9 queue, and a `failed_unreachable` filter on the admin Alert
  deliveries screen (platform view, no message content).
- **States:** S0 plus the ladder states *delivered / failed / pending retry / exhausted*. Text and icon per state; failure reasons are generic ("push
  failed"), never vendor payloads.
- **Actions:** *Call* (tel: link from the tenant fallback number), *Open thread*, supervisor *Reassign* (4.9). No "retry" button for a human: the system retries.
- **A11y/PHI:** the state change is announced **assertively** once. Delivery log shows channel and outcome only.
- **Acceptance:** axe + keyboard; live: simulated push+SMS outage yields the supervisor item within the configured window (plan acceptance 4.5).

### 4.6 Notification policy, preferences and quiet hours (safety floor)

> Status: **partial, backend only** (ADR-0073 floor). The two web screens below are not built.

```
My notifications                      Organization policy (tighten-only)
Quiet hours  22:00–06:00 [on]         Floor (platform, locked) ─────────────
 Routine, mentions: silenced          🔒 Urgent clinical, Critical: always delivered
 Important: in-app only               Quiet hours may NOT suppress the locked rows
 🔒 Urgent clinical: delivered        Org may shorten ack deadlines   Urgent [15▾] max 30
Channels: Push [on] SMS [on] Email [ ]  Org may add routes, never remove
Vacation forward to [Dana K.▾]        [Save]   Last changed by … on …
```
- **Owner:** web `/messaging/preferences` (everyone) and `/messaging/policy` (tenant admin / clinical lead). The existing admin Notification preferences
  and Quiet hours screens stay as the platform-ops view and read the same endpoints; do not fork the logic.
- **States:** S0; *locked row* (🔒 + "Set by the platform; cannot be turned off"); *tighten-only violation* (server 409: "Cannot be looser than the
  platform maximum", field-level); *unsaved changes* guard.
- **Actions:** edit own preferences; the policy screen edits only values that may tighten and shows the platform maximum beside each; every save audited
  with before/after.
- **A11y/PHI:** switches are `role="switch"` with state text; the lock is text not just icon. Preview text uses synthetic copy only.
- **Acceptance:** axe + keyboard; live: quiet-hours test (routine suppressed, designated urgent still delivered); a loosening PATCH is refused by the DB trigger.
- **Sign-off:** the floor list and which classes may never be silenced — clinical lead.

### 4.7 Lock-screen privacy — template preview (proof screen)

> Status: **partial**: the guard and snapshot coverage shipped (ADR-0074); this proof screen did not.

Admin-only read screen listing every push, SMS and email template with a **synthetic** rendering and a green "No identifiers" check produced by the
same sanitiser test the snapshot suite uses. No tenant data is rendered. States: S0 only. A11y: table with captions. Acceptance: the preview and
the snapshot test read one template registry, so a template cannot be added without appearing here (`arch`-style test); live: none needed beyond the
snapshot test over every template (no name, MRN, diagnosis or free text).

### 4.8 Deep-link landing and push opt-in

> Status: **built (landing)** at `/n/:id` per ADR-0075; the route in the sketch below is superseded. Push opt-in and the iOS PWA hint: unverified.

```
Opening your message…            → signed out → sign-in → returns to the same link
Thread opens with the ack card focused (not the composer).
```
- **States:** S0 plus *signed out* (sign-in then resume, URL holds ids only), *message or request gone* ("This message is no longer available."),
  *step-up needed* (existing `requireStepUp`), *push permission denied* (explain in preferences, never nag), *push unsupported* (iOS Safari not
  installed as PWA: show how to add to Home Screen).
- **Actions:** cold start lands on the thread with `m=` scrolled into view and focus on the ack card's primary action.
- **A11y/PHI:** announce "Opened urgent message" politely; the push body is the generic text from 4.7.
- **Acceptance:** keyboard; Playwright cold-start link lands on the ack card after auth; live: foreign-tenant id returns the no-access panel.

### 4.9 Unacknowledged-urgent queue (supervisor) with escalation-ladder visualiser

> Status: **partial**. Built: the queue (flat list, restricted rows, narrowing-only filters, "Showing N of M", supervisor Reassign). Supervisor reassign is built (ADR-0078, `messaging.review`, `mode="supervisor"` dialog and the `supervisor-reassign` route). Not built: the ladder visualiser, detail panel, Call and take-over. Route and permission differ from the table: `/messaging/unacknowledged`, `messaging.review`.

```
┌ Safety queue ─ Unacknowledged ───────────────────── ● live  [Refresh] ┐
│ [All 7] [Overdue 2] [Pending 4] [Unreachable 1]   Shown 7 of 7 · Filters: none │
├────────────────────────────────────────┬───────────────────────────────┤
│ ⚠ Critical  J.B. · 84y · Team B   +03m │ Request #…4f2   Urgent clinical │
│ ⚠ Urgent    M.R. · 71y · Team A   +12m │ From Rita (RN) → Dana K. (RN)   │
│ ◔ Important T.K. · 90y · Team A  −40m │ Ladder:                         │
│ …                                     │  ●1 Dana K.   asked 14:05  ✓ opened │
│                                       │  ◐2 On-call RN  due 14:20       │
│                                       │  ○3 DON         due 14:25       │
│                                       │  ○4 Supervisor copy             │
│                                       │ [Open thread][Call][Reassign]   │
└────────────────────────────────────────┴───────────────────────────────┘
```
- **Pattern:** Work Queue + Right Detail Panel (`wx-work-queue`, `wx-work-split`, `wx-kpi-strip`). Sorted by class (Critical > Urgent > Important), then
  overdue-first, then oldest. A **"Shown N of M" line is always visible** and any active filter is a removable chip, so nothing is hidden by a filter
  (plan 4.9 acceptance). Rows never leave the list until `resolved`/`cancelled`; a taken request moves to "Taken in the last hour" for context.
- **Ladder visualiser:** vertical stepper in the detail panel (and read-only in the ack card): tier, who, state (*pending / opened / escalated / skipped /
  exhausted / unreachable*), due time in the **schedule's time zone** with the user's zone in `title`. Opened ≠ taken is drawn explicitly ("opened,
  not taken"). With the deny-stub the ladder shows "On-call roster not connected" instead of inventing names.
- **States:** S0 plus *ladder unavailable* (router `unavailable`/`coverage_gap`, shown as a warning with the telephone procedure), *no items* ("Nothing is
  waiting for a response" with last-checked time), *scope* (shows the supervisor's team scope in the header).
- **Actions:** open thread (audited read), call (tel:), **reassign as supervisor** (BUILT, ADR-0078, still needs clinical-lead sign-off) and **take over** (not built; brief §5). The shipped queue opens the G1 dialog in `mode="supervisor"`, which calls the separate `supervisor-reassign` route with a fixed reason code; a supervisor never "acknowledges" on a clinician's behalf.
- **A11y/PHI:** list is a `table` or `listbox` with row headers; arrow keys move, Enter opens, `r` reassign. Assertive announcer for each *new overdue*
  or *unreachable* item, once. Shipped rows show the requester name (`requester_display_name`) and `request_ref` (ADR-0078, open for Part 2 review), never diagnosis or message text; the initials/age-band/team form is the proposal.
- **Acceptance:** axe + keyboard; live: queue contains every pending/overdue item in the organisation (org-wide today; team scoping is a follow-up, THREAT_MODEL I-16); audit row on open;
  count equals ops-dashboard overdue metric. **Needs sign-off** for supervisor reassign and the visible scope.

### 4.10 Reminders and snooze

> Status: **built** (ADR-0077; paths in §3). Compare the shipped wording with the proposal below before treating any line as open.

Inline menu on a non-urgent notification or inbox row: *Remind me in 1 h / this afternoon / tomorrow 08:00*. For an urgent or ack-bound item the
control is present but **disabled with text**: "Urgent items can't be snoozed. Take responsibility or reassign." (never hidden, so the rule is visible).
A snooze never moves an urgent deadline. Digest: a switch in 4.6 "Daily summary of unread (no patient details)" (P2).
- **States:** S0; *snooze rejected* (server 409 → the text above); *snoozed* chip with end time and **Undo**.
- **A11y/PHI:** menu with `aria-haspopup`; announced "Snoozed until 08:00". Digest email has counts only.
- **Acceptance:** axe + keyboard; live: snooze on urgent returns 409 and writes nothing.

### 4.11 Fallback card and drill log

> Status: **partial**: the runbook exists; the screens do not.

`/messaging/fallback` (any staff, **cached for offline**): the agency telephone tree, who calls whom when push fails, the emergency-procedure line.
Content is tenant-authored, contains no patient data, and is the page the flag-off/unreachable states link to. `/messaging/governance/drills`
(clinical ops): quarterly drill checklist, date, participants (user ids), result, evidence link; list + "Record a drill" drawer.
- **States:** S0; fallback card must render from cache when offline with "Last updated" age; *never blank*: if the tenant has not set a number, show a
  platform warning to the admin and a plain "Ask your administrator" to staff.
- **A11y:** printable (`@media print`), high contrast, large type. **PHI:** none.
- **Acceptance:** axe + keyboard; offline render test; live: drill create is audited. Evidence = runbook `docs/runbooks/messaging-escalation-fallback.md`.

### 4.12 (proposed) On-call "who is covering now" directory with role-based send

```
On call now (Team A)  as of 14:07 (America/Los_Angeles)    [Role ▾ RN]
 RN        Dana K.   until 19:00   ● available     [Message] [Urgent…]
 Physician Dr. Mehta until 08:00   ◐ on a visit     [Message] [Urgent…]
 Backup    Sam T.    tier 2        ○ not paged yet
 Next shift change 19:00 → Priya N.
```
- **Purpose:** answer "who do I call right now" and let a sender address a **role** ("on-call RN"), resolved by the server at send time, not a stale name.
  Role-based send is the missing half of WP 4.3 (recipient is a named person today). The sender sees the resolved name and **confirms** it before an urgent
  send (hazard H-02), and the stored request keeps the resolved person and the role.
- **States:** S0 plus *roster not connected* (deny-stub), *coverage gap* ("No one is rostered. Use the agency procedure." with call link), *stale*
  (older than 60 s: refresh then disable send), *shift changes mid-compose* (re-resolve on send; if the person changed, require re-confirm).
- **A11y/PHI:** table with a time-zone caption; availability by text and icon. Shows staff and roles only; no patient data on this screen.
- **Acceptance:** axe + keyboard; live: shift-boundary and DST cases through the real router. **Blockers:** a real M19 router and a named M19 owner
  ([`brief-m19-owner.md`](./brief-m19-owner.md)); an ADR for role recipients; clinical-lead sign-off on who may be addressed by role.

## 6. Phase 5 screens

### 5.1 Offline drafts and optimistic send (outbox)

```
Thread (offline)  ⚠ You are offline. Messages are saved on this device and sent when you reconnect.
 You: Will visit at 3         ◔ Not sent · saved on this device   [Retry] [Delete]
 Composer: [Message…]                       Draft: Saved on this device only
```
- **Rule:** an offline message is **never** shown as sent, delivered or read. States, in order: *Draft → Not sent (queued) → Sending → Sent → Failed (retry)*;
  text and icon each. Reuse the existing `use-outbox` and `client_message_id` (replay returns the original, so no duplicate).
- **Never queued offline:** urgent clinical, "Needs a response", acknowledge, take responsibility, reassign. Their controls are disabled with "Needs a
  connection. Use the agency telephone procedure." (a queued urgent message that arrives late is a hazard).
- **Storage:** IndexedDB, encrypted with a key held only for the session; cleared on sign-out, session revoke, and tenant switch (existing sign-out
  reset tests must still pass). Bodies of PHI threads are not persisted for read-only offline viewing in v1.
- **States:** S0; *storage unavailable* (private window): warn that drafts are memory-only; *quota full*; *conflict on reconnect* (existing
  `draft-conflict-prompt`).
- **A11y:** the offline banner is `role="status"`; each Not-sent row exposes Retry/Delete by keyboard.
- **Acceptance:** axe + keyboard; Playwright offline→online soak with flapping network: no loss, no duplicate, never shown delivered; live: replay with the same key = one row.

### 5.2 Reconnect sync

A small status chip in the thread header: *Live*, *Catching up…*, *Paused (refreshing every N s)*. On resume, `?after=` cursor delta merges messages, read
state, drafts and ack-card state; a gap in the cursor shows an inline "Some messages may be missing. Reload" row, never silently. States: S0 plus
*cursor too old* (reload thread). Announcer: polite "3 new messages". Acceptance: flapping-network soak, no gaps/duplicates; focus not stolen on merge.

### 5.3 Camera attachment

Composer 📷 button (shown only where `capture` is supported) opens the device camera via `<input type="file" accept="image/*" capture="environment">`;
preview with **Retake / Use photo**; upload goes through the same scan pipeline, the photo is **hidden to others until `clean`**, EXIF (location, device)
is stripped server-side and the preview says "Location data is removed". States: S0 plus *camera denied/unavailable* (falls back to file picker),
*too large*, *scanning* (existing attachment states), *quarantined*. Acceptance: phone photo passes scan and appears only after `clean`; EXIF absent in the stored object.

### 5.4 Responsive, touch and accessibility evidence

```
< 768 px: one pane              768–1279: inbox + thread          ≥ 1280: three panes
┌ ‹ Back  Team A ⋮┐             context = right slide-over
│ messages        │             ack / handoff / safety queue use full-height sheets on phone
│ [composer docked]│            Safety queue row = 1 column card, actions in a bottom sheet
└─────────────────┘
```
Every screen in this file is built at 360, 768 and 1280 px. Targets ≥ 44 px; composer docked above the keyboard (visual-viewport); sheets have a visible
Close; no hover-only affordance; pinch-zoom allowed. Evidence kept per phase: axe report, the keyboard script, the VoiceOver/NVDA script, a 200 % text and
320 px reflow screenshot set, and a measured target-size table (closes [`09` §C](./09-ui-gap-register.md)).

### 5.5 Device and session manager (with remote lockout and app lock)

```
Devices and sessions                                  [Sign out everywhere else]
 This device   Chrome · macOS     active now      (current)
 iPhone        Safari PWA         3 h ago   Push ✓   [Revoke]
 Pixel 7       Chrome Android     12 d ago  Push ✓   [Revoke]
 App lock: [PIN or biometric after 2 min idle ▾]  (tenant minimum: 5 min)
```
- **Owner:** self-service page for every user; `/messaging/governance/sessions` lets a security officer list and revoke **any user's** sessions (audited, step-up).
- **Revoke** kills the session, closes the socket, expires the push endpoint; next REST call is 401 (plan 5.5). "Remote lockout" in the admin variant is the
  same action plus a "sign out everywhere" for a lost device.
- **App lock:** device-local PIN/biometric screen after idle, tenant sets the **maximum** idle time (tighten-only). The lock screen shows no PHI.
- **States:** S0 plus *revoking* (row disabled, spinner text), *revoke failed* (stays listed), *current device* (revoking asks to confirm sign-out).
- **A11y:** each Revoke names its device; confirm dialog; announce "Pixel 7 revoked". **PHI:** device names are user-agent summaries, no IP in UI beyond coarse region.
- **Acceptance:** axe + keyboard; live: revoked session gets 401, socket closed, endpoint expired (plan 5.5 acceptance).

### 5.6 Retention and legal-hold admin

Two tabs: **Retention** (per message class: current period, source policy, next plan-only scan date, "N messages eligible", plan-only until a human
approves) and **Legal holds** (hold name, scope channel/patient/user, placed by, date, reason, **Release**). A hold is an **overlay** (ADR-0051), not a
class change. Creating/releasing a hold needs reason text and step-up; release shows what becomes eligible ("412 messages will become eligible on the
next scan") and requires a second confirmation. Held messages show a "Legal hold" chip to authorized viewers only. States: S0 plus *scan running*,
*destruction certificate available* (link to the M4 certificate, ids only). Never shows message content. Acceptance: axe + keyboard; live: a held message survives the scan; release restores
eligibility; both audited. **Needs:** ADR for message retention classes; compliance sign-off.

### 5.7 Export request and approval

```
Requests │ Awaiting my approval (2) │ Ready
 New request: Scope [channel ▾ / patient ▾]  Dates [..]  Reason [..]  Format [PDF/JSON]  [Request]
 #31 Team A thread   requested by Priya   [Approve] [Deny]   (you cannot approve your own)
 #29 Ready · expires in 47 h · encrypted · [Download (step-up)]    [Revoke]
```
- Requester ≠ approver, enforced server-side; the default role set cannot request (ADR/matrix: "limited / approved"). The artefact is encrypted, the link
  expires (default 48 h), download needs step-up and is audited; revoke kills the link. The screen never previews content.
- **States:** S0 plus *awaiting approval*, *building* (progress text, not a spinner only), *failed* (retry creates a new job), *expired*, *denied (reason shown)*,
  *self-approval blocked* (explanatory text, button absent).
- **A11y:** approve/deny buttons name the request; download link states size and expiry. **PHI:** the request list shows scope kind and ids, not names.
- **Acceptance:** axe + keyboard; live: unapproved export blocked, artefact auto-expires, requester cannot approve. **Needs:** compliance sign-off; ADR for the export artefact format.

### 5.8 Break-glass request and review queue

```
(1) Request — from a "You do not have access" screen the user is ELIGIBLE for (no title shown)
    Reason [required, ≥ 20 chars]  Scope: this conversation  Duration [30 min ▾ max 60]  [Request access]
(2) Active banner:  ⚠ Break-glass access to this conversation ends 15:42. Every read is recorded. [End now]
(3) Review queue (compliance):  # · user · scope · reason · reads (n) · status [Open ▸ Reviewed ✓ / Concern ⚑]
```
- Self-approved at request time but **time-boxed, scoped to one channel or patient, and always followed by a review item**. The banner is persistent and
  cannot be dismissed. The review detail lists each audited read (ids, times), never message bodies unless the reviewer is separately authorized.
- **States:** S0 plus *not eligible* (no button, no hint), *grant expired* (access ends mid-read: page falls back to no-access without losing the user's unsaved composer text, which is discarded not sent),
  *review overdue* (badge on the compliance nav).
- **A11y:** the banner is `role="status"`; countdown is text, updated at most every minute (no 1 s live-region chatter). Expiry announced politely.
- **Acceptance:** axe + keyboard; live: grant expires, each read audited and queued, admin gets no implicit access. **Needs:** compliance + clinical-lead sign-off on eligible roles (matrix: "conditional").

### 5.9 Offboarding workflow

```
Offboarding: Alex P. (RN) · deactivated 14:02             Done 5 of 9
 ✓ Sessions & devices revoked (3)            ✓ Channel memberships ended (12)
 ▢ Open escalations owned (2)  [Reassign…]   ▢ Handoffs offered/received (1) [Reassign…]
 ▢ Open communication tasks (4) [Reassign all…]  ▢ Review items raised (0)
 Attribution is kept. Messages are never deleted.        [Mark complete — blocked until zero owned urgent items]
```
- Opened from the identity deactivation (M2) or the lifecycle review queue. Each row opens the same reassign dialogs (G1, tasks, handoffs). **An open
  urgent or ack item cannot be left ownerless**: Complete is disabled with the count and reason. A bulk reassign picks one qualified colleague or a
  supervisor queue.
- **States:** S0 plus *partial failure* (per-row errors, retry row), *already complete*, *user not offboarded* (no access to this page for an active user).
- **A11y:** checklist with `aria-checked` text; progress "5 of 9" as text. **PHI:** shows counts and ids; opening an item is an audited read.
- **Acceptance:** axe + keyboard; live: Workflow F ([`05`](./05-clinical-workflows-and-safety.md)) end to end; offboarding never deletes messages.

### 5.10 Recovery rehearsal report (platform)

Read-only admin page: last N rehearsals, RPO/RTO measured vs target, message ↔ attachment ↔ audit reconciliation counts, mismatches listed by id. States:
S0 plus *never run* (a warning, since the evidence is a release gate). No content, no PHI. Acceptance: axe; the page renders a seeded run from the real
drill output.

## 7. Phase 6 screens (all behind per-tenant flags)

### 6.1 Smart work inbox

```
My work                          Why this order? ▸
 1 ⚠ Needs your response   Urgent · due 14:20      (rule 1: open urgent assigned to me)
 2 ◔ Handoff to accept     2 items · from Rita     (rule 3)
 3 ☑ Task due today        Call family             (rule 4)
 4 @ Mentioned             Team A                   (rule 5)
 5 ● Unread care team      3 conversations          (rule 6)
```
- **Deterministic and explainable:** fixed ranking rules, numbered and shown in the "Why this order?" drawer and as a per-row reason; no ML. Order:
  (1) open urgent/important assigned to me or escalated to me, overdue first; (2) overdue tasks; (3) handoffs awaiting me; (4) tasks due today;
  (5) mentions; (6) unread care-team threads. **Urgent is pinned above any filter, sort or search** and cannot be collapsed.
- **States:** S0 plus *inbox zero* ("You're all caught up") only when server-confirmed; *a source failed* (that section shows its own error with retry;
  the others still render, so one failing source never hides urgent items).
- **A11y:** one ordered list, rows with the rule name in `wx-sr-only`; announcer for a new top item. **PHI:** same as 4.9.
- **Acceptance:** axe + keyboard; unit test fixes the ordering; live: urgent never absent when any source errors.

### 6.2 Response analytics

KPI strip (median acknowledgment time, % acknowledged before deadline, escalation rate, handoff acceptance time) and breakdowns by **team, shift,
class and discipline-group** over a date range, via M33. **Aggregates only, no message content, minimum cell size 5** (smaller cells show "fewer than 5").
No per-person view in v1: individual analysis needs HR/compliance review and its own permission. States: S0 plus *insufficient data*, *report building*. A11y: every chart has a
table twin; not colour alone. Acceptance: axe + keyboard; live: a viewer without `messaging.analytics.read` gets 403; suppression of small cells.
**Needs sign-off:** compliance/HR on any individual-level reporting (the plan already forbids it by default).

### 6.3 Voice notes and dictation

Composer 🎙 → **Record / Pause / Stop / Listen / Discard / Attach**. A voice note is an attachment (same scan, retention, audit, no preview in
push). Dictation fills the composer as a **draft** the user must edit and send; nothing is sent by voice alone. States: S0 plus *microphone denied*,
*recording* (visible timer, `role="timer"` not announced each second), *too long* (limit shown), *uploading/scanning*, *transcript pending* (optional).
A11y: all controls keyboard operable; recording is also indicated in text. PHI: the "Dictation sends audio to the speech service" notice is shown
once and per policy; audio never goes to a non-BAA service. **Needs:** ADR for the dictation PHI boundary (M32 or browser speech) and retention class.

### 6.4 Language and template translation

User language in preferences; UI strings from i18n keys; where a string or template is missing, show English with a visible **EN** tag (not silent).
Template translations carry reviewer and date; unreviewed translations are labelled "Not clinician-reviewed" and **never auto-applied to clinical
content**. No machine translation of message bodies unless a tenant flag and a visible "Machine translated, check original" label. Acceptance: axe (lang
attribute per segment, 3.1.2); missing-key fallback test. **Needs:** clinician reviewer sign-off.

### 6.5 AI summary panel (M32)

```
┌ AI summary · draft · not verified ──────────────────── [✕] ┐
│ • Pain reported uncontrolled since morning [1][4]            │
│ • Family asked for a call today [2]                          │
│ ⚠ Unclear from the messages: whether PRN was given.          │
│ Sources: [1] Rita 09:12  [2] Dana 10:01 … (click to jump)    │
│ [Copy to draft]  [Regenerate]  [Not useful]   Based on 28 messages you can see │
└──────────────────────────────────────────────────────────────┘
```
- **Guardrails shown in the UI:** label "AI-generated draft. It can be wrong. It is not a chart note and does not send, order or change anything." Every
  bullet cites source messages; an **uncertainty** line is mandatory; input is limited to the messages the user is authorized to see; every call is
  an `ai_interaction` row; output is never auto-posted. "Copy to draft" puts text in the composer for the human to edit and send. No "send", no "create
  task" in the panel.
- **States:** S0 plus *generating* (skeleton, cancel), *AI unavailable*, *too little to summarise*, *flag off / tenant has no BAA environment* (panel absent).
- **A11y:** panel is a `complementary` region; citations are links with the source author/time; generation completion announced politely.
- **Acceptance:** axe + keyboard; live: AI cannot send/order/write a chart record; `ai_interaction` row lands; out-of-scope messages never included.
  **Needs:** clinical-lead and compliance review of each AI capability; ADR for M32 data boundary.

### 6.6 External partner share

Share dialog on a conversation: Partner (pharmacy/DME from the directory) · scope = **this conversation only** · expiry (default 7 d, max 30) · what the
partner can do (read / reply). Management page lists shares with **Revoke now**. The partner sees only shared conversations through a separate,
minimal partner view (M31/M29 portal patterns): one-time link, second factor, **no PHI in the invitation** (generic text only), banner "You can only see
what was shared with you." States: S0 plus *share expired*, *revoked* (partner view instantly shows "Access ended"), *partner not verified*. A11y: dialog
names the partner and expiry in its confirm button. Acceptance: axe + keyboard; live: partner reads nothing outside scope; revocation is immediate on
the next request. **Needs:** ADR, BAA/legal review, clinical-lead sign-off on what may be shared.

## 8. Exceeding TigerConnect

> **Caution on the comparison.** The "TigerConnect" column is based on publicly marketed capability names as we understand them. It is
> **vendor marketing, unverified**: no hands-on evaluation, contract, or independent source was used. Re-verify each row before any claim leaves this document.
> "Parity target" is what we need so a TigerConnect user is not worse off; the next column is what a hospice-native system adds. Priorities: P0 safety-critical,
> P1 mature launch, P2 later, P3 watch. WPs not in [`04`](./04-phases-4-to-6.md) are **proposed** and need adding there.

| Area | TigerConnect (marketing, unverified) | Parity target | Hospice-specific advantage we add | Pri | WP |
|---|---|---|---|---|---|
| Role-based messaging | Message a role or on-call person, not a phone | Address "on-call RN" and get a person | Server resolves at send time with schedule zone, **sender confirms the resolved person**, request stores role + person; coverage gap is explicit, never silent | P0 | 4.3 (built seam) + **4.12** |
| Priority alerts | Priority levels with distinct alerting | Routine / important / urgent / Critical, distinct tone | **Closed-loop acknowledgment with audit**: opened ≠ taken; aide = receipt only; permanent "not the emergency path" | P0 | 4.1, 4.2 (built), G1, G2 |
| Escalation | Auto-escalate unanswered alerts | Timed tier escalation, backup routing | Visible **ladder visualiser**, supervisor queue with "shown N of M", `failed_unreachable`, restart-safe timers, exactly-once | P0 | 4.4 (built), 4.5, 4.9 |
| Scheduling | On-call schedules integrated | Read M19 roster | Honest "who covers now" with shift/time-zone correctness; **after-hours triage line routing** into M19 `triage_call` | P0 | **4.12**, **4.13** |
| Alarm management | Clinical alarm/event routing from devices | Receive system events as alerts | Hospice has little bedside telemetry: P3. Reuse the alert catalog for M-module events; ingest of third-party alarms only on a real customer need | P3 | **6.10** (watch) |
| Patient engagement | Secure patient/family messaging | Family can reach the team | **Family/caregiver secure messaging with no app** (one-time link + code, no PHI in SMS/email), routed to the care team; bereavement channel kept after death | P1 | **6.7** |
| Admin console, LDAP/SAML, PIN, remote lockout | Directory sync, SSO, PIN lock, remote wipe | Central identity, app lock, revoke a lost device | Identity stays M2/M34 (SAML/OIDC via the platform, not a second directory); **tenant-set tighten-only app lock**; revoke kills socket + endpoint; offboarding never leaves an urgent item ownerless | P1 | 5.5, 5.9 (+ M2 SSO, out of scope here) |
| Archive / export | Retention policies, eDiscovery export | Retention, legal hold, export | Hold as an **overlay**, two-person export, expiring encrypted artefact, destruction certificates (M4), break-glass with mandatory post-review | P1 | 5.6, 5.7, 5.8 |
| Self-destruct / message expiry | Messages auto-delete after a time | — (we decline for clinical content) | **Retention-governed, never ephemeral**: clinical messages cannot self-destruct; only drafts and non-clinical items may expire. Compliance decision | P2 | ADR (no WP) |
| Broadcast | Mass notifications | Announcements with read tracking | **Acknowledge-required broadcast** (e.g. policy change, weather closure) with a who-has-not-read list for supervisors | P2 | **6.8** (extends TC-08) |
| Video / voice | Voice and video calling | Voice notes; click-to-call | Voice notes follow clinical-attachment rules; click-to-call from the on-call directory; video link-out only to an approved BAA service | P2 | 6.3 |
| Native mobile | iOS/Android apps | Push, deep link, offline drafts | PWA first, **offline-safe: never falsely delivered**, urgent never queued; native push and biometric lock via the separate Expo app of ADR-0072 (not a PWA wrapper) | P1 | 4.8, 5.1, **5.11** |
| Analytics | Usage and response reports | Ack latency, escalation rate | Aggregates only, minimum cell size, no individual ranking by default; **deterministic explainable work inbox** | P2 | 6.1, 6.2 |

**Further hospice-native advantages (not in TigerConnect's marketing list, as we read it):** IDG and handoff accountability (per-item accept; sender
keeps accountability until accepted); tighten-only safety floors that no tenant or user can turn off; death/discharge/transfer lifecycle rules that
move open items to a supervisor (Workflow E, built) plus a **death-event coordination board** (**6.9**: the checklist thread for pronouncement
calls, family notification, equipment pickup, bereavement referral, each owned and acknowledged); messaging never becomes the order or the record
(promotion is explicit, orders go to M11/M12).

## 9. Sign-off and ADR flags

| Item | Needs | Why |
|---|---|---|
| Reassign limits; supervisor override and take-over (G1, 4.9) | Clinical lead | Open in brief §3 and §5 |
| Safety-floor list and locked quiet-hours rows (4.6) | Clinical lead | Decides what can never be silenced |
| Role-based recipients and who may address a role (4.12) | Clinical lead + **new ADR** + M19 owner | Not built; changes who is paged |
| Message retention classes and legal-hold overlay (5.6) | **New ADR** (ADR-0051 pattern) + compliance | Plan 02 §8 |
| Export format and approval roles (5.7) | Compliance + **new ADR** | |
| Break-glass eligibility, durations, review SLA (5.8) | Compliance + clinical lead | Matrix says "conditional" |
| App-lock minimums and device policy (5.5) | Security architect | |
| Dictation PHI boundary and voice retention (6.3) | **New ADR** (M32) + compliance | |
| Machine translation of clinical content (6.4) | Clinical lead | Off by default |
| AI summaries and drafting (6.5) | Clinical lead + compliance + **new ADR** | Hazard H-08 |
| External partner share (6.6) | Legal (BAA) + clinical lead + **new ADR** | |
| Family/caregiver messaging without an app (6.7) | Privacy officer + **new ADR** | New outbound surface |
| Native push and biometric lock (5.11) | Reconcile with [ADR-0072](../adr/ADR-0072-separate-react-native-expo-mobile-app.md) (separate React Native/Expo app, status Proposed) | 5.11 was first written as a PWA shell; it must not contradict that ADR |
| Self-destruct decision (§8) | Compliance | We recommend declining for clinical content |
| Individual-level analytics (6.2) | HR/compliance | Forbidden by default |

## 10. Build order suggestion

1. Remaining safety-loop work: G2, the 4.9 ladder visualiser, the 4.5 attempts log; then the 4.6 web screens, the 4.7 preview and the 4.11 screens. (G1, 4.8, 4.10 and the 4.9 queue are built.)
2. 4.12/4.13 as soon as an M19 owner is named.
3. 5.1–5.4 with 5.5; then 5.6–5.9 as one governance group; 5.10 last.
4. Phase 6 per tenant demand; 6.7 and 6.8 first because they extend built surfaces.

Batch the pushes (CLAUDE.md): one group per push, `/ecc:code-review` on the branch diff, `/ecc:react-review` for `apps/web`/`apps/admin`, and
`/ecc:security-scan` for the governance, session and break-glass screens.
