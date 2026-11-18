/**
 * Wave 6, T2(a) (ADV-2). A variable bun or perl reads at start decides what loads before the agent hook judges
 * anything: `BUN_OPTIONS=--preload=x.js` or `NODE_OPTIONS=--require=x.js` on a nested `claude`/`codex`, `PERL5OPT` on
 * the Codex wrapper, `LD_PRELOAD`, `PATH`. `arch:compliance` refuses them in the shared settings `env` block; nothing
 * refused them on a COMMAND LINE. Every payload under an "asks" heading answered `allow` at the base of this wave, and
 * each has an everyday neighbour that must stay allowed (`NODE_OPTIONS=--max-old-space-size=8192 bunx tsc` is what
 * the repo's own typecheck script runs). `classifyBash` is pure: root, home and cwd are injected.
 */
import { describe, expect, it } from "vitest";
import { isAgentSpawn, loaderEnvReason } from "../harness/env-hazards";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const reason = (cmd: string) => classifyBash(cmd, ctx).reason;

describe("loaderEnvReason: assignments that load code", () => {
  const one = (words: string[], prog = "x", args: string[] = []) =>
    loaderEnvReason([{ prog, args, words }]);
  it.each([
    "BUN_OPTIONS=--preload=/tmp/x.js",
    "BUN_CONFIG_VERBOSE_FETCH=curl",
    "NODE_OPTIONS=--require=/tmp/x.js",
    "PERL5OPT=-Mstrict",
    "PERL5LIB=/tmp/x",
    "PERLLIB=/tmp/x",
    "PERL5DB=BEGIN{}",
    "DYLD_INSERT_LIBRARIES=/tmp/x.dylib",
    "LD_PRELOAD=/tmp/x.so",
    "NODE_OPTIONS+=' --require x'",
  ])("%s asks", (word) => {
    expect(one([word])).toMatch(/load code or a library/);
  });
  it.each([
    "NODE_OPTIONS=--max-old-space-size=8192",
    "NODE_OPTIONS=--trace-warnings --max-old-space-size=4096",
    "BUN_OPTIONS=--smol",
    "PERL5OPT=-w",
    "PERL5OPT=-CSDA",
    "NODE_OPTIONS=",
    "LD_PRELOAD=",
    "PERL5LIB=",
    "PATH=/x:/y",
    "ENV=production",
    "FOO=--require",
  ])("%s does not (no agent is started)", (word) => {
    expect(one([word])).toBeNull();
  });
  it("PATH, SHELL and the startup-file variables ask only beside a coding agent", () => {
    for (const name of [
      "PATH",
      "SHELL",
      "BASH_ENV",
      "ENV",
      "ZDOTDIR",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
    ]) {
      expect(one([`${name}=/tmp/x`])).toBeNull();
      expect(one([`${name}=/tmp/x`], "claude")).toMatch(/hooks on a binary or startup file/);
    }
  });
  it("an agent started on another segment still counts, in either order", () => {
    const set = { prog: "export", args: [], words: ["PATH=/tmp/x:$PATH"] };
    const agent = { prog: "claude", args: ["-p", "x"], words: [] };
    expect(loaderEnvReason([set, agent])).not.toBeNull();
    expect(loaderEnvReason([agent, set])).not.toBeNull();
    expect(loaderEnvReason([set])).toBeNull();
  });
});

describe("isAgentSpawn", () => {
  it.each<[string, string[], boolean]>([
    ["claude", ["-p", "x"], true],
    ["codex", ["exec", "hi"], true],
    ["bunx", ["claude", "-p", "x"], true],
    ["npx", ["@anthropic-ai/claude-code"], true],
    ["codex@latest", [], true],
    ["/usr/local/bin/claude", [], true],
    ["git", ["status"], false],
    ["rg", ["foo", "docs"], false],
    ["claudette", [], false],
  ])("%s %j -> %s", (prog, args, expected) => {
    expect(isAgentSpawn(prog, args)).toBe(expected);
  });
});

describe("ADV-2: code-loading variables ask on a nested agent, and anywhere", () => {
  it.each([
    // The reviewer's repros, all `allow` at the base.
    `BUN_OPTIONS=--preload=/tmp/x.js claude -p "do it"`,
    `NODE_OPTIONS=--require=/tmp/x.js claude -p "do it"`,
    "BUN_OPTIONS=--preload=/tmp/x.js codex exec hi",
    "PERL5OPT=-Mstrict codex exec hi",
    `PATH=/tmp/fakebin:$PATH claude -p "do it"`,
    "export PERL5OPT=-Mx",
    // Bare, with no agent anywhere.
    "export BUN_OPTIONS=--preload=/tmp/x.js",
    "BUN_OPTIONS=--preload=/tmp/x.js bun run test",
    "BUN_OPTIONS=-r/tmp/x.js bun run test",
    "export BUN_CONFIG_VERBOSE_FETCH=curl; bun run test",
    "NODE_OPTIONS=--import=./x.mjs bun run test",
    "NODE_OPTIONS='--max-old-space-size=8192 --require ./x.js' bunx tsc",
    "NODE_OPTIONS=--loader=./x.mjs node y.js",
    "NODE_OPTIONS=--experimental-loader=./x.mjs node y.js",
    "NODE_OPTIONS=-p node y.js",
    "NODE_OPTIONS=--eval=x node y.js",
    "BUN_OPTIONS='--smol --eval x' bun y.ts",
    "PERL5OPT=-wMstrict perl x.pl",
    "PERL5OPT=-I/tmp/lib perl x.pl",
    "PERL5OPT=-d:Foo perl x.pl",
    "export PERL5LIB=/tmp/lib",
    "export PERLLIB=/tmp/lib",
    "PERL5DB='BEGIN{exit}' perl -d x.pl",
    "export DYLD_INSERT_LIBRARIES=/tmp/x.dylib",
    "LD_PRELOAD=/tmp/x.so ls",
    // Every spelling of the assignment.
    "(export BUN_OPTIONS=--preload=/tmp/x.js; bun run test)",
    "{ export BUN_OPTIONS=--preload=/tmp/x.js; bun run test; }",
    "export BUN_OPTIONS=--preload=/tmp/x.js; bun run test",
    "export BUN_OPTIONS=--preload=/tmp/x.js\nbun run test",
    "env BUN_OPTIONS=--preload=/tmp/x.js bun run test",
    "declare -x BUN_OPTIONS=--preload=/tmp/x.js; bun run test",
    "typeset -x NODE_OPTIONS=--require=x; node y.js",
    "readonly PERL5LIB=/tmp/x; perl y.pl",
    "export BUN_OPTIONS+=' --preload=/tmp/x.js'; bun run test",
    "BUN_OPTIONS+=--preload=/tmp/x.js bun run test",
    "export 'BUN_OPTIONS'=--preload=/tmp/x.js; bun run test",
    "export BUN_OPT\\IONS=--preload=/tmp/x.js; bun run test",
    "export BUN_OPTIONS{,}=--preload=/tmp/x.js; bun run test",
    `bash -c 'export BUN_OPTIONS=--preload=/tmp/x.js; claude -p hi'`,
    `ssh localhost 'BUN_OPTIONS=--preload=/tmp/x.js claude -p hi'`,
    `sudo env BUN_OPTIONS=--preload=/tmp/x.js claude -p hi`,
    // A variable that picks the agent's hook binary, set on an earlier statement of the same line.
    `export PATH=/tmp/fakebin:$PATH; claude -p "do it"`,
    `export PATH=/tmp/fakebin:$PATH && codex exec hi`,
    `claude -p hi; export PATH=/tmp/fakebin:$PATH`,
    "SHELL=/tmp/sh claude -p hi",
    "BASH_ENV=/tmp/x.sh codex exec hi",
    "ENV=/tmp/x.sh claude -p hi",
    "ZDOTDIR=/tmp/z claude -p hi",
    "LD_LIBRARY_PATH=/tmp/lib codex exec hi",
    "DYLD_LIBRARY_PATH=/tmp/lib claude -p hi",
    "DYLD_FALLBACK_LIBRARY_PATH=/tmp/lib claude -p hi",
    "env PATH=/tmp/fakebin claude -p hi",
    "PATH=/tmp/fakebin bunx claude -p hi",
    "PATH=/tmp/fakebin npx @anthropic-ai/claude-code -p hi",
    "PATH=/tmp/fakebin codex@latest exec hi",
  ])("asks: %s", (cmd) => {
    expect(d(cmd)).not.toBe("allow");
  });

  it("says why, in words a person can act on", () => {
    expect(reason("BUN_OPTIONS=--preload=/tmp/x.js claude -p hi")).toMatch(
      /load code or a library/,
    );
    expect(reason("PATH=/tmp/fakebin claude -p hi")).toMatch(/PATH, SHELL, BASH_ENV/);
  });

  it("a deny in the same command line still wins over the ask", () => {
    expect(d("export PERL5LIB=/tmp/x; cat apps/backend/.env")).toBe("deny");
  });

  it.each([
    // The repo's own typecheck script, and its neighbours.
    "NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p tsconfig.tests.json",
    "NODE_OPTIONS=--max-old-space-size=8192 tsc -p tsconfig.tests.json --pretty",
    "export NODE_OPTIONS=--max-old-space-size=4096; bun run build",
    `NODE_OPTIONS="--max-old-space-size=8192 --trace-warnings" bun run build`,
    "NODE_OPTIONS=--no-warnings bun run test",
    "BUN_OPTIONS=--smol bun run test",
    "PERL5OPT=-w perl x.pl",
    "PERL5OPT=-CSDA perl x.pl",
    "NODE_OPTIONS= bun run test",
    "LD_PRELOAD= ls",
    // PATH and friends are everyday when no agent is started.
    "PATH=$PWD/node_modules/.bin:$PATH bun run test",
    "export PATH=$HOME/.bun/bin:$PATH; bun run test",
    "SHELL=/bin/zsh bun run test",
    "ENV=test bun run test",
    "ZDOTDIR=/tmp/z ls",
    // Naming or reading one is not setting it.
    "rg BUN_OPTIONS= docs",
    "rg -n NODE_OPTIONS scripts",
    "echo $NODE_OPTIONS",
    'echo "$BUN_OPTIONS"',
    "printenv NODE_OPTIONS",
    `printf '%s\\n' "$PERL5OPT"`,
    "grep -r LD_PRELOAD docs",
    "git grep PERL5LIB",
    "cat docs/x.md | grep PERLLIB=",
    "echo 'NODE_OPTIONS=--require x'",
    "unset NODE_OPTIONS",
    "env -u BUN_OPTIONS bun run test",
    // A nested agent with nothing that changes its hook.
    "claude --version",
    `claude -p "hi"`,
    "codex exec hi",
    "CI=1 claude -p hi",
    "NODE_OPTIONS=--max-old-space-size=4096 claude -p hi",
    "FOO=bar codex exec hi",
  ])("allows: %s", (cmd) => {
    expect(d(cmd)).toBe("allow");
  });
});
