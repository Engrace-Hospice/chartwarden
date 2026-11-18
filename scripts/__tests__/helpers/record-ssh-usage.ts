/**
 * Rule 12 for the ssh family (wave 13 part B; round-10 CR-1, CR-3): the valued option letters of ssh, scp, sftp, ssh-keyscan and ssh-copy-id are
 * recorded from the usage line each INSTALLED program prints when it is started with nothing to connect to (no network, no operand), and
 * `fixtures/harness-ssh-options/openssh.<version>.json` holds the text. `lettersOf` reads a usage line: `[-46AaC]` is flags, `[-c cipher]` is a valued
 * letter, `[-i [identity_file]]` an optional value (ssh-copy-id: read as a flag). Two builds are recorded where both exist: the first ssh on PATH
 * (Homebrew's on this machine) and the system one in /usr/bin (Apple's, its own version and usage lines); the guard cannot know which one a command
 * starts. Re-record: `bun scripts/__tests__/helpers/record-ssh-usage.ts --write`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "harness-ssh-options");
/** The program and the arguments that make it print its usage and exit (none of them connects anywhere). */
export const USAGE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  ssh: [],
  scp: [],
  sftp: [],
  "ssh-keyscan": [],
  "ssh-copy-id": ["-h"],
};

export interface SshUsageFixture {
  readonly version: string;
  readonly usage: Readonly<Record<string, string>>;
}

const scrubbedEnv = (home: string) => ({ PATH: "/usr/bin:/bin", HOME: home, LANG: "C" });
const PROGRAMS = Object.keys(USAGE_COMMANDS);
const hasSsh = (dir: string): boolean => existsSync(join(dir, "ssh"));

/** The directories that hold an ssh a developer may run: the first one on PATH and `/usr/bin`. */
export function sshDirectories(): string[] {
  const onPath = (process.env.PATH ?? "").split(":").find((dir) => dir !== "" && hasSsh(dir));
  return [...new Set([onPath, "/usr/bin"])].filter(
    (dir): dir is string => dir !== undefined && hasSsh(dir),
  );
}

/** The OpenSSH version word (`OpenSSH_10.6p1`) of the ssh in `dir`, or undefined when it does not answer. */
export function sshVersionIn(dir: string): string | undefined {
  const r = spawnSync(join(dir, "ssh"), ["-V"], { encoding: "utf8", timeout: 5000 });
  return r.error === undefined
    ? /^(OpenSSH_[\w.]+)/.exec(`${r.stderr}${r.stdout}`)?.[1]
    : undefined;
}

/** What the `program` in `dir` prints as its usage (stderr and stdout, trailing blank lines removed). */
export function readUsage(dir: string, program: string): string {
  const home = mkdtempSync(join(tmpdir(), "cw-ssh-usage-"));
  const r = spawnSync(join(dir, program), [...(USAGE_COMMANDS[program] ?? [])], {
    encoding: "utf8",
    env: scrubbedEnv(home),
    timeout: 5000,
  });
  return `${r.stderr}${r.stdout}`.replace(/\s+$/, "");
}

/** The flag letters and the valued letters a usage text lists. */
export function lettersOf(usage: string): { flags: string; valued: string } {
  const flags = new Set<string>();
  const valued = new Set<string>();
  for (const m of usage.matchAll(/\[-([A-Za-z0-9?|-]+)\]/g)) {
    for (const letter of (m[1] as string).replace(/\|-/g, "")) flags.add(letter);
  }
  // `[-c cipher]` and `[-D [bind_address:]port]` take a value; `[-i [identity_file]]` takes one only sometimes (a flag here).
  for (const m of usage.matchAll(/\[-([A-Za-z]) (?!\[\w+\]\])[\w[]/g)) valued.add(m[1] as string);
  for (const m of usage.matchAll(/\[-([A-Za-z]) \[\w+\]\]/g)) flags.add(m[1] as string);
  const sorted = (set: Set<string>) => [...set].sort().join("");
  return { flags: sorted(flags), valued: sorted(valued) };
}

/** One recording of the programs of the ssh family that `dir` holds (Homebrew's OpenSSH has no ssh-copy-id), or undefined when its ssh does not answer. */
export function recordSshUsage(dir: string): SshUsageFixture | undefined {
  const version = sshVersionIn(dir);
  if (version === undefined) return undefined;
  const there = PROGRAMS.filter((p) => existsSync(join(dir, p)));
  return { version, usage: Object.fromEntries(there.map((p) => [p, readUsage(dir, p)])) };
}

if (process.argv.includes("--write")) {
  for (const dir of sshDirectories()) {
    const fixture = recordSshUsage(dir);
    if (fixture === undefined) continue;
    const file = join(FIXTURE_DIR, `openssh.${fixture.version.replace("OpenSSH_", "")}.json`);
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
}
