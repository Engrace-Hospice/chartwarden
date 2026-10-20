-- M19 WP 4.13 slice S2 (ADR-0082 decision 4, PROPOSED, flag-off) - the durable "this request was already decided" record.
--
-- Why a table: the relay writes its consumer receipt AFTER the handler returns, in a separate transaction (at-least-once), so a crash in
-- between redelivers `m36.afterhours_triage.requested`. For `opened` the guard is `triage_call_source_dedupe_uq`; `coalesced` and
-- `no_coverage` write no call row, so a replay re-decided against facts that had moved: a second outcome, a second `coverage_gap`, or
-- (coalesce target closed meanwhile) a new call answered `opened`, contradicting the first outcome. M19 may not read `outbox_event`
-- (arch:tables), so the decision is recorded in an M19-owned row written in the SAME transaction as the decision and its outcome event.
--   * source_outbox_event_id is UNIQUE: one decision per request event (org-scoped read keeps it tenant-safe; the id is deployment-unique);
--   * triage_call_id is set only for opened / coalesced (CHECK), no FK (the call may later be erased; this row carries ids only);
--   * ids, one closed outcome and an instant only: no text, no patient id, no name.
-- Isolation: org policy on organization_id (ADR-0010; the 1132 shape), ENABLE + FORCE; the app role may SELECT and INSERT, never UPDATE or DELETE.
CREATE TABLE "triage_afterhours_decision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "source_outbox_event_id" uuid NOT NULL,
  "triage_call_id" uuid,
  "outcome" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "triage_afterhours_decision_event_uq" UNIQUE ("source_outbox_event_id"),
  CONSTRAINT "triage_afterhours_decision_outcome" CHECK ("outcome" IN ('opened', 'coalesced', 'no_coverage')),
  CONSTRAINT "triage_afterhours_decision_call" CHECK (
    ("outcome" IN ('opened', 'coalesced') AND "triage_call_id" IS NOT NULL)
    OR ("outcome" = 'no_coverage' AND "triage_call_id" IS NULL))
);--> statement-breakpoint

-- FK-index coverage (test:fk-indexes:live): the organization FK leads an index.
CREATE INDEX "triage_afterhours_decision_org_idx" ON "triage_afterhours_decision" ("organization_id");--> statement-breakpoint

ALTER TABLE "triage_afterhours_decision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "triage_afterhours_decision" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "triage_afterhours_decision_org_isolation" ON "triage_afterhours_decision"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "triage_afterhours_decision" TO wardenx_app;--> statement-breakpoint

CREATE TRIGGER "trg_audit_triage_afterhours_decision" AFTER INSERT OR UPDATE OR DELETE ON triage_afterhours_decision
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

GRANT SELECT, DELETE ON "triage_afterhours_decision" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "triage_afterhours_decision_destruction" ON "triage_afterhours_decision"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
