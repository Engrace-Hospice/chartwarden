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
