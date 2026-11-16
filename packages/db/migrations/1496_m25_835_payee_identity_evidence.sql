-- compat: expand
-- Keep a non-sensitive audit record of the payee identity method used. Historical rows stay NULL;
-- the JSON contains only verification method/scope/policy source/time, never an NPI or TIN value.
ALTER TABLE remittance_advice
  ADD COLUMN payee_identity_evidence jsonb;
