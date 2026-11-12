/**
 * Variables that change what a hook command loads before it judges anything (wave 6, T2).
 * ------------------------------------------------------------------------------------------------
 * The pinned hook commands start `bun` (Claude) or `perl` then `bun` (Codex). A variable the process reads at start
 * decides what else runs first: `BUN_OPTIONS=--preload=x.js` and `NODE_OPTIONS=--require=x.js` load x.js into bun,
 * `PERL5OPT`, `PERL5LIB`, `PERLLIB` and `PERL5DB` do the same to perl (before its `-e` body), `LD_PRELOAD` and
 * `DYLD_INSERT_LIBRARIES` load a library into either, and `PATH`, `SHELL`, `BASH_ENV`, `ENV`, `ZDOTDIR` choose which
 * binary or startup file runs. `arch:compliance` already refuses the first group in the shared settings `env` block;
 * this rule is its twin for a COMMAND LINE the agent writes:
 *
 *   - assigned anywhere in the command (`NAME=v cmd`, `export NAME=v`, `env NAME=v cmd`, `+=`, a later statement):
 *     the variables whose only use is to load code (`PERL5LIB`, `PERLLIB`, `PERL5DB`, `LD_PRELOAD`,
 *     `DYLD_INSERT_LIBRARIES`, `BUN_CONFIG_*`), and the option strings (`BUN_OPTIONS`, `NODE_OPTIONS`, `PERL5OPT`) when
 *     their value names an option that loads or runs code. `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc` is real
 *     everyday use (the repo's own typecheck script sets it) and stays allowed;
 *   - or, when the same command line starts a coding agent (`claude`, `codex`), also the variables that are too common
 *     to refuse everywhere but decide which hook an agent runs: `PATH`, `SHELL`, `BASH_ENV`, `ENV`, `ZDOTDIR`,
 *     `LD_LIBRARY_PATH` and every `DYLD_*`.
 *
 * Reading one is not setting it: `echo $NODE_OPTIONS`, `printenv NODE_OPTIONS`, `rg BUN_OPTIONS= docs` assign nothing
 * (only an assignment word is read; the text of a search is not). A value left empty clears the variable and is
 * allowed. Not decided by text: a variable set by an earlier tool call, a startup file or the human's own shell. Pure.
 */
import { assignments } from "./shell-assignments";

/** The parts of one simple command this rule reads; `words` are its `NAME=value` words (prefix assignments, `export` args). */
export interface EnvCommand {
  readonly prog: string;
  readonly args: readonly string[];
  readonly words: readonly string[];
}

/** Variables that exist to load code or a library: any non-empty value asks. */
const LOADER_VARIABLE =
  /^(?:PERL5LIB|PERLLIB|PERL5DB|DYLD_INSERT_LIBRARIES|LD_PRELOAD|BUN_CONFIG_[A-Z0-9_]+)$/;

/** An option that loads or runs code, as `node`/`bun` spell it, inside an option string. */
const JS_LOADING_OPTION =
  /(?:^|[\s'"])(?:-r|-e|-p|--require|--import|--loader|--experimental-loader|--preload|--eval|--print)(?![A-Za-z0-9-])/;
/** `PERL5OPT` takes bundled switches (`-wMstrict`): `M`/`m` load a module, `I` adds a library path, `d` a debugger module. */
const PERL_LOADING_OPTION = /-[A-Za-z]*[MmId]/;

/** Option-string variables, with what in their value makes them load code. */
const OPTION_VARIABLE: ReadonlyMap<string, RegExp> = new Map([
  ["NODE_OPTIONS", JS_LOADING_OPTION],
  ["BUN_OPTIONS", JS_LOADING_OPTION],
  ["PERL5OPT", PERL_LOADING_OPTION],
]);

/** Variables that decide which hook a coding agent runs: refused only when an agent is started on the same line. */
const AGENT_HOOK_VARIABLE = /^(?:PATH|SHELL|BASH_ENV|ENV|ZDOTDIR|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+)$/;

/** A coding agent's command word (`claude`, `codex`, `claude-code`, `claude@latest`), bare or as a path. */
const AGENT_CLI = /(^|\/)(codex|claude(-code)?)(@[\w.-]+)?$/;

/** Does this command start a coding agent (as the program, or `bunx claude`, `npx claude-code` after a runner)? */
export const isAgentSpawn = (prog: string, args: readonly string[]): boolean =>
  [prog, ...args.slice(0, 3)].some((w) => AGENT_CLI.test(w));

const LOADER_REASON =
  "That variable makes bun or perl load code or a library of the caller's choosing before the agent hook runs (BUN_OPTIONS, BUN_CONFIG_*, NODE_OPTIONS, PERL5OPT, PERL5LIB, PERLLIB, PERL5DB, LD_PRELOAD, DYLD_INSERT_LIBRARIES), which can silence the guard. A human decides.";
const AGENT_REASON =
  "A coding agent started with PATH, SHELL, BASH_ENV, ENV, ZDOTDIR, LD_LIBRARY_PATH or DYLD_* set runs its hooks on a binary or startup file of the caller's choosing, which can silence the guard. A human decides.";

/** Does the value of an option variable name an option that loads or runs code? */
const loadsCode = (name: string, value: string): boolean =>
  OPTION_VARIABLE.get(name)?.test(value) === true;

/**
 * Why the command line of `commands` should ask, or null: a variable that loads code is assigned anywhere in it, or
 * an agent is started and a variable that picks its hook binary is assigned anywhere in it.
 */
export function loaderEnvReason(commands: readonly EnvCommand[]): string | null {
  const assigned = commands.flatMap((c) => assignments(c.words)).filter((a) => a.value !== "");
  if (assigned.some((a) => LOADER_VARIABLE.test(a.name) || loadsCode(a.name, a.value))) {
    return LOADER_REASON;
  }
  const startsAgent = commands.some((c) => isAgentSpawn(c.prog, c.args));
  return startsAgent && assigned.some((a) => AGENT_HOOK_VARIABLE.test(a.name))
    ? AGENT_REASON
    : null;
}
