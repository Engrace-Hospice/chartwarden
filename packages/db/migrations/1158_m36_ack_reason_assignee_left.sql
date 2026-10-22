-- M36 workforce offboarding (ADR-0084, open decision 6) - a dedicated ack-history reason code `assignee_left_organisation`.
-- The offboarding reassign used the closest existing code (`assignee_unable_to_sign_in`); the history now says what happened. Same CHECK
-- as migration 1126 plus one value; no new column, table or grant. Existing rows keep their code (a widened set accepts every old value).

ALTER TABLE "message_acknowledgment_event" DROP CONSTRAINT "message_ack_event_reason_code";--> statement-breakpoint
ALTER TABLE "message_acknowledgment_event" ADD CONSTRAINT "message_ack_event_reason_code"
  CHECK ("reason_code" IS NULL OR (
    "event_type" = 'reassigned' AND "actor_kind" = 'user' AND "reason_code" IN
      ('assignee_unreachable', 'assignee_unable_to_sign_in', 'assignee_off_shift', 'coverage_change', 'workload', 'other_operational',
       'assignee_left_organisation')));
