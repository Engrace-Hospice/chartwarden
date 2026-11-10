/**
 * Third adversarial review of the shell classifier (2026-11-09). Every payload under an "asks" or "denies"
 * heading answered `allow` (or hung the hook) at e9f9688c6; each describe block pairs them with the nearby
 * everyday commands that must stay allowed, so a fix cannot quietly make Claude Code's own workflow noisy.
 * `classifyBash` is pure: `root` and `home` are injected, so nothing here depends on this machine.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ROOT = "/repo";
const HOME = "/Users/dev";
const ctx = { root: ROOT, home: HOME };
const v = (cmd: string, c: object = ctx) => classifyBash(cmd, c);
const d = (cmd: string, c: object = ctx) => v(cmd, c).decision;

describe("1 — a cd that may not have applied (failed, subshell, pipe, background, ||, ;)", () => {
  it.each([
    "cd nope; echo x > scripts/harness/pre-tool-guard.ts",
    "(cd apps && true); echo x > scripts/harness/pre-tool-guard.ts",
    "cd apps | cat; echo x > .githooks/pre-commit",
    "cd nope; tee compliance/controls.yaml < /tmp/x",
    "cd nope; sed -i s/a/b/ compliance/controls.yaml",
    'bash -c "cd nope; echo x > scripts/harness/pre-tool-guard.ts"',
    "cd nope; echo x >> .claude/rules/phi-and-secrets.md",
    "cd apps & echo x > compliance/controls.yaml",
    "cd nope || echo x > scripts/harness/pre-tool-guard.ts",
    "cd nope; git checkout -- scripts/harness/patterns.ts",
    'eval "cd nope; echo x > .githooks/pre-commit"',
    "cd a && cd b; echo x > compliance/controls.yaml",
    "cd .claude; echo $(echo x > settings.json)",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it("asks about a write inside a substitution that runs where a cd left it", () => {
    expect(d("cd .claude && echo $(echo x > settings.json)")).toBe("ask");
  });

  it("still resolves a cd that certainly applied (an && chain with no group, pipe or background)", () => {
    expect(d("cd .claude && echo x > settings.json")).toBe("ask");
    expect(d("cd scripts && cd harness && touch x")).toBe("ask");
    expect(d("cd docs && echo x > compliance/AGENT_HARNESS.md")).toBe("allow");
    expect(d("cd nope && echo x > scripts/harness/pre-tool-guard.ts")).toBe("allow");
  });

  it("asks when a chain longer than the tracked set precedes a protected write", () => {
    const hops = Array.from({ length: 40 }, (_, i) => `cd d${i}`).join("; ");
    expect(d(`${hops}; echo x > scripts/harness/pre-tool-guard.ts`)).toBe("ask");
  });

  it.each([
    "cd apps/backend && bun run test",
    "cd apps/backend; bun run test",
    'cd "$(git rev-parse --show-toplevel)" && rm -rf dist',
    "cd apps/web; echo x > notes.txt",
    "(cd apps/web && bun run build); echo done > /tmp/out.txt",
    "cd apps | cat; echo x > docs/notes.md",
    "cd docs && echo x > compliance/AGENT_HARNESS.md",
    "cd /tmp && echo x > settings.json",
    'bash -c "cd apps/web && bun test"',
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("4 — `~` and `$HOME` spelled paths onto the repo", () => {
  const home = { root: "/Users/dev/Apps/x2/wardenx4", home: "/Users/dev" };

  it.each([
    "cd ~/Apps/x2/wardenx4 && echo x > scripts/harness/pre-tool-guard.ts",
    "cd $HOME/Apps/x2/wardenx4; tee compliance/controls.yaml < /tmp/x",
    "echo x > ~/Apps/x2/wardenx4/scripts/harness/pre-tool-guard.ts",
    'cd "${HOME}/Apps/x2/wardenx4" && cd scripts && echo x > harness/pre-tool-guard.ts',
    "cd ~ && cd Apps/x2/wardenx4 && echo x > .githooks/pre-commit",
    "cd ~/Apps/x2/wardenx4/scripts && rm -r harness",
    "rm -r ~/Apps/x2/wardenx4/compliance",
    "cp /tmp/x $HOME/Apps/x2/wardenx4/.claude/settings.json",
    "cd ~/Apps && cd x2/wardenx4 && sed -i s/a/b/ compliance/controls.yaml",
  ])("asks before %s", (cmd) => expect(d(cmd, home)).toBe("ask"));

  it("still asks for the files under the home directory that the repo-less spelling protects", () => {
    expect(d("echo x > ~/.codex/config.toml", home)).toBe("ask");
    expect(d("cd ~ && echo x > .codex/config.toml", home)).toBe("ask");
    expect(d("rm -r ~/.claude", home)).toBe("ask");
  });

  it.each([
    "cd ~/Apps/other && echo x > scripts/harness/pre-tool-guard.ts",
    "cd ~/Apps/x2/wardenx4/apps/backend && bun run test",
    "echo x > ~/notes.txt",
    "echo x > $HOME/Apps/x2/other/scripts/harness/x.ts",
    "cd ~ && echo x > Apps/x2/wardenx4/docs/notes.md",
  ])("allows the look-alike %s", (cmd) => {
    const verdict = v(cmd, home);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("does not need a home directory to keep the plain spelling working", () => {
    expect(d("echo x > scripts/harness/pre-tool-guard.ts", { root: ROOT, home: "" })).toBe("ask");
  });
});

// The guard fails OPEN when the hook is killed at its 10 s timeout, so no input may make it slow. Each case
// below took 0.5 s to minutes at e9f9688c6; the fixed classifier answers in a few milliseconds, so the bound
// is generous.
describe("2 and 7 — bounded work on hostile input", () => {
  const FAST_MS = 1000;
  const LIMIT = 64 * 1024;
  const timed = (cmd: string) => {
    const started = performance.now();
    const verdict = v(cmd);
    return { verdict, ms: performance.now() - started };
  };
  const repeat = (unit: string, chars: number): string =>
    unit.repeat(Math.floor(chars / unit.length));

  it.each([22, 30, 5000])(
    "denies the secret read and answers fast beside a %i-star glob",
    (stars) => {
      const { verdict, ms } = timed(`cat .env; echo .${"*".repeat(stars)}zz`);
      expect(verdict.decision).toBe("deny");
      expect(ms).toBeLessThan(FAST_MS);
    },
  );

  it.each([
    ["a glob word", `cat .${"*".repeat(30)}zz`],
    ["find -name", `find . -name '.${"*".repeat(30)}zz'`],
    ["stars between literals", `cat ${"*a".repeat(2000)}*zz`],
    ["a run of unclosed brackets", `cat .${"[".repeat(60_000)}zz`],
    ["question marks", `cat ${"?".repeat(60_000)}env`],
  ])("judges %s quickly", (_name, cmd) => {
    expect(timed(cmd).ms).toBeLessThan(FAST_MS);
  });

  it.each([
    ["cat .e*", "deny"],
    ["cat .?nv", "deny"],
    ["cat *.env", "deny"],
    ["cat .[e]nv", "deny"],
    ["cat .[!x]nv", "deny"],
    ["cat .[a-f]nv", "deny"],
    ["cat .env*", "deny"],
    ["cat .e**v", "deny"],
    ["cat .*", "deny"],
    ["cat backend.e*", "deny"],
    ["cat *", "allow"],
    ["cat feat/*", "allow"],
    ["cat ???", "allow"],
    ["cat src/*.ts", "allow"],
    ["cat .git*", "allow"],
    ["cat .[x-z]nv", "allow"],
    ["cat .[nv", "allow"],
  ])("still reads the wildcard %s as %s", (cmd, decision) => {
    expect(d(cmd)).toBe(decision);
  });

  it("answers ask at once for a command longer than 64 KB, before parsing it", () => {
    const { verdict, ms } = timed(repeat("cd a;", LIMIT + 4_000));
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/too (long|large)/i);
    expect(ms).toBeLessThan(100);
    expect(d(`cat .env${" ".repeat(LIMIT)}`)).toBe("ask");
  });

  it("still judges a command that fits in 64 KB", () => {
    expect(d(`echo ${"a".repeat(LIMIT - 10)}`)).toBe("allow");
    expect(d(`cat .env; echo ${"a".repeat(LIMIT - 20)}`)).toBe("deny");
  });

  it("keeps a 60 KB chain of cd linear", () => {
    const { verdict, ms } = timed(`${repeat("cd a;", 60_000)}ls`);
    expect(verdict.decision).toBe("allow");
    expect(ms).toBeLessThan(500);
    expect(timed(`${repeat("cd a/b/c/d/e/f/g/h/i/j;", 60_000)}ls`).ms).toBeLessThan(500);
  });

  it.each([
    ["an open brace group of commas", `cat {${",".repeat(60_000)}`],
    ["the same in a redirect", `echo x > {${",".repeat(60_000)}`],
    ["a run of two-way groups", `cat ${"{a,b}".repeat(12_000)}`],
    ["a run of unclosed braces", `cat ${"{".repeat(60_000)}`],
    ["rm with a long flag word", `rm -${"a".repeat(60_000)}1 x`],
    ["grep with a long flag word", `grep -${"r".repeat(60_000)}1 foo .`],
    ["rg with a long flag word", `rg -${"u".repeat(60_000)}1 foo`],
    ["unzip with a long flag word", `unzip -${"l".repeat(60_000)}1 x.zip`],
    ["git clean with a long flag word", `git clean -${"n".repeat(60_000)}1`],
    ["chmod with a long flag word", `chmod -${"R".repeat(60_000)}1 755 x`],
    ["cp with a long flag word", `cp -${"a".repeat(60_000)}1 x y`],
    ["bash with a long flag word", `bash -${"c".repeat(60_000)}1 x`],
  ])("judges %s quickly", (_name, cmd) => {
    expect(timed(cmd).ms).toBeLessThan(FAST_MS);
  });

  it("expands braces as before", () => {
    expect(d("cat .en{v,}")).toBe("deny");
    expect(d("cat {.env,x}")).toBe("deny");
    expect(d("cat {a,{.env,b}}")).toBe("deny");
    expect(d("cat {a,b}{c,d}")).toBe("allow");
    expect(d("cat {a}{b}")).toBe("allow");
  });
});

describe("6 — a destructive command over the whole repo root", () => {
  it.each([
    "chmod -R a-r .",
    "chmod -R 000 ./",
    "chown -R root .",
    "chmod -R u+w $PWD",
    "find . -type f -delete",
    "find -delete",
    "find . -delete",
    "find /repo -type f -delete",
    "find . -type f -exec rm {} +",
    "find . -mtime +7 -delete",
    "find . -name x -o -delete",
    "find . ! -name '*.keep' -delete",
    "find . -path ./node_modules -prune -o -type f -delete",
    "find . -delete -name '*.tmp'",
    "rm -rf $PWD",
    'rm -rf "$PWD"',
    "rm -rf $(pwd)",
    "rm -rf $(git rev-parse --show-toplevel)",
    "rm -rf /repo",
    "rm -rf .",
    "rm -rf ./",
    "rm -r --force .",
    "cd apps && rm -rf ..",
    "cd apps/web && cd ../.. && rm -rf .",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it("says what is at stake, not an empty path", () => {
    expect(v("rm -rf $PWD").reason).toMatch(/repo root/i);
    expect(v("rm -rf $PWD").reason).not.toMatch(/^``/);
  });

  it.each([
    "find . -name '*.tmp' -delete",
    "find . -iname '*.log' -delete",
    "find . -path './tmp/*' -delete",
    "find . -regex '.*\\.o' -delete",
    "find . -type f -name '*.js' -delete",
    "find . \\( -name '*.o' -o -name '*.a' \\) -delete",
    "find . -name node_modules -prune -o -name '*.tmp' -delete",
    "find . -name '*.log' -exec rm {} +",
    "find dist -type f -delete",
    "find node_modules -delete",
    "find apps/web/dist -mtime +7 -delete",
    "find . -type f",
    "find . -type f -exec grep foo {} +",
    "find . -name '*.ts' -newer x",
    "rm -rf dist",
    "rm -rf node_modules",
    "rm -rf apps/web/dist",
    "rm -r apps/web/dist apps/backend/dist",
    "rm -f x.ts",
    "rm -rf /tmp/work",
    "rm -rf /repo/apps/web/dist",
    "chmod -R 755 apps/web",
    "chmod -R u+w apps",
    "chown -R me apps/web/dist",
    "chmod +x scripts/new-tool.sh",
    "cd apps/web && chmod -R 755 .",
    "cd apps/web && rm -rf .turbo",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});
