/**
 * The name a program word stands for: the shell removes its backslashes, and a directory in front of it (`/usr/bin/nice`,
 * `./nohup`, `~/bin/env`) does not make it another program. ONE helper for the wrapper lookup, the runner lookup and every
 * other place that compares a program word with a name (wave 10, A3: R7-ADV-5, the wrapper lookup used the whole word, so a
 * wrapper called by path was never peeled and hid its command from every rule). The name is in LOWER case: macOS (APFS) is
 * case-insensitive, so an upper-case `GIT` or `PSQL` runs the real tool, and every table is keyed by the lower-case name (wave 13, A1:
 * R10-ADV-1). Only the lookup folds: a word that is printed is printed as typed. Pure.
 */
export const programName = (word: string): string =>
  word
    .replace(/\\(.)/gs, "$1")
    .replace(/^.*\//s, "")
    .toLowerCase();
