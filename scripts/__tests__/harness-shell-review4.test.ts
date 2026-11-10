/**
 * Fourth review of the shell classifier (2026-11-09). Every payload under an "asks"/"denies" heading answered
 * `allow` (or took longer than the hook's 10 s) at a491dd563; each describe block pairs them with the nearby
 * everyday commands that must stay allowed. `classifyBash` is pure: `root`, `cwd` and `home` are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ROOT = "/repo";
const HOME = "/Users/dev";
const ctx = { root: ROOT, home: HOME };
const v = (cmd: string, c: object = ctx) => classifyBash(cmd, c);
const d = (cmd: string, c: object = ctx) => v(cmd, c).decision;

describe("a write after `A || cd X && W` may run where A ran, not only in X", () => {
  it.each([
    "true || cd apps && echo x > scripts/harness/pre-tool-guard.ts",
    "[ -d apps ] || cd apps && sed -i s/a/b/ compliance/controls.yaml",
    "git status || cd apps && sed -i s/a/b/ compliance/controls.yaml",
    "true || cd apps && rm -rf .",
    "true || { cd apps; } && echo x > compliance/controls.yaml",
    "true; false || cd apps && echo x > compliance/controls.yaml",
    "cd . || cd apps && echo x > compliance/controls.yaml",
    "true || pushd apps && echo x > compliance/controls.yaml",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "cd apps/backend && bun run test",
    'cd "$(git rev-parse --show-toplevel)" && rm -rf dist',
    "test -d apps || cd apps && echo x > notes.txt",
    "true || cd apps && echo x > docs/notes.md",
    "cd apps/web || cd apps && bun run build",
    "true || cd apps/backend && bun run test",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});
