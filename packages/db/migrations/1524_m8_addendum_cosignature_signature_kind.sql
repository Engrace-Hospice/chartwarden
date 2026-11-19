-- compat: expand
-- M8 visit-note drafting (ADR-0114 VN-D30): the cosignature of an AMENDING addendum's request is a signature event, so it leaves its provenance row in
-- `encounter_signature` like every other (who signed, by which factor, when the step-up was verified, the attestation presented; CoP 418.104(c)).
-- It cannot use kind 'cosignature': `encounter_signature_unique_cosig_idx` allows ONE per encounter, and the encounter's own cosignature (when its note
-- needed one) already holds it; dropping that unique index is a contract change. A distinct kind keeps the note's cosignature and an amendment's apart,
-- on the same table, with the addendum named in `addendum_id`. Additive: the previous release never writes or reads the new value (it only reads
-- `encounter_signature` through the note's own paths). The value cannot be used in this transaction; the application writes it from the release that
-- ships with this migration. Mirrored in `packages/db/src/enums.ts` and `packages/types`.
ALTER TYPE "public"."signature_kind" ADD VALUE IF NOT EXISTS 'addendum_cosignature';
