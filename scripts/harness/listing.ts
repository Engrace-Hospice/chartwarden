/**
 * A directory listing and whether it saw everything (wave 8, T6(d); round-6 CR6-6). The live env files and the live suite
 * files are read from the tree under a budget (a directory cap, a depth cap, a read that can fail). A listing that was cut
 * short must not read as "there is none": the rules that ask "could this reach one?" answer yes when `complete` is false,
 * as `protected-names.ts` does for the protected names. A caller that can only hand a plain array (a unit test) has a
 * complete listing. Pure.
 */
export interface Listing {
  readonly files: readonly string[];
  /** False when a directory cap, a depth cap, a symlinked directory or an unreadable directory kept the walk from seeing all of it. */
  readonly complete: boolean;
}

/** What a caller may hand the classifier: a plain list (complete) or a listing that says so. */
export type Listed = readonly string[] | Listing;

export const asListing = (listed: Listed): Listing =>
  "files" in listed ? listed : { files: listed, complete: true };
