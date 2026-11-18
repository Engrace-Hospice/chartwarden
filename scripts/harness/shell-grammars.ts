/**
 * How each shell reads the words in front of its command string (wave 12 part E1, E1-1; round-9 R9-ADV-1, R9-ADV-2, R9-ADV-6, R9-ADV-17).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * Waves 3 to 11 read every shell with ONE bash-shaped rule, and the real shells disagree (the committed recordings of
 * `scripts/__tests__/fixtures/harness-shell-options/` are the proof, re-recorded by `helpers/record-shell-options.ts`):
 *   - `+c` is `-c` in bash, sh, dash and zsh (`bash +c 'CMD'` runs CMD); ksh93 does not read `+c` as `-c`, but runs its first operand as a
 *     command line when no such file exists, which is the same hole (`ksh 'CMD'`);
 *   - `-o` and `-O` of bash and dash (and sh, which is bash in POSIX mode on macOS and dash on Debian: both readings are tried) take the
 *     NEXT word and the rest of the cluster stays flags (`bash -oc pipefail 'CMD'` runs CMD; the wave-11 reader stopped at the `o`);
 *   - zsh's `-o`/`+o` take the rest of the cluster as the option name when there is one (`zsh -oc x` names the option `c`, an error) and
 *     the next word otherwise; zsh's `-O` is a plain flag (`zsh -O -c 'CMD'` runs CMD, wave 10 denied it, wave 11 allowed it);
 *   - ksh93's `-o`/`+o` take the rest of the cluster, else the next word, unless that word starts with `-` or `+` (then `-o` lists the
 *     options and the `-c` after it still runs: `ksh -o -c 'CMD'`); `-O` is an error;
 *   - csh and tcsh: every `c` of a `-` cluster takes the NEXT word as the command, a later one replaces an earlier one (`csh -cc a CMD`
 *     runs CMD), `-b` ends the options, `--` is an error and `+c` is a file name.
 * fish, pwsh, ash and busybox sh are not installed here: they are read by the documented grammar and an option their table does not place
 * asks. Pure data; the reader is `shell-command-string.ts`.
 */

/** What a valued letter takes: the next word (the rest of the cluster stays flags), or the rest of the cluster, else the next word. */
export type ValueKind = "next" | "rest-or-next" | "rest-or-next-unless-dash";

export interface ShellGrammar {
  /** `+c` runs the string like `-c`. */
  readonly plusC: boolean;
  /** The letters that take a value, in `-` and `+` clusters alike. Any other letter is a flag. */
  readonly valued: Readonly<Record<string, ValueKind>>;
  /** Long options that take the next word as their value; every other `--name` is a flag. */
  readonly valuedLong: readonly string[];
  /** The first operand runs as a command line when no file of that name exists (ksh93). */
  readonly operandRuns: boolean;
}

const BASH: ShellGrammar = {
  plusC: true,
  valued: { o: "next", O: "next" },
  valuedLong: ["--rcfile", "--init-file"],
  operandRuns: false,
};
const DASH: ShellGrammar = {
  plusC: true,
  valued: { o: "next" },
  valuedLong: [],
  operandRuns: false,
};
const ZSH: ShellGrammar = {
  plusC: true,
  valued: { o: "rest-or-next" },
  valuedLong: [],
  operandRuns: false,
};
const KSH: ShellGrammar = {
  plusC: false,
  valued: { o: "rest-or-next-unless-dash" },
  valuedLong: [],
  operandRuns: true,
};

/**
 * The grammars a shell name is read with. `sh` is read as bash AND as dash (macOS `sh` is bash in POSIX mode, Debian's is dash), `ash` and
 * `busybox sh` as bash, `fish` as bash too besides its own options (unverified: not installed here). csh and tcsh have their own reader (`cshCommandStrings`).
 */
export const SHELL_GRAMMARS: ReadonlyMap<string, readonly ShellGrammar[]> = new Map([
  ["bash", [BASH]],
  ["sh", [BASH, DASH]],
  ["dash", [DASH]],
  ["zsh", [ZSH]],
  ["ksh", [KSH]],
  ["ash", [BASH]],
  ["fish", [BASH]],
]);

/** Shells whose tables come from their documentation: the tool is not installed where the recordings were made. */
export const UNVERIFIED_SHELLS: readonly string[] = ["ash", "fish", "pwsh", "powershell"];

/**
 * The shell a program name stands for, by FAMILY (wave 13, B11: R10-ADV-B11): a version or a variant of a shell reads its options like the shell it is
 * (`bash-5.2`, `rbash`, `ksh93`, `mksh`, `pdksh`, `oksh`, `busybox` as `sh`), and a shell nobody recorded (`xonsh`, `elvish`, `nu`) is read like `ash`: judged as
 * bash and asked about. A name of no family is returned as it is.
 */
export function shellFamily(prog: string): string {
  const bare = prog.replace(/-?[0-9][0-9.]*$/, "");
  if (bare === "rbash") return "bash";
  if (/^(?:mksh|pdksh|oksh|ksh)$/.test(bare)) return "ksh";
  if (bare === "busybox") return "sh";
  if (/^(?:xonsh|elvish|nu)$/.test(bare)) return "ash";
  return bare === "" ? prog : bare;
}
