/**
 * Wave 11 part C, rule 12(c) (R8-CR-12): the recordings must not rot unseen. Where a tool is INSTALLED (looked up on PATH and in the usual
 * package-manager directories, never at a hard-coded path), this test re-records a bounded sample of its options live and
 *   1. fails when a production table disagrees with what the tool does NOW (the invariant the fixture test holds against the committed recording),
 *   2. fails when the live answer differs from the committed recording for the same version (re-record with
 *      `bun scripts/__tests__/helpers/record-tool-options.ts --write "<command>"`), and says so when the installed version is another one.
 * It is skipped ONLY when the tool is not installed. A full re-record costs minutes (npm and pnpm start node for every probe), so a deterministic sample of the
 * valued options and of the flags is probed here; the recorder's CLI re-records everything.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as G from "../harness/runner-grammars";
import {
  TARGETS,
  type ToolFixture,
  candidatesOf,
  findTool,
  installedVersion,
  liveCommands,
  newNamesInHelp,
  recordTarget,
} from "./helpers/record-tool-options";
import { TABLES, disagreements, fixtureOf } from "./helpers/tool-tables";

const LIVE_TIMEOUT_MS = 300_000;
const FLAG_SAMPLE = 14;
const VALUED_SAMPLE = 30;
/** Every `step`-th name of `names`, at most `count` of them: the same ones on every machine. */
const everyNth = (names: readonly string[], count: number): string[] =>
  names.filter((_, at) => at % Math.max(1, Math.ceil(names.length / count)) === 0);
const sampleOf = (fixture: ToolFixture): ReadonlySet<string> => {
  const flags = fixture.options.filter((o) => o.takesValue === false).map((o) => o.name);
  const valued = fixture.options
    .filter((o) => o.takesValue === true && o.evidence === "probe")
    .map((o) => o.name);
  return new Set([...everyNth(valued, VALUED_SAMPLE), ...everyNth(flags, FLAG_SAMPLE)]);
};

const isGnuEnv = (bin: string): boolean =>
  /GNU coreutils/.test(spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout);

/** The subcommand lists the production tables carry, per recording (a word in one is no program: `npm --no-fund install`). */
const PRODUCTION_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  bun: G.BUN_COMMANDS,
  npm: G.NPM_COMMANDS,
  pnpm: [...G.PNPM_COMMANDS],
};

/** The recordings that hold subcommands alone: no option of theirs is probed (`npm`, for `npm --no-fund install`). */
const COMMANDS_ONLY = new Set(["npm"]);

/** The commands whose option names come from a help text alone (no probe to repeat): their names are compared instead. */
const HELP_ONLY = new Set(["bun x", "pnpm dlx"]);

for (const target of TARGETS) {
  const bin = findTool(target.tool);
  describe(`live: ${target.key}`, () => {
    it.skipIf(bin === undefined)(
      `the installed ${target.tool} still reads its options as the recording and the production table say`,
      async (ctx) => {
        const committed = fixtureOf(target.key);
        const installed =
          target.flavour === true
            ? committed.version.startsWith("gnu") === isGnuEnv(bin as string)
              ? committed.version
              : "other flavour"
            : installedVersion(bin as string);
        // Another version than the one recorded (CI runs bun 1.3.5 on Linux, the recordings are from a developer machine) is not what the tables were
        // proven against: skip with the reason BEFORE any assertion, never fail on a version difference (wave 13, C2). Re-record to compare.
        if (installed !== committed.version)
          ctx.skip(
            `${target.key} ${installed} is installed and the recording is ${committed.version}: re-record with "bun scripts/__tests__/helpers/record-tool-options.ts --write \"${target.key}\"" to compare`,
          );
        // A name the installed tool lists that the recording does not hold is an option nobody has read yet (a newer tool): fail until re-recorded
        const fresh = COMMANDS_ONLY.has(target.key)
          ? []
          : await newNamesInHelp(bin as string, target, committed);
        expect(
          fresh,
          `${target.key} ${installed} lists options the recording does not hold: re-record the fixture and read them`,
        ).toEqual([]);
        // the same for subcommands, and the production list must hold every one the tool lists
        if (target.commands !== undefined) {
          const now = await liveCommands(bin as string, target);
          expect(
            now.filter((c) => !(committed.commands ?? []).includes(c)),
            `${target.key} ${installed} lists subcommands the recording does not hold`,
          ).toEqual([]);
          expect(
            now.filter((c) => !(PRODUCTION_COMMANDS[target.key] ?? []).includes(c)),
            `the production list of ${target.key} subcommands lacks some`,
          ).toEqual([]);
        }
        if (COMMANDS_ONLY.has(target.key)) return;
        if (HELP_ONLY.has(target.key)) {
          // names only: every recorded option must still be in the tool's own help text
          const { spawnSync } = await import("node:child_process");
          const text = target.helpArgs
            .map((args) => {
              const r = spawnSync(bin as string, [...args], { encoding: "utf8", timeout: 20_000 });
              return `${r.stdout}\n${r.stderr}`;
            })
            .join("\n");
          const live = new Set(candidatesOf(text).map((c) => c.name));
          const gone = committed.options
            .filter((o) => o.takesValue !== "unverified" && !live.has(o.name))
            .map((o) => o.name);
          if (installed === committed.version)
            expect(gone, `${target.key} ${installed}`).toEqual([]);
          return;
        }
        const first = await recordTarget(bin as string, target, sampleOf(committed));
        // a probe the loaded machine never answered is `unverified` live (`NoAnswer`): ask again, alone, for the names the recording had settled
        const settled = new Set(
          committed.options.filter((o) => o.takesValue !== "unverified").map((o) => o.name),
        );
        const unsure = first.options
          .filter((o) => o.takesValue === "unverified" && settled.has(o.name))
          .map((o) => o.name);
        const again =
          unsure.length === 0
            ? []
            : (await recordTarget(bin as string, target, new Set(unsure))).options;
        const live = {
          ...first,
          options: first.options.map((o) => again.find((a) => a.name === o.name) ?? o),
        };
        // 1. the table against the tool as it is now
        const table = TABLES.filter((t) => t.commands.includes(target.key));
        expect(table.length, `a production table reads ${target.key}`).toBeGreaterThan(0);
        for (const { grammar } of table) {
          expect(disagreements(grammar, live), `${target.key} ${installed}`).toEqual([]);
        }
        // 2. the committed recording against the tool as it is now (same version: they must agree)
        const was = new Map(committed.options.map((o) => [o.name, o.takesValue]));
        const changed = live.options
          .filter((o) => o.takesValue !== "unverified" && was.get(o.name) !== undefined)
          .filter((o) => was.get(o.name) !== "unverified" && was.get(o.name) !== o.takesValue)
          .map(
            (o) => `${o.name}: recorded ${String(was.get(o.name))}, now ${String(o.takesValue)}`,
          );
        expect(live.options.length).toBeGreaterThan(0);
        expect(changed, `${target.key} ${installed}: re-record the fixture`).toEqual([]);
      },
      LIVE_TIMEOUT_MS,
    );
  });
}
