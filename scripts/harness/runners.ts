/**
 * Package runners: the programs that start another program (wave 8, T1; round-6 ADV6-1, CR6-2, CR6-8).
 * ------------------------------------------------------------------------------------------------
 * `bunx git push origin main`, `npx rm .claude/settings.json`, `bun x cp x CLAUDE.md`, `pnpm exec sh -c '…'`, `yarn dlx
 * cp …`, `npm exec -- cp …`, `npx -c 'cp x CLAUDE.md'`, `bun run cp x CLAUDE.md`: the program that runs is the one after
 * the runner, so it is judged by every rule as if it had been typed alone. This is the ONE reader of a runner's own
 * options (two earlier readers disagreed on `bun run X`); `peelRunner` returns the words of the command that really runs,
 * and the classifier applies it where it finds a command's program, so a runner under `env`, `nice`, `timeout`, `time` or
 * another runner is peeled too.
 *
 * What a runner starts: `bunx|npx|pnpx X`, `bun x X`, `pnpm|yarn|npm exec|dlx X` and `npm x X` run a package binary or a
 * PATH program; `-c STR`, `--call STR`, `--call=STR` and pnpm's `--shell-mode` hand a string to a shell. `bun run X`,
 * `yarn run X`, `bun X` and `yarn X` run a package SCRIPT when X is a key of the nearest package.json (or has a colon, as
 * `arch:fitness`), a file when X looks like one, a builtin subcommand (`bun test`, `yarn install`), and otherwise the PATH
 * program X (`bun run echo hello` runs `echo`: checked). `npm run X` and `pnpm run X` only run scripts, so they are no
 * runner. A text heuristic: an option with a value this table does not know is read as a flag. Pure.
 */

/** Does this name a package script of the package the command runs in? The caller knows; a colon always says yes. */
export type ScriptLookup = (name: string) => boolean;

const SPEC_VERSION = /(?<=.)@[^@/]*$/;
const SCOPE = /^@[^/]+\//;
/** `@biomejs/biome@1.9.0` and `shellcheck@latest` name the binary `biome` and `shellcheck`. */
const binaryOf = (spec: string): string => spec.replace(SCOPE, "").replace(SPEC_VERSION, "");

const baseName = (w: string): string => w.replace(/\\(.)/g, "$1").replace(/^.*\//, "");

/** How a runner reads the words after its subcommand. */
interface Grammar {
  /** Options that take the next word as their value. */
  readonly valued: RegExp;
  /** Options whose value is a command line for a shell (`-c STR`, `--call STR`). */
  readonly call: RegExp;
  /** Options that make the rest of the words ONE shell string (pnpm's `-c` / `--shell-mode` is a flag). */
  readonly shellMode: RegExp;
}

const NEVER = /^$/;
const NPX: Grammar = {
  valued:
    /^(?:-p|--package|--prefix|--cache|--userconfig|--registry|--loglevel|-w|--workspace|--node-arg)$/,
  call: /^(?:-c|--call)$/,
  shellMode: NEVER,
};
const BUNX: Grammar = { valued: /^(?:-p|--package)$/, call: NEVER, shellMode: NEVER };
const PNPM: Grammar = {
  valued: /^(?:-p|--package|--filter|-F|--workspace-root|--reporter|--registry)$/,
  call: NEVER,
  shellMode: /^(?:-c|--shell-mode)$/,
};
const YARN: Grammar = { valued: /^(?:-p|--package|--cwd)$/, call: NEVER, shellMode: NEVER };

/** The grammar of `<manager> <subcommand>`, for the subcommands that start a program. */
const SUBCOMMAND_RUNNERS: ReadonlyMap<string, ReadonlyMap<string, Grammar>> = new Map([
  ["bun", new Map([["x", BUNX]])],
  [
    "pnpm",
    new Map([
      ["exec", PNPM],
      ["dlx", PNPM],
    ]),
  ],
  [
    "yarn",
    new Map([
      ["exec", YARN],
      ["dlx", YARN],
    ]),
  ],
  [
    "npm",
    new Map([
      ["exec", NPX],
      ["x", NPX],
    ]),
  ],
]);

const BARE_RUNNERS: ReadonlyMap<string, Grammar> = new Map([
  ["bunx", BUNX],
  ["npx", NPX],
  ["pnpx", PNPM],
]);

/** Options a package manager takes BEFORE its subcommand (`pnpm -C dir exec`, `npm --prefix x exec`, `bun --cwd d run`). */
const MANAGER_VALUED =
  /^(?:-C|--dir|--cwd|--filter|-F|--prefix|-w|--workspace|--registry|--userconfig|--cache|--loglevel|--config|-c|--env-file|--preload|-r|--tsconfig-override|--elide-lines)$/;

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

/** Words after the runner's options: skip options (those in `valued` take a value), stop at `--` (dropped) or the first operand. */
function operandsFrom(words: readonly string[], valued: RegExp): number {
  let k = 0;
  while (k < words.length) {
    const w = words[k] as string;
    if (w === "--") return k + 1;
    if (!w.startsWith("-") || w === "-") return k;
    k += valued.test(w) ? 2 : 1;
  }
  return k;
}

/** The command a runner starts, from the words after its subcommand; null when it names none. */
function innerOf(words: readonly string[], grammar: Grammar): readonly string[] | null {
  let k = 0;
  while (k < words.length) {
    const w = words[k] as string;
    if (w === "--") {
      k++;
      break;
    }
    if (!w.startsWith("-") || w === "-") break;
    const eq = w.indexOf("=");
    const name = eq < 0 ? w : w.slice(0, eq);
    if (grammar.call.test(name)) {
      const value = eq < 0 ? (words[k + 1] ?? "") : w.slice(eq + 1);
      return ["sh", "-c", value];
    }
    // `-c'cmd'`: the short option with its value attached.
    if (eq < 0 && /^-[A-Za-z]./.test(w) && grammar.call.test(w.slice(0, 2))) {
      return ["sh", "-c", w.slice(2)];
    }
    if (grammar.shellMode.test(name)) return ["sh", "-c", words.slice(k + 1).join(" ")];
    // `-pPKG` and `--package=PKG`: the value is attached; `-p PKG` takes the next word.
    const attached = eq >= 0 || (/^-[A-Za-z]./.test(w) && grammar.valued.test(w.slice(0, 2)));
    k += grammar.valued.test(name) && !attached ? 2 : 1;
  }
  const spec = words[k];
  if (spec === undefined) return null;
  return [binaryOf(spec), ...words.slice(k + 1)];
}

/** The subcommand of `<manager> …` and the index after it, skipping the manager's own options. */
function subcommand(words: readonly string[]): { sub: string | undefined; at: number } {
  const at = operandsFrom(words.slice(1), MANAGER_VALUED) + 1;
  return { sub: words[at], at };
}

/**
 * `bun run X …`, `yarn run X …`, `bun X …`, `yarn X …`: the PATH program X, or null when X is a package script, a file or
 * a builtin subcommand. `words` start at the first word after the manager's options.
 */
function scriptOrProgram(
  words: readonly string[],
  builtins: ReadonlySet<string>,
  isScript: ScriptLookup,
): readonly string[] | null {
  const at = operandsFrom(words, MANAGER_VALUED);
  const target = words[at];
  if (target === undefined) return null;
  const script = target.includes(":") || isScript(target);
  return script ||
    !PROGRAM_NAME.test(target.replace(/^.*\//, "")) ||
    LOOKS_LIKE_FILE.test(target) ||
    builtins.has(baseName(target))
    ? null
    : words.slice(at);
}

/**
 * The words of the command a runner really runs (`bunx -y @biomejs/biome@1.9.0 check x` → `biome check x`, `npx -c 'S'` →
 * `sh -c S`, `bun run echo hi` → `echo hi`), or null when `words[0]` is no runner, a runner with no command
 * (`bunx --version`), or the manager running one of the package's scripts (`bun run test`, `npm test`, `bun test`).
 */
export function peelRunner(
  words: readonly string[],
  isScript: ScriptLookup,
): readonly string[] | null {
  const first = words[0];
  if (first === undefined) return null;
  const name = baseName(first);
  const bare = BARE_RUNNERS.get(name);
  if (bare) return innerOf(words.slice(1), bare);
  const subcommands = SUBCOMMAND_RUNNERS.get(name);
  if (subcommands === undefined) return null;
  const { sub, at } = subcommand(words);
  const grammar = sub === undefined ? undefined : subcommands.get(sub);
  if (grammar) return innerOf(words.slice(at + 1), grammar);
  // bun and yarn run a PATH program when the name is no script; npm and pnpm only run scripts.
  if (name !== "bun" && name !== "yarn") return null;
  const builtins = name === "bun" ? BUN_BUILTINS : YARN_BUILTINS;
  // After `run` the name is a script or a program, never a subcommand (`bun run rm` is the PATH `rm`, `bun rm` is `bun remove`).
  if (sub === "run") return scriptOrProgram(words.slice(at + 1), new Set(), isScript);
  // `bun NAME` only when NAME is the first word: an option before it (`bun -e CODE`, `bun --hot x.ts`) is bun's own.
  if (sub === undefined || at !== 1 || builtins.has(sub)) return null;
  return scriptOrProgram(words.slice(at), builtins, isScript);
}
