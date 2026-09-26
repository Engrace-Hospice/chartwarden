CREATE TABLE "alert_receipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id" uuid NOT NULL,
  "recipient_user_id" uuid NOT NULL,
  "read_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE "alert_receipt"
  ADD CONSTRAINT "alert_receipt_alert_id_alert_id_fk"
  FOREIGN KEY ("alert_id")
  REFERENCES "public"."alert"("id")
  ON DELETE CASCADE;

ALTER TABLE "alert_receipt"
  ADD CONSTRAINT "alert_receipt_recipient_user_id_user_id_fk"
  FOREIGN KEY ("recipient_user_id")
  REFERENCES "public"."user"("id");

CREATE UNIQUE INDEX "alert_receipt_alert_recipient_unique"
  ON "alert_receipt" ("alert_id", "recipient_user_id");

CREATE INDEX "alert_receipt_recipient_idx"
  ON "alert_receipt" ("recipient_user_id", "created_at");

CREATE INDEX "alert_receipt_alert_idx"
  ON "alert_receipt" ("alert_id");