/**
 * Records how the INSTALLED awk reads its options (wave 12, part F, F-6; round-9 R9-CR-4; rule 12).
 * ------------------------------------------------------------------------------------------------------------------
 * `text-programs.ts` judges the program text of an awk command line. Wave 11 took the first non-option word as the program and skipped the
 * value of `-F -v -f` only, so an option another awk gives a value (`gawk -i inplace`, `-l time`, `-E file`, `-e SRC`, `mawk -W opt`) made
 * its value the "program" and the real program was never read. This recorder produces the evidence about the awk that is installed here (macOS:
 * BWK awk 20200816; gawk and mawk are NOT installed on the machine that recorded it, so their options are listed as UNVERIFIED in
 * `awk/awk-unverified.json` and the reader treats every option it does not know for certain as one that takes no value):
 *
 *   bun scripts/__tests__/helpers/record-awk-options.ts          re-record and write `awk/awk.<flavour>-<version>.json`
 *   bun scripts/__tests__/helpers/record-awk-options.ts --check  re-record and report a difference from the fixture
 *
 * How (echo-only: the program is `BEGIN{print "HIT"}`; nothing is read or written outside a throwaway directory, HOME inside it, a closed stdin):
 *   - `awk -X 'BEGIN{print "HIT"}'` prints HIT when X took no value (BWK awk also says "unknown option -X ignored" for a letter it does not know, and
 *     goes on: the NEXT word is the program); it does not print HIT when X took the program as its value (`-F`: "no program given", `-v`: "invalid
 *     -v option argument", `-f`: "can't open file BEGIN…").
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AWK_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "harness-db-tool-options",
  "awk",
);

export type AwkFlavour = "bwk" | "gawk" | "mawk" | "unknown";

export interface RecordedAwkOption {
  readonly option: string;
  /** It consumed the program word: its value. */
  readonly takesValue: boolean;
  /** The awk said "unknown option … ignored" and went on (the next word is the program). */
  readonly ignored: boolean;
  /** It printed a version and exited (no program ran). */
  readonly exits: boolean;
}

export interface AwkFixture {
  readonly tool: "awk";
  readonly flavour: AwkFlavour;
  readonly version: string;
  readonly probe: string;
  readonly options: readonly RecordedAwkOption[];
}

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The options probed: every letter, and the long and version spellings the awks use. */
export const PROBED_OPTIONS: readonly string[] = [
  ...[...LETTERS].map((c) => `-${c}`),
  "--version",
  "-version",
  "--csv",
  "--help",
  "--source",
  "--include",
  "--load",
  "--exec",
  "--file",
];
const PROGRAM = 'BEGIN{print "HIT"}';

export const awkPath = (): string | null => {
  const found = spawnSync("sh", ["-c", "command -v awk"], { encoding: "utf8" });
  const path = found.stdout.trim();
  return found.status === 0 && path !== "" ? path : null;
};

function scratch(): { cwd: string; env: NodeJS.ProcessEnv; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cw-awk-opts-"));
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return {
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C" },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(awk: string, s: { cwd: string; env: NodeJS.ProcessEnv }, args: readonly string[]) {
  const r = spawnSync(awk, [...args], {
    cwd: s.cwd,
    env: s.env,
    encoding: "utf8",
    timeout: 8000,
    input: "",
  });
  if (r.error !== undefined || r.signal !== null)
    throw new Error(`awk ${args.join(" ")} did not finish: ${r.error ?? r.signal}`);
  return { out: r.stdout, err: r.stderr };
}

export function flavourOf(versionText: string): { flavour: AwkFlavour; version: string } {
  if (/GNU Awk/i.test(versionText))
    return { flavour: "gawk", version: /GNU Awk (\S+?),?\s/i.exec(versionText)?.[1] ?? "unknown" };
  if (/mawk/i.test(versionText))
    return { flavour: "mawk", version: /mawk (\S+)/i.exec(versionText)?.[1] ?? "unknown" };
  const bwk = /awk version (\d+)/i.exec(versionText)?.[1];
  return bwk === undefined
    ? { flavour: "unknown", version: "unknown" }
    : { flavour: "bwk", version: bwk };
}

/** Record how the installed awk reads each probed option. */
export function recordAwk(awk: string): AwkFixture {
  const s = scratch();
  try {
    const versionRun = run(awk, s, ["--version"]);
    const { flavour, version } = flavourOf(`${versionRun.out}${versionRun.err}`);
    const options = PROBED_OPTIONS.map((option): RecordedAwkOption => {
      const { out, err } = run(awk, s, [option, PROGRAM]);
      const printed = out.includes("HIT");
      const exits = !printed && /version/i.test(`${out}${err}`) && !/invalid|can't open/i.test(err);
      return {
        option,
        takesValue: !printed && !exits,
        ignored: /unknown option .* ignored/i.test(err),
        exits,
      };
    });
    return { tool: "awk", flavour, version, probe: `awk OPTION '${PROGRAM}'`, options };
  } finally {
    s.done();
  }
}

if (import.meta.main) {
  const awk = awkPath();
  if (awk === null) throw new Error("awk is not installed: nothing to record");
  const fixture = recordAwk(awk);
  const file = join(AWK_FIXTURE_DIR, `awk.${fixture.flavour}-${fixture.version}.json`);
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    let old = "";
    try {
      old = readFileSync(file, "utf8");
    } catch {
      // no fixture yet: a difference
    }
    if (old !== text) {
      console.log(`DIFFERS ${file}`);
      process.exit(1);
    }
  } else {
    mkdirSync(AWK_FIXTURE_DIR, { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote ${file} (${fixture.options.length} options)`);
  }
}
