/**
 * Wave 11, part D, rule 12 (round-8 R8-ADV-4, R8-CR-12): the option tables of the database clients are proven against the
 * REAL programs. `scripts/__tests__/helpers/record-pg-options.ts` records each installed client (PostgreSQL 16's, redis 8's:
 * `--help`, the program's own getopt parser, the role of every valued option, every abbreviation up to one character past
 * where it is unique; every probe names 127.0.0.1 port 1) into `fixtures/harness-tool-options/<tool>.<major>.json`.
 *
 *   1. (no tool needed) every recorded option is read by the production table the way the real program reads it: a recorded
 *      valued option is never a flag, a recorded flag never a valued option, the role of a host or connection-string option
 *      is kept, an option missing from a table that must be complete fails, and every recorded abbreviation resolves the
 *      way getopt_long resolved it (the one-character prefixes of round 8 included);
 *   2. (no tool needed) the monotonicity walk: every recorded option, in every spelling, in front of a non-local host
 *      leaves the answer a refusal;
 *   3. (the tool installed) the fixture is re-recorded live and must equal the committed one, so it cannot rot unseen.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isListedLong, readLongOption, readShortOption } from "../harness/db-long-options";
import { TARGET_CLIENTS } from "../harness/db-target-clients";
import { classifyBash } from "../harness/patterns";
import {
  FIXTURE_DIR,
  PROBED_TOOLS,
  type RecordedOption,
  type ToolFixture,
  comparable,
  findBinary,
  recordTool,
} from "./helpers/record-pg-options";

const H = `prod${"."}example${"."}com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const fixtures: readonly ToolFixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(`${FIXTURE_DIR}/${file}`, "utf8")) as ToolFixture);

const specOf = (tool: string) => {
  const spec = TARGET_CLIENTS.get(tool);
  if (spec === undefined) throw new Error(`${tool} is not in the client table`);
  return spec;
};

/** The roles a table may give an option the real program says takes a value. */
const VALUE_ROLES = new Set(["host", "string", "alias", "indirect", "value"]);

describe("every probed program has a fixture, and the fixtures name only probed programs", () => {
  it("covers PROBED_TOOLS exactly", () => {
    expect(fixtures.map((f) => f.tool).sort()).toEqual(Object.keys(PROBED_TOOLS).sort());
  });
  it("records the version the table was proven against", () => {
    for (const f of fixtures) expect(f.version, f.tool).toMatch(/^(16\.\d+|8\.\d+\.\d+)/);
  });
});

describe("rule 12: the production table reads each recorded option the way the real program does", () => {
  for (const fixture of fixtures) {
    const spec = () => specOf(fixture.tool);
    const named = fixture.options.filter(
      (o): o is RecordedOption & { name: string } => o.name !== undefined && o.argv1Only !== true,
    );
    const shorts = fixture.options.filter(
      (o): o is RecordedOption & { short: string } => o.short !== undefined && o.argv1Only !== true,
    );

    describe(fixture.tool, () => {
      it.each(named.map((o) => [o.name, o] as const))("--%s", (name, option) => {
        const read = readLongOption(spec(), name);
        if (option.takesValue === true) {
          expect(VALUE_ROLES.has(read), `--${name} is a valued option, read as ${read}`).toBe(true);
        } else {
          expect(read, `--${name} takes no separate value, read as ${read}`).toBe("flag");
        }
        if (option.role !== undefined) expect(read, `role of --${name}`).toBe(option.role);
        expect(isListedLong(spec(), name), `--${name} is missing from the table`).toBe(true);
      });

      it.each(shorts.map((o) => [o.short, o] as const))("-%s", (letter, option) => {
        const read = readShortOption(spec(), letter);
        if (option.takesValue === true) {
          expect(read === "flag", `-${letter} is a valued option, read as a flag`).toBe(false);
        } else {
          expect(read, `-${letter} takes no separate value, read as ${read}`).toBe("flag");
        }
        if (option.role !== undefined) expect(read, `role of -${letter}`).toBe(option.role);
      });

      it.each(fixture.abbreviations.map((a) => [a.prefix, a.outcome] as const))(
        "abbreviation --%s resolves as getopt_long resolved it (%s)",
        (prefix, outcome) => {
          const read = readLongOption(spec(), prefix);
          if (outcome === "unrecognized") expect(read).toBe("unknown");
          else if (outcome === "ambiguous") {
            // getopt refuses a prefix of several options. The reader asks when they differ in kind (a flag and a valued
            // option: the next word may or may not be theirs); several valued options read alike and the real program errors.
            const kinds = new Set(
              named.filter((o) => o.name.startsWith(prefix)).map((o) => o.takesValue === true),
            );
            if (kinds.size > 1)
              expect(read, `a prefix of a flag and a valued option`).toBe("ambiguous");
            else
              expect(read === "flag" || VALUE_ROLES.has(read) || read === "ambiguous").toBe(true);
          } else if (outcome === "flag" || outcome === "optional") expect(read).toBe("flag");
          else if (outcome === "value") expect(VALUE_ROLES.has(read), `read as ${read}`).toBe(true);
          else expect(read).toBe(outcome);
        },
      );

      it.skipIf(fixture.exactLong !== true)("reads long options by exact name only", () => {
        expect(spec().exactLong).toBe(true);
      });
    });
  }
});

/** Every spelling of one recorded option: what the walk puts in front of `-h HOST`. */
function spellings(option: RecordedOption): string[] {
  const valued = option.takesValue === true;
  const value = option.role === "host" || option.role === "string" ? "localhost" : "v";
  const out: string[] = [];
  if (option.name !== undefined) {
    out.push(valued ? `--${option.name} ${value}` : `--${option.name}`);
    if (valued) out.push(`--${option.name}=${value}`);
  }
  if (option.short !== undefined) {
    out.push(valued ? `-${option.short} ${value}` : `-${option.short}`);
    if (valued) out.push(`-${option.short}${value}`);
  }
  return out;
}

describe("rule 12: monotonicity walks the recorded options (wrapped is never weaker than the command alone)", () => {
  for (const fixture of fixtures.filter(
    (f) => !f.tool.startsWith("redis-") && f.options.some((o) => o.role === "host"),
  )) {
    const alone = `${fixture.tool} -h ${H}`;
    it(`${fixture.tool}: the host alone is refused`, () => {
      expect(decide(alone), alone).toBe("deny");
    });
    for (const option of fixture.options.filter((o) => o.argv1Only !== true)) {
      const label = option.name ?? option.short ?? "?";
      it(`${fixture.tool} ${label}: no spelling hides a later -h HOST`, () => {
        for (const spelling of spellings(option)) {
          for (const cmd of [
            `${fixture.tool} ${spelling} -h ${H}`,
            `${fixture.tool} ${spelling} --host=${H}`,
            `${fixture.tool} ${spelling} -h${H}`,
          ]) {
            expect(decide(cmd), cmd).not.toBe("allow");
          }
        }
      });
      if (option.short !== undefined && option.takesValue !== true) {
        it(`${fixture.tool} -${option.short}: a cluster ending in h names the host`, () => {
          const cmd = `${fixture.tool} -${option.short}h ${H}`;
          expect(decide(cmd), cmd).not.toBe("allow");
        });
      }
    }
    it(`${fixture.tool}: -- ends the options and a word after it is no host option`, () => {
      expect(decide(`${fixture.tool} -h ${H} -- x`)).toBe("deny");
    });
  }
});

describe("rule 12 (live): the fixture is the installed program's behaviour today", () => {
  for (const tool of Object.keys(PROBED_TOOLS)) {
    const installed = findBinary(tool) !== undefined;
    it.skipIf(!installed)(
      `${tool}: re-recorded options equal the committed fixture`,
      async () => {
        const live = await recordTool(tool);
        expect(live).toBeDefined();
        if (live === undefined) return;
        const major = live.version.split(".")[0];
        const file = `${FIXTURE_DIR}/${tool}.${major}.json`;
        expect(existsSync(file), `no fixture ${file}: run record-pg-options.ts`).toBe(true);
        const committed = JSON.parse(readFileSync(file, "utf8")) as ToolFixture;
        expect(comparable(live)).toEqual(comparable(committed));
      },
      180_000,
    );
  }
});
