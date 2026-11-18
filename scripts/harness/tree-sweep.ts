/**
 * Commands that print every file under a directory, and the operands they read (wave 6, T3).
 * ------------------------------------------------------------------------------------------------
 * `grep -r` ignores .gitignore, so over a directory that holds a live env file it prints the file; the classifier asks
 * about that (`recursiveSearchVerdict`). `git diff --no-index DIR DIR`, `diff -r DIR DIR` and `colordiff -r` do the same
 * (a diff of a directory against an empty one prints every file as an addition), and a plain `diff DIR DIR` compares the
 * same-named files directly under both (`diff -N` any file). git also treats `git diff A B` as `--no-index` when one of
 * the two paths is outside the working tree. This module names the operands such a command reads; the classifier
 * places each one (`classifySegment`, the same placement `grep -r` uses). `cmp` is not here: on a directory it only
 * says "Is a directory". Pure.
 */
import { isLongOption } from "./option-values";

/** How much of an operand directory the command reads: its whole tree, or the files directly under it. */
export type SweepDepth = "tree" | "children";

export interface DiffSweep {
  /** The operand words, in order, minus options (an option's separate value may be among them: harmless to judge). */
  readonly operands: readonly string[];
  readonly mode: SweepDepth;
}

export interface GitDiffSweep {
  readonly operands: readonly string[];
  /** `--no-index` was given. Without it the two operands are only a candidate: git implies it for a path outside the tree. */
  readonly noIndex: boolean;
}

const DIFF_PROGRAMS = /^(?:diff|colordiff)$/;
const SHORT_CLUSTER = /^-[A-Za-z]+$/;

/** The words that are not inside a process substitution: `diff <(git -C ROOT show x) y` compares `y`, not `ROOT`. */
function outsideSubstitutions(args: readonly string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const a of args) {
    if (depth === 0 && !/^[<>]\(/.test(a)) {
      out.push(a);
      continue;
    }
    depth += (a.match(/\(/g)?.length ?? 0) - (a.match(/\)/g)?.length ?? 0);
    depth = Math.max(depth, 0);
  }
  return out;
}

/** The words that are not options, and everything after `--`. A lone `-` (standard input) is not a path. */
function positionals(all: readonly string[]): string[] {
  const args = outsideSubstitutions(all);
  const out: string[] = [];
  let literal = false;
  for (const a of args) {
    if (literal) out.push(a);
    else if (a === "--") literal = true;
    else if (a !== "-" && !a.startsWith("-")) out.push(a);
  }
  return out;
}

/** The arguments before any `--`: the only place an option can be. */
const optionsOf = (args: readonly string[]): readonly string[] => {
  const end = args.indexOf("--");
  return end < 0 ? args : args.slice(0, end);
};

/** Does `given` (the text after `--`, up to any `=`) spell `name` or an unambiguous prefix of it of `min` characters? */
const spells = (given: string, name: string, min: number): boolean =>
  isLongOption(`--${given}`, name, min);

const longName = (arg: string): string | null =>
  arg.startsWith("--") && arg !== "--"
    ? arg.slice(2, arg.indexOf("=") < 0 ? undefined : arg.indexOf("="))
    : null;

/** `diff` and `colordiff`: `-r`, `-R`, `--recursive` (or a prefix of it) read whole trees; otherwise the direct children. */
export function diffSweepOperands(prog: string, args: readonly string[]): DiffSweep | null {
  if (!DIFF_PROGRAMS.test(prog)) return null;
  const recursive = optionsOf(args).some((a) => {
    const long = longName(a);
    return long === null ? SHORT_CLUSTER.test(a) && /[rR]/.test(a) : spells(long, "recursive", 3);
  });
  return { operands: positionals(args), mode: recursive ? "tree" : "children" };
}

/**
 * `git diff` (`rest` is what follows the subcommand): with `--no-index` it reads the filesystem, whole trees included
 * (every positional word is then a path). Without it git still treats TWO paths as `--no-index` when one of them is
 * outside the working tree: exactly two operands and no revision before a `--` (`git diff -- A B` and `git diff A B`
 * qualify, `git diff HEAD -- A` and `git diff A..B -- C` do not). The caller decides "outside" by where the operands
 * are. Null for any other `git diff`.
 */
export function gitDiffSweepOperands(rest: readonly string[]): GitDiffSweep | null {
  const noIndex = optionsOf(rest).some((a) => {
    const long = longName(a);
    return long !== null && spells(long, "no-index", 5);
  });
  if (noIndex) return { operands: positionals(rest), noIndex };
  const dashdash = rest.indexOf("--");
  const operands = dashdash < 0 ? positionals(rest) : rest.slice(dashdash + 1);
  const revisions = dashdash < 0 ? [] : positionals(rest.slice(0, dashdash));
  return operands.length === 2 && revisions.length === 0 ? { operands, noIndex } : null;
}
