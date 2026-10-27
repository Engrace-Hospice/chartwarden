-- M23 / ADR-0053 (issue #836): the render time remembered beside the interchange number.
--
-- 1281 made ISA13 stable across a redelivery, but the writer still got a fresh `now`, so ISA09/ISA10 and GS04/GS05/BHT04/BHT05
-- changed and a raw-X12 vendor (direct MAC, in_memory) saw a different payload hash under the same idempotency key. The
-- memo now carries the time the interchange was first rendered; a redelivered job renders with it, byte-identical.
-- Existing rows take their `created_at` (the memo is drawn immediately before the first render, so it is the same moment
-- to within a request). Written once at allocation by the attempt store; the app role still only reads and inserts.
ALTER TABLE "clearinghouse_interchange_number" ADD COLUMN IF NOT EXISTS "rendered_at" timestamptz;--> statement-breakpoint
UPDATE "clearinghouse_interchange_number" SET "rendered_at" = "created_at" WHERE "rendered_at" IS NULL;--> statement-breakpoint
ALTER TABLE "clearinghouse_interchange_number" ALTER COLUMN "rendered_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "clearinghouse_interchange_number" ALTER COLUMN "rendered_at" SET NOT NULL;
