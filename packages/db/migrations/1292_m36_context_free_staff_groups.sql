-- compat: expand
-- Staff group conversations have no patient subject but retain care-related messages.
ALTER TYPE channel_kind ADD VALUE IF NOT EXISTS 'group';
