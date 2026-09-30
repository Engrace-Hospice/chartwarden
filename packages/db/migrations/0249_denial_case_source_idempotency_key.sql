-- F-153/F-156 (#248) — M25's `handlers-unbound` group: `handleClaimRejected`/`handleEvvAggregatorRejected`
-- (consumers/handlers.ts) have promised, in their own header comment, since they were written: "the 277CA
-- seed dedupes on (claimId, source, UTC date); the EVV seed on the aggregator submission id … the store
-- enforces the dedupe." No store implementation existed and no column or index on `denial_case` ever backed
-- either dedupe key shape — only non-unique indexes (`ix_denial_claim`, `ix_denial_carc`, …) existed, so a
-- redelivery of the same catalogued event, or two dispatcher ticks racing on the same delivery, would
-- silently double-seed a worklist row for the same rejection.
--
-- `source_idempotency_key` materializes the caller-computed key (`277ca:<claimId>:<utcDate>` /
-- `evv:<aggregatorSubmissionId>`) rather than deriving it from `opened_at` — `opened_at` is INSERTION time
-- (`defaultNow()`), not the source event's `occurredAt`, and deriving the UTC-date component from it would
-- let a redelivery that lands on the other side of a UTC midnight boundary evade the dedupe it is meant to
-- enforce.
--
-- Left NULL for the existing WX-PR-012 `remittance_adjustment`-sourced seed path (ingest/service-drizzle.ts):
-- that source is already naturally 1:1 with its `remittance_adjustment_id` (one CAS adjustment posts at
-- most once inside one transactional 835-post), so it needs no key here and is unaffected by this migration.
--
-- The UNIQUE constraint on `(organization_id, source_idempotency_key)` needs no partial WHERE clause to
-- exempt those NULL rows: Postgres unique constraints treat every NULL as distinct from every other NULL by
-- default (NULLS DISTINCT, the default — see migration 0110's `sss_active_pair_uniq` / migration 0237's
-- `NULLS NOT DISTINCT` for the opposite case), so any number of NULL-keyed rows coexist freely and only the
-- two real dedupe sources are ever constrained.
ALTER TABLE "denial_case"
ADD COLUMN "source_idempotency_key" varchar(160);

ALTER TABLE "denial_case"
ADD CONSTRAINT "denial_case_source_idempotency_key_uq" UNIQUE ("organization_id", "source_idempotency_key");
