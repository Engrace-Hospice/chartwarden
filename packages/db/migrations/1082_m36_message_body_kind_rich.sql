-- M36 WP 2.1 - the structured ("rich") message body.
--
-- `message_body_kind` gains `rich`: the encrypted plaintext of such a row is the canonical JSON of a versioned,
-- server-sanitised document (`{"schemaVersion":1,"doc":{...}}`, see packages/types/src/messaging-rich-body.ts).
-- `body_sha256` stays the SHA-256 of that exact plaintext, so `messaging.hash_verify` needs no change. Existing
-- `plain`, `markdown` and `system` rows are untouched and keep rendering as before; `message_revision.body_kind`
-- shares the enum, so a revision of a rich body is self-describing. The new value is not used by any statement in
-- this file. Idempotent.
ALTER TYPE "public"."message_body_kind" ADD VALUE IF NOT EXISTS 'rich';
