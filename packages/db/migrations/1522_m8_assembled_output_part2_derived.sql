-- compat: expand
-- M8 visit-note drafting (ADR-0114, design 3.1 "Per-viewer view", VN-D13): `hearthnote_assembled_output.part2_derived` says the pinned
-- narrative carries a section drafted from sources that may hold 42 CFR Part 2 content (the compiler's fail-closed flag: true unless every
-- source behind the section is proven not SUD-related). Finalize writes it when it pins the author's confirmed draft text, and sign rewrites
-- it with the signer's text, next to `final_cipher` and the sealed per-section rows of 1518.
--   * It exists because the sealed rows are written at SIGN: between finalize and sign the pin holds the author's draft text and there is no
--     row to say which section is Part 2. A reader without disclosure of such a pin is shown the note withheld, whole. And a sign that finds
--     the draft switched off while the pin carries Part 2 text is refused, since no rows could be written for it.
--   * NOT NULL DEFAULT false: a pin written without the draft (the switch off, a template the corpus does not draft) holds the clinician's own
--     words and Layer 1 text, which are not classified (design 3.1), so false is the true value for every row that exists before this column.
--   * A boolean, never content: the row audit trigger of 0031 already scrubs the three ciphers and takes the flag as it is. The frozen-after-sign
--     trigger of 1521 guards the ciphers only; sign sets this flag in the same UPDATE as the ciphers, before the status flips.
-- Roles are the post-1139 names (chartwarden_*).

ALTER TABLE "hearthnote_assembled_output"
  ADD COLUMN "part2_derived" boolean DEFAULT false NOT NULL;
