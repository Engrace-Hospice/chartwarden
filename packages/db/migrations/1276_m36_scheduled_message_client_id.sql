-- M36 scheduled send: a client-minted id, stable across retries of one schedule request, so a create whose response was
-- lost (a 5xx that actually committed) is a replay and not a second scheduled message. Same shape as message.client_message_id
-- (1071): nullable, unique per (organization, owner); NULL never conflicts so unkeyed creates are unaffected. The column
-- rides the existing owner-isolation RLS policy and the INSERT grant (INSERT is table-wide); it is plaintext, no PHI.
ALTER TABLE "scheduled_message" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_client_message_unique"
  UNIQUE ("organization_id", "user_id", "client_message_id");
