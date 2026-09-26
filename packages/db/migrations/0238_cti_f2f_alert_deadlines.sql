ALTER TABLE "certification_of_terminal_illness"
ADD COLUMN "signature_requested_at" timestamptz;

ALTER TABLE "certification_of_terminal_illness"
ADD COLUMN "signature_due_at" timestamptz;

ALTER TABLE "face_to_face_encounter"
ADD COLUMN "scheduled_date" date;