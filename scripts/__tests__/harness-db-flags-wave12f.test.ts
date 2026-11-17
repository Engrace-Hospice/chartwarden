/**
 * Wave 12, part F, F-9 (round-9 R9-CR-10, R9-CR-11, R9-CR-12 PG half).
 *
 * 1. The PostgreSQL fixtures are PG16 recordings but the repository ships PG18, and the recorder read option names from `--help` only, so names the
 *    real program accepts and does not list were missing: real PG16 accepts `pg_dump --no-acl`, `pg_dumpall --no-acl`, `pg_restore --no-acl` and
 *    `pg_dump`/`pg_dumpall --attribute-inserts` (`--no-privileges` and `--column-inserts` deprecated spellings), so `pg_dump --no-owner --no-acl -h
 *    localhost db` asked. The recorder now probes a bounded candidate list (the known aliases, `--no-` plus every listed flag, every name the production
 *    table lists, every name another PostgreSQL program of the same major lists) and records what the parser accepts as `hidden`. PostgreSQL 18 is
 *    recorded as a second version (`fixtures/harness-db-tool-options/pg18/`).
 * 2. `VERIFIED_OPTIONS` (the data the production table is built from) was never compared with the fixtures: the production table is that data UNITED
 *    with the hand table, so dropping `U` or `h` from psql's letters survived every test (round-9 mutants P16 and P17). This file compares the data with the
 *    fixtures directly.
 * 3. The live re-record skipped silently when the installed major was not 16. Every skip here names the recorded and the installed major.
 * PostgreSQL 18's additions are NOT in the production table: they are unknown options of a verified client and ASK (a union would change which prefixes are
 * ambiguous, which the major-16 recording proves). `pgbench -d` is `--debug` in 16 and `--dbname` (a connection string) in 18: the table keeps the 16 reading,
 * and the word after it is read as a positional connection string either way.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isListedLong, readLongOption } from "../harness/db-long-options";
import { TARGET_CLIENTS, type TargetClient } from "../harness/db-target-clients";
import { RECORDED_MAJOR, VERIFIED_OPTIONS } from "../harness/db-target-flags";
import { classifyBash } from "../harness/patterns";
import {
  FIXTURE_DIR,
  PROBED_TOOLS,
  RECORDED_POSTGRES_MAJORS,
  type ToolFixture,
  comparable,
  findBinary,
  fixtureDirectory,
  readFixture,
  recordTool,
} from "./helpers/record-pg-options";

const H = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const POSTGRES_TOOLS = Object.keys(PROBED_TOOLS).filter((tool) => !tool.startsWith("redis-"));
const fixtureOf = (tool: string, major: string): ToolFixture => readFixture(tool, major);

// ---------------------------------------------------------------------------------------------------
// 2. The data the production table is built from, against the fixtures
// ---------------------------------------------------------------------------------------------------

/** The letters, long names and flags of a fixture, as `VERIFIED_OPTIONS` states them (`argv1Only` names are not options of the parser). */
function dataOf(fixture: ToolFixture) {
  const parsed = fixture.options.filter((o) => o.argv1Only !== true);
  return {
    valueShort: [
      ...new Set(
        parsed.flatMap((o) => (o.short !== undefined && o.takesValue === true ? [o.short] : [])),
      ),
    ]
      .sort()
      .join(""),
    valueLong: parsed
      .flatMap((o) => (o.name !== undefined && o.takesValue === true ? [o.name] : []))
      .sort(),
    flagLong: parsed
      .flatMap((o) => (o.name !== undefined && o.takesValue !== true ? [o.name] : []))
      .sort(),
  };
}

describe("VERIFIED_OPTIONS is the recording of the installed programs (R9-CR-11: nothing compared them)", () => {
  it("covers exactly the PostgreSQL clients and redis tools the recorder probes", () => {
    expect([...VERIFIED_OPTIONS.keys()].sort()).toEqual(Object.keys(PROBED_TOOLS).sort());
  });

  for (const [tool, data] of VERIFIED_OPTIONS) {
    const major = tool.startsWith("redis-") ? "8" : RECORDED_MAJOR;
    describe(tool, () => {
      const expected = dataOf(fixtureOf(tool, major));
      it("the letters that take a value are the recorded ones", () => {
        expect([...new Set(data.valueShort)].sort().join("")).toBe(expected.valueShort);
      });
      it("the long names that take a value are the recorded ones", () => {
        expect([...data.valueLong].sort()).toEqual(expected.valueLong);
      });
      it("the long names that take none are the recorded ones", () => {
        expect([...data.flagLong].sort()).toEqual(expected.flagLong);
      });
    });
  }

  it("psql's -U and -h are letters that take a value (mutants P16 and P17 dropped one each)", () => {
    const psql = VERIFIED_OPTIONS.get("psql");
    expect(psql?.valueShort).toContain("U");
    expect(psql?.valueShort).toContain("h");
  });
});

// ---------------------------------------------------------------------------------------------------
// The recorded major, loudly
// ---------------------------------------------------------------------------------------------------

describe("the committed fixtures are of the major the table says it was recorded from", () => {
  it("every PostgreSQL fixture in the fixture directory is major RECORDED_MAJOR", () => {
    for (const tool of POSTGRES_TOOLS) {
      const fixture = fixtureOf(tool, RECORDED_MAJOR);
      expect(
        fixture.version.split(".")[0],
        `${tool}: fixture ${fixture.version}, table recorded from ${RECORDED_MAJOR}`,
      ).toBe(RECORDED_MAJOR);
    }
  });

  it("the recorder expects that major of every PostgreSQL tool", () => {
    for (const tool of POSTGRES_TOOLS) expect(PROBED_TOOLS[tool]?.major, tool).toBe(RECORDED_MAJOR);
  });

  it("every recorded major has a fixture for every PostgreSQL tool, and no other major has one", () => {
    for (const major of RECORDED_POSTGRES_MAJORS) {
      for (const tool of POSTGRES_TOOLS) {
        const file = join(fixtureDirectory(tool, major), `${tool}.${major}.json`);
        expect(
          existsSync(file),
          `${file} is missing: run scripts/__tests__/helpers/record-pg-options.ts`,
        ).toBe(true);
        expect(fixtureOf(tool, major).version.startsWith(`${major}.`), file).toBe(true);
      }
    }
    const extra = readdirSync(FIXTURE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^pg\d+$/.test(d.name))
      .map((d) => d.name.slice(2));
    expect(extra.sort()).toEqual(
      RECORDED_POSTGRES_MAJORS.filter((m) => m !== RECORDED_MAJOR).sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// 1. Hidden aliases (rows CR10a..c) and PostgreSQL 18
// ---------------------------------------------------------------------------------------------------

describe("R9-CR-10: names the program accepts and its --help does not list are recorded and read", () => {
  const ALIASES: ReadonlyArray<readonly [tool: string, name: string]> = [
    ["pg_dump", "no-acl"],
    ["pg_dump", "attribute-inserts"],
    ["pg_dumpall", "no-acl"],
    ["pg_dumpall", "attribute-inserts"],
    ["pg_restore", "no-acl"],
  ];

  it.each(ALIASES)("%s --%s is a recorded hidden flag", (tool, name) => {
    const option = fixtureOf(tool, RECORDED_MAJOR).options.find((o) => o.name === name);
    expect(option, `${tool} --${name}`).toMatchObject({ takesValue: false, hidden: true });
  });

  it("every other recorded option is one the help lists", () => {
    const hidden = POSTGRES_TOOLS.flatMap((tool) =>
      fixtureOf(tool, RECORDED_MAJOR)
        .options.filter((o) => o.hidden === true)
        .map((o) => `${tool} --${o.name}`),
    );
    expect(hidden.sort()).toEqual(ALIASES.map(([tool, name]) => `${tool} --${name}`).sort());
  });

  it.each([
    "pg_dump --no-owner --no-acl -h localhost db",
    "pg_dump --attribute-inserts -h localhost db",
    "pg_restore --no-acl -h localhost -d db x.dump",
    "pg_dumpall --no-acl --attribute-inserts -h localhost",
    "pg_dump --no-acl --no-owner --no-privileges -h localhost -d db",
  ])("%s is allowed against a local host", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it.each([
    `pg_dump --no-acl -h ${H} db`,
    `pg_dump --attribute-inserts -h ${H} db`,
    `pg_restore --no-acl -h ${H} -d db x.dump`,
    `pg_dumpall --no-acl -h ${H}`,
  ])("%s is refused against a remote host (an alias hides nothing)", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });

  it("an unlisted option of a verified client still asks", () => {
    expect(decide("pg_dump --nosuch-option-zzz -h localhost db")).toBe("ask");
  });
});

describe("R9-CR-10: PostgreSQL 18 (the repository's) is recorded as a second version", () => {
  /** The long names a major-18 program accepts that the major-16 program does not: not in the production table, so they ask. */
  const added = (tool: string) => {
    const old = new Set(
      fixtureOf(tool, RECORDED_MAJOR).options.flatMap((o) =>
        o.name === undefined ? [] : [o.name],
      ),
    );
    return fixtureOf(tool, "18").options.filter((o) => o.name !== undefined && !old.has(o.name));
  };

  it("pg18 holds a fixture of every PostgreSQL tool, version 18.x", () => {
    for (const tool of POSTGRES_TOOLS)
      expect(fixtureOf(tool, "18").version, tool).toMatch(/^18\.\d+/);
  });

  it("an option both versions have is read the same way by both, but pgbench -d (`--debug` in 16, `--dbname` in 18)", () => {
    const differences: string[] = [];
    for (const tool of POSTGRES_TOOLS) {
      const sixteen = new Map(
        fixtureOf(tool, RECORDED_MAJOR).options.flatMap((o) =>
          o.name === undefined ? [] : [[o.name, o] as const],
        ),
      );
      for (const o of fixtureOf(tool, "18").options) {
        const was = o.name === undefined ? undefined : sixteen.get(o.name);
        if (was !== undefined && (was.takesValue !== o.takesValue || was.role !== o.role))
          differences.push(`${tool} --${o.name}`);
      }
    }
    expect(differences).toEqual([]);
    const dash = (major: string) =>
      fixtureOf("pgbench", major).options.find((o) => o.short === "d");
    expect(dash(RECORDED_MAJOR)).toMatchObject({ name: "debug", takesValue: false });
    expect(dash("18")).toMatchObject({ name: "dbname", takesValue: true, role: "string" });
  });

  it("the additions of 18 the reviewer named are recorded", () => {
    const names = (tool: string) => added(tool).map((o) => o.name);
    expect(names("pg_dump")).toEqual(
      expect.arrayContaining(["sync-method", "statistics-only", "no-statistics"]),
    );
    expect(names("vacuumdb")).toContain("missing-stats-only");
    expect(names("pg_basebackup")).toContain("incremental");
  });

  it("an addition of 18 is unknown to the table and asks, or resolves as a prefix of a 16 option of the same arity; never an allow against a remote host", () => {
    const asked: string[] = [];
    for (const tool of POSTGRES_TOOLS) {
      const spec = TARGET_CLIENTS.get(tool) as TargetClient;
      // A name the hand table already lists (from a newer manual: `pg_dump --exclude-extension`) is read, not asked about.
      for (const option of added(tool).filter((o) => !isListedLong(spec, o.name as string))) {
        const name = option.name as string;
        const spelled = option.takesValue === true ? `--${name}=x` : `--${name}`;
        const local = `${tool} ${spelled} -h localhost`;
        const read = readLongOption(spec, name);
        if (read === "unknown") {
          expect(decide(local), local).toBe("ask");
          asked.push(`${tool} --${name}`);
        } else if (read === "ambiguous") {
          expect(decide(local), local).toBe("ask");
        } else if (option.takesValue === true) {
          expect(
            ["host", "string", "alias", "indirect", "value"],
            `${tool} --${name} read as ${read}`,
          ).toContain(read);
        } else {
          expect(read, `${tool} --${name}`).toBe("flag");
        }
        const remote = `${tool} ${spelled} -h ${H}`;
        expect(decide(remote), remote).not.toBe("allow");
      }
    }
    // Most additions are unknown to a table proven against 16 (the reviewer's examples among them).
    expect(asked.length).toBeGreaterThan(15);
  });

  it("the specific names the round-9 review listed ask", () => {
    for (const cmd of [
      "pg_dump --sync-method=fsync -h localhost db",
      "pg_dump --statistics-only -h localhost db",
      "vacuumdb --missing-stats-only -h localhost db",
      "pg_basebackup --incremental=x -D out -h localhost",
    ]) {
      expect(decide(cmd), cmd).toBe("ask");
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. The live re-record, never a silent skip
// ---------------------------------------------------------------------------------------------------

const installedMajor = (tool: string): string | undefined => {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  if (found === "") return undefined;
  const out = spawnSync(found, ["--version"], { encoding: "utf8" });
  return /(\d+)\.\d+/.exec(`${out.stdout}${out.stderr}`)?.[1];
};

describe("live re-recording of the PostgreSQL option fixtures (each skip names the recorded and the installed major)", () => {
  const onPath = installedMajor("psql");
  if (onPath !== undefined && !RECORDED_POSTGRES_MAJORS.includes(onPath)) {
    it.skip(`psql on PATH is PostgreSQL ${onPath}, which is not a recorded major (recorded: ${RECORDED_POSTGRES_MAJORS.join(", ")}); record it with record-pg-options.ts`, () => {});
  }
  // 16 is re-recorded in full by harness-db-options-wave11.test.ts; 18, a sample of the clients agents run most (the recorder's --check does every one).
  for (const tool of ["psql", "pg_dump", "pg_restore"]) {
    const binary = findBinary(tool, "18");
    it.skipIf(binary === undefined)(
      `${tool} 18: re-recorded options equal the committed fixture (skipped only when PostgreSQL 18's ${tool} is not installed; PATH has ${onPath ?? "no PostgreSQL"}, recorded ${RECORDED_POSTGRES_MAJORS.join(", ")})`,
      async () => {
        const live = await recordTool(tool, "18");
        expect(live).toBeDefined();
        if (live === undefined) return;
        expect(comparable(live)).toEqual(comparable(fixtureOf(tool, "18")));
      },
      240_000,
    );
  }

  it("the committed JSON of every fixture parses and names its own tool", () => {
    for (const major of RECORDED_POSTGRES_MAJORS) {
      for (const tool of POSTGRES_TOOLS) {
        const text = readFileSync(
          join(fixtureDirectory(tool, major), `${tool}.${major}.json`),
          "utf8",
        );
        expect((JSON.parse(text) as ToolFixture).tool).toBe(tool);
      }
    }
  });
});
