-- FY2027 hospice election statement addendum (42 CFR 418.24(b)(6), (c), (d) as amended by CMS-1851-F, effective
-- 2026-10-01) — the three additive enum values the addendum needs, in their own migration: PG forbids using a value
-- added earlier in the same transaction (the 0267 precedent), and 0381 creates the table that the new
-- `compliance_window_kind` values and the new document aggregate type are written against.
--
-- 1. compliance_window_kind.election_addendum_initial — furnish within 5 calendar days of the election's effective
--    date (418.24(d)(1); MLN Connects 2026-10-01: "5 calendar days").
-- 2. compliance_window_kind.election_addendum_update  — update within 3 calendar days of a plan-of-care change that
--    affects the addendum's determinations (418.24(d)(2)).
-- 3. document_aggregate_type.election_addendum        — the M22 PDF, one document per addendum version.
--
-- Additive only; no existing row changes. Idempotent (IF NOT EXISTS).
ALTER TYPE "public"."compliance_window_kind" ADD VALUE IF NOT EXISTS 'election_addendum_initial';--> statement-breakpoint
ALTER TYPE "public"."compliance_window_kind" ADD VALUE IF NOT EXISTS 'election_addendum_update';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'election_addendum';
