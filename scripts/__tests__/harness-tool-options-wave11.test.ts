/**
 * Wave 11 part C, rule 12 (R8-ADV-2, R8-ADV-3, R8-ADV-11, R8-CR-10, R8-CR-12): the option tables of bun, pnpm, npm, npx and docker/podman/compose
 * `run` and `exec` are held against what the INSTALLED tools do. `scripts/__tests__/helpers/record-tool-options.ts` probes each tool and writes
 * `fixtures/harness-tool-options/<command>.<version>.json`; this test needs no tool (it runs on CI) and fails when
 *  - a recorded valued option is read as a flag (the wave-10 regressions: `bun run --cwd x CMD`, `pnpm --prefix x exec CMD`),
 *  - a recorded flag is read as a valued option (the next word is the command, not a value),
 *  - a recorded option is missing from a strict table, or (lax table) an unlisted option does not ask,
 *  - the production table lists an option the tool does not know without saying why.
 * The monotonicity walk below iterates the FIXTURE options (not the table), in every spelling: wrapped(inner) >= inner.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type OptionGrammar, readOptions } from "../harness/option-grammar";
import { classifyBash } from "../harness/patterns";
import * as G from "../harness/runner-grammars";
import type { RecordedOption } from "./helpers/record-tool-options";
import {
  FIXTURE_DIR,
  TABLES,
  disagreements,
  fixtureOf,
  fixtures,
  tokensOf,
} from "./helpers/tool-tables";

describe("the recordings are well formed", () => {
  it("every tool has a recording and every recording says how it was made", () => {
    expect(fixtures.map((f) => f.command).sort()).toEqual(
      [
        "bun",
        "bun run",
        "bun x",
        "docker compose exec",
        "docker compose run",
        "docker exec",
        "docker run",
        "env",
        "npm exec",
        "npx",
        "pnpm",
        "pnpm dlx",
        "podman exec",
        "podman run",
      ].sort(),
    );
    for (const f of fixtures) {
      expect(f.version, f.command).toMatch(/^(?:\d+\.\d+|bsd|gnu-\d+\.\d+)/);
      expect(["echo-hit", "flag-needs-argument", "help"]).toContain(f.method);
      expect(f.options.length, f.command).toBeGreaterThan(4);
      for (const o of f.options) {
        expect([true, false, "optional", "unverified"]).toContain(o.takesValue);
        expect(o.name).toMatch(/^--?[A-Za-z0-9]/);
      }
    }
  });

  it("the wave-10 holes are recorded as the real tools have them", () => {
    const valued = (command: string, name: string) =>
      fixtureOf(command).options.find((o) => o.name === name)?.takesValue;
    for (const name of [
      "--cwd",
      "--env-file",
      "--elide-lines",
      "--shell",
      "--install",
      "--preload",
      "--tsconfig-override",
      "--port",
      "--define",
      "--loader",
    ]) {
      expect(valued("bun run", name), `bun run ${name}`).toBe(true);
    }
    // `--config` and `-c` take their value only after `=`: the word after them is the script
    expect(valued("bun run", "--config")).toBe(false);
    expect(valued("pnpm", "--prefix")).toBe(true);
    expect(valued("pnpm", "--workspace-packages")).toBe(true);
    for (const name of [
      "--tag",
      "--otp",
      "--omit",
      "--scope",
      "--proxy",
      "--cache",
      "--node-options",
      "--umask",
    ]) {
      expect(valued("npm exec", name), `npm ${name}`).toBe(true);
    }
    expect(valued("docker exec", "--env")).toBe(true);
    expect(valued("docker compose exec", "--env")).toBe(true);
    expect(valued("podman exec", "--env")).toBe(true);
  });
});

describe("the production tables read every recorded option the way the tool does", () => {
  for (const table of TABLES) {
    it(`${table.name}: no valued option read as a flag, no flag read as a valued option, nothing missing`, () => {
      const lines = table.commands.flatMap((command) =>
        disagreements(table.grammar, fixtureOf(command)),
      );
      expect(lines.slice(0, 8), `${lines.length} disagreements`).toEqual([]);
    });

    it(`${table.name}: the tool's own spellings agree (docker and podman do not disagree on a name)`, () => {
      const seen = new Map<string, unknown>();
      const conflicts: string[] = [];
      for (const command of table.commands) {
        for (const o of fixtureOf(command).options) {
          if (o.takesValue === "unverified") continue;
          const before = seen.get(o.name);
          if (before !== undefined && before !== o.takesValue && command !== "npm exec") {
            conflicts.push(
              `${o.name}: ${String(before)} against ${String(o.takesValue)} in ${command}`,
            );
          }
          seen.set(o.name, o.takesValue);
        }
      }
      expect(conflicts).toEqual([]);
    });

    it(`${table.name}: a name the table lists and the tool does not know is explained`, () => {
      const known = new Set<string>();
      for (const command of [...table.commands, ...(table.alsoKnown ?? [])]) {
        for (const o of fixtureOf(command).options) for (const t of tokensOf(o)) known.add(t);
      }
      const g = table.grammar;
      const listed = [
        ...g.longFlags.map((n) => `--${n}`),
        ...g.longValues.map((n) => `--${n}`),
        ...[...g.flags, ...g.values].map((n) => `-${n}`),
      ];
      const unexplained = listed.filter((t) => !known.has(t) && !table.legacy.includes(t));
      expect(unexplained).toEqual([]);
    });
  }

  it("the checker itself fails on a wrong table (a valued option moved to the flags is caught)", () => {
    const wrong: OptionGrammar = {
      ...G.BUN_RUN,
      longFlags: [...G.BUN_RUN.longFlags, "cwd", "env-file"],
      longValues: G.BUN_RUN.longValues.filter((n) => n !== "cwd" && n !== "env-file"),
    };
    expect(disagreements(wrong, fixtureOf("bun run")).join("\n")).toMatch(
      /--cwd.*reads it as flag/s,
    );
    const missing: OptionGrammar = {
      ...G.BUN_RUN,
      longFlags: G.BUN_RUN.longFlags.filter((n) => n !== "silent"),
    };
    expect(disagreements(missing, fixtureOf("bun run")).join("\n")).toMatch(
      /--silent.*missing from a strict table/,
    );
    const narrow: OptionGrammar = {
      ...G.PNPM,
      longValues: G.PNPM.longValues.filter((n) => n !== "prefix"),
    };
    expect(disagreements(narrow, fixtureOf("pnpm")).join("\n")).toMatch(
      /--prefix.*unplaced|--prefix/,
    );
  });
});

describe("rule 2: in every lax grammar an unlisted `--name VALUE` followed by a bare word asks", () => {
  const LAX: ReadonlyArray<readonly [string, OptionGrammar]> = [
    ["PNPM", G.PNPM],
    ["NPM", G.NPM],
    ["NPX", G.NPX],
    ["BUNX", G.BUNX],
    ["PNPM_DLX", G.PNPM_DLX],
    ["YARN", G.YARN],
    ["YARN_FOREACH", G.YARN_FOREACH],
    ["DOTENV", G.DOTENV],
    ["DOTENVX", G.DOTENVX],
    ["ENV_CMD", G.ENV_CMD],
    ["DOPPLER", G.DOPPLER],
    ["OP", G.OP],
    ["LERNA", G.LERNA],
    ["NX", G.NX],
    ["MISE", G.MISE],
    ["VOLTA", G.VOLTA],
    ["NIX", G.NIX],
    ["PERF", G.PERF],
  ];
  it.each(LAX)("%s", (_name, grammar) => {
    expect(grammar.lax, "a grammar that reads unlisted options as flags says so").toBe(true);
    const read = readOptions(grammar, ["--zz-not-an-option", "VALUE", "cmd"], 0);
    expect(read.unplaced).toBe("--zz-not-an-option");
    // nothing bare after it: a flag, as before
    expect(readOptions(grammar, ["--zz-not-an-option"], 0).unplaced).toBeUndefined();
    expect(readOptions(grammar, ["--zz-not-an-option", "--also"], 0).unplaced).toBeUndefined();
    expect(readOptions(grammar, ["--zz-not-an-option=v", "cmd"], 0).unplaced).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// MONOTONICITY over the FIXTURE options: wrapped(inner) >= inner, in every spelling of every recorded option
// ---------------------------------------------------------------------------------------------------

const ENV_FILE = `apps/backend/.e${"nv"}`;
const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;

const INNERS: ReadonlyArray<readonly [label: string, command: string]> = [
  ["a force push", "git push --force origin main"],
  ["a hook bypass", "git commit --no-verify -m x"],
  ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
  ["a secret read", `cat ${ENV_FILE}`],
];

interface Shape {
  /** The command line for one option spelling `spelled` (a list of words) in front of the guarded command. */
  readonly build: (spelled: readonly string[], inner: string) => string;
  /** Options that decide what runs or print and exit: the guarded command is not behind them. */
  readonly skip: ReadonlySet<string>;
}

const COMMON_SKIP = ["--help", "-h", "--version", "-v", "-V", "--revision", "--usage", "-?"];
const SHAPES: Readonly<Record<string, Shape>> = {
  bun: {
    build: (o, i) => `bun ${o.join(" ")} run ${i}`,
    skip: new Set([...COMMON_SKIP, "--eval", "-e", "--print", "-p"]),
  },
  "bun run": {
    build: (o, i) => `bun run ${o.join(" ")} ${i}`,
    skip: new Set([...COMMON_SKIP, "--eval", "-e", "--print", "-p"]),
  },
  "bun x": { build: (o, i) => `bun x ${o.join(" ")} ${i}`, skip: new Set(COMMON_SKIP) },
  pnpm: {
    build: (o, i) => `pnpm ${o.join(" ")} exec ${i}`,
    skip: new Set([...COMMON_SKIP, "-c", "--shell-mode"]),
  },
  "pnpm dlx": {
    build: (o, i) => `pnpm dlx ${o.join(" ")} ${i}`,
    skip: new Set([...COMMON_SKIP, "-c", "--shell-mode", "-s", "--silent"]),
  },
  "npm exec": {
    build: (o, i) => `npm exec ${o.join(" ")} -- ${i}`,
    skip: new Set([...COMMON_SKIP, "-c", "--call", "--versions"]),
  },
  npx: {
    build: (o, i) => `npx ${o.join(" ")} -- ${i}`,
    skip: new Set([...COMMON_SKIP, "-c", "--call", "--versions"]),
  },
  env: {
    build: (o, i) => `env ${o.join(" ")} ${i}`,
    skip: new Set([...COMMON_SKIP, "-S", "--split-string"]),
  },
  "docker run": {
    build: (o, i) => `docker run ${o.join(" ")} IMG ${i}`,
    skip: new Set([...COMMON_SKIP, "--entrypoint"]),
  },
  "docker exec": {
    build: (o, i) => `docker exec ${o.join(" ")} CTR ${i}`,
    skip: new Set(COMMON_SKIP),
  },
  "docker compose run": {
    build: (o, i) => `docker compose run ${o.join(" ")} SVC ${i}`,
    skip: new Set([...COMMON_SKIP, "--entrypoint"]),
  },
  "docker compose exec": {
    build: (o, i) => `docker compose exec ${o.join(" ")} SVC ${i}`,
    skip: new Set(COMMON_SKIP),
  },
  "podman run": {
    build: (o, i) => `podman run ${o.join(" ")} IMG ${i}`,
    skip: new Set([...COMMON_SKIP, "--entrypoint"]),
  },
  "podman exec": {
    build: (o, i) => `podman exec ${o.join(" ")} CTR ${i}`,
    skip: new Set(COMMON_SKIP),
  },
};

/** The spellings of one recorded option in front of a command: separate value, joined `=` value, joined short value, flag alone. */
function spellings(option: RecordedOption): Array<readonly string[]> {
  const out: Array<readonly string[]> = [];
  const longs = option.name.startsWith("--") ? [option.name] : [];
  const shorts = option.name.startsWith("--")
    ? option.short === undefined
      ? []
      : [option.short]
    : [option.name];
  // a short letter whose arity no probe settled is read as the flag it is in the table: a stray word after it is a command of its own
  if (option.takesValue === false || (option.takesValue === "unverified" && longs.length === 0)) {
    for (const t of [...longs, ...shorts]) out.push([t]);
    return out;
  }
  for (const t of longs) out.push([t, "x"], [`${t}=x`]);
  for (const t of shorts) out.push([t, "x"], [`${t}x`]);
  // a value option left with no value, or an unverified one, is the command's own business: the table must not guess
  return out;
}

describe("MONOTONICITY over the recorded options: no spelling of a real option hides a guarded command", () => {
  for (const [command, shape] of Object.entries(SHAPES)) {
    it(command, () => {
      const fixture = fixtureOf(command);
      const weaker: string[] = [];
      let checked = 0;
      for (const option of fixture.options) {
        if (shape.skip.has(option.name) || shape.skip.has(option.short ?? "")) continue;
        for (const spelled of spellings(option)) {
          for (const [label, inner] of INNERS) {
            const alone = rank(inner);
            const wrapped = shape.build(spelled, inner);
            checked++;
            const answer = rank(wrapped);
            // an option the table cannot place (unverified) asks; any other must keep the answer of the command itself
            const floor = option.takesValue === "unverified" ? 1 : alone;
            if (answer < floor) weaker.push(`${label}: ${wrapped} -> ${answer} (alone ${alone})`);
          }
        }
      }
      expect(checked, `${command}: invocations generated`).toBeGreaterThan(fixture.options.length);
      expect(weaker.slice(0, 6), `${command}: ${weaker.length} of ${checked} weaker`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Real command lines: an option no table places asks, an option a table places keeps the command judged
// ---------------------------------------------------------------------------------------------------

const NO_VERIFY = "git commit --no-verify -m x";

describe("rule 2 on real command lines: an unlisted or unverified option followed by a bare word asks", () => {
  it.each([
    `pnpm --zz-unlisted x exec ${NO_VERIFY}`,
    `pnpm --node-linker hoisted exec ${NO_VERIFY}`,
    `pnpm --trust-policy no-downgrade exec ${NO_VERIFY}`,
    `npm exec --zz-unlisted x -- ${NO_VERIFY}`,
    `npx --zz-unlisted x -- ${NO_VERIFY}`,
    `bunx --zz-unlisted x ${NO_VERIFY}`,
    `bun run --zz-unlisted x ${NO_VERIFY}`,
    `yarn --zz-unlisted x exec ${NO_VERIFY}`,
    `corepack pnpm --zz-unlisted x exec ${NO_VERIFY}`,
    `sudo -n pnpm --zz-unlisted x exec ${NO_VERIFY}`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("a recorded option is placed: the command behind it is judged, not asked about", () => {
    expect(rank(`pnpm --prefix x exec ${NO_VERIFY}`)).toBe(2);
    expect(rank(`bun run --cwd x ${NO_VERIFY}`)).toBe(2);
    expect(rank(`npm exec --tag x -- ${NO_VERIFY}`)).toBe(2);
    expect(rank("pnpm --prefix apps/web exec ls")).toBe(0);
    expect(rank("bun run --cwd apps/backend test")).toBe(0);
    expect(rank("npm exec --tag x -- ls")).toBe(0);
    expect(rank("npx --yes -- tsc --noEmit")).toBe(0);
    // npx's legacy --no-install: 49 distinct real commands of this machine use it
    expect(rank("npx --no-install tsc --noEmit")).toBe(0);
    expect(rank("npx --no-install -- tsc")).toBe(0);
    expect(rank(`npx --no-install ${NO_VERIFY}`)).toBe(2);
    expect(rank("pnpm --silent exec ls")).toBe(0);
  });

  it("npx reads -p as the package it names, npm exec reads -p as --parseable", () => {
    expect(rank(`npx -p typescript -- ${NO_VERIFY}`)).toBe(2);
    expect(rank(`npm exec -p -- ${NO_VERIFY}`)).toBe(2);
  });
});

describe("an option whose arity no probe could settle is neither a flag nor a value", () => {
  const G2: OptionGrammar = {
    flags: "",
    values: "",
    longFlags: ["a"],
    longValues: ["b"],
    exact: true,
    unverified: ["trust-policy"],
  };
  it("an exact grammar asks on it, and on nothing else it lacks the name of", () => {
    expect(readOptions(G2, ["--trust-policy", "x", "cmd"], 0).unplaced).toBe("--trust-policy");
    expect(readOptions(G2, ["--trust-policy"], 0).unplaced).toBe("--trust-policy");
    expect(readOptions(G2, ["--a", "cmd"], 0).unplaced).toBeUndefined();
    // a grammar that is lax as well still does not read it as a flag
    expect(readOptions({ ...G2, lax: true }, ["--trust-policy"], 0).unplaced).toBe(
      "--trust-policy",
    );
  });
  it("a prefix of it is not taken for a longer name", () => {
    const loose: OptionGrammar = {
      ...G2,
      exact: false,
      lax: true,
      longValues: ["trust-policy-exclude"],
    };
    expect(readOptions(loose, ["--trust-policy", "x", "cmd"], 0).unplaced).toBe("--trust-policy");
    expect(readOptions(loose, ["--trust-policy-exclude", "x", "cmd"], 0).end).toBe(2);
    expect(readOptions(loose, ["--trust", "x", "cmd"], 0).unplaced).toBe("--trust");
  });
});

// ---------------------------------------------------------------------------------------------------
// Coverage: no wrapper or runner table escapes rule 12
// ---------------------------------------------------------------------------------------------------

describe("every wrapper and runner is covered by a recording or says why it is not", () => {
  const unverified = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "unverified-tools.json"), "utf8"),
  ) as { tools: Record<string, { evidence: string; note: string }> };
  const recorded = new Set(["bun", "bunx", "pnpm", "pnpx", "npm", "npx", "env"]);
  const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!"]);

  it("a wrapper, manager or bare runner is recorded or listed with its evidence", async () => {
    const { WRAPPER_SPECS } = await import("../harness/wrapper-specs");
    const { MANAGERS, BARE_RUNNERS } = await import("../harness/runners");
    const names = [...WRAPPER_SPECS.keys(), ...MANAGERS.keys(), ...BARE_RUNNERS.keys()].filter(
      (n) => !recorded.has(n) && !KEYWORDS.has(n),
    );
    const missing = names.filter((n) => unverified.tools[n] === undefined);
    expect(missing, "add it to unverified-tools.json with its evidence, or record it").toEqual([]);
    for (const entry of Object.values(unverified.tools)) {
      expect(["manpage", "help-text", "manual", "builtin"]).toContain(entry.evidence);
    }
  });

  it("every installed tool with a recording is listed in the recordings, not as unverified", () => {
    for (const name of ["bun", "pnpm", "npm", "npx", "docker", "podman", "env"]) {
      expect(unverified.tools[name], name).toBeUndefined();
    }
  });
});

describe("R8-ADV-9: `pnpm WORD` runs the PATH program WORD unless it is a pnpm command or a script", () => {
  it("every command pnpm lists is known, so it is not read as a program", () => {
    for (const command of fixtureOf("pnpm").commands ?? []) {
      expect(G.PNPM_COMMANDS.has(command), command).toBe(true);
    }
  });
  it.each([
    `pnpm ${NO_VERIFY}`,
    `pnpm psql -h ${HOST} -c 'select 1'`,
    "pnpm git push --force origin main",
    `pnpm -r ${NO_VERIFY}`,
    `pnpm --filter x ${NO_VERIFY}`,
    `pnpm -C apps/web ${NO_VERIFY}`,
    `pnpm --dir apps/web ${NO_VERIFY}`,
    `pnpm --prefix x ${NO_VERIFY}`,
    `pnpm -r --parallel ${NO_VERIFY}`,
    `corepack pnpm ${NO_VERIFY}`,
    `/opt/homebrew/bin/pnpm ${NO_VERIFY}`,
    "pnpm cp /tmp/y .claude/settings.json",
  ])("%s is judged as the program it runs", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });
  it("pnpm's own commands, scripts and everyday forms stay allowed", () => {
    for (const cmd of [
      "pnpm install",
      "pnpm i",
      "pnpm add zod",
      "pnpm test",
      "pnpm start",
      "pnpm run build",
      "pnpm exec tsc --noEmit",
      "pnpm dlx cowsay hi",
      "pnpm -r run build",
      "pnpm --filter web build",
      "pnpm arch:fitness",
      "pnpm lint",
      "pnpm dev",
      "pnpm update",
      "pnpm why zod",
      "pnpm store prune",
      "pnpm config set x y",
    ]) {
      expect(rank(cmd), cmd).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Clusters of the recorded short flags, and `--` after the options
// ---------------------------------------------------------------------------------------------------

describe("MONOTONICITY over the recorded options: clusters of short flags and `--` keep the guarded command judged", () => {
  /** Commands whose real CLI takes `--` between its options and the command (pflag); the npm shapes carry their own `--`. */
  const DASHDASH = new Set([
    "docker run",
    "docker exec",
    "docker compose run",
    "docker compose exec",
    "podman run",
    "podman exec",
  ]);
  for (const [command, shape] of Object.entries(SHAPES)) {
    it(command, () => {
      const fixture = fixtureOf(command);
      const shortFlags = fixture.options
        .filter((o) => o.takesValue === false && !shape.skip.has(o.name))
        .flatMap((o) =>
          o.name.startsWith("--") ? (o.short === undefined ? [] : [o.short]) : [o.name],
        )
        .filter((t) => !shape.skip.has(t));
      const weaker: string[] = [];
      let checked = 0;
      const check = (spelled: readonly string[]): void => {
        for (const [label, inner] of INNERS) {
          const alone = rank(inner);
          const wrapped = shape.build(spelled, inner);
          checked++;
          if (rank(wrapped) < alone) weaker.push(`${label}: ${wrapped}`);
        }
      };
      // every pair of short flags as one cluster, and each flag then `--`
      for (const a of shortFlags.slice(0, 8)) {
        for (const b of shortFlags.slice(0, 8)) if (a !== b) check([`${a}${b.slice(1)}`]);
        if (DASHDASH.has(command)) check([a, "--"]);
      }
      if (DASHDASH.has(command)) check(["--"]);
      expect(weaker.slice(0, 5), `${command}: ${weaker.length} of ${checked}`).toEqual([]);
    });
  }
});
