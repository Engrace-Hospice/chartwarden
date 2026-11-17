/**
 * Package runners: the programs that start another program (wave 8, T1; round-6 ADV6-1, CR6-2, CR6-8; wave 10, A8/A9).
 * ------------------------------------------------------------------------------------------------
 * `bunx git push origin main`, `npx rm .claude/settings.json`, `bun x cp x CLAUDE.md`, `pnpm exec sh -c '…'`, `yarn dlx
 * cp …`, `npm exec -- cp …`, `npx -c 'cp x CLAUDE.md'`, `bun run cp x CLAUDE.md`, `uv run psql …`: the program that runs is the one
 * after the runner, so it is judged by every rule as if it had been typed alone. This is the ONE reader of a runner's own options;
 * `peelRunner` returns the words of the command that really runs, and the classifier applies it where it finds a command's program,
 * so a runner under `env`, `nice`, `timeout`, `time` or another runner is peeled too. Wave 9 (W9-3) adds the version managers and
 * environment loaders that start a command by name (`corepack`, `volta run`, `mise exec|x`, `asdf exec`, `direnv exec DIR`,
 * `cross-env`, `dotenv`, `dotenvx run`, `env-cmd`, `doppler run`, `op run`, `lerna exec`, `nx exec`); wave 10 gives every tool the
 * option grammar of its own CLI (`runner-grammars.ts`, read by `option-grammar.ts`: `pnpm -r exec` and `pnpm -w exec` read `-r` and `-w` as
 * the flags they are), passes `yarn workspace NAME …` and `yarn workspaces foreach …` through to the command behind them, runs
 * `bun exec STR` as a shell line, and adds `uv run|tool run`, `uvx`, `pipx run`, `poetry|pdm|rye|hatch|pipenv|devbox run`,
 * `conda|micromamba run`, `nix shell|develop -c`, `nix-shell --run` and `flox activate`. A runner's own option that names a file
 * (`dotenv -e FILE`, `op run --env-file FILE`, `bun --env-file FILE run echo`) is handed back with the command
 * (`peelRunnerWithFiles`), so peeling never turns the refusal of a live env file into an allow. An option a strict grammar (bun, uv)
 * does not list is handed back as `unplaced`: the guard asks. `make`, `just` and `task` run recipes of the repo, not an arbitrary
 * command, and are not peeled (a documented residual).
 *
 * What a runner starts: `bunx|npx|pnpx X`, `bun x X`, `pnpm|yarn|npm exec|dlx X` and `npm x X` run a package binary or a PATH
 * program; `-c STR`, `--call STR`, `--call=STR` and pnpm's `--shell-mode` hand a string to a shell. `bun run X`, `yarn run X`,
 * `bun X` and `yarn X` run a package SCRIPT when X is a key of the nearest package.json (or has a colon, as `arch:fitness`), a file
 * when X looks like one, a builtin subcommand (`bun test`, `yarn install`), and otherwise the PATH program X (`bun run echo hello`
 * runs `echo`: checked; a bare `bun echo hello` does not on bun 1.4.4, and an option before the name makes the name no program
 * here). `npm run X` and `pnpm run X` only run scripts, so they are no runner. Pure.
 */
import { type OptionGrammar, readOptions } from "./option-grammar";
import { programName } from "./program-name";
import * as G from "./runner-grammars";

/** Does this name a package script of the package the command runs in? The caller knows; a colon always says yes. */
export type ScriptLookup = (name: string) => boolean;

const SPEC_VERSION = /(?<=.)@[^@/]*$/;
const SCOPE = /^@[^/]+\//;
/** `@biomejs/biome@1.9.0` and `shellcheck@latest` name the binary `biome` and `shellcheck`. */
const binaryOf = (spec: string): string => spec.replace(SCOPE, "").replace(SPEC_VERSION, "");

/** How a runner reads the words after its subcommand. */
export interface Grammar {
  readonly options: OptionGrammar;
  /** Names of options whose value is a command line for a shell (`-c STR`, `--call STR`). */
  readonly call?: readonly string[];
  /** Names of flags that make the rest of the words ONE shell string (pnpm's `-c` / `--shell-mode`). */
  readonly shellMode?: readonly string[];
  /** Spellings of an option after which the command is the next word and every word that follows (`nix develop -c git push`). */
  readonly commandRest?: readonly string[];
  /** Operands before the command that are not it (`direnv exec DIR cmd`). */
  readonly skip?: number;
  /** Tool specs (`node@20`) come before the command, which a `--` may separate (`mise x node@20 -- cmd`). */
  readonly toolSpecs?: boolean;
  /** The words are ONE shell command line (`bun exec 'cmd args'`). */
  readonly shellLine?: boolean;
}

const plain = (options: OptionGrammar, rest: Partial<Grammar> = {}): Grammar => ({
  options,
  ...rest,
});
const NPX = plain(G.NPM, { call: ["c", "call"] });
const NPX_BIN = plain(G.NPX, { call: ["c", "call"] });
const PNPM_EXEC = plain(G.PNPM, { shellMode: ["c", "shell-mode"] });
const PNPM_DLX = plain(G.PNPM_DLX, { shellMode: ["c", "shell-mode"] });
const YARN_RUN = plain(G.YARN);
const MISE = plain(G.MISE, { call: ["c", "command"], toolSpecs: true });
const NIX = plain(G.NIX, { commandRest: ["-c", "--command"] });

/** A manager: the grammar of its options before the subcommand, and the subcommands that start a program. */
export interface Manager {
  readonly global: OptionGrammar;
  readonly subcommands: ReadonlyMap<string, Grammar>;
}
const manager = (global: OptionGrammar, ...subs: Array<[string, Grammar]>): Manager => ({
  global,
  subcommands: new Map(subs),
});

export const MANAGERS: ReadonlyMap<string, Manager> = new Map([
  [
    "bun",
    manager(G.BUN_GLOBAL, ["x", plain(G.BUNX)], ["exec", plain(G.BUN_RUN, { shellLine: true })]),
  ],
  ["pnpm", manager(G.PNPM, ["exec", PNPM_EXEC], ["dlx", PNPM_DLX])],
  ["yarn", manager(G.YARN, ["exec", YARN_RUN], ["dlx", YARN_RUN])],
  ["npm", manager(G.NPM, ["exec", NPX], ["x", NPX])],
  ["volta", manager(G.VOLTA, ["run", plain(G.VOLTA)])],
  ["mise", manager(G.MISE, ["exec", MISE], ["x", MISE])],
  ["asdf", manager(G.ASDF, ["exec", plain(G.ASDF)])],
  ["direnv", manager(G.DIRENV, ["exec", plain(G.DIRENV, { skip: 1 })])],
  ["dotenvx", manager(G.DOTENVX, ["run", plain(G.DOTENVX)])],
  ["doppler", manager(G.DOPPLER, ["run", plain(G.DOPPLER, { call: ["command"] })])],
  ["op", manager(G.OP, ["run", plain(G.OP)])],
  ["lerna", manager(G.LERNA, ["exec", plain(G.LERNA)])],
  ["nx", manager(G.NX, ["exec", plain(G.NX)])],
  ["uv", manager(G.UV_RUN, ["run", plain(G.UV_RUN)])],
  ["pipx", manager(G.PIPX, ["run", plain(G.PIPX)])],
  ["poetry", manager(G.PLAIN_RUN, ["run", plain(G.PLAIN_RUN)])],
  ["pdm", manager(G.PLAIN_RUN, ["run", plain(G.PLAIN_RUN)])],
  ["rye", manager(G.PLAIN_RUN, ["run", plain(G.PLAIN_RUN)])],
  ["hatch", manager(G.PLAIN_RUN, ["run", plain(G.PLAIN_RUN)])],
  ["pipenv", manager(G.PLAIN_RUN, ["run", plain(G.PLAIN_RUN)])],
  ["conda", manager(G.CONDA, ["run", plain(G.CONDA)])],
  ["micromamba", manager(G.CONDA, ["run", plain(G.CONDA)])],
  ["devbox", manager(G.PLAIN_RUN, ["run", plain(G.PLAIN_RUN)])],
  ["flox", manager(G.FLOX, ["activate", plain(G.FLOX, { call: ["c", "command"] })])],
  ["nix", manager(G.NIX, ["shell", NIX], ["develop", NIX])],
  [
    "perf",
    manager(G.PERF, ["stat", plain(G.PERF)], ["record", plain(G.PERF)], ["trace", plain(G.PERF)]),
  ],
]);

export const BARE_RUNNERS: ReadonlyMap<string, Grammar> = new Map([
  ["bunx", plain(G.BUNX)],
  ["npx", NPX_BIN],
  ["pnpx", PNPM_DLX],
  ["uvx", plain(G.UVX)],
  ["dotenv", plain(G.DOTENV)],
  ["env-cmd", plain(G.ENV_CMD)],
  ["nix-shell", plain(G.NIX, { call: ["run", "command"] })],
]);

/** `corepack pnpm exec x`: corepack runs the package manager that follows it (`pnpm@9` names pnpm). */
const COREPACK_MANAGERS = new Set(["yarn", "yarnpkg", "pnpm", "pnpx", "npm", "npx"]);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** `node@20`, `npm@10`, `python@3.12`: a tool and its version, not a command. */
const TOOL_SPEC = /^[\w.-]+@[\w.*-]+$/;

/** The subcommands a manager reads itself: a word that is one of these is NOT a program to run. */
const BUN_BUILTINS = new Set([
  ..."x run test build install i add a remove rm update upgrade link unlink pm init create c repl outdated publish audit info patch why exec completions help".split(
    " ",
  ),
]);
const YARN_BUILTINS = new Set([
  ..."add bin cache config constraints dedupe dlx exec explain info init install link node npm pack patch plugin rebuild remove run set stage unlink unplug up upgrade version why workspace workspaces global help install-peerdeps import generate-lock-entry licenses outdated owner policies publish tag team test login logout list check autoclean".split(
    " ",
  ),
]);

/** A name a PATH program can have: not code (`bun -e 'x()'` is bun's own option), not a lone `-` (stdin). */
const PROGRAM_NAME = /^[A-Za-z0-9_@.][\w.@+-]*$/;

/** A word bun runs as a file (`./x.ts`, `src/x.ts`, `x.mjs`) rather than as a package script or a program. */
const LOOKS_LIKE_FILE = /\/|\.(?:[cm]?[jt]sx?|json|sh|py)$/;

/** What reading a runner's words found besides the command: the files its options name, and the options it could not place. */
interface Sink {
  readonly files: string[];
  readonly unplaced: string[];
}

/**
 * The options of `grammar` at `words[from..]`. The value of every option is a file the runner may read (`dotenv -e FILE`) and
 * nobody else will look at it once the runner is peeled, so it is collected.
 */
function readInto(grammar: OptionGrammar, words: readonly string[], from: number, sink: Sink) {
  const read = readOptions(grammar, words, from);
  for (const option of read.options) if (option.value !== undefined) sink.files.push(option.value);
  if (read.unplaced !== undefined) sink.unplaced.push(read.unplaced);
  return read;
}

/** The command a runner starts, from the words after its subcommand; null when it names none. */
function innerOf(words: readonly string[], grammar: Grammar, sink: Sink): readonly string[] | null {
  const read = readInto(grammar.options, words, 0, sink);
  const call = read.options.find((o) => grammar.call?.includes(o.name));
  if (call !== undefined) return ["sh", "-c", call.value ?? ""];
  const mode = read.options.find((o) => grammar.shellMode?.includes(o.name));
  if (mode !== undefined) return ["sh", "-c", words.slice(mode.at + 1).join(" ")];
  // `nix shell nixpkgs#git -c CMD ARGS`: installables stand before the option, so the spellings are searched for anywhere.
  const rest =
    grammar.commandRest === undefined
      ? -1
      : words.findIndex((w) => grammar.commandRest?.includes(w));
  if (rest >= 0 && words[rest + 1] !== undefined) {
    return [binaryOf(words[rest + 1] as string), ...words.slice(rest + 2)];
  }
  let k = read.end;
  if (grammar.shellLine === true)
    return k < words.length ? ["sh", "-c", words.slice(k).join(" ")] : null;
  if (grammar.toolSpecs) {
    while (words[k] !== undefined && TOOL_SPEC.test(words[k] as string)) k++;
    if (words[k] === "--") k++;
  }
  // `direnv exec DIR cmd`: the operand before the command is a directory the tool reads from.
  const skipped = grammar.skip ?? 0;
  sink.files.push(...words.slice(k, k + skipped));
  k += skipped;
  const spec = words[k];
  if (spec === undefined) return null;
  return [binaryOf(spec), ...words.slice(k + 1)];
}

/**
 * `bun run X …`, `yarn run X …`, `bun X …`, `yarn X …`: the PATH program X, or null when X is a package script, a file or
 * a builtin subcommand. `words` start at the first word after the manager's options.
 */
function scriptOrProgram(
  options: OptionGrammar,
  words: readonly string[],
  builtins: ReadonlySet<string>,
  isScript: ScriptLookup,
  sink: Sink,
): readonly string[] | null {
  const at = readInto(options, words, 0, sink).end;
  const target = words[at];
  if (target === undefined) return null;
  const script = target.includes(":") || isScript(target);
  return script ||
    !PROGRAM_NAME.test(target.replace(/^.*\//, "")) ||
    LOOKS_LIKE_FILE.test(target) ||
    builtins.has(programName(target))
    ? null
    : words.slice(at);
}

/** `cross-env A=1 B=2 cmd`: the assignments stay (the classifier reads them), `cross-env-shell` hands one string to a shell. */
function crossEnv(words: readonly string[], shell: boolean): readonly string[] | null {
  let k = 1;
  while (ASSIGNMENT_WORD.test(words[k] ?? "")) k++;
  const rest = words.slice(k);
  if (rest.length === 0) return null;
  return shell ? [...words.slice(1, k), "sh", "-c", rest.join(" ")] : words.slice(1);
}

/** `yarn workspace NAME CMD…` and `yarn workspaces foreach [options] CMD…`: the yarn command behind them. */
function yarnWorkspaces(
  words: readonly string[],
  at: number,
  isScript: ScriptLookup,
  sink: Sink,
): readonly string[] | null {
  const sub = words[at];
  if (sub === "workspace") return peel(["yarn", ...words.slice(at + 2)], isScript, sink);
  if (sub !== "workspaces" || words[at + 1] !== "foreach") return null;
  const end = readInto(G.YARN_FOREACH, words, at + 2, sink).end;
  return peel(["yarn", ...words.slice(end)], isScript, sink);
}

/** The words of the command a runner starts, and the files its own options name; null when it starts none. */
function peel(
  words: readonly string[],
  isScript: ScriptLookup,
  sink: Sink,
): readonly string[] | null {
  const first = words[0];
  if (first === undefined) return null;
  const name = programName(first);
  const bare = BARE_RUNNERS.get(name);
  if (bare) return innerOf(words.slice(1), bare, sink);
  if (name === "cross-env" || name === "cross-env-shell")
    return crossEnv(words, name.endsWith("shell"));
  if (name === "corepack") {
    const next = programName(words[1] ?? "").replace(/@.*$/, "");
    return COREPACK_MANAGERS.has(next) ? [next, ...words.slice(2)] : null;
  }
  const runner = MANAGERS.get(name);
  if (runner === undefined) return null;
  const at = readInto(runner.global, words, 1, sink).end;
  const sub = words[at];
  // `uv tool run`: the subcommand is the pair.
  const tool = name === "uv" && sub === "tool" && words[at + 1] === "run";
  const grammar = tool ? plain(G.UVX) : sub === undefined ? undefined : runner.subcommands.get(sub);
  if (grammar) return innerOf(words.slice(tool ? at + 2 : at + 1), grammar, sink);
  if (name === "yarn") {
    const through = yarnWorkspaces(words, at, isScript, sink);
    if (through !== null) return through;
  }
  // bun and yarn run a PATH program when the name is no script; npm and pnpm only run scripts.
  if (name !== "bun" && name !== "yarn") return null;
  const builtins = name === "bun" ? BUN_BUILTINS : YARN_BUILTINS;
  const options = name === "bun" ? G.BUN_RUN : G.YARN;
  // After `run` the name is a script or a program, never a subcommand (`bun run rm` is the PATH `rm`, `bun rm` is `bun remove`).
  if (sub === "run")
    return scriptOrProgram(options, words.slice(at + 1), new Set(), isScript, sink);
  // `bun NAME` only when NAME is the first word: an option before it (`bun -e CODE`, `bun --hot x.ts`) is bun's own.
  if (sub === undefined || at !== 1 || builtins.has(sub)) return null;
  return scriptOrProgram(options, words.slice(at), builtins, isScript, sink);
}

/**
 * The words of the command a runner really runs (`bunx -y @biomejs/biome@1.9.0 check x` → `biome check x`, `npx -c 'S'` →
 * `sh -c S`, `bun run echo hi` → `echo hi`), or null when `words[0]` is no runner, a runner with no command
 * (`bunx --version`), or the manager running one of the package's scripts (`bun run test`, `npm test`, `bun test`).
 */
export const peelRunner = (
  words: readonly string[],
  isScript: ScriptLookup,
): readonly string[] | null => peel(words, isScript, { files: [], unplaced: [] });

/**
 * `peelRunner`, the values of the runner's own options (files it reads, `dotenv -e FILE`), and the options it could not place. A runner that
 * starts no command but holds an option it could not place (`pnpm --zz-unlisted x exec CMD`: the `x` may be the option's value) is
 * `{ inner: null, … }`: the classifier asks, because the command after the option may be the one that runs (wave 11, rule 2).
 */
export function peelRunnerWithFiles(
  words: readonly string[],
  isScript: ScriptLookup,
): {
  readonly inner: readonly string[] | null;
  readonly files: readonly string[];
  readonly unplaced?: readonly string[];
} | null {
  const sink: Sink = { files: [], unplaced: [] };
  const inner = peel(words, isScript, sink);
  if (inner === null && sink.unplaced.length === 0) return null;
  return {
    inner,
    files: inner === null ? [] : sink.files,
    ...(sink.unplaced.length === 0 ? {} : { unplaced: sink.unplaced }),
  };
}
