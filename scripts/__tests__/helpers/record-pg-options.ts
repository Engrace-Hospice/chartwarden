/**
 * Records the option table of a real database client from the INSTALLED program (wave 11, part D, rule 12; round-8 R8-ADV-4).
 * ------------------------------------------------------------------------------------------------------------------
 * The guard's option tables (`scripts/harness/db-target-clients.ts`) were once "proven" against data the table itself was
 * built from. This recorder produces the independent evidence: a JSON fixture per program, read from the real tool.
 *
 *   bun scripts/__tests__/helpers/record-pg-options.ts          re-record every installed client and write the fixtures
 *   bun scripts/__tests__/helpers/record-pg-options.ts --check  re-record and report a difference from the fixtures
 *
 * What is recorded, and how (a payload is never run against a non-local host: every probe names 127.0.0.1 port 1, a closed
 * local port, or no host at all with `-p 1`, whose socket does not exist; `PG*` variables are removed from the environment and
 * each probe runs in a fresh temporary directory):
 *   - the options: names and short letters read from `--help`;
 *   - flag or value: the real tool's own parser. A valued option at the end of the command line fails with "requires an
 *     argument"; a long flag given `=x` fails with "doesn't allow an argument". Both fail before any connection is made;
 *   - the role: `--NAME=127.0.0.1 -p 1` that connects to 127.0.0.1 is a host option; `--NAME='host=127.0.0.1 port=1'` that
 *     does is a connection-string option (a database name, a maintenance database);
 *   - abbreviations (getopt_long): every prefix of a long option up to one character past where it becomes unique is
 *     probed: `ambiguous`, `unrecognized`, or what it resolves to (`flag`, `value`, `optional`, `host`, `string`).
 * `--help` and `--version` of most PostgreSQL programs are read from `argv[1]` only, not by getopt: the probe says
 * "unrecognized" and the option is recorded with `argv1Only`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "harness-tool-options",
);

export type Role = "host" | "string";
export type Takes = boolean | "optional";

export interface RecordedOption {
  /** The long name without `--`; absent for a short-only option. */
  readonly name?: string;
  readonly short?: string;
  readonly takesValue: Takes;
  readonly role?: Role;
  /** Read from `argv[1]` by the program, not by getopt (`--help`, `--version` of most PostgreSQL programs). */
  readonly argv1Only?: true;
}

export type AbbreviationOutcome =
  | "ambiguous"
  | "unrecognized"
  | "flag"
  | "value"
  | "optional"
  | Role;

export interface RecordedAbbreviation {
  readonly prefix: string;
  readonly outcome: AbbreviationOutcome;
}

export interface ToolFixture {
  readonly tool: string;
  readonly version: string;
  readonly command: string;
  readonly options: readonly RecordedOption[];
  /** getopt_long prefixes; empty for a program that reads long options by their exact name. */
  readonly abbreviations: readonly RecordedAbbreviation[];
  /** The program reads long options by their exact name only. */
  readonly exactLong?: true;
}

/** How each program is probed: the words it needs in front so that a probe reaches the option parser or the connection. */
interface ProbeSpec {
  readonly kind: "getopt" | "redis";
  /** Words placed before every probe (a required argument the program checks before it connects). */
  readonly extras?: readonly string[];
  /** Role probes run once more with these words in front (`-a`: the maintenance database only counts when every database is wanted). */
  readonly roleExtras?: readonly string[];
  /** The program has no host option (`pg_upgrade`): only the option parser is probed. */
  readonly noHost?: true;
  /** The program reads its input before it connects (`pg_restore`): roles come from the help's metavariable. */
  readonly roleFromHelp?: true;
  /** The expected major version of the installed program. */
  readonly major: string;
}

const PG = { kind: "getopt", major: "16" } as const;
export const PROBED_TOOLS: Readonly<Record<string, ProbeSpec>> = {
  psql: PG,
  pg_dump: PG,
  pg_dumpall: PG,
  pg_restore: { ...PG, extras: ["-d", "x"], roleFromHelp: true },
  pg_isready: PG,
  pgbench: PG,
  createuser: PG,
  createdb: PG,
  dropdb: { ...PG, extras: ["x"] },
  dropuser: { ...PG, extras: ["x"] },
  clusterdb: { ...PG, roleExtras: ["-a"] },
  vacuumdb: { ...PG, roleExtras: ["-a"] },
  reindexdb: { ...PG, roleExtras: ["-a"] },
  pg_amcheck: { ...PG, roleExtras: ["-a"] },
  pg_basebackup: { ...PG, extras: ["-D", "out"] },
  pg_receivewal: { ...PG, extras: ["-D", "out"] },
  pg_upgrade: { ...PG, noHost: true },
  pg_recvlogical: { ...PG, extras: ["--slot", "s", "--start", "-f", "-", "-d", "x"] },
  "redis-cli": { kind: "redis", major: "8" },
  "redis-benchmark": { kind: "redis", major: "8" },
};

const PROBE_TIMEOUT_MS = 20_000;
/** A redis tool retries a refused connection for an option such as `-l` or `-I` until it is killed: such a probe says nothing. */
const REDIS_PROBE_TIMEOUT_MS = 3_000;
const MAX_PARALLEL = 6;
const HOST_MARKER =
  /at "127\.0\.0\.1", port 1|127\.0\.0\.1:1 - |Could not connect to Redis at 127\.0\.0\.1:1/;
const CLOSED_HOST = ["-h", "127.0.0.1", "-p", "1"] as const;
const STRING_PROBE = "host=127.0.0.1 port=1";

// ---------------------------------------------------------------------------------------------------------------- binaries

const EXTRA_BIN_DIRECTORIES = [
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/local/opt/postgresql@16/bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/pgsql-16/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const brewPrefix = (formula: string): string | undefined => {
  const result = spawnSync("brew", ["--prefix", formula], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? `${result.stdout.trim()}/bin` : undefined;
};

const isExpected = (path: string, wanted: string | undefined): boolean =>
  existsSync(path) && versionOf(path)?.startsWith(`${wanted}.`) === true;

/** `PATH` first, then the places a package manager puts PostgreSQL 16 and redis; undefined when the program is not installed. */
export function findBinary(tool: string, major?: string): string | undefined {
  const wanted = major ?? PROBED_TOOLS[tool]?.major;
  const directories = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_BIN_DIRECTORIES];
  const found = directories
    .filter((directory) => directory !== "")
    .map((directory) => join(directory, tool))
    .find((path) => isExpected(path, wanted));
  if (found !== undefined || tool.startsWith("redis-")) return found;
  // A keg-only Homebrew formula is on no PATH: ask brew only when nothing else found the program.
  const brewed = brewPrefix("postgresql@16");
  return brewed === undefined || !isExpected(join(brewed, tool), wanted)
    ? undefined
    : join(brewed, tool);
}

const run = (
  binary: string,
  args: readonly string[],
  cwd: string,
  timeout = PROBE_TIMEOUT_MS,
): Promise<{ readonly output: string; readonly code: number | null }> =>
  new Promise((resolve) => {
    // Detached: a new session, so no controlling terminal; a password prompt reads the closed stdin and moves on.
    const child = spawn(binary, [...args], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // No PG* variable, no home: a probe cannot read a service file or a password file.
      env: { PATH: process.env.PATH ?? "", HOME: cwd, LANG: "C", PGCONNECT_TIMEOUT: "2" },
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ output, code: null });
    });
  });

function versionOf(binary: string): string | undefined {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  return /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(`${result.stdout}${result.stderr}`)?.[1];
}

// -------------------------------------------------------------------------------------------------------------------- help

interface HelpOption {
  readonly names: readonly string[];
  readonly shorts: readonly string[];
  /** What `--help` says: `=X` after a long name, `<x>` after a redis option. */
  readonly hint: Takes;
  /** The metavariable of the first long option that has one (`HOSTNAME`, `DBNAME`). */
  readonly metavar?: string;
}

/** One help line of a getopt program: `  -c, --command=COMMAND  text`, `      --csv  text`, `  -v, --set=, --variable=NAME=VALUE`. */
function parseGetoptHelp(text: string): HelpOption[] {
  const out: HelpOption[] = [];
  for (const line of text.split("\n")) {
    if (!/^\s+-/.test(line)) continue;
    const head = line.trim().split(/\s{2,}/)[0] ?? "";
    const shorts = [...head.matchAll(/(?:^|,\s*)-([A-Za-z0-9?])(?![A-Za-z0-9_-])/g)].map(
      (m) => m[1] as string,
    );
    const longs = [...head.matchAll(/--([A-Za-z0-9][\w-]*)(=|\[=)?([A-Za-z0-9_|{}]*)/g)];
    const names = longs.map((m) => m[1] as string);
    const hint: Takes = longs.some((m) => m[2] === "=")
      ? true
      : longs.some((m) => m[2] === "[=")
        ? "optional"
        : false;
    const metavar = longs.find((m) => m[2] !== undefined && m[3] !== "")?.[3];
    out.push({
      names,
      shorts,
      hint,
      ...(metavar === undefined || metavar === "" ? {} : { metavar }),
    });
  }
  return out;
}

/** One help line of a redis program: `  -h <hostname>      text`, `  --tls              text`. */
function parseRedisHelp(text: string): HelpOption[] {
  const out: HelpOption[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s{1,2}(-{1,2})([A-Za-z0-9][\w-]*)(?:\s+<([^>]*)>)?/.exec(line);
    if (m === null) continue;
    const dashes = m[1] as string;
    const name = m[2] as string;
    out.push({
      names: dashes === "--" ? [name] : [],
      shorts: dashes === "-" ? [name] : [],
      hint: m[3] !== undefined,
      ...(m[3] === undefined ? {} : { metavar: m[3] }),
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ probes

interface Probe {
  readonly binary: string;
  readonly extras: readonly string[];
  readonly roleExtras: readonly string[];
  readonly roleFromHelp: boolean;
  /** The words that make a probe connect to the closed local port (none for a program without a host option). */
  readonly closed: readonly string[];
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly limit: <T>(task: () => Promise<T>) => Promise<T>;
}

const probeRun = (p: Probe, args: readonly string[]): Promise<string> =>
  p.limit(async () => (await run(p.binary, [...p.extras, ...args], p.cwd, p.timeoutMs)).output);

type LongOutcome = "ambiguous" | "unrecognized" | "flag" | "value" | "optional";

/** What a getopt program makes of `--TOKEN`: resolved to a flag, a required or an optional value; or an error. */
async function classifyGetoptLong(
  p: Probe,
  token: string,
): Promise<{ outcome: LongOutcome; role?: Role }> {
  const withValue = await probeRun(p, [...p.closed, `--${token}=x`]);
  if (/ambiguous/.test(withValue)) return { outcome: "ambiguous" };
  if (/unrecognized option|unknown option|invalid option/.test(withValue))
    return { outcome: "unrecognized" };
  if (/(?:doesn't|does not) allow an argument/.test(withValue)) return { outcome: "flag" };
  const bare = await probeRun(p, [...p.closed, `--${token}`]);
  if (!/requires an argument/.test(bare)) return { outcome: "optional" };
  const role = await roleOf(p, `--${token}=`);
  return { outcome: "value", ...(role === undefined ? {} : { role }) };
}

/** Which role a valued option plays: its value is a host, or a connection string that names one. */
async function roleOf(p: Probe, spelling: string, separate = false): Promise<Role | undefined> {
  const argsFor = (value: string): string[] =>
    separate ? [spelling, value] : [`${spelling}${value}`];
  if (p.closed.length === 0) return undefined;
  const variants: Array<readonly string[]> = p.roleExtras.length === 0 ? [[]] : [[], p.roleExtras];
  for (const extras of variants) {
    if (HOST_MARKER.test(await probeRun(p, [...extras, "-p", "1", ...argsFor("127.0.0.1")])))
      return "host";
    if (HOST_MARKER.test(await probeRun(p, [...extras, "-p", "1", ...argsFor(STRING_PROBE)])))
      return "string";
  }
  return undefined;
}

/** What a getopt program makes of `-L`: a flag, a valued option (with its role) or an error. */
async function classifyGetoptShort(
  p: Probe,
  letter: string,
): Promise<{ outcome: "unrecognized" | "flag" | "value"; role?: Role }> {
  const bare = await probeRun(p, [...p.closed, `-${letter}`]);
  if (/requires an argument/.test(bare)) {
    const role = await roleOf(p, `-${letter}`, true);
    return { outcome: "value", ...(role === undefined ? {} : { role }) };
  }
  return {
    outcome: /invalid option|unrecognized option|unknown option/.test(bare)
      ? "unrecognized"
      : "flag",
  };
}

/**
 * Does the help text agree with the parser? The parser is the authority (pg_amcheck's `--install-missing` takes an optional
 * argument its help line does not show); a required value the help does not show, or one it shows that the parser does not
 * take, is a recorder or tool problem, never data.
 */
function assertAgrees(tool: string, label: string, hint: Takes, observed: Takes): void {
  if (hint === observed || (hint === false && observed === "optional")) return;
  throw new Error(
    `${tool}: ${label}: --help says ${String(hint)} but the parser says ${String(observed)}`,
  );
}

/** The short letter of an option must read the way its long name does (value or flag, same role). */
async function assertShortAgrees(
  p: Probe,
  tool: string,
  letter: string,
  long: { outcome: LongOutcome | "unrecognized"; role?: Role },
): Promise<void> {
  const short = await classifyGetoptShort(p, letter);
  // A letter the program's getopt string does not list (pg_dump `-V`) is an error there, not a different reading.
  if (short.outcome === "unrecognized") return;
  if (long.outcome === "unrecognized")
    throw new Error(`${tool}: -${letter} is read by getopt, its long name is not`);
  // psql's `-?` is a flag whereas `--help` takes an optional argument.
  if (long.outcome === "optional" && short.outcome === "flag") return;
  const longValue = long.outcome === "value" || long.outcome === "optional";
  if ((short.outcome === "value") !== longValue || short.role !== long.role) {
    throw new Error(
      `${tool}: -${letter} reads as ${short.outcome}/${short.role}, its long name as ${long.outcome}/${long.role}`,
    );
  }
}

const takesOf = (outcome: LongOutcome | "unrecognized"): Takes =>
  outcome === "value" ? true : outcome === "optional" ? "optional" : false;

async function recordGetoptOptions(
  p: Probe,
  tool: string,
  help: HelpOption[],
): Promise<RecordedOption[]> {
  const options: RecordedOption[] = [];
  const seen = new Set<string>();
  for (const entry of help) {
    const shortLetter = entry.shorts[0];
    for (const [index, name] of entry.names.entries()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const read = await classifyGetoptLong(p, name);
      const short = index === 0 ? shortLetter : undefined;
      if (read.outcome === "unrecognized") {
        options.push({
          name,
          ...(short === undefined ? {} : { short }),
          takesValue: false,
          argv1Only: true,
        });
        continue;
      }
      if (name !== "help") assertAgrees(tool, `--${name}`, entry.hint, takesOf(read.outcome));
      const role = read.role ?? (p.roleFromHelp ? metavarRole(name, entry.metavar) : undefined);
      if (short !== undefined) await assertShortAgrees(p, tool, short, read);
      options.push({
        name,
        ...(short === undefined ? {} : { short }),
        takesValue: takesOf(read.outcome),
        ...(role === undefined ? {} : { role }),
      });
    }
    if (entry.names.length === 0 && shortLetter !== undefined) {
      const read = await classifyGetoptShort(p, shortLetter);
      if (read.outcome === "unrecognized") {
        options.push({ short: shortLetter, takesValue: false, argv1Only: true });
      } else {
        options.push({
          short: shortLetter,
          takesValue: read.outcome === "value",
          ...(read.role === undefined ? {} : { role: read.role }),
        });
      }
    }
  }
  return options;
}

/** A program that reads its input before it connects cannot be probed for roles: the help's metavariable says what a value is. */
const metavarRole = (name: string, metavar: string | undefined): Role | undefined =>
  metavar === "HOSTNAME"
    ? "host"
    : name === "dbname" && /^(?:DB)?NAME$/.test(metavar ?? "")
      ? "string"
      : undefined;

/** The shortest prefix of `name` no other name starts with (the name itself when it prefixes another). */
const uniqueLength = (name: string, names: readonly string[]): number => {
  for (let n = 1; n < name.length; n++) {
    if (!names.some((other) => other !== name && other.startsWith(name.slice(0, n)))) return n;
  }
  return name.length;
};

async function recordAbbreviations(
  p: Probe,
  options: readonly RecordedOption[],
): Promise<RecordedAbbreviation[]> {
  const names = options.flatMap((o) =>
    o.name === undefined || o.argv1Only === true ? [] : [o.name],
  );
  const prefixes = new Set<string>();
  for (const name of names) {
    const upTo = Math.min(uniqueLength(name, names) + 1, name.length - 1);
    for (let n = 1; n <= upTo; n++) prefixes.add(name.slice(0, n));
  }
  const exact = new Set(names);
  const wanted = [...prefixes].filter((prefix) => !exact.has(prefix)).sort();
  return Promise.all(
    wanted.map(async (prefix): Promise<RecordedAbbreviation> => {
      const read = await classifyGetoptLong(p, prefix);
      // Without a connection to observe, a prefix that resolves to a value takes the role of the one option it can be.
      const candidates = options.filter(
        (o) => o.argv1Only !== true && o.name?.startsWith(prefix) === true,
      );
      const inherited =
        p.roleFromHelp && read.outcome === "value" && candidates.length === 1
          ? candidates[0]?.role
          : undefined;
      return { prefix, outcome: read.role ?? inherited ?? read.outcome };
    }),
  );
}

async function recordRedisOptions(
  p: Probe,
  tool: string,
  help: HelpOption[],
): Promise<RecordedOption[]> {
  const options: RecordedOption[] = [];
  for (const entry of help) {
    const token = entry.names[0] !== undefined ? `--${entry.names[0]}` : `-${entry.shorts[0]}`;
    if (/^-{1,2}(?:help|version)$/.test(token)) {
      options.push({ ...redisNames(entry), takesValue: entry.hint });
      continue;
    }
    const bare = await probeRun(p, [...CLOSED_HOST, token]);
    const bareConnects = HOST_MARKER.test(bare);
    const withValue = bareConnects
      ? false
      : HOST_MARKER.test(await probeRun(p, [...CLOSED_HOST, token, "x"]));
    // A probe that reaches neither connection leaves the help hint standing (the option exits early or needs more words).
    // The parser outranks the help text (`-X <tag>` and `--precision <num>` are not shown with their argument).
    if (bareConnects && entry.hint === true)
      throw new Error(`${tool}: ${token}: --help shows a value, the parser takes none`);
    const takesValue: Takes = bareConnects ? false : withValue ? true : entry.hint;
    // Only an option whose help names a host or a URI is probed for a role: the others (`-l`, `-c`) retry a refused connection.
    const hostLike = entry.metavar === "hostname" || entry.metavar === "uri";
    const role = takesValue === true && hostLike ? await redisRole(p, token) : undefined;
    options.push({ ...redisNames(entry), takesValue, ...(role === undefined ? {} : { role }) });
  }
  return options;
}

/**
 * A redis option whose value is a host (`-h`), or a URI that names one (`-u`). The default host of redis-cli is 127.0.0.1, so
 * the distinguishable closed host is `localhost` (its error names it as written; 127.0.0.2 hangs on macOS).
 */
async function redisRole(p: Probe, token: string): Promise<Role | undefined> {
  const names = /Could not connect to Redis at localhost:1/;
  if (names.test(await probeRun(p, ["-p", "1", token, "localhost"]))) return "host";
  if (names.test(await probeRun(p, [token, "redis://localhost:1"]))) return "string";
  return undefined;
}

const redisNames = (entry: HelpOption): { name?: string; short?: string } => ({
  ...(entry.names[0] === undefined ? {} : { name: entry.names[0] }),
  ...(entry.shorts[0] === undefined ? {} : { short: entry.shorts[0] }),
});

async function redisReadsExactNames(
  p: Probe,
  options: readonly RecordedOption[],
): Promise<boolean> {
  const longs = options.flatMap((o) => (o.name === undefined || o.name.length < 4 ? [] : [o.name]));
  for (const name of longs.slice(0, 3)) {
    const out = await probeRun(p, [...CLOSED_HOST, `--${name.slice(0, name.length - 1)}`]);
    if (HOST_MARKER.test(out)) return false;
  }
  return true;
}

function pool(width: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    active--;
    waiting.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= width) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

/** Record one installed program; undefined when it is not installed (or is not the expected major version). */
export async function recordTool(tool: string): Promise<ToolFixture | undefined> {
  const spec = PROBED_TOOLS[tool];
  if (spec === undefined) throw new Error(`no probe spec for ${tool}`);
  const binary = findBinary(tool);
  if (binary === undefined) return undefined;
  const version = versionOf(binary) ?? "unknown";
  const cwd = mkdtempSync(join(tmpdir(), "cw-record-options-"));
  try {
    const helpText = (await run(binary, ["--help"], cwd)).output;
    const help = spec.kind === "getopt" ? parseGetoptHelp(helpText) : parseRedisHelp(helpText);
    mkdirSync(join(cwd, "out"));
    const p: Probe = {
      binary,
      extras: spec.extras ?? [],
      roleExtras: spec.roleExtras ?? [],
      roleFromHelp: spec.roleFromHelp === true,
      closed: spec.noHost === true ? [] : CLOSED_HOST,
      timeoutMs: spec.kind === "redis" ? REDIS_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS,
      cwd,
      limit: pool(MAX_PARALLEL),
    };
    if (spec.kind === "redis") {
      const options = await recordRedisOptions(p, tool, help);
      const exact = await redisReadsExactNames(p, options);
      return {
        tool,
        version,
        command: `${tool} --help; behaviour probes against 127.0.0.1 port 1`,
        options,
        abbreviations: [],
        ...(exact ? { exactLong: true as const } : {}),
      };
    }
    const options = await recordGetoptOptions(p, tool, help);
    const abbreviations = await recordAbbreviations(p, options);
    return {
      tool,
      version,
      command: `${tool} --help; getopt behaviour probes against 127.0.0.1 port 1`,
      options,
      abbreviations,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export const fixtureFile = (tool: string, version: string): string =>
  join(FIXTURE_DIR, `${tool}.${version.split(".")[0]}.json`);

export const readFixture = (tool: string, major: string): ToolFixture =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, `${tool}.${major}.json`), "utf8")) as ToolFixture;

/** The comparable part of a recording: the version's minor number is not part of what the tool's parser does. */
export const comparable = (fixture: ToolFixture): Omit<ToolFixture, "version"> => {
  const { version: _version, ...rest } = fixture;
  return rest;
};

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let failed = false;
  for (const tool of Object.keys(PROBED_TOOLS)) {
    const fixture = await recordTool(tool);
    if (fixture === undefined) {
      console.log(`${tool}: not installed, fixture left as it is`);
      continue;
    }
    const file = fixtureFile(tool, fixture.version);
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    if (check) {
      const same =
        existsSync(file) &&
        JSON.stringify(comparable(JSON.parse(readFileSync(file, "utf8")))) ===
          JSON.stringify(comparable(fixture));
      console.log(`${tool}: ${same ? "matches" : "DIFFERS from"} ${file}`);
      failed ||= !same;
    } else {
      writeFileSync(file, text);
      console.log(
        `${tool} ${fixture.version}: ${fixture.options.length} options, ${fixture.abbreviations.length} prefixes -> ${file}`,
      );
    }
  }
  if (failed) process.exitCode = 1;
}

if ((import.meta as { main?: boolean }).main === true) await main();
