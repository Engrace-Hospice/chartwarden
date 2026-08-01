-- M6L-T03 — the election-statement + CTI DRAFT→SIGN lifecycle. Both tables were shaped for a COMPLETED
-- record (every signing/clinical field NOT NULL), which made the §7.3 draft step impossible to persist.
-- A draft carries only intent; the signed-document + clinical fields are filled on sign/complete.
--
-- election_statement: gains a `status` (drafted → signed → voided) and relaxes the signed-document fields
-- to nullable at draft (filled by signElection). CTI: relaxes the clinical fields to nullable at draft
-- (filled by draftCti when known / on completion); `status` already exists (cti_status).
CREATE TYPE "public"."election_statement_status" AS ENUM('drafted', 'signed', 'voided');--> statement-breakpoint
ALTER TABLE "election_statement" ADD COLUMN "status" "election_statement_status" DEFAULT 'drafted' NOT NULL;--> statement-breakpoint
ALTER TABLE "election_statement" ALTER COLUMN "patient_name_at_signing" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "election_statement" ALTER COLUMN "hospice_name_at_signing" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "election_statement" ALTER COLUMN "curative_care_acknowledgment" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "election_statement" ALTER COLUMN "signed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "election_statement" ALTER COLUMN "signature_method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ALTER COLUMN "terminal_diagnosis_icd10" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ALTER COLUMN "narrative" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ALTER COLUMN "period_start" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_of_terminal_illness" ALTER COLUMN "period_end" DROP NOT NULL;
