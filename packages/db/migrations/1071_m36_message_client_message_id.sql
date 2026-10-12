-- M36 WP 1.2 — idempotent durable send: the DB backstop behind the `Idempotency-Key` HTTP middleware.
-- The middleware dedupes a retry that carries the SAME header key; it cannot help a retry that arrives under a
-- fresh key (key rotated after a 409 "still processing", a pending record that never completed, a seam caller
-- with no HTTP layer). `client_message_id` is a client-minted id that stays stable across those retries: a second
-- insert for the same (organization, author, client_message_id) is a no-op that returns the original row.
-- Nullable (system/seam writers and legacy rows have none); NULLs never collide in a UNIQUE constraint.

ALTER TABLE "message" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_client_message_unique"
  UNIQUE ("organization_id", "author_user_id", "client_message_id");
