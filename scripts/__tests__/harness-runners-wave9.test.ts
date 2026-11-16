/**
 * Wave 9, W9-3. Wave 8 unwraps `bunx|npx|pnpx|pnpm exec|dlx|yarn exec|dlx|npm exec|bun x|bun run X`. The other programs that
 * start a command by name were not in the table, so what they ran was never judged: `corepack`, `volta run`, `mise exec`,
 * `asdf exec`, `direnv exec DIR`, `cross-env VAR=x cmd`, `dotenv [-e FILE] -- cmd`, `dotenvx run [-f FILE] -- cmd`,
 * `env-cmd [-f FILE] cmd`, `doppler run -- cmd`, `op run [--env-file FILE] -- cmd`, `lerna exec`, `nx exec`. They are peeled with
 * the same code and the inner command is judged by every rule. A runner's own option that names a file (`dotenv -e FILE`,
 * `op run --env-file FILE`, `bun --env-file FILE run echo`) is judged like an input redirect, so peeling never turns the
 * refusal of a live env file into an allow. The live env file name is built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { peelRunner, peelRunnerWithFiles } from "../harness/runners";

const ENV_FILE = `apps/backend/.e${"nv"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{F}", ENV_FILE);
const isScript = (name: string): boolean => name === "test";

/** Each prefix runs the command that follows it. */
const RUNNER_PREFIXES: readonly string[] = [
  "corepack pnpm exec",
  "corepack yarn exec",
  "corepack npm exec --",
  "corepack pnpm dlx",
  "corepack npx",
  "volta run",
  "volta run --node 18",
  "volta run --node 18 --npm 9",
  "volta run --bundled-npm",
  "mise exec --",
  "mise x --",
  "mise x node@20 --",
  "mise exec node@20 npm@10 --",
  "mise x -C /tmp --",
  "asdf exec",
  "direnv exec .",
  "direnv exec /tmp/proj",
  "cross-env FOO=1",
  "cross-env FOO=1 BAR=2",
  "dotenv --",
  "dotenv -e .env.example --",
  "dotenv -e .env.example -e .env.sample --",
  "dotenv -c --",
  "dotenv -c development --",
  "dotenv -v A=1 --",
  "dotenv -o -e .env.example --",
  "dotenvx run --",
  "dotenvx run -f .env.example --",
  "dotenvx run -f .env.example -f .env.sample --",
  "dotenvx run --env-file=.env.example --",
  "dotenvx run -fk .env.keys.example --",
  "dotenvx run -e A=1 --",
  "env-cmd -f .env.example",
  "env-cmd -f .env.example --",
  "env-cmd -e production -f .env.example",
  "env-cmd --use-shell --silent",
  "doppler run --",
  "doppler run -p proj -c dev --",
  "doppler run --project=proj --config=dev --",
  "op run --",
  "op run --env-file .env.example --",
  "op run --env-file=.env.example --no-masking --",
  "lerna exec --",
  "lerna exec --scope pkg --",
  "lerna exec --concurrency 2 --",
  "nx exec --",
];

/** The wrappers and runners that may stand in front of any of the above. */
const OUTER: readonly string[] = [
  "",
  "nice -n 5 ",
  "env A=1 ",
  "timeout 5 ",
  "bunx ",
  "sudo -u x ",
];

describe("the command after a runner is the command that is judged", () => {
  it.each(RUNNER_PREFIXES)("%s git commit --no-verify -m x", (prefix) => {
    const cmd = `${prefix} git commit --no-verify -m x`;
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each(RUNNER_PREFIXES)("%s cat <a live env file>", (prefix) => {
    const cmd = fill(`${prefix} cat {F}`);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each(RUNNER_PREFIXES)("%s printenv", (prefix) => {
    expect(decide(`${prefix} printenv`), prefix).toBe("deny");
  });

  it.each(RUNNER_PREFIXES)("%s rm -rf scripts/harness", (prefix) => {
    expect(decide(`${prefix} rm -rf scripts/harness`), prefix).toBe("ask");
  });

  it.each(RUNNER_PREFIXES)("%s echo hi stays allowed", (prefix) => {
    const cmd = `${prefix} echo hi`;
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("a flag of the inner command is not sudo's own: `sudo -u x dotenv -e F -- cmd`", () => {
    expect(decide("sudo -u x dotenv -e .env.example -- git commit --no-verify -m x")).toBe("deny");
    expect(decide("sudo -u x dotenv -e .env.example -- echo hi")).toBe("allow");
  });

  it.each(OUTER)("a runner under %j still hides nothing", (outer) => {
    for (const prefix of ["corepack pnpm exec", "dotenv -e .env.example --", "cross-env FOO=1"]) {
      const cmd = `${outer}${prefix} git commit --no-verify -m x`;
      expect(decide(cmd), cmd).toBe("deny");
    }
  });

  it("one runner under another", () => {
    expect(decide("volta run corepack pnpm exec git commit --no-verify -m x")).toBe("deny");
    expect(decide("dotenv -- cross-env A=1 doppler run -- git commit --no-verify -m x")).toBe(
      "deny",
    );
    expect(decide("mise x -- bunx git commit --no-verify -m x")).toBe("deny");
  });
});

describe("cross-env-shell hands one string to a shell", () => {
  it("judges the string", () => {
    expect(decide('cross-env-shell FOO=1 "git commit --no-verify -m x"')).toBe("deny");
    expect(decide('cross-env-shell FOO=1 "echo hi"')).toBe("allow");
  });
});

describe("`mise x -c STR` and `doppler run --command STR` hand a string to a shell", () => {
  it("judges the string", () => {
    expect(decide("mise x -c 'git commit --no-verify -m x'")).toBe("deny");
    expect(decide("mise x --command 'git commit --no-verify -m x'")).toBe("deny");
    expect(decide("doppler run --command 'git commit --no-verify -m x'")).toBe("deny");
    expect(decide("mise x -c 'echo hi'")).toBe("allow");
  });
});

describe("a runner's own option that names a file is judged like an input redirect", () => {
  it.each([
    "dotenv -e {F} -- node x.js",
    "dotenv -e {F} -- printenv X",
    "dotenv -e.env.example -e{F} -- node x.js",
    "dotenv --env {F} -- node x.js",
    "dotenv --env={F} -- node x.js",
    "dotenv -c -e {F} -- node x.js",
    "dotenvx run -f {F} -- node x.js",
    "dotenvx run --env-file {F} -- node x.js",
    "dotenvx run --env-file={F} -- node x.js",
    "dotenvx run -f.env.example -f{F} -- node x.js",
    "env-cmd -f {F} node x.js",
    "env-cmd --file {F} node x.js",
    "env-cmd --file={F} node x.js",
    "env-cmd -r {F} node x.js",
    "op run --env-file {F} -- node x.js",
    "op run --env-file={F} -- node x.js",
    "doppler run --mount {F} -- node x.js",
    "direnv exec {F} node x.js",
    "bun --env-file {F} run echo hi",
    "bun --env-file={F} x echo hi",
    "bunx --package {F} echo hi",
    "bun run --env-file {F} echo hi",
    "node --env-file={F} x.js",
    "node --env-file {F} x.js",
    "bun --env-file={F} x.ts",
    "deno run --env-file={F} x.ts",
    "docker run --env-file {F} alpine echo",
    "uv run --env-file {F} python x.py",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "dotenv -e .env.example -- node x.js",
    "dotenvx run -f .env.sample -- node x.js",
    "env-cmd -f .env.template node x.js",
    "op run --env-file .env.dist -- node x.js",
    "node --env-file=.env.example x.js",
    "bun --env-file .env.example run echo hi",
    "docker compose --env-file .env.example up",
    "direnv exec . node x.js",
    "corepack enable",
    "corepack prepare pnpm@9 --activate",
    "volta install node@20",
    "volta list",
    "mise install",
    "mise use node@20",
    "mise ls",
    "asdf install",
    "asdf list",
    "direnv allow",
    "direnv reload",
    "doppler setup",
    "op read op://vault/item",
    "lerna run build",
    "nx build web",
    "nx run web:build",
    "dotenv --help",
    "env-cmd --version",
  ])("a template, a subcommand that runs nothing, or a lifecycle command allows: %s", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("docker compose --env-file keeps its lifecycle exemption", () => {
    expect(decide(fill("docker compose --env-file {F} up -d"))).toBe("allow");
  });
});

describe("a runner that starts a live suite is a live run", () => {
  const live = ["apps/backend/__tests__/care-plan-conformance.live.test.ts"];
  const withListing = (cmd: string): string =>
    classifyBash(cmd, { ...ctx, liveSuiteFiles: () => live }).decision;
  it.each([
    "dotenv -e .env.example -- vitest run care-plan",
    "cross-env CI=1 vitest run care-plan-conformance",
    "mise x -- bunx vitest run care-plan",
    "corepack pnpm exec vitest run care-plan",
    "volta run vitest run care-plan",
    "asdf exec vitest run care-plan",
    "doppler run -- vitest run care-plan",
  ])("%s", (cmd) => {
    expect(withListing(cmd), cmd).toBe("ask");
  });

  it("a unit test filter does not ask", () => {
    expect(
      withListing("dotenv -e .env.example -- vitest run scripts/__tests__/harness-hooks"),
    ).toBe("allow");
  });
});

describe("peelRunner and peelRunnerWithFiles read the same grammar", () => {
  it.each([
    ["dotenv -e A -e B -- git push", ["git", "push"], ["A", "B"]],
    ["dotenvx run -f A -- git push", ["git", "push"], ["A"]],
    ["env-cmd -f A git push", ["git", "push"], ["A"]],
    ["op run --env-file=A -- git push", ["git", "push"], ["A"]],
    ["cross-env FOO=1 git push", ["FOO=1", "git", "push"], []],
    // one step: the classifier peels again (`pnpm exec` is the next runner)
    ["corepack pnpm exec git push", ["pnpm", "exec", "git", "push"], []],
    ["volta run --node 18 git push", ["git", "push"], ["18"]],
    ["mise x node@20 -- git push", ["git", "push"], []],
    ["direnv exec /d git push", ["git", "push"], ["/d"]],
    ["lerna exec --scope p -- git push", ["git", "push"], ["p"]],
  ])("%s", (line, inner, files) => {
    const words = line.split(" ");
    expect(peelRunner(words, isScript)).toEqual(inner);
    expect(peelRunnerWithFiles(words, isScript)).toEqual({ inner, files });
  });

  it.each([
    "corepack enable",
    "volta install node",
    "mise install",
    "asdf install",
    "direnv allow",
    "dotenv",
    "dotenv --",
    "dotenvx get",
    "dotenvx encrypt",
    "op read x",
    "doppler setup",
    "lerna run x",
    "nx build x",
    "cross-env",
  ])("%s runs no command", (line) => {
    expect(peelRunner(line.split(" "), isScript)).toBeNull();
  });
});
