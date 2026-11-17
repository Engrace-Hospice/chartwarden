/**
 * Wave 12 part E1, E1-3 and E1-4 (R9-CR-1, R9-ADV-10, R9-CR-18, R9-CR-8, R9-COMP-5):
 *   E1-3 `bun run --parallel|--sequential 'CMD'` runs every operand as a shell line (probed on bun 1.4.4: `bun run --parallel 'echo HIT'` prints HIT where
 *        `bun run 'echo HIT'` is "Script not found"); npm 11.11 runs the LAST `-c` (`npm exec -c true -c 'echo HIT'` prints HIT), so every `-c`/`--call` value is
 *        judged; `npm exec --no CMD` reads `--no` as the flag it is. The recordings carry `runsOperandAsCommand` for these options and the walk below puts a
 *        guarded command behind each of them as a QUOTED operand (the walk of round 9 put only unquoted words behind options).
 *   E1-4 the wave-11 rule "an unlisted option followed by a bare word asks" no longer fires where no program can follow (`npm --no-fund install`) and now also
 *        covers unlisted short letters (`pnpm -Z x exec CMD`).
 * The non-local host and the live env file are built from parts.
 */
import { describe, expect, it } from "vitest";
import { program } from "../harness/command-words";
import { type OptionGrammar, readOptions } from "../harness/option-grammar";
import { classifyBash } from "../harness/patterns";
import * as G from "../harness/runner-grammars";
import { shellQuote } from "../harness/shell-quote";
import { fixtureOf, fixtures } from "./helpers/tool-tables";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const GUARDED: ReadonlyArray<readonly [label: string, command: string]> = [
  ["a force push", "git push --force origin main"],
  ["a hook bypass", "git commit --no-verify -m x"],
  ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
  ["a protected write", "cp /tmp/x .claude/settings.json"],
  ["a secret read", `cat ${ENV_FILE}`],
];

describe("E1-3: bun run --parallel and --sequential run every operand as a shell line", () => {
  const FORMS: ReadonlyArray<readonly [string, (line: string) => string]> = [
    ["run --parallel", (l) => `bun run --parallel ${shellQuote(l)}`],
    ["run --sequential", (l) => `bun run --sequential ${shellQuote(l)}`],
    ["--parallel run", (l) => `bun --parallel run ${shellQuote(l)}`],
    ["--sequential run", (l) => `bun --sequential run ${shellQuote(l)}`],
    ["--parallel, no run", (l) => `bun --parallel ${shellQuote(l)}`],
    ["after another option", (l) => `bun run --parallel --silent ${shellQuote(l)}`],
    ["after a valued option", (l) => `bun run --parallel --cwd /tmp ${shellQuote(l)}`],
    ["after --", (l) => `bun run --parallel -- ${shellQuote(l)}`],
    ["second operand", (l) => `bun run --parallel 'echo A' ${shellQuote(l)}`],
    ["third operand", (l) => `bun run --sequential 'echo A' 'echo B' ${shellQuote(l)}`],
    ["first of two", (l) => `bun run --parallel ${shellQuote(l)} 'echo B'`],
    ["under env", (l) => `env A=1 bun run --parallel ${shellQuote(l)}`],
    ["under timeout", (l) => `timeout 5 bun run --parallel ${shellQuote(l)}`],
    ["under sudo", (l) => `sudo bun run --parallel ${shellQuote(l)}`],
  ];
  for (const [label, command] of GUARDED) {
    it(`no form hides ${label}`, () => {
      const alone = rank(command);
      expect(alone, `${label} alone`).toBeGreaterThanOrEqual(1);
      const weaker = FORMS.map(([name, build]) => [name, build(command)] as const).filter(
        ([, cmd]) => rank(cmd) < alone,
      );
      expect(weaker.slice(0, 4), `${weaker.length} of ${FORMS.length}`).toEqual([]);
    });
  }

  it("each word is a line of its own, and the words joined are judged too (what a user typing `--parallel git push …` means)", () => {
    expect(program("bun run --parallel echo hi").lines).toEqual(
      expect.arrayContaining(["hi", "echo hi"]),
    );
    expect(rank("bun run --parallel git push --force origin main")).toBe(2);
  });

  it("bun's own subcommands keep the flag: `bun --parallel test`, `install`, `x CMD` are not run lines", () => {
    expect(decide("bun --parallel test")).toBe("allow");
    expect(decide("bun --parallel install")).toBe("allow");
    expect(decide("bun --parallel x tsc --noEmit")).toBe("allow");
    // `bun --parallel x CMD` is still bunx: the command behind it is judged
    expect(rank("bun --parallel x git commit --no-verify -m x")).toBe(2);
  });

  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "bun run --parallel test",
      "bun run --parallel lint typecheck",
      "bun run --sequential 'echo a' 'echo b'",
      "bun run --parallel 'bun run dev' 'bun run test'",
      "bun run --filter '*' --parallel dev",
      "bun run test",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("the recordings say which options run their operand, and the production tables list them", () => {
    for (const command of ["bun", "bun run"]) {
      const marked = fixtureOf(command)
        .options.filter((o) => o.runsOperandAsCommand === true)
        .map((o) => o.name);
      expect(marked.sort(), command).toEqual(["--parallel", "--sequential"]);
    }
    for (const command of ["npm exec", "npx"]) {
      expect(
        fixtureOf(command).options.find((o) => o.runsOperandAsCommand === true)?.name,
        command,
      ).toBe("--call");
    }
    expect(fixtureOf("env").options.find((o) => o.runsOperandAsCommand === true)?.name).toBe("-S");
    expect(fixtureOf("pnpm").options.some((o) => o.runsOperandAsCommand === true)).toBe(false);
  });
});

describe("the monotonicity walk over the recorded options puts a guarded command behind every option that runs its operand, QUOTED", () => {
  /** Where the quoted command goes for each recorded command. */
  const SHAPES: Readonly<Record<string, (option: string, quoted: string) => string[]>> = {
    bun: (o, q) => [`bun ${o} ${q}`, `bun ${o} run ${q}`, `bun ${o} 'echo A' ${q}`],
    "bun run": (o, q) => [
      `bun run ${o} ${q}`,
      `bun run ${o} 'echo A' ${q}`,
      `bun run ${o} -- ${q}`,
    ],
    "npm exec": (o, q) => [
      `npm exec ${o} ${q}`,
      `npm exec ${o}=${q}`,
      `npm exec -c true ${o} ${q}`,
      `npm exec ${o} ${q} -c true`,
    ],
    npx: (o, q) => [`npx ${o} ${q}`, `npx ${o}=${q}`, `npx -c true ${o} ${q}`],
    env: (o, q) => [`env ${o} ${q}`, `env -i ${o} ${q}`, `env ${o}${q}`],
  };
  const flagged = fixtures.flatMap((f) =>
    f.options.filter((o) => o.runsOperandAsCommand === true).map((o) => [f.command, o] as const),
  );

  it("every flagged option has a shape here (a new one fails until it is walked)", () => {
    expect(flagged.length).toBe(7);
    for (const [command] of flagged) expect(Object.keys(SHAPES), command).toContain(command);
  });

  for (const [label, guarded] of GUARDED) {
    it(label, () => {
      const alone = rank(guarded);
      const weaker: string[] = [];
      let checked = 0;
      for (const [command, option] of flagged) {
        for (const spelling of [
          option.name,
          ...(option.short === undefined ? [] : [option.short]),
        ]) {
          for (const cmd of (SHAPES[command] as (o: string, q: string) => string[])(
            spelling,
            shellQuote(guarded),
          )) {
            checked++;
            if (rank(cmd) < alone) weaker.push(cmd);
          }
        }
      }
      expect(checked).toBeGreaterThan(20);
      expect(weaker.slice(0, 5), `${weaker.length} of ${checked}`).toEqual([]);
    });
  }
});

describe("E1-3: npm reads the LAST -c, so every -c and --call value is judged", () => {
  const NV = "git commit --no-verify -m x";
  const q = (c: string): string => shellQuote(c);
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["npm exec -c true -c CMD", `npm exec -c true -c ${q(NV)}`],
    ["npm exec -c CMD -c true", `npm exec -c ${q(NV)} -c true`],
    ["npm exec -c a -c CMD -c b", `npm exec -c true -c ${q(NV)} -c true`],
    ["npm exec --call x -c CMD", `npm exec --call x -c ${q(NV)}`],
    ["npm exec --call=x --call=CMD", `npm exec --call=x --call=${q(NV)}`],
    ["npm exec -cx -cCMD", `npm exec -ctrue -c${q(NV)}`],
    ["npm x -c true -c CMD", `npm x -c true -c ${q(NV)}`],
    ["npx -c true -c CMD", `npx -c true -c ${q(NV)}`],
    ["npx --call true --call CMD", `npx --call true --call ${q(NV)}`],
    ["npx -y -c true -c CMD", `npx -y -c true -c ${q(NV)}`],
    ["under env", `env A=1 npm exec -c true -c ${q(NV)}`],
  ];
  it.each(cases)("%s is judged", (_label, cmd) => {
    expect(rank(cmd), cmd).toBe(2);
  });
  it("one -c, as before", () => {
    expect(rank(`npm exec -c ${q(NV)}`)).toBe(2);
    expect(decide("npm exec -c 'echo hi'")).toBe("allow");
    expect(decide("npx -c 'echo a' -c 'echo b'")).toBe("allow");
  });
});

describe("R9-CR-18: `npm exec --no CMD` reads --no as a flag (probed: it leaves CMD as the package)", () => {
  it("both grammars list it", () => {
    for (const g of [G.NPM, G.NPX]) expect(readOptions(g, ["--no", "x"], 0).end).toBe(1);
    for (const command of ["npm exec", "npx"]) {
      expect(fixtureOf(command).options.find((o) => o.name === "--no")?.takesValue, command).toBe(
        false,
      );
    }
  });
  it("so the command behind it is judged like `npm exec CMD`", () => {
    expect(rank("npm exec --no git commit --no-verify -m x")).toBe(2);
    expect(rank("npx --no git commit --no-verify -m x")).toBe(2);
  });
});

describe("E1-4: an unlisted option before one of the manager's own subcommands is a flag", () => {
  const OK = [
    "npm --no-fund install",
    "npm --silent run build",
    "npm --quiet install",
    "npm --no-audit install",
    "npm --no-progress ci",
    "npm --verbose install",
    "pnpm --frozen-lockfile install",
    "pnpm --ignore-scripts install",
    "pnpm --offline install",
    "pnpm --prefer-offline install",
    "pnpm --shamefully-hoist install",
    "pnpm --fetch-timeout 1 install",
    "bun --frozen-lockfile install",
    "bun --silent install",
    "yarn --frozen-lockfile install",
    "yarn --silent add left-pad",
    "yarn dlx -q cowsay hi",
    "pnpm install --frozen-lockfile",
    "npm install --no-fund",
    "command -v git",
    "nohup ls",
  ];
  it.each(OK)("%s stays allowed", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  const STILL_ASK = [
    // a bare word after an unlisted option that could be a program
    "npm --zz-unlisted git commit --no-verify -m x",
    "pnpm --zz-unlisted git commit --no-verify -m x",
    "yarn --zz-unlisted git commit --no-verify -m x",
    "bun --zz-unlisted x git commit --no-verify -m x",
    // after `exec` the same subcommand word IS a program, so the grammar after it has no subcommands
    "npm exec --zz-unlisted install",
    "pnpm exec --zz-unlisted install",
    "npx --zz-unlisted git commit --no-verify -m x",
    "bunx --zz-unlisted git commit --no-verify -m x",
  ];
  it.each(STILL_ASK)("%s asks or denies", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("a subcommand that is itself a program starter is still read: `npm --no-fund exec CMD`, `pnpm --frozen-lockfile exec CMD`", () => {
    expect(rank("npm --no-fund exec git commit --no-verify -m x")).toBe(2);
    expect(rank("pnpm --frozen-lockfile exec git commit --no-verify -m x")).toBe(2);
    expect(rank("pnpm --frozen-lockfile dlx git commit --no-verify -m x")).toBe(2);
    expect(rank("bun --frozen-lockfile run git commit --no-verify -m x")).toBeGreaterThanOrEqual(0);
  });

  it("the subcommand lists hold every command the installed tools listed (recorded in the fixtures)", () => {
    const lists: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["bun", G.BUN_COMMANDS],
      ["npm", G.NPM_COMMANDS],
      ["pnpm", [...G.PNPM_COMMANDS]],
    ];
    for (const [tool, production] of lists) {
      const recorded = fixtureOf(tool).commands ?? [];
      expect(recorded.length, `${tool} recorded commands`).toBeGreaterThan(20);
      expect(
        recorded.filter((c) => !production.includes(c)),
        tool,
      ).toEqual([]);
    }
  });

  it("only a grammar with `subcommands` reads one that way", () => {
    const g: OptionGrammar = { flags: "", values: "", longFlags: [], longValues: [], lax: true };
    expect(readOptions(g, ["--zz", "install"], 0).unplaced).toBe("--zz");
    expect(
      readOptions({ ...g, subcommands: ["install"] }, ["--zz", "install"], 0).unplaced,
    ).toBeUndefined();
    expect(readOptions({ ...g, subcommands: ["install"] }, ["--zz", "git"], 0).unplaced).toBe(
      "--zz",
    );
  });
});

describe("R9-COMP-5: an unlisted short letter followed by a bare word asks (the recordings list every letter the tools know)", () => {
  const NV = "git commit --no-verify -m x";
  it.each([
    `pnpm -Z x exec ${NV}`,
    `npm exec -Z x -- ${NV}`,
    `npx -Z x -- ${NV}`,
    `bunx -Z x ${NV}`,
    `yarn -Z x exec ${NV}`,
    `pnpm -Zq x exec ${NV}`,
    `bun -Z x ${NV}`,
  ])("%s asks", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("a recorded letter is placed: the command behind it is judged", () => {
    for (const cmd of [
      `npm exec -y -- ${NV}`,
      `npx -y ${NV}`,
      `pnpm -r exec ${NV}`,
      `pnpm -C dir exec ${NV}`,
      `npm exec -D -- ${NV}`,
    ]) {
      expect(rank(cmd), cmd).toBe(2);
    }
  });

  it("a letter before a subcommand is a flag (nothing can start there), after a flag-only run nothing asks", () => {
    expect(decide("pnpm -Z install")).toBe("allow");
    expect(decide("npm -Z install")).toBe("allow");
    expect(decide("yarn -Z install")).toBe("allow");
  });

  it("npm's own warning marks the letters it does not know: they are `rejected` in the recording and not in the table", () => {
    const rejected = fixtureOf("npm exec").rejected.filter((n) => /^-[A-Za-z0-9]$/.test(n));
    expect(rejected.length).toBeGreaterThan(20);
    for (const name of rejected)
      expect(
        G.NPM.flags.includes(name.slice(1)) || G.NPM.values.includes(name.slice(1)),
        name,
      ).toBe(false);
  });

  it("wrappers that take no option are not affected: any dash word stays a flag", () => {
    for (const cmd of ["command -v git", "nohup -x ls", "setsid -w ls", "builtin -x ls"])
      expect(rank(cmd), cmd).toBe(0);
  });
});
