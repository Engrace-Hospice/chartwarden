// @chartwarden/intake-extraction — the ICD-10-CM facts the DocLens coding checks need (F-238), as a port.
// The backend implements it over M38 (`concept_icd10cm` + `deprecation_mapping`, loaded from the CDC/NCHS
// release by scripts/db/load-icd10cm.ts); tests implement it over a fixture cut from that same data.

/** One ICD-10-CM concept as of a date. Codes are dotted (`I50.22`). */
export interface IcdCodeFacts {
  readonly code: string;
  readonly display: string;
  /** Valid for HIPAA-covered transactions (a leaf); false = a category/header, needs a subcode. */
  readonly billable: boolean;
  /** "in (other) diseases classified elsewhere" — never sequenced first. */
  readonly manifestation: boolean;
  readonly effectiveDate: string;
  readonly endDate: string | null;
}

export interface IcdDeprecation {
  readonly code: string;
  /** ISO date the code stopped being billable. */
  readonly effective: string;
  readonly successors: readonly string[];
}

export interface CodingTerminology {
  /** The concepts in force on `asOfIso` for these codes; a code absent from the map is not valid then. */
  lookup(codes: readonly string[], asOfIso: string): Promise<ReadonlyMap<string, IcdCodeFacts>>;
  /**
   * The codes that exist in ANY loaded release, each with its most recent official title — used to vet OCR
   * repairs (an older record may carry a code retired since). A code absent from the map is not a code.
   */
  titles(codes: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The first date the loaded releases cover (an older document is judged by that release), or null. */
  coverageFrom(): Promise<string | null>;
  /** Deprecations recorded for these codes (a code that became a header, or was deleted). */
  deprecations(codes: readonly string[]): Promise<ReadonlyMap<string, IcdDeprecation>>;
}
