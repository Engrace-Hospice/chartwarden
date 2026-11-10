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

// The hook is killed at 10 s and Claude Code then lets the call run, so a command that makes the classifier
// slow is a bypass. The 64 KB cap bounds the text, not the work: 1,300 words that each expand to 256 brace
// alternatives, judged against 16 candidate directories, are five million path resolutions.
describe("path resolution and brace expansion draw on a per-command budget", () => {
  const FAST_MS = 2000;
  const cwd = { root: ROOT, home: HOME, cwd: ROOT };
  const cds = `${Array.from({ length: 15 }, (_, i) => `cd /tmp/d${i};`).join(" ")} `;
  const eightGroups = "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}";
  const eightEmpty = "{,}{,}{,}{,}{,}{,}{,}{,}";
  const words = (count: number, braces: string): string =>
    Array.from({ length: count }, (_, i) => `w${i}${braces}`).join(" ");
  const timed = (cmd: string) => {
    const started = performance.now();
    const verdict = classifyBash(cmd, cwd);
    return { verdict, ms: performance.now() - started };
  };

  it.each([
    ["rm -f", eightGroups, 1300],
    ["rm -f", eightEmpty, 1900],
    ["touch", eightGroups, 1300],
    ["touch", eightEmpty, 1900],
    ["mv", eightGroups, 1300],
    ["mv", eightEmpty, 1900],
  ])(
    "answers `%s` over many brace words after fifteen absolute cds in under 2 s (%s x %i)",
    (prog, braces, count) => {
      const cmd = `${cds}${prog} ${words(count, braces)} /tmp/dest`;
      expect(cmd.length).toBeLessThan(64 * 1024);
      const { verdict, ms } = timed(cmd);
      expect(ms).toBeLessThan(FAST_MS);
      expect(verdict.decision).toBe("ask");
      expect(verdict.reason).toMatch(/too many/i);
      expect(verdict.reason).not.toMatch(/cannot resolve/i);
    },
    60_000,
  );

  it("asks about brace expansion alone, with no write and no cd to multiply it", () => {
    const { verdict, ms } = timed(`cat ${words(1300, eightGroups)}`);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/too many/i);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("asks about plain targets alone, with no brace to multiply them", () => {
    const plain = Array.from({ length: 9000 }, (_, i) => `f${i}`).join(" ");
    const { verdict, ms } = timed(`${cds}rm -f ${plain}`);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/too many/i);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("still denies a secret read that sits beside the expansion", () => {
    const cmd = `cat .env; ${cds}rm -f ${words(1300, eightGroups)}`;
    expect(timed(cmd).verdict.decision).toBe("deny");
  });

  it("spends the budget per command: the next command starts with a full one", () => {
    expect(timed(`${cds}rm -f ${words(1300, eightGroups)}`).verdict.decision).toBe("ask");
    expect(d("rm -f build/a{,.orig} build/b{1,2,3}.tmp")).toBe("allow");
  });

  it.each([
    "rm -f a{1,2,3}.tmp b{,.orig}",
    "mkdir -p src/{a,b,c}/{x,y}",
    "cd /tmp/a; cd /tmp/b; rm -f x{,.orig}",
    "cp config.{json,json.orig}",
    "echo x > out{1,2,3,4}.txt",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd, cwd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("allows a long plain file list judged from every candidate directory", () => {
    const files = Array.from({ length: 300 }, (_, i) => `dist/f${i}.js`).join(" ");
    const verdict = v(`${cds}rm -f ${files}`, cwd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});
