-- M2 Identity — passkey labels are optional.
-- Better Auth omits `name` when the user does not provide a label, so the
-- persistence model must allow NULL while retaining user-provided labels.

ALTER TABLE "passkey"
  ALTER COLUMN "name" DROP NOT NULL;
