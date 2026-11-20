-- compat: expand
-- M8 (WF09): a signed note's text can now be the clinician's own edit of the generated narrative. The assembled-output row already
-- holds BOTH texts (`layer1_cipher` the deterministic Layer-1 assembly, `final_cipher` the bytes that were signed); this flag says
-- the two differ because the author edited the note text, so a reader of a signed note, the PDF render and an auditor can tell an
-- edited note from a generated one without opening and comparing two ciphertexts. The previous release never reads it and writes the
-- default, which is exactly what it means: not edited. A pure expand (the column is NOT NULL with a constant default).
ALTER TABLE "hearthnote_assembled_output" ADD COLUMN "clinician_edited" boolean NOT NULL DEFAULT false;
