/**
 * Records the long options of `git push`, `git add` and `git update-index` from the INSTALLED git (wave 12, part F, F-4 and F-5; rule 12, W11).
 * ------------------------------------------------------------------------------------------------------------------
 * git (parse-options.c) accepts an unambiguous PREFIX of a long option (`git add --fo .env` is `--force`) and refuses an ambiguous
 * one (`git push --forc` could be `--force`, `--force-with-lease` or `--force-if-includes`). The rules that read a push or an add
 * (`git-push-refs.ts`, `git-add-force.ts`) resolve prefixes with `git-long-options.ts`; this recorder produces the independent
 * evidence from the real tool, a JSON fixture per command under `fixtures/harness-db-tool-options/git/`:
 *
 *   bun scripts/__tests__/helpers/record-git-options.ts          re-record and write the fixtures
 *   bun scripts/__tests__/helpers/record-git-options.ts --check  re-record and report a difference from the fixtures
 *
 * What is recorded and how (nothing reaches a non-local host or changes a repository outside the scratch directory: a throwaway bare
 * remote and work tree in a temporary directory, HOME inside it, no global or system config, `-n` (dry run) on every push and add, a
 * closed stdin):
 *   - the options: the names printed by `git <command> -h` (`--[no-]x` is `x` and `no-x`), with their short letters;
 *   - flag or value: the real parser. A flag given `=x` fails with "takes no value" before any repository work happens, a valued option
 *     given last fails with "requires a value";
 *   - abbreviations: every prefix of every option, every one-letter and every two-letter string and `no-` plus every letter (a hidden
 *     option shows as an `ok` prefix no listed name starts with), run as `--PREFIX` followed by an option that does not exist, so the
 *     command itself never runs: `ambiguous` (git names the candidates), `unknown`, or `ok` (it resolved to exactly one option and git
 *     went on to the sentinel).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GIT_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "harness-db-tool-options",
  "git",
);

export type Outcome = "ok" | "ambiguous" | "unknown";
export type GitCommand = "push" | "add" | "update-index";

export interface RecordedGitOption {
  readonly name: string;
  /** A long option that takes the next word (or `=value`); `optional`: only with `=`. */
  readonly takesValue: boolean | "optional";
}

export interface GitFixture {
  readonly tool: "git";
  readonly command: `git ${GitCommand}`;
  readonly version: string;
  readonly options: readonly RecordedGitOption[];
  readonly shortOptions: readonly string[];
  readonly abbreviations: Readonly<Record<string, Outcome>>;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

export const gitPath = (): string | null => {
  const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const path = found.stdout.trim();
  return found.status === 0 && path !== "" ? path : null;
};

/** A throwaway repository pair and the scrubbed environment every probe runs in. */
function scratch(git: string): { work: string; env: NodeJS.ProcessEnv; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cw-git-opts-"));
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(git)}:/usr/bin:/bin`,
    HOME: home,
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    // `git add --edit` would start an editor: `true` is the one that does nothing.
    GIT_EDITOR: "true",
    EDITOR: "true",
    VISUAL: "true",
  };
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(git, args, { cwd, env, encoding: "utf8", timeout: 20_000, input: "" });
  run(root, "init", "-q", "--bare", "remote.git");
  run(root, "init", "-q", "-b", "topic", "work");
  const work = join(root, "work");
  run(work, "config", "user.email", "a@b.c");
  run(work, "config", "user.name", "t");
  writeFileSync(join(work, "f"), "x\n");
  run(work, "add", "f");
  run(work, "commit", "-q", "-m", "init");
  run(work, "remote", "add", "origin", "../remote.git");
  return { work, env, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Run `git <command> <args>` in the scratch work tree; the combined output, lower case not applied. */
function probe(
  git: string,
  s: { work: string; env: NodeJS.ProcessEnv },
  command: GitCommand,
  args: readonly string[],
): string {
  // `-n` (dry run) on push and add; `git update-index` has none, and only ever touches the scratch repository.
  const r = spawnSync(git, [command, ...(command === "update-index" ? [] : ["-n"]), ...args], {
    cwd: s.work,
    env: s.env,
    encoding: "utf8",
    timeout: 20_000,
    input: "",
  });
  if (r.error !== undefined || r.signal !== null)
    throw new Error(
      `probe of git ${command} ${args.join(" ")} did not finish: ${r.error ?? r.signal}`,
    );
  return `${r.stdout}${r.stderr}`;
}

/**
 * A probe never lets the command run: `--PREFIX` is followed by an option that does not exist, so git's parser either refuses the prefix
 * (`ambiguous` names the candidates, `unknown` complains about the prefix itself) or accepts it and then complains about the sentinel
 * (`ok`). An option that takes a value consumes the sentinel, and the command then fails or runs in the scratch repository: also `ok`.
 */
export const SENTINEL = "zz-probe-sentinel";

export function outcomeOf(output: string): Outcome {
  if (/ambiguous option/i.test(output)) return "ambiguous";
  // git quotes the name as `name' (push, add) or 'name' (update-index).
  const complained = /unknown option [`']([^`']*)'/i.exec(output)?.[1];
  return complained !== undefined && complained !== SENTINEL ? "unknown" : "ok";
}

/** The long names and short letters `git <command> -h` prints: `--[no-]x` is `x` and `no-x`. */
export function namesFromUsage(usage: string): { names: string[]; shorts: string[] } {
  const names = new Set<string>();
  const shorts = new Set<string>();
  for (const line of usage.split("\n")) {
    const m = /^\s{4}(?:-(\w),\s+)?--(\[no-\])?([\w-]+)/.exec(line);
    if (m === null) continue;
    if (m[1] !== undefined) shorts.add(m[1]);
    names.add(m[3] as string);
    if (m[2] !== undefined) names.add(`no-${m[3]}`);
  }
  return { names: [...names].sort(), shorts: [...shorts].sort() };
}

/**
 * Flag or value: a valued option given last fails with "requires a value" (`--cacheinfo` says "expects"); a flag given `=x` fails with
 * "takes no value"; neither: it takes a value only with `=`.
 */
function arityOf(
  git: string,
  s: { work: string; env: NodeJS.ProcessEnv },
  command: GitCommand,
  name: string,
): boolean | "optional" {
  if (/requires a value|expects/i.test(probe(git, s, command, [`--${name}`]))) return true;
  return /takes no value/i.test(probe(git, s, command, [`--${name}=x`])) ? false : "optional";
}

/** The installed git's version, as `git --version` prints it. */
export const installedGitVersion = (git: string): string =>
  /git version (\S+)/.exec(spawnSync(git, ["--version"], { encoding: "utf8" }).stdout)?.[1] ??
  "unknown";

/** The long names and short letters the installed git prints for `git <command> -h`. */
export function recordNames(
  git: string,
  command: GitCommand,
): { names: string[]; shorts: string[] } {
  const s = scratch(git);
  try {
    const help = spawnSync(git, [command, "-h"], {
      cwd: s.work,
      env: s.env,
      encoding: "utf8",
      input: "",
    });
    return namesFromUsage(`${help.stdout}${help.stderr}`);
  } finally {
    s.done();
  }
}

/** The outcome of `--PREFIX` for each prefix, from the installed git (the command itself never runs: see SENTINEL). */
export function recordPrefixes(
  git: string,
  command: GitCommand,
  prefixes: Iterable<string>,
): Record<string, Outcome> {
  const s = scratch(git);
  try {
    const out: Record<string, Outcome> = {};
    for (const prefix of [...new Set(prefixes)].sort()) {
      out[prefix] = outcomeOf(probe(git, s, command, [`--${prefix}`, `--${SENTINEL}`]));
    }
    return out;
  } finally {
    s.done();
  }
}

/** Every prefix of each name, one letter up to the whole name. */
export const prefixesOf = (names: readonly string[]): string[] =>
  names.flatMap((name) => Array.from({ length: name.length }, (_, n) => name.slice(0, n + 1)));

/** Record one command from the installed git: the full fixture (every prefix of every name, and every short string, for hidden options). */
export function recordGit(git: string, command: GitCommand): GitFixture {
  const { names, shorts } = recordNames(git, command);
  const s = scratch(git);
  try {
    const options: RecordedGitOption[] = names.map((name) => ({
      name,
      takesValue: arityOf(git, s, command, name),
    }));
    const short = [...LETTERS].flatMap((a) => [
      a,
      `no-${a}`,
      ...[...`${LETTERS}-`].map((b) => `${a}${b}`),
    ]);
    return {
      tool: "git",
      command: `git ${command}`,
      version: installedGitVersion(git),
      options,
      shortOptions: shorts,
      abbreviations: recordPrefixes(git, command, [...prefixesOf(names), ...short]),
    };
  } finally {
    s.done();
  }
}

if (import.meta.main) {
  const git = gitPath();
  if (git === null) throw new Error("git is not installed: nothing to record");
  const check = process.argv.includes("--check");
  mkdirSync(GIT_FIXTURE_DIR, { recursive: true });
  let differs = false;
  for (const command of ["push", "add", "update-index"] as const) {
    const fixture = recordGit(git, command);
    const file = join(GIT_FIXTURE_DIR, `git-${command}.${fixture.version}.json`);
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    if (check) {
      let old = "";
      try {
        old = readFileSync(file, "utf8");
      } catch {
        // no fixture yet: a difference
      }
      if (old !== text) {
        differs = true;
        console.log(`DIFFERS ${file}`);
      }
    } else {
      writeFileSync(file, text);
      console.log(
        `wrote ${file} (${fixture.options.length} options, ${Object.keys(fixture.abbreviations).length} prefixes)`,
      );
    }
  }
  if (differs) process.exit(1);
}
