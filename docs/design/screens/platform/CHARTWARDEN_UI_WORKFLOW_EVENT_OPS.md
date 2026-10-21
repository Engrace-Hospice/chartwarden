# CHARTWARDEN_UI_WORKFLOW_EVENT_OPS

Version: 1.0
Status: Screen Specification
Module: FOUNDATION (M01)

---

## Purpose

Workflow & Event Ops is the internal-operator view of the platform's workflow/event spine:
the workflow transition log (entity state transitions, invariants checked, idempotency keys),
the domain-event outbox monitor (pending / published / failed with retry), the job-queue
(BullMQ) dashboard, and cache (Valkey) status. It is where an operator confirms the spine is
flowing — events draining, jobs processing, no poison messages stuck — and intervenes when it
is not. ChartWarden-internal surface; not tenant-facing.

---

## Primary Users

- ChartWarden Ops / SRE
- Platform Engineer
- On-Call Engineer

---

## Layout Pattern

Use Status Board.

```text
Status Header (spine health · pending backlog · failed count)
Spine Card grid (Transitions · Outbox · Job Queue · Cache)
Transition Log  +  Outbox Monitor
Operational Controls (retry · drain · purge)
```

---

## Spine Cards

- Workflow Transitions (rate, blocked count)
- Domain-Event Outbox (pending / published / failed)
- Job Queue / BullMQ (depth, active, failed)
- Cache / Valkey (hit rate, memory, pub/sub)

---

## Workflow Transition Log

Recent entity transitions across modules: entity type + id, `from → to` state, the invariants
checked at the boundary (pass/fail), the idempotency key, actor, and timestamp. Failed-invariant
transitions are highlighted with the blocking rule. Idempotent replays are marked as such (no
duplicate effect).

---

## Domain-Event Outbox Monitor

Outbox rows by event type (`mN.*` catalog convention): status `pending`, `dispatching`, `dispatched`,
`failed`, with publish attempt count, next-retry, and last error. Operators can retry a row,
retry-all-failed, or move a poison event to a dead-letter holding area *(target-state — the
shipped ops surface is two read-only routes)*. Ordering and
at-least-once delivery semantics are visible (sequence per aggregate).

---

## Job Queue (BullMQ)

Per-queue depth: `waiting`, `active`, `delayed`, `completed`, `failed`. Failed-job error log
with stack-trace excerpt, retry/backoff state, and per-job retry / remove / drain controls.
Worker concurrency and throughput sparkline per queue.

---

## Cache (Valkey)

Hit / miss rate, memory pressure, evictions, connected clients, and pub/sub channel activity
(plus any list-backed queue depth riding on Valkey). Surfaces degraded cache as a status so
fallbacks (cache-miss read paths) are explained, not mysterious.

---

## Statuses

- Spine: `Healthy`, `Degraded`, `Backlogged`, `Stalled`
- Outbox event: `pending`, `dispatching`, `dispatched`, `failed` (the shipped `outbox_status` enum — there is no published or dead-letter state)
- Job: `Waiting`, `Active`, `Delayed`, `Completed`, `Failed`
- Cache: `Operational`, `Degraded`, `Unavailable`

---

## Edit Rules & Sensitive Data

- This is an infrastructure surface — payloads are referenced by id/type, not rendered; any
  PHI within an event body is never displayed here.
- Retry / drain / purge / dead-letter are audited operator actions *(target — none of these endpoints exist yet)*; purge requires confirmation
  and is irreversible.
- Idempotency keys are shown to prove replays are safe; manual replay respects them.
- Access is restricted to platform-operator roles; no tenant context leaks across rows.

---

## Empty State

"Spine healthy — nothing pending." Per-card: "No blocked transitions" / "Outbox drained" /
"No failed jobs" / "Cache nominal."

---

## Actions

- Retry event · retry all failed · dead-letter event *(target — not yet built)*
- Retry / remove / drain job · pause / resume queue
- Inspect transition (invariants · idempotency key)
- Flush / inspect cache key · refresh metrics
- Export spine snapshot

---

## Pencil Notes

Create versions for:

- Spine status board (four cards)
- Workflow transition log (invariants · idempotency)
- Outbox monitor (pending / published / failed + retry)
- Job-queue dashboard (depth · failed-job error log)
- Cache status (hit rate · pub/sub · queue depth)
