/**
 * Options whose value is a file the program reads LINE BY LINE as names or code, and prints in an error (wave 10, B12; round-7
 * R7-ADV-19). `file -f .env` and `file --files-from .env` treat each line of the file as a file name and report on it,
 * `wc --files0-from=F`, `du --files0-from=F` and `sort --files0-from=F` do the same with NUL-separated names, `git add
 * --pathspec-from-file=F` and `git rm --pathspec-from-file=F` print a `pathspec ... did not match` for a line, `rsync
 * --files-from=F` names each line in its errors, and `sed -f F` / `awk -f F` read the file as a program and print the line that
 * does not parse. A live env file read this way prints its lines into the transcript like `cat` does, so each such file is judged
 * as a read (the secret-name rule). Pure.
 */
import { optionValues } from "./option-values";

/** The files `prog args` reads as a list of names or as code, by the options that take one. */
export function listedFiles(prog: string, args: readonly string[]): string[] {
  switch (prog) {
    case "file":
      return optionValues(args, "f", [["files-from", 7]]);
    case "wc":
    case "du":
    case "sort":
      return optionValues(args, "", [["files0-from", 6]]);
    case "git":
      return optionValues(args, "", [["pathspec-from-file", 6]]);
    case "rsync":
      return optionValues(args, "", [
        ["files-from", 6],
        ["exclude-from", 8],
        ["include-from", 8],
      ]);
    case "sed":
      return optionValues(args, "f", [["file", 4]]);
    case "awk":
    case "gawk":
      return optionValues(args, "f", [["file", 4]]);
    default:
      return [];
  }
}
