/**
 * Wave 10 part A, A8/A9/A10 (R7-ADV-13, R7-CR-8, R7-ADV-15, R7-CR-13, R7-ADV-18). The wave-8 runner peel read the options of every package
 * manager with ONE regex that listed `-r -c -w -F -C` as value options (flags in pnpm and yarn), so `pnpm -r exec CMD` ate `exec`;
 * `yarn workspace(s)` hit the builtin list and returned nothing; `bun exec` sat in the builtin list; booleans were listed as
 * valued (`env-cmd --fallback`, `lerna exec --include-dependencies`, `nx exec --parallel`, `op run --cache`); the Python and Nix
 * runners were not peeled; and the peeled program word was never read as an operand (`bun <live env file>`). Each tool now has the
 * grammar of its own CLI (bun's, pnpm's and uv's read from the installed `--help`). The MONOTONICITY property test walks every
 * manager and subcommand of the real tables: a guarded command behind any spelling of any runner option is never answered
 * more weakly than the command alone. Hosts and the live env file name are built from parts.
 */
import { describe, expect, it } from "vitest";
import { type OptionGrammar, readOptions, resolveLong } from "../harness/option-grammar";
import { classifyBash } from "../harness/patterns";
import { BARE_RUNNERS, type Grammar, MANAGERS, peelRunner } from "../harness/runners";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const NO_VERIFY = `git commit --no-${"verify"} -m x`;
const PROTECTED = ".claude/settings.json";
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("A8: pnpm and yarn read -r -w -c -F -C as the flags and values they are", () => {
  it.each([
    `pnpm -r exec cp /tmp/x ${PROTECTED}`,
    `pnpm -r exec psql -h ${HOST}`,
    "pnpm -r exec git push origin main",
    `pnpm -w exec ${NO_VERIFY}`,
    `pnpm -w exec git push origin main`,
    `pnpm -c exec ${NO_VERIFY}`,
    `pnpm -rw exec ${NO_VERIFY}`,
    `pnpm exec --workspace-root ${NO_VERIFY}`,
    `pnpm exec --resume-from x ${NO_VERIFY}`,
    `pnpm exec --recursive ${NO_VERIFY}`,
    `pnpm --reporter silent exec ${NO_VERIFY}`,
    `pnpm --workspace-concurrency 2 exec ${NO_VERIFY}`,
    `pnpm --filter web exec ${NO_VERIFY}`,
    `pnpm -F web exec ${NO_VERIFY}`,
    `pnpm -C apps/web exec ${NO_VERIFY}`,
    `pnpm --dir apps/web exec ${NO_VERIFY}`,
    `pnpm --loglevel warn -r exec ${NO_VERIFY}`,
    `pnpm dlx --package x ${NO_VERIFY}`,
    `pnpm dlx --allow-build x ${NO_VERIFY}`,
    // yarn
    `yarn workspace x exec ${NO_VERIFY}`,
    `yarn workspace x run ${NO_VERIFY}`,
    `yarn workspace @scope/x exec cp /tmp/x ${PROTECTED}`,
    `yarn workspaces foreach exec ${NO_VERIFY}`,
    `yarn workspaces foreach -A exec ${NO_VERIFY}`,
    `yarn workspaces foreach -A -p exec ${NO_VERIFY}`,
    `yarn workspaces foreach -Apt run ${NO_VERIFY}`,
    `yarn workspaces foreach --all --jobs 2 exec ${NO_VERIFY}`,
    `yarn workspaces foreach -j 2 exec ${NO_VERIFY}`,
    `yarn -w exec ${NO_VERIFY}`,
    `yarn -r exec ${NO_VERIFY}`,
    `yarn -c exec ${NO_VERIFY}`,
    `yarn --cwd apps/web exec ${NO_VERIFY}`,
    // bun
    `bun exec '${NO_VERIFY}'`,
    `bun exec 'cp /tmp/x ${PROTECTED}'`,
    "bun exec git push origin main",
    `bun --bun run ${NO_VERIFY}`,
    `bun --port=3000 run ${NO_VERIFY}`,
    `bun --cwd=apps run ${NO_VERIFY}`,
    `bun -F web run ${NO_VERIFY}`,
    `bun --silent x ${NO_VERIFY}`,
    // npm
    `npm -w web exec -- ${NO_VERIFY}`,
    `npm --workspace web exec -- ${NO_VERIFY}`,
    `npm --workspaces exec -- ${NO_VERIFY}`,
    `npm --prefix apps exec -- ${NO_VERIFY}`,
    `npm exec -w web -- ${NO_VERIFY}`,
    `npm exec --workspaces -- ${NO_VERIFY}`,
    `npm exec --include-workspace-root -- ${NO_VERIFY}`,
    // corepack with a version
    `corepack pnpm@9 dlx ${NO_VERIFY}`,
    `corepack pnpm@9.1.0 exec ${NO_VERIFY}`,
    `corepack yarn@4 exec ${NO_VERIFY}`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("bun's long options take their value after `=` only: `bun --port 3000 run x` is a usage error, not a run (probed on bun 1.4.4)", () => {
    expect(peelRunner(["bun", "--port", "3000", "run", "cp", "x"], () => false)).toBeNull();
    expect(peelRunner(["bun", "--port=3000", "run", "cp", "x"], () => false)).toEqual(["cp", "x"]);
    // and a bare `bun NAME` with an option before it is not a program (bun reports Script not found)
    expect(peelRunner(["bun", "--bun", "cp", "x"], () => false)).toBeNull();
  });

  it("the everyday manager commands stay allowed", () => {
    for (const cmd of [
      "pnpm -r exec ls",
      "pnpm -w exec tsc --noEmit",
      "pnpm exec tsc --noEmit",
      "pnpm --filter web exec tsc --noEmit",
      "pnpm -r run build",
      "pnpm run test",
      "pnpm install",
      "pnpm dlx cowsay hi",
      "yarn workspace web run build",
      "yarn workspace web exec tsc --noEmit",
      "yarn workspaces foreach -A run build",
      "yarn workspaces foreach -Apt run test",
      "yarn run test",
      "yarn install",
      "bun exec 'echo hi'",
      "bun --bun run test",
      "bun run build",
      "bun -F web run test",
      "bun test",
      "npm -w web exec -- tsc --noEmit",
      "npm --workspace web run test",
      "npm exec -w web -- tsc --noEmit",
      "corepack pnpm@9 dlx cowsay hi",
      "corepack enable",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("A9: runners and loaders that were not peeled", () => {
  it.each([
    `uv run psql -h ${HOST} -c 'select 1'`,
    `uv run -- ${NO_VERIFY}`,
    `uv run --with requests ${NO_VERIFY}`,
    `uv run --python 3.12 ${NO_VERIFY}`,
    `uv run -p 3.12 ${NO_VERIFY}`,
    `uv run --no-project ${NO_VERIFY}`,
    `uv --quiet run ${NO_VERIFY}`,
    `uvx pgcli -h ${HOST}`,
    `uvx --from pgcli pgcli -h ${HOST}`,
    `uvx ${NO_VERIFY}`,
    `uv tool run ${NO_VERIFY}`,
    `uv tool run --from x ${NO_VERIFY}`,
    `pipx run ${NO_VERIFY}`,
    `pipx run --spec x ${NO_VERIFY}`,
    `poetry run ${NO_VERIFY}`,
    `pdm run ${NO_VERIFY}`,
    `rye run ${NO_VERIFY}`,
    `hatch run ${NO_VERIFY}`,
    `pipenv run ${NO_VERIFY}`,
    `conda run ${NO_VERIFY}`,
    `conda run -n base ${NO_VERIFY}`,
    `conda run --no-capture-output ${NO_VERIFY}`,
    `micromamba run -n x ${NO_VERIFY}`,
    `devbox run ${NO_VERIFY}`,
    `devbox run -- ${NO_VERIFY}`,
    `flox activate -- ${NO_VERIFY}`,
    `flox activate -c '${NO_VERIFY}'`,
    `nix develop -c ${NO_VERIFY}`,
    `nix develop --command ${NO_VERIFY}`,
    `nix shell nixpkgs#git -c ${NO_VERIFY}`,
    `nix shell nixpkgs#git --command ${NO_VERIFY}`,
    `nix-shell --run '${NO_VERIFY}'`,
    `nix-shell -p git --run '${NO_VERIFY}'`,
    `nix-shell --command '${NO_VERIFY}'`,
    // the booleans that were listed as valued, and the value option that was missing
    `env-cmd --fallback ${NO_VERIFY}`,
    `env-cmd -f .env.example --fallback ${NO_VERIFY}`,
    `lerna exec --include-dependencies ${NO_VERIFY}`,
    `lerna exec --include-dependencies -- ${NO_VERIFY}`,
    `nx exec --parallel ${NO_VERIFY}`,
    `nx exec --parallel -- ${NO_VERIFY}`,
    `op run --cache ${NO_VERIFY}`,
    `op run --cache -- ${NO_VERIFY}`,
    `dotenvx run --ignore MISSING_ENV_FILE -- ${NO_VERIFY}`,
    // the flock/runuser `-c` of the inner command is not the wrapper's own
    `flock /tmp/l psql -h ${HOST} -c 'select 1'`,
    `runuser -u x -- psql -h ${HOST} -c 'select 1'`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "uv run python -V",
      "uv run pytest",
      "uv run --with requests python x.py",
      "uv sync",
      "uv pip install x",
      "uvx ruff check .",
      "uvx --from ruff ruff check .",
      "uv tool run ruff check .",
      "pipx run cowsay hi",
      "poetry run pytest",
      "pdm run pytest",
      "conda run -n base python -V",
      "nix develop -c echo hi",
      "nix-shell --run 'echo hi'",
      "flox activate -- echo hi",
      "devbox run echo hi",
      "env-cmd --fallback echo hi",
      "lerna exec --include-dependencies -- echo hi",
      "nx exec --parallel -- echo hi",
      "op run --cache -- echo hi",
      "make test",
      "just build",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("`make`, `just` and `task` run recipes of the repo: they are not peeled (a documented residual)", () => {
    for (const cmd of ["make -C /tmp psql", "just psql", "task psql"]) {
      expect(
        peelRunner(cmd.split(" "), () => false),
        cmd,
      ).toBeNull();
    }
  });
});

describe("A10: the word a runner starts is a name the shell opens", () => {
  it.each([
    `bun ${ENV_FILE}`,
    `bun run ${ENV_FILE}`,
    "bun run .env",
    "bun .env",
    `bunx ${ENV_FILE}`,
    `npx ${ENV_FILE}`,
    `yarn run ${ENV_FILE}`,
    `pnpm exec ${ENV_FILE}`,
    "uv run .env",
  ])("%s is denied", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });

  it("an example file and a package script keep their answers", () => {
    expect(decide("bun .env.example")).toBe("allow");
    expect(decide("bun run test")).toBe("allow");
    expect(decide("bun run arch:fitness")).toBe("allow");
  });
});

// ---------------------------------------------------------------------------------------------------
// Monotonicity over the real tables
// ---------------------------------------------------------------------------------------------------

const GUARDED: ReadonlyArray<readonly [string, string]> = [
  ["a push", "git push origin main"],
  ["a hook bypass", NO_VERIFY],
  ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
  ["a protected write", `cp /tmp/x ${PROTECTED}`],
  ["a secret read", `cat ${ENV_FILE}`],
];

/** Every spelling of every option of the grammar, except the options that make the words after them a string. */
function spellings(g: OptionGrammar, skip: ReadonlySet<string>): string[][] {
  const out: string[][] = [[]];
  for (const l of g.flags) if (!skip.has(l)) out.push([`-${l}`]);
  for (const v of g.values) {
    if (skip.has(v)) continue;
    out.push([`-${v}`, "arg"], [`-${v}arg`]);
  }
  for (const f of g.longFlags) if (!skip.has(f)) out.push([`--${f}`]);
  for (const v of g.longValues) {
    if (skip.has(v)) continue;
    out.push([`--${v}`, "arg"], [`--${v}=arg`]);
  }
  for (const w of g.wordValues ?? []) out.push([w, "arg"]);
  return out;
}

const skipOf = (g: Grammar): ReadonlySet<string> =>
  new Set([
    ...(g.call ?? []),
    ...(g.shellMode ?? []),
    ...(g.commandRest ?? []).map((spelling) => spelling.replace(/^-+/, "")),
  ]);

describe("MONOTONICITY: a guarded command behind any spelling of any runner option is never answered more weakly", () => {
  const check = (prefix: (options: string[]) => string[], variants: string[][], label: string) => {
    const failures: string[] = [];
    let checked = 0;
    for (const options of variants) {
      for (const [what, command] of GUARDED) {
        const alone = rank(command);
        const cmd = [...prefix(options), command].join(" ");
        checked++;
        if (rank(cmd) < alone) failures.push(`${what}: ${cmd}`);
      }
    }
    expect(checked, label).toBeGreaterThanOrEqual(GUARDED.length);
    expect(failures.slice(0, 5), `${label}: ${failures.length} of ${checked}`).toEqual([]);
  };

  for (const [name, runner] of MANAGERS) {
    for (const [sub, grammar] of runner.subcommands) {
      if (grammar.shellLine) continue;
      const lead = name === "uv" ? [] : [];
      it(`${name} ${sub}: the options after the subcommand`, () => {
        const dashes = grammar.toolSpecs || grammar.skip ? ["--"] : [];
        const start = grammar.commandRest?.slice(0, 1) ?? [];
        check(
          (o) => [
            name,
            ...lead,
            sub,
            ...o,
            ...dashes,
            ...Array(grammar.skip ?? 0).fill("dir"),
            ...start,
          ],
          spellings(grammar.options, skipOf(grammar)),
          `${name} ${sub}`,
        );
      });
      it(`${name} ${sub}: the options before the subcommand`, () => {
        const dashes = grammar.toolSpecs || grammar.skip ? ["--"] : [];
        const start = grammar.commandRest?.slice(0, 1) ?? [];
        check(
          (o) => [name, ...o, sub, ...dashes, ...Array(grammar.skip ?? 0).fill("dir"), ...start],
          spellings(runner.global, new Set()),
          `${name} ${sub} (global)`,
        );
      });
    }
  }
  for (const [name, grammar] of BARE_RUNNERS) {
    it(`${name}: its own options`, () => {
      check((o) => [name, ...o], spellings(grammar.options, skipOf(grammar)), name);
    });
  }
  for (const manager of ["bun", "yarn"]) {
    const runner = MANAGERS.get(manager);
    it(`${manager} run: the manager's options after \`run\``, () => {
      const g = runner?.global as OptionGrammar;
      check((o) => [manager, "run", ...o], spellings(g, new Set()), `${manager} run`);
    });
  }
});

describe("table consistency: a runner flag that prefixes a value option is still a flag", () => {
  const grammars: Array<[string, OptionGrammar]> = [];
  for (const [name, runner] of MANAGERS) {
    grammars.push([`${name} global`, runner.global]);
    for (const [sub, g] of runner.subcommands) grammars.push([`${name} ${sub}`, g.options]);
  }
  for (const [name, g] of BARE_RUNNERS) grammars.push([name, g.options]);
  for (const [name, g] of grammars) {
    for (const flag of g.longFlags) {
      const longer = g.longValues.filter((v) => v !== flag && v.startsWith(flag));
      if (longer.length === 0) continue;
      it(`${name} --${flag} (a prefix of --${longer[0]})`, () => {
        expect(readOptions(g, [`--${flag}`, "cmd"], 0).end).toBe(1);
        expect(resolveLong(g, flag)).toEqual({ kind: "flag", name: flag });
      });
    }
  }

  it("no name is both a flag and a value option in any runner grammar", () => {
    for (const [name, g] of grammars) {
      expect(
        g.longFlags.filter((n) => g.longValues.includes(n)),
        `${name} long`,
      ).toEqual([]);
      expect(
        [...g.flags].filter((n) => g.values.includes(n)),
        `${name} short`,
      ).toEqual([]);
    }
  });
});
