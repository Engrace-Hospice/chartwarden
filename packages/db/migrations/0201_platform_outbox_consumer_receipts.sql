-- M1 §3.10 (GAP-099) — the per-consumer completion RECEIPT path for platform-wide
-- (`organization_id IS NULL`) outbox events.
--
-- WHAT WAS MISSING. Migration 0186 gave the platform-wide outbox row a full write/claim/finalize path
-- (`report_writer_*`), and the dispatcher's `pollPlatform()` uses it — but only to claim a row and put it
-- straight back down as `deferred`. It could never DELIVER a platform event to a consumer, because
-- delivery needs the §4.11 `(event_id, consumer_name)` receipt to be readable and writable for a row whose
-- `organization_id` is NULL, and `outbox_consumer_receipt` had `organization_id` NOT NULL under a policy
-- keyed on `app.org_id`. There is no org to set. The receipt was the hard blocker; everything else about
-- platform delivery is application code.
--
-- WHY THE RECEIPT IS NOT OPTIONAL FOR THESE ROWS. A platform event has FEWER safety nets than an org one,
-- not more: one `m29.nppes.provider_synced` per changed NPI per nightly run, fanned to every declared
-- consumer, retried on failure. Without a durable receipt an applier that succeeded and then had a LATER
-- binding in the same row fail would re-run its canonical write on every retry — and re-running a
-- minimum-update applier is only harmless because that particular handler happens to be idempotent. The
-- receipt is what makes partial fan-out restart-safe in general, which is the whole reason it exists for
-- org rows.
--
-- THE PATTERN is 0186's, unchanged: `report_writer` (M33's existing platform writer role, already the
-- owner of every `report_writer_*_platform_outbox*` function) gains a policy admitting ONLY
-- `organization_id IS NULL` receipt rows, plus two SECURITY DEFINER functions whose bodies hardcode that
-- predicate. `wardenx_app` gets EXECUTE and never role membership, so the tenant pool still cannot read or
-- write an org-less receipt directly. The existing `outbox_consumer_receipt_org` policy is untouched — a
-- tenant session sees exactly the rows it saw before.
ALTER TABLE "outbox_consumer_receipt" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint

DROP POLICY IF EXISTS "outbox_consumer_receipt_platform_writer" ON "outbox_consumer_receipt";--> statement-breakpoint
CREATE POLICY "outbox_consumer_receipt_platform_writer" ON "outbox_consumer_receipt"
  FOR ALL TO report_writer
  USING ("organization_id" IS NULL)
  WITH CHECK ("organization_id" IS NULL);--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "outbox_consumer_receipt" TO report_writer;--> statement-breakpoint

-- ── (1) has this platform event already been completed by this consumer? ───────────────────────────────
-- Its own function rather than a widened SELECT policy: the dedup read must not be able to answer for an
-- ORG row (that would be a cross-tenant read through a platform-shaped question).
CREATE OR REPLACE FUNCTION report_writer_platform_receipt_exists(
  p_event_id uuid,
  p_consumer_name text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM outbox_consumer_receipt
    WHERE organization_id IS NULL
      AND event_id = p_event_id
      AND consumer_name = p_consumer_name
  );
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_platform_receipt_exists(uuid, text) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_platform_receipt_exists(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_platform_receipt_exists(uuid, text) TO wardenx_app;--> statement-breakpoint

-- ── (2) record the completion. ON CONFLICT DO NOTHING against the (event_id, consumer_name) unique index
-- the 0165 table already carries — two dispatcher processes racing the same row both succeed. ───────────
CREATE OR REPLACE FUNCTION report_writer_insert_platform_receipt(
  p_event_id uuid,
  p_consumer_name text,
  p_consumer_module text,
  p_completed_at timestamptz
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO outbox_consumer_receipt (organization_id, event_id, consumer_name, consumer_module, completed_at)
  VALUES (NULL, p_event_id, p_consumer_name, p_consumer_module, p_completed_at)
  ON CONFLICT (event_id, consumer_name) DO NOTHING;
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_insert_platform_receipt(uuid, text, text, timestamptz) OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_insert_platform_receipt(uuid, text, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_insert_platform_receipt(uuid, text, text, timestamptz) TO wardenx_app;--> statement-breakpoint

-- ── (3) the readiness probe's backlog depth for platform rows. `pendingDepth()` counted org rows only
-- and said so in a comment, which was defensible while platform rows could never be delivered (their
-- backlog was expected, not a symptom). Now that they CAN be delivered, an undeliverable platform backlog
-- is exactly the condition the depth check exists to surface, so it has to be countable. ────────────────
CREATE OR REPLACE FUNCTION report_writer_platform_outbox_pending_depth() RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::int FROM outbox_event WHERE organization_id IS NULL AND status = 'pending';
$$;--> statement-breakpoint
ALTER FUNCTION report_writer_platform_outbox_pending_depth() OWNER TO report_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION report_writer_platform_outbox_pending_depth() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_writer_platform_outbox_pending_depth() TO wardenx_app;--> statement-breakpoint

-- ── (4) retention. `report_writer_purge_platform_outbox` DELETEs dispatched platform rows past the
-- window; `outbox_consumer_receipt_event_fk` is ON DELETE CASCADE, so the receipts follow automatically —
-- but the cascade runs as the DELETING role, which is why the DELETE grant above is not decorative.
COMMENT ON POLICY "outbox_consumer_receipt_platform_writer" ON "outbox_consumer_receipt" IS
  'GAP-099 — admits ONLY organization_id IS NULL receipts, to report_writer, for the SECURITY DEFINER platform-receipt functions. The tenant pool reaches these rows through neither this policy nor outbox_consumer_receipt_org.';
