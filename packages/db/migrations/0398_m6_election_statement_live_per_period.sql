-- M6 — one LIVE election statement per benefit period (42 CFR 418.24; spec R-EL-05, v0.9.1).
--
-- `election_statement_period_idx` (0026) was a plain unique index on `election_period_id`, so once a
-- drafted statement was voided (`POST /election-statements/:id/void`) no new statement could ever be
-- drafted for that period — the draft answered 409 ELECTION_STATEMENT_CONFLICT forever. The intent (a
-- voided statement is history, a re-draft replaces it) mirrors `cti_period_active_idx`: the index is now
-- partial and only counts non-voided rows. Same name, so the registered business rule (`businessRule()`,
-- F-022) and the service-side 23505 mapping keep matching it.
DROP INDEX IF EXISTS "election_statement_period_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "election_statement_period_idx"
  ON "election_statement" USING btree ("election_period_id")
  WHERE status <> 'voided';
