-- compat: expand
-- BIL-1.5A: persist a non-postable hold when the M25 posting boundary finds an exact prior financial identity.
ALTER TYPE m25_parse_status ADD VALUE IF NOT EXISTS 'held_duplicate';
