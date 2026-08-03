-- M13 eMAR — TASK-008: single-use witness-attestation token burn (§7.4/§2.6 D7, SEC-001 compromise #5).
--
-- The witness token is HMAC-verified + TTL-checked + scope-bound, but until now nothing prevented the
-- SAME token from being replayed to witness a second administration inside its 60s TTL: the service
-- inserted `administration_witness` unconditionally, never checking whether the token's digest had
-- already been consumed. This constraint makes replay structurally impossible cluster-wide (Postgres,
-- not an optional Redis/Valkey dependency this deployment can run without) — a second INSERT carrying
-- the same `attestation_token_digest` now fails with a unique violation, and the whole administration
-- write rolls back with it (same tx). The service adds a friendly pre-check ahead of this (mirrors the
-- M15 `volunteer_compliance_gate` precedent: the index is the structural backstop, not the primary UX).
ALTER TABLE "administration_witness"
  ADD CONSTRAINT "administration_witness_attestation_token_digest_unique" UNIQUE ("attestation_token_digest");
