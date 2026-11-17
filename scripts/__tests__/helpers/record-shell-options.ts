/**
 * Records, from the INSTALLED shells, which words run a command string (wave 12 part E1, E1-1, rule 12 for shells; round-9 R9-ADV-1, -2, -6, -17).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * Wave 11 read every shell with one bash-shaped rule and the real shells disagree (`bash +c`, `zsh -O`, `ksh -o -c`, `-oc VAL`, `csh -cc`). This
 * recorder runs bash, sh, dash, zsh, ksh, csh and tcsh with a deterministic set of option sequences followed by three echo-only operands
 * (`echo M1`, `echo M2`, `echo M3`), in a scratch directory (a shell option may create a file named like an option: `ksh -R x`) with a scratch HOME,
 * a scrubbed environment and a closed stdin, and writes which marker each shell really ran to a committed JSON fixture
 * (`scripts/__tests__/fixtures/harness-shell-options/<shell>.json`). `harness-shell-options-wave12e1.test.ts` holds the production reader
 * (`shell-command-string.ts`, `shell-grammars.ts`) against the fixtures on CI (no shell needed); `harness-shell-options-live-wave12e1.test.ts`
 * re-records a sample live where the shell is installed. Nothing here ever offers a shell anything but an `echo Mk` string.
 * Not a test file.
 */
import { spawnSync } from "node:child_process";
import { constants, accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exactProbes } from "./shell-probes";

export interface ShellProbe {
  /** The option words in front of the three operands. */
  readonly args: readonly string[];
  /** The markers the shell really ran, as digits: `"1"` ran M1, `"2"` ran M2, `""` ran none. */
  readonly ran: string;
}

export interface ShellFixture {
  readonly shell: string;
  /** The first line of `--version` (or the platform when the shell has none). */
  readonly version: string;
  readonly platform: string;
  readonly probes: readonly ShellProbe[];
}

export const SHELLS: readonly string[] = ["bash", "sh", "dash", "zsh", "ksh", "csh", "tcsh"];
export const OPERANDS: readonly string[] = ["echo M1", "echo M2", "echo M3"];
const BIN_DIRS = ["/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"];
const PROBE_TIMEOUT_MS = 5000;

/** The shell's binary in the system directories (a shell found through a developer's PATH is not the one recorded); undefined when absent. */
export function findShell(name: string): string | undefined {
  for (const dir of BIN_DIRS) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // not here
    }
  }
  return undefined;
}

const COMMON = [
  "-c",
  "+c",
  "-x",
  "-e",
  "--",
  "-",
  "-cx",
  "-xc",
  "-ec",
  "-ce",
  "-cl",
  "-lc",
  "-s",
  "-i",
  "-l",
  "-u",
  "-f",
  "-n",
  "+x",
  "-o",
  "+o",
  "-O",
  "+O",
  "-oc",
  "-co",
  "-Oc",
  "-eoc",
];
// no file-writing option (`ksh -R FILE`) and nothing that reads a file we did not make
const SPECIFIC: Readonly<Record<string, readonly string[]>> = {
  bash: [
    "--norc",
    "--noprofile",
    "--posix",
    "--login",
    "--rcfile",
    "--init-file",
    "--verbose",
    "+Oc",
    "-oerrexit",
    "-p",
    "-r",
  ],
  sh: ["--norc", "--posix", "--login", "--rcfile", "+Oc", "-p"],
  dash: ["-C", "-v", "-b", "-m", "-I", "+oc"],
  zsh: [
    "--login",
    "--no-rcs",
    "--rcs",
    "-b",
    "-d",
    "-k",
    "-m",
    "-r",
    "-oerrexit",
    "-onomatch",
    "-eo",
    "+oc",
    "-cO",
  ],
  ksh: ["--norc", "--login", "--verbose", "-p", "-oxtrace", "+oc", "-D"],
  csh: ["-b", "-d", "-q", "-t", "-v", "-V", "-X", "-cc", "-ccc", "-bc", "-cb", "-fc", "-cf", "-cn"],
  tcsh: [
    "-b",
    "-d",
    "-q",
    "-t",
    "-v",
    "-V",
    "-X",
    "-cc",
    "-ccc",
    "-bc",
    "-cb",
    "-fc",
    "-cf",
    "-cn",
  ],
};
// words an option may take as its value: a valid option name, a valid shopt name, a file that does not exist
const VALUES = ["errexit", "extglob", "/nonexistent"];

const vocabulary = (shell: string): string[] => [
  ...new Set([...COMMON, ...(SPECIFIC[shell] ?? []), ...VALUES]),
];

/** A deterministic generator (a linear congruential one): the same sequences on every machine. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const CORE_PAIRS = 22;
const RANDOM_SEQUENCES = 100;

/** The sequences recorded for `shell`: every word alone, every ordered pair of the core words, and seeded random runs of three to four words. */
export function probeSequences(shell: string): string[][] {
  const words = vocabulary(shell);
  const core = words.slice(0, CORE_PAIRS);
  const out: string[][] = [[], ...words.map((w) => [w])];
  for (const a of core) for (const b of core) out.push([a, b]);
  const next = lcg(shell.length * 7919 + 1);
  for (let i = 0; i < RANDOM_SEQUENCES; i++) {
    const length = 3 + Math.floor(next() * 2);
    out.push(Array.from({ length }, () => words[Math.floor(next() * words.length)] as string));
  }
  out.push(...exactProbes(shell).map(([args]) => args));
  const seen = new Set<string>();
  return out.filter((seq) => {
    const key = seq.join("\u0001");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Which markers did a shell run: `M1` at the start of a line or followed by a space (ksh runs `echo M1 'echo M2'` and prints `M1 echo M2`). */
export const markersIn = (stdout: string): string =>
  ["1", "2", "3"].filter((n) => new RegExp(`(^|\\n)M${n}( |\\n|$)`).test(stdout)).join("");

/** One probe: the shell run with `args` and the three operands in a fresh scratch directory and HOME; an exec error or a timeout is thrown, never read as "ran nothing". */
export function runProbe(binary: string, args: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "cw-shell-record-"));
  try {
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    const result = spawnSync(binary, [...args, ...OPERANDS], {
      cwd: work,
      env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb" },
      input: "",
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error !== undefined)
      throw new Error(`${binary} ${args.join(" ")}: ${result.error.message}`);
    return markersIn(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The first line the shell says about itself; some (dash) have no version flag. */
export function shellVersion(binary: string): string {
  const result = spawnSync(binary, ["--version"], {
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
    input: "",
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
  const first = `${result.stdout}${result.stderr}`.split("\n")[0]?.trim() ?? "";
  return /version|\d+\.\d+/i.test(first) ? first : "no version flag";
}

/** Records `shell` with the given sequences (all of `probeSequences` by default); undefined when the shell is not installed. */
export function recordShell(
  shell: string,
  only?: readonly (readonly string[])[],
): ShellFixture | undefined {
  const binary = findShell(shell);
  if (binary === undefined) return undefined;
  const probes = (only ?? probeSequences(shell)).map((args) => ({
    args,
    ran: runProbe(binary, args),
  }));
  return {
    shell,
    version: shellVersion(binary),
    platform: `${process.platform}-${process.arch}`,
    probes,
  };
}

export const FIXTURE_DIR = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "harness-shell-options",
);

// CLI: `bun scripts/__tests__/helpers/record-shell-options.ts [--write] [shell ...]`
if (process.argv[1]?.endsWith("record-shell-options.ts") === true) {
  const write = process.argv.includes("--write");
  const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const shell of SHELLS.filter((s) => names.length === 0 || names.includes(s))) {
    const fixture = recordShell(shell);
    if (fixture === undefined) {
      console.log(`${shell}: not installed, nothing recorded`);
      continue;
    }
    const ran = fixture.probes.filter((p) => p.ran !== "").length;
    console.log(
      `${shell} (${fixture.version}): ${fixture.probes.length} probes, ${ran} ran a marker`,
    );
    if (write) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(join(FIXTURE_DIR, `${shell}.json`), `${JSON.stringify(fixture)}\n`);
    }
  }
}
