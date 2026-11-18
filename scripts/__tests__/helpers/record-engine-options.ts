/**
 * Rule 12 for the container engines (wave 13 part B2; round-10 B3): the short options of `docker`, `podman` and `docker-compose` that stand before the
 * subcommand are recorded from the INSTALLED tools' `--help` and `fixtures/harness-engine-options/<tool>.<version>.json` holds the entry lines. An entry
 * with a type word after its long name (`-c, --context string`) is valued, one without (`-D, --debug`) is a flag. `docker -cprod ps` names the context
 * `prod` with the value attached to the letter, and `docker -Dc prod ps` clusters a flag with a valued letter: `engine-short-options.ts` reads both from
 * the recorded letters. nerdctl and podman-compose are not installed (their letters are documentation, listed unverified). Only `--help` and `--version`
 * are run, with HOME in a scratch directory. Re-record: `bun scripts/__tests__/helpers/record-engine-options.ts --write`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "harness-engine-options");

export interface EngineFixture {
  readonly tool: string;
  readonly version: string;
  readonly lines: readonly string[];
}

/** The program, the arguments that print its help and its version, and the version's pattern. */
export const ENGINES: Readonly<
  Record<string, { help: readonly string[]; version: readonly string[]; pattern: RegExp }>
> = {
  docker: { help: ["--help"], version: ["--version"], pattern: /Docker version ([\w.]+)/ },
  podman: { help: ["--help"], version: ["--version"], pattern: /podman version ([\w.]+)/ },
  "docker-compose": {
    help: ["--help"],
    version: ["--version"],
    pattern: /Docker Compose version v?([\w.]+)/,
  },
};

function run(program: string, args: readonly string[]): string | undefined {
  const r = spawnSync(program, [...args], {
    encoding: "utf8",
    input: "",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: mkdtempSync(join(tmpdir(), "cw-engine-options-")),
      LANG: "C",
    },
  });
  return r.error === undefined && r.status === 0 ? `${r.stdout}${r.stderr}` : undefined;
}

export function engineVersion(tool: string): string | undefined {
  const spec = ENGINES[tool];
  return spec === undefined ? undefined : spec.pattern.exec(run(tool, spec.version) ?? "")?.[1];
}

/** The option entries of the help's `Options:` or `Global Options:` section (two spaces of indent, a long name, a description after two more spaces). */
export function engineLines(tool: string): string[] | undefined {
  const spec = ENGINES[tool];
  const text = spec === undefined ? undefined : run(tool, spec.help);
  if (text === undefined) return undefined;
  const lines: string[] = [];
  let inOptions = false;
  for (const line of text.split("\n")) {
    if (/^(?:Global )?Options:$/.test(line)) inOptions = true;
    else if (/^\S/.test(line)) inOptions = false;
    else if (inOptions && /^ {2}(?:-\w, | {4})--[\w-]+/.test(line)) lines.push(line);
  }
  return lines;
}

/** `-c, --context string` is valued, `-D, --debug` is a flag; an option with no short letter has no letter to read. */
export function parseEngineLines(lines: readonly string[]): { valued: string; flags: string } {
  const valued: string[] = [];
  const flags: string[] = [];
  for (const line of lines) {
    const m = /^ {2}(?:-(\w), | {4})--[\w-]+(?: (\w+)(?:\[=[^\]]*\])?)? {2}/.exec(line);
    const letter = /^ {2}-(\w), /.exec(line)?.[1];
    if (m === null || letter === undefined) continue;
    (m[2] === undefined ? flags : valued).push(letter);
  }
  const sorted = (xs: string[]): string => [...new Set(xs)].sort().join("");
  return { valued: sorted(valued), flags: sorted(flags) };
}

export function recordEngine(tool: string): EngineFixture | undefined {
  const version = engineVersion(tool);
  const lines = engineLines(tool);
  return version === undefined || lines === undefined ? undefined : { tool, version, lines };
}

if (process.argv.includes("--write")) {
  for (const tool of Object.keys(ENGINES)) {
    const fixture = recordEngine(tool);
    if (fixture === undefined) continue;
    const file = join(FIXTURE_DIR, `${tool}.${fixture.version}.json`);
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
}
