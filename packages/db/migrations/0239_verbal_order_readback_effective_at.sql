ALTER TABLE "verbal_order"
ADD COLUMN "read_back_verified" boolean NOT NULL DEFAULT false;

ALTER TABLE "verbal_order"
ADD COLUMN "effective_at" timestamptz;

UPDATE "verbal_order"
SET "effective_at" = "received_at"
WHERE "effective_at" IS NULL;

ALTER TABLE "verbal_order"
ALTER COLUMN "effective_at" SET NOT NULL;