-- 0154 — TASK-006 (production-readiness audit 2026-08-03, OPS-001): the transactional-outbox
-- DISPATCHER lands. `outbox_event` rows were written by every module's catalog publisher and then
-- never left the table — nothing polled, so cross-module consumers starved silently. The dispatcher
-- needs an explicit retry clock: `next_attempt_at` carries the exponential-backoff eligibility
-- instant (NULL = eligible immediately), so a failing event backs off without overloading
-- `dispatched_at` (which keeps its documented meaning: the SUCCESS instant).
--
-- Forward-only (never edit an applied migration). Idempotent guards so a replay is safe.

ALTER TABLE outbox_event
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- The relay's poll predicate: pending + due. Partial index keeps it tight on a hot table.
CREATE INDEX IF NOT EXISTS outbox_pending_due_idx
  ON outbox_event (next_attempt_at, created_at)
  WHERE status = 'pending';
