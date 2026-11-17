/**
 * The production option tables and the recordings they are held against (wave 11 part C, rule 12): shared by the fixture test (CI, no tool
 * needed) and the live test (re-records the installed tool). Not a test file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSE_EXEC_GRAMMAR,
  COMPOSE_RUN_GRAMMAR,
  EXEC_GRAMMAR,
  RUN_GRAMMAR,
} from "../../harness/container-run";
import { type OptionGrammar, readOptions } from "../../harness/option-grammar";
import * as G from "../../harness/runner-grammars";
import { WRAPPER_SPECS } from "../../harness/wrapper-specs";
import type { RecordedOption, ToolFixture } from "./record-tool-options";

export const FIXTURE_DIR = join(__dirname, "..", "fixtures", "harness-tool-options");
export const fixtures: ToolFixture[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json") && name !== "unverified-tools.json")
  .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as ToolFixture);
export const fixtureOf = (command: string): ToolFixture => {
  const found = fixtures.find((f) => f.command === command);
  if (found === undefined) throw new Error(`no fixture for ${command}`);
  return found;
};

export interface Table {
  readonly name: string;
  readonly grammar: OptionGrammar;
  /** The recordings whose options this one table reads (docker and podman share a table). */
  readonly commands: readonly string[];
  /** Recordings of other commands whose options this table also lists (npx reads npm's names). */
  readonly alsoKnown?: readonly string[];
  /** Names the table lists that the installed tool does not know, and why (an older version, a spelling the tool lists nowhere). */
  readonly legacy: readonly string[];
}

export const TABLES: readonly Table[] = [
  {
    name: "env",
    grammar: (WRAPPER_SPECS.get("env") as { grammar: OptionGrammar }).grammar,
    commands: ["env"],
    // GNU env's long options and `-a` (the GNU argv0 option, BSD env rejects it): the short options BSD env does record are NOT listed here, so a
    // table that read one wrongly would be reported (E1-8; wave 11 listed `-i -0 -v -u -C -S -P` too, which silenced the check for them)
    legacy: [
      "--ignore-environment",
      "--null",
      "--debug",
      "--list-signal-handling",
      "--help",
      "--version",
      "--block-signal",
      "--default-signal",
      "--ignore-signal",
      "--unset",
      "--chdir",
      "--split-string",
      "--argv0",
      "-a",
    ],
  },
  { name: "BUN_GLOBAL", grammar: G.BUN_GLOBAL, commands: ["bun"], legacy: [] },
  { name: "BUN_RUN", grammar: G.BUN_RUN, commands: ["bun run"], legacy: [] },
  { name: "BUNX", grammar: G.BUNX, commands: ["bun x"], legacy: ["--help", "-b"] },
  { name: "PNPM", grammar: G.PNPM, commands: ["pnpm"], legacy: [] },
  { name: "PNPM_DLX", grammar: G.PNPM_DLX, commands: ["pnpm dlx"], legacy: ["-p"] },
  { name: "NPM", grammar: G.NPM, commands: ["npm exec"], legacy: [] },
  { name: "NPX", grammar: G.NPX, commands: ["npx"], alsoKnown: ["npm exec"], legacy: [] },
  {
    name: "RUN_GRAMMAR",
    grammar: RUN_GRAMMAR,
    commands: ["docker run", "podman run"],
    legacy: [
      "--kernel-memory",
      "--cpu-count",
      "--cpu-percent",
      "--io-maxbandwidth",
      "--io-maxiops",
    ],
  },
  {
    name: "COMPOSE_RUN_GRAMMAR",
    grammar: COMPOSE_RUN_GRAMMAR,
    commands: ["docker compose run"],
    legacy: ["--help"],
  },
  {
    name: "EXEC_GRAMMAR",
    grammar: EXEC_GRAMMAR,
    commands: ["docker exec", "podman exec"],
    legacy: [],
  },
  {
    name: "COMPOSE_EXEC_GRAMMAR",
    grammar: COMPOSE_EXEC_GRAMMAR,
    commands: ["docker compose exec"],
    legacy: [],
  },
];

type Reading = "value" | "flag" | "unplaced";

/** How the table reads `token` when a word follows it: a value, a flag (the next word is the command), or a question. */
export function reading(grammar: OptionGrammar, token: string): Reading {
  const read = readOptions(grammar, [token, "VAL", "CMD"], 0);
  if (read.unplaced !== undefined) return "unplaced";
  return read.end === 2 ? "value" : "flag";
}

/** The tokens one recorded option is spelled with: its long name and its short letter. */
export const tokensOf = (option: RecordedOption): string[] =>
  [option.name, option.short].filter((t): t is string => t !== undefined);

/** Every disagreement between a table and a recording, as readable lines. */
export function disagreements(grammar: OptionGrammar, fixture: ToolFixture): string[] {
  const lines: string[] = [];
  for (const option of fixture.options) {
    for (const token of tokensOf(option)) {
      const got = reading(grammar, token);
      if (option.takesValue === true && got !== "value") {
        lines.push(
          `${fixture.command} ${token}: the tool takes a value, the table reads it as ${got}`,
        );
      } else if (option.takesValue === false && got === "value") {
        lines.push(`${fixture.command} ${token}: the tool takes no value, the table reads a value`);
      } else if (option.takesValue === false && got === "unplaced" && grammar.lax !== true) {
        lines.push(`${fixture.command} ${token}: missing from a strict table`);
      } else if (option.takesValue === false && got === "unplaced" && token.startsWith("--")) {
        lines.push(`${fixture.command} ${token}: a recorded flag is unlisted (it asks)`);
      } else if (
        option.takesValue === "unverified" &&
        token.startsWith("--") &&
        got !== "unplaced"
      ) {
        lines.push(
          `${fixture.command} ${token}: unverified, so the table must not place it (read as ${got})`,
        );
      }
    }
  }
  return lines;
}
