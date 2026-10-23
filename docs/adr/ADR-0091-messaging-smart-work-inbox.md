# ADR-0091 — Messaging smart work inbox: one read-only, deterministically ranked queue of the caller's own work

- **Status:** **Proposed** (2026-10-23). Built behind the tenant flag `messaging.smart_inbox` (default off). Decisions D1 to D8 are the build team's defaults; the clinical lead has not confirmed the band order or the handoff "expiring soon" threshold.
- **Date:** 2026-10-23
- **Phase:** Messaging Hub Phase 6, WP 6.1.
- **Related:** [ADR-0076](ADR-0076-messaging-unacknowledged-queue.md) (the unacknowledged queue this reads, narrowed to the assignee), [ADR-0061](ADR-0061-messaging-communication-tasks.md) (tasks), [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (handoffs), [ADR-0010](ADR-0010-tenancy-rls-invariants.md).

## Context

A clinician's waiting work in M36 lives on four screens: acknowledgment requests, tasks, handoffs and the conversation list with unread and mention counts. WP 6.1 asks for one queue: "unacknowledged urgent, assigned tasks, handoffs awaiting me, mentions, unread care-team", with the guardrail "ranking is deterministic and explainable (no ML needed); urgent never buried".

## Decision (proposed)

1. **D1: read-only aggregation, no table.** `GET /api/v1/messaging/inbox` (`messaging.read`) composes the sources M36 already owns. No migration, no write, no event, nothing is acknowledged, accepted or completed by looking. Each row names the surface that owns the item; the inbox has no action button.
2. **D2: sources are reused, not re-queried.** Urgent: the ADR-0076 service, with a service-level `assignedUserId` filter (added to the reader's `queueFilters`; the supervisor route does not expose it, so the supervisor view and its permission are unchanged). Handoffs: `handoffService.list(incoming, active)`, only offers the caller may accept. Tasks: `taskService.list(assigned, active)`. Mentions and unread: the channel list's `unreadCount` / `mentionCount` (the same authorized, read-receipt based figures the conversation list shows). Tasks and handoffs honour their own tenant flags (`messaging.tasks`, `messaging.handoffs`): off means no rows, so the inbox never shows what the owning screen hides.
3. **D3: fixed ranking.** The sort key is (band, sub-rank, time, row key): bands in this order: `urgent_ack`, `handoff_awaiting`, `task_assigned`, `mention`, `care_team_unread`. Inside urgent: unreachable (no route reached anyone), then overdue (longest overdue first), then waiting by deadline. Handoffs: expiring within 60 minutes first, then by expiry. Tasks: overdue, clinical concern, due, open; then by due time. Conversations: most recent activity first; a conversation appears once, as a mention when it has an unread mention. The key makes the order total, so identical inputs give an identical list in any input order. There are no weights, so volume in a lower band can never out-rank a higher band.
4. **D4: every row says why.** Each row carries `reasons[]` (a stable code and a plain sentence the web shows verbatim) and its `rank`. The web never re-ranks.
5. **D5: urgent is never buried or cut.** `limit` (default 50, max 100) applies below the urgent band only; every urgent row returned by the source is kept. `band_counts` cover the whole list. Because the urgent source is the ADR-0076 page (up to 100 rows), `urgent_complete=false` is reported when it could not return all of them, and the web says so and points at the acknowledgment queue.
6. **D6: failure is visible.** A source that fails to read is named in `unavailable_sources` and the rest still show; an unreadable urgent source also clears `urgent_complete`. The web never renders "nothing is waiting" for a failed read. An unreadable flag reads as off.
7. **D7: privacy.** Titles are generic, rows carry ids and instants only, never message text or a patient name (the live suite asserts this). A request in a conversation the caller cannot open stays in the list as a restricted row with no request, channel or message id, exactly as ADR-0076 does. Only the caller's own work is read: there is no org-wide read here. Read-audit is recorded as a list read (`smart_inbox`).
8. **D8: flag.** The ops flag `messaging.smart_inbox` (tenant row wins; absent = off), read through the platform flag reader and cached a few seconds per organisation like its siblings. Off answers `200 {enabled:false}` with no source read, so the web shows "not turned on". It is added to the demo seed's flag list only (`scripts/db/seed-messaging-flags.ts`); a real tenant's flag is set through the platform admin API.

## Consequences

- No schema change and no new permission. The cost is one extra bounded read per source per open (and per 15 s poll of the screen); the channel list already decrypts last-message previews for the conversation list, and the inbox discards them. A leaner unread-only reader is the follow-up if this shows up in profiling.
- Mentions are the unread mention count of a conversation, not a per-message list.
- Only `care_team` conversations enter as unread work. DMs, announcements and department channels do not (provisional; the clinical lead decides).

## Not decided / provisional

The band order, the 60-minute handoff threshold, whether DMs count as unread work, and deep links: the web rows open `/messaging`, because the conversation, task and handoff screens have no URL that selects an item yet.
