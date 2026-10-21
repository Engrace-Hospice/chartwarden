# ADR-0046 — The D11 vocabulary pin is the narrative corpus release, not an M38 `code_system_version`

- **Status:** **Accepted** — ratified 2026-08-27. Closes the production-readiness finding F-056
  (issue #128) and un-defers §2.6 check 12 in M8's compliance-gate register.
- **Date:** 2026-08-27
- **Phase:** production-readiness audit remediation (2026-08-25 corpus).
- **Related:** [ADR-0043](ADR-0043-m8-completeness-seam-inversion.md) (the other M8 decision that
  reads architecture over the locked §2 text), and issues #121 (the Layer-3 gate this check belongs
  to) and #122 (the assembled-output pin this is the counterpart of).

## Context

M8 §2.7 D11 pins the vocabulary version an encounter was authored under, so that a later corpus
release cannot change the rendered text of an already-signed note. `encounter.vocab_version_id` and
`hearthnote_assembled_output.vocab_version_id` hold it.

The column is a `uuid`. The narrative corpus versions itself as a **string** —
`@chartwarden/narrative-vocab`'s `VOCAB_VERSION`, currently `narrative-vocab@2026.06.0`. Nothing bridged
the two, so finalize wrote a fixed sentinel — `00000000-0000-4000-8000-0000000000d8` — onto **every
encounter the platform has ever finalized**. It satisfied the `encounter_vocab_pinned_when_finalized`
CHECK and the `m8.encounter.finalized` payload's required `vocabVersionId`, and identified nothing.

Two consequences followed. §2.6 check 12 stood `deferred`, because comparing a placeholder against a
real id refuses every signature and comparing it against itself passes unconditionally — the F-051
defect one level down. And `checkVocabVersion`, the §2.7 guard written in M8-T04, was reachable from
no production path: the 409 `VOCAB_VERSION_MISMATCH` the spec specifies could not occur.

The module spec resolves the pin against **M38**: §2.7's rule reads "Vocab version is the active M38
version at finalize-time", and `encounters.ts`'s column comment says "M38 code_system_version
(logical)". Issue #128 proposed following that — create a `code_system_version` row for the narrative
corpus and publish a reader seam.

## Decision

**The pin is the `@chartwarden/narrative-vocab` corpus release.** `packages/narrative-vocab` carries a
`(version → uuid)` release registry (`releases.ts`); finalize resolves the running build's release
through it and pins that uuid. `VOCAB_VERSION_SENTINEL` is deleted, not bypassed.

The **module spec is overridden on this point**, under the authority rule: architecture wins over a
module spec, and the module spec is an implementation proposal.

## Why not an M38 `code_system_version` row

1. **That table models externally loaded terminology.** It requires `source_file_ref` (a MinIO object
   id) and a `checksum` of that file, both NOT NULL, and its `code_system_id` enum is the set of
   licensed systems M38 loads — the enum comment reserves `'cpt'` pending an AMA license precisely so
   that no row can reference a system the platform has no right to. A first-party corpus that ships
   as a package has no source file and no license gate; a row there would fabricate both.

2. **M38 has no "active version" to resolve.** Its model is **as-of-date, per code system**. The real
   seam is `TerminologyProvider` (registered, consumed by M12/M31/M32 — not the `TerminologyReader`
   the issue looked for, which does not exist), and every method on it — `validate`, `lookup`,
   `expand`, `isMemberOf` — is keyed on `asOf`. There is no single pointer for a `uuid` column to
   hold, and a per-system pin would need one column per system.

3. **Pinning M38 would protect nothing — this is the reason that decides it.** Architecture §10.5.2
   makes Layer-1 assembly a pure function of (selection tree × template × the vocabulary library), and
   names `packages/narrative-vocab/` as that library. `@chartwarden/hearthnote` depends on
   `@chartwarden/narrative-vocab` and `@chartwarden/types` and nothing else; **no SNOMED, LOINC or ICD-10
   concept is resolved anywhere in the assembly path.** A SNOMED release therefore cannot change a
   rendered narrative, and pinning its version would guard a door nothing walks through, while the
   package that *can* change the bytes stayed unpinned. D11's stated rationale — "M38 version updates
   do not change prior encounters' rendered narratives; re-render is byte-identical" — is satisfied
   only by pinning the corpus.

`packages/narrative-vocab` is M8-owned (manifest `codePaths`), so the module reads it directly. **No
seam is involved and no new cross-module dependency is created** — the module already imported
`VOCAB_VERSION`; it simply wrote a sentinel into the uuid column instead of resolving it.

## Consequences

- Each shipped corpus release is assigned one uuid, **once**, and that pairing is immutable — a
  retained record's pin must keep meaning the same thing for the life of the record (42 CFR 418.104).
  `releases.test.ts` fails if `VOCAB_VERSION` has no registered row, so a version bump cannot silently
  reintroduce an unresolvable pin.
- `activeNarrativeVocabRelease` **throws** on an unregistered version rather than falling back. A
  fallback is the defect being fixed: a placeholder pin is indistinguishable from a real one at every
  later read, and the record it corrupts is a signed clinical note.
- §2.6 check 12 moves from `deferred` to **`elsewhere`**, not to `evaluated`. Both halves are enforced,
  and neither belongs in the pure gate: *recorded* is the DB CHECK
  `encounter_vocab_pinned_when_finalized` (and the gate runs as a **preview** at finalize, before that
  transition's own pin is written, so evaluating presence there would refuse every first finalize);
  *still active* is `checkVocabVersion` in the finalize path, now reached.
- A draft authored against an older corpus is refused at finalize with 409 `VOCAB_VERSION_MISMATCH`,
  read off `hearthnote_selection.template_version`. Re-saving the selections restamps it and clears
  the refusal, so the remedy is in the clinician's hands.
- A draft **voided** before it ever finalized still needs a pin for the CHECK. It takes the corpus
  current at the void — a real, decodable release rather than the sentinel. Nothing was assembled
  under it and a voided draft claims no narrative, but the column must say something truthful.
- **Not addressed here:** `administration_record.vocab_version_id` (M13) is nullable and written by
  nothing. That is a separate D-decision on a different table and is out of scope for F-056.

## Documents this changes

- `docs/modules/CHARTWARDEN_MODULE_08_ENCOUNTERS_SPEC_v0_2.md` §2.7 / §3 — the "active M38 version"
  wording and the `vocab_version_id` column comment are superseded by this ADR.
- `packages/db/src/schema/encounter/encounters.ts` — column comment updated to cite ADR-0046.
- `apps/backend/src/modules/08-encounters/gate/checks.ts` — check 12's register entry.
