-- M11 D5 scheduled materialization needs the signed template's actual signer attribution.  Historical
-- rows stay NULL deliberately: guessing a clinician discipline would falsify clinical provenance.  The
-- spawner refuses such legacy templates until their authorized signature attribution is repaired.
ALTER TABLE "standing_order"
  ADD COLUMN IF NOT EXISTS "signer_discipline" text;--> statement-breakpoint

COMMENT ON COLUMN "standing_order"."signer_discipline" IS
  'M11 D5 template signature-anchor discipline; NULL only for legacy templates requiring attribution repair.';
