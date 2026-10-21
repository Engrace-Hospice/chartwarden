// packages/narrative-vocab/src/releases.ts — the D11 release registry (#128, spec §2.7 / architecture §10.5.2).
//
// `encounter.vocab_version_id` is a `uuid`. The corpus versions itself as a STRING (`VOCAB_VERSION`).
// That mismatch is why finalize used to write one constant sentinel uuid for every encounter ever
// signed: it satisfied the `encounter_vocab_pinned_when_finalized` CHECK and identified nothing.
//
// This file is the mapping the column always needed. Each shipped corpus release is assigned ONE uuid,
// once, by hand, and that pairing is immutable forever — a signed encounter's pin has to keep meaning
// the same thing for as long as the record is retained (42 CFR 418.104), which is longer than any of
// this code will live.
//
// WHY NOT AN M38 `code_system_version` ROW — the shape #128 proposed. Three reasons, and the third is
// the one that decides it:
//
//   1. `code_system_version` models EXTERNALLY LOADED terminology: it requires `source_file_ref` (a
//      MinIO object id) and a `checksum` of that file, and its `code_system_id` enum is the set of
//      licensed systems M38 loads — the enum comment reserves 'cpt' pending an AMA license precisely
//      to stop a row referencing a system the platform has no right to. A first-party corpus that
//      ships as a package has no source file to reference and no license to gate; a row there would
//      have to fabricate both.
//   2. M38's resolution model is AS-OF-DATE per code system, not a single active-version pointer.
//      `TerminologyProvider` (which is real, registered, and named `TerminologyProvider`, not the
//      `TerminologyReader` the issue looked for) exposes `validate`/`lookup`/`expand` — every one of
//      them keyed on `asOf`. There is no "the active M38 version" for a `uuid` column to hold.
//   3. **Pinning M38 would protect nothing.** D11 exists so that a corpus release cannot change the
//      rendered text of an already-signed note. Architecture §10.5.2 makes the Layer-1 assembly a pure
//      function of (selection tree × template × this package) — `@chartwarden/hearthnote` depends on
//      `@chartwarden/narrative-vocab` and `@chartwarden/types` and nothing else, and no SNOMED or LOINC concept
//      is resolved anywhere in assembly. The version whose stability the guarantee rests on is THIS
//      one. `packages/narrative-vocab` is M8-owned (manifest `codePaths`), so the module reads it
//      directly and needs no seam at all.
//
// The module spec names M38 here (§2.7, "the active M38 version at finalize-time"). Architecture wins
// on conflict, and this file follows architecture — see the note in `docs/adr/` if one is added.

/** One shipped release of the narrative corpus. The `(version, id)` pairing is permanent. */
export interface NarrativeVocabRelease {
  /** The semver string the package publishes as {@link VOCAB_VERSION}. */
  readonly version: string;
  /** The uuid `encounter.vocab_version_id` / `hearthnote_assembled_output.vocab_version_id` pin. */
  readonly id: string;
  /** The date this corpus was released, for the audit trail. */
  readonly releasedOn: string;
}

/**
 * Every corpus release, oldest first.
 *
 * ADDING ONE: bump `VOCAB_VERSION` in `vocabulary.ts` and append a row here with a FRESHLY GENERATED
 * uuid in the same commit. Never edit or reuse an existing row — a historical encounter pins that id.
 * `releases.test.ts` fails if `VOCAB_VERSION` has no row, so the two cannot drift apart silently.
 */
export const NARRATIVE_VOCAB_RELEASES: readonly NarrativeVocabRelease[] = [
  {
    version: "narrative-vocab@2026.06.0",
    id: "81dcb265-d2ef-456b-b029-1bcce25105e7",
    releasedOn: "2026-06-01",
  },
];

/** Raised when {@link VOCAB_VERSION} names a release this registry does not carry. */
export class UnregisteredNarrativeVocabRelease extends Error {
  constructor(version: string) {
    super(
      `narrative corpus '${version}' has no entry in NARRATIVE_VOCAB_RELEASES — add one (with a new uuid) in the same commit that bumped VOCAB_VERSION`,
    );
    this.name = "UnregisteredNarrativeVocabRelease";
  }
}

/**
 * The release the running build assembles against — the D11 pin finalize writes.
 *
 * THROWS rather than falling back when the version is unregistered. A fallback here is exactly the
 * defect being fixed: a placeholder pin is indistinguishable from a real one at every later read, and
 * the record it corrupts is a signed clinical note. Refusing to finalize is recoverable; a chart full
 * of notes pinned to a version nobody can name is not.
 */
export function activeNarrativeVocabRelease(version: string): NarrativeVocabRelease {
  const found = NARRATIVE_VOCAB_RELEASES.find((r) => r.version === version);
  if (found === undefined) throw new UnregisteredNarrativeVocabRelease(version);
  return found;
}

/** Decode a pin off a historical record: which corpus was this note assembled against? */
export function narrativeVocabReleaseById(id: string): NarrativeVocabRelease | null {
  return NARRATIVE_VOCAB_RELEASES.find((r) => r.id === id) ?? null;
}
