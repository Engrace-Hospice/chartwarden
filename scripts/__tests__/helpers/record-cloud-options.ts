/**
 * Rule 12 for the cloud CLIs (wave 13 part B2; round-10 B4 and CR-6): the options that stand before the subcommand of `kubectl` and `gcloud` are recorded
 * from the INSTALLED tools and `fixtures/harness-cloud-options/<tool>.<version>.json` holds the lines. kubectl: the entries of `kubectl options` (a default of
 * `false` or `true` is a flag, any other default a valued option). gcloud: the flag entries of the GLOBAL FLAGS and OTHER FLAGS sections of `gcloud --help`
 * (`--name=VALUE` is valued, `--quiet, -q` and `-h` are flags). `aws` is not installed here: `aws.unverified.json` holds the AWS CLI documentation's list and
 * says so. Only `--help`, `options` and `version` are run, with HOME and the gcloud configuration in a scratch directory and no input; nothing connects anywhere.
 * Re-record: `bun scripts/__tests__/helpers/record-cloud-options.ts --write`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "harness-cloud-options");

export interface CloudFixture {
  readonly tool: string;
  readonly version: string;
  /** Where the lines come from; `documentation` means no binary was run. */
  readonly source: "kubectl options" | "gcloud --help" | "documentation";
  /** `true` for a list that was NOT read from a binary. */
  readonly unverified?: boolean;
  readonly lines: readonly string[];
}

export interface ParsedOptions {
  readonly valued: readonly string[];
  readonly flags: readonly string[];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** `-n, --namespace='':` is valued (default `''`), `--match-server-version=false:` is a flag. */
export function parseKubectlLines(lines: readonly string[]): ParsedOptions {
  const valued: string[] = [];
  const flags: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:(-\w), )?(--[\w-]+)=(.*):$/.exec(line);
    if (m === null) continue;
    const names = [m[1], m[2]].filter((n): n is string => n !== undefined);
    (m[3] === "false" || m[3] === "true" ? flags : valued).push(...names);
  }
  return { valued: sorted(valued), flags: sorted(flags) };
}

/** `--account=ACCOUNT` is valued, `--quiet, -q` and `-h` are flags. */
export function parseGcloudLines(lines: readonly string[]): ParsedOptions {
  const valued: string[] = [];
  const flags: string[] = [];
  for (const line of lines) {
    const entry = line.trim();
    if (!entry.startsWith("-")) continue;
    const names = entry.split(", ").map((part) => part.split("=")[0] as string);
    (entry.includes("=") ? valued : flags).push(...names);
  }
  return { valued: sorted(valued), flags: sorted(flags) };
}

function run(program: string, args: readonly string[]): string | undefined {
  const home = mkdtempSync(join(tmpdir(), "cw-cloud-options-"));
  const r = spawnSync(program, [...args], {
    encoding: "utf8",
    input: "",
    timeout: 90_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      LANG: "C",
      CLOUDSDK_CONFIG: join(home, "gcloud"),
      CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
      CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
    },
  });
  return r.error === undefined && r.status === 0 ? `${r.stdout}${r.stderr}` : undefined;
}

export function kubectlVersion(): string | undefined {
  return /Client Version: (v[\w.]+)/.exec(run("kubectl", ["version", "--client"]) ?? "")?.[1];
}

export function gcloudVersion(): string | undefined {
  return /Google Cloud SDK ([\w.]+)/.exec(run("gcloud", ["version"]) ?? "")?.[1];
}

/** The entry lines of `kubectl options`, as printed (the cache directory default carries HOME, so only the option and its kind are kept). */
export function kubectlLines(): string[] | undefined {
  const text = run("kubectl", ["options"]);
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .filter((l) => /^\s{4}(?:-\w, )?--[\w-]+=.*:$/.test(l))
    .map((l) => l.replace(/^(\s*(?:-\w, )?--cache-dir=).*:$/, "$1<home>/.kube/cache:"));
}

/** The flag entries (five spaces of indent, starting with a dash) of the GLOBAL FLAGS and OTHER FLAGS sections of `gcloud --help`. */
export function gcloudLines(): string[] | undefined {
  const text = run("gcloud", ["--help"]);
  if (text === undefined) return undefined;
  return text
    .replace(ANSI, "")
    .split("\n")
    .filter((l) => /^ {5}-/.test(l));
}

export function recordKubectl(): CloudFixture | undefined {
  const version = kubectlVersion();
  const lines = kubectlLines();
  return version === undefined || lines === undefined
    ? undefined
    : { tool: "kubectl", version, source: "kubectl options", lines };
}

export function recordGcloud(): CloudFixture | undefined {
  const version = gcloudVersion();
  const lines = gcloudLines();
  return version === undefined || lines === undefined
    ? undefined
    : { tool: "gcloud", version, source: "gcloud --help", lines };
}

/** The AWS CLI v2 documentation's global options (https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-options.html), NOT read from a binary. */
export const AWS_DOCUMENTED: CloudFixture = {
  tool: "aws",
  version: "documentation",
  source: "documentation",
  unverified: true,
  lines: [
    "--debug",
    "--endpoint-url=URL",
    "--no-verify-ssl",
    "--no-paginate",
    "--output=FORMAT",
    "--query=QUERY",
    "--profile=PROFILE",
    "--region=REGION",
    "--version",
    "--color=on|off|auto",
    "--no-sign-request",
    "--ca-bundle=PATH",
    "--cli-read-timeout=SECONDS",
    "--cli-connect-timeout=SECONDS",
    "--cli-binary-format=FORMAT",
    "--no-cli-pager",
    "--cli-auto-prompt",
    "--no-cli-auto-prompt",
  ],
};

if (process.argv.includes("--write")) {
  for (const fixture of [recordKubectl(), recordGcloud(), AWS_DOCUMENTED]) {
    if (fixture === undefined) continue;
    const file = join(FIXTURE_DIR, `${fixture.tool}.${fixture.version}.json`);
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
}
