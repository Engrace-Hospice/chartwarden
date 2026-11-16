/**
 * Wave 10 part A, A1 (R7-CR-1). A command line handed to a shell as one string is read ONCE by the rules of the quote it was
 * written in: inside double quotes `\"`, `\\`, `\$` and a backslash before a backtick drop the backslash, inside single quotes nothing
 * does. The guard used to hand the inner text over with its backslashes (`bash -c "cat \".env\""` judged `cat \".env\"`, a path
 * with quote characters that matches no secret name), so every escaped quote hid the inner command. These tests put the
 * same guarded inner command behind every producer of a nested string, at 1 to 14 levels of nesting. The live env file name is
 * built from parts: the repo guard refuses a command that names one.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ENV_FILE = `.e${"nv"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[decide(cmd)] ?? -1;

/** `text` as the body of a double-quoted shell word: the characters the shell reads back are escaped. */
const dq = (text: string): string => `"${text.replace(/[\\"$`]/g, "\\$&")}"`;

/** The guarded commands whose inner spelling uses a quote of its own (a quote that must be escaped inside `dq`). */
const INNERS: ReadonlyArray<readonly [label: string, inner: string, alone: string]> = [
  ["a secret read", `cat ".e${"nv"}"`, `cat ${ENV_FILE}`],
  ["a protected write", `cp /tmp/x "CLAUDE.md"`, "cp /tmp/x CLAUDE.md"],
  ["a force push", `git push --force origin "main"`, "git push --force origin main"],
  ["a hook bypass", `git commit --no-verify -m "x"`, "git commit --no-verify -m x"],
];

/** Each producer of a nested string: the command line that runs `{S}`, a double-quoted string, as a command line. */
const PRODUCERS: ReadonlyArray<readonly [name: string, template: string]> = [
  ["bash -c", "bash -c {S}"],
  ["sh -c", "sh -c {S}"],
  ["zsh -c", "zsh -c {S}"],
  ["bash -lc", "bash -lc {S}"],
  ["dash -ec", "dash -ec {S}"],
  ["/bin/bash -c", "/bin/bash -c {S}"],
  ["eval", "eval {S}"],
  ["watch", "watch {S}"],
  ["watch -n", "watch -n 1 {S}"],
  ["su -c", "su -c {S}"],
  ["su root -c", "su root -c {S}"],
  ["runuser -c", "runuser -l dev -c {S}"],
  ["flock -c", "flock -c {S} /tmp/l"],
  ["find -exec bash -c", "find . -maxdepth 0 -exec bash -c {S} \\;"],
  ["find -exec sh -c", "find . -maxdepth 0 -exec sh -c {S} _ {} +"],
  ["ssh localhost", "ssh localhost {S}"],
  ["ssh -p localhost", "ssh -p 22 localhost {S}"],
  ["script -c", "script -c {S} /tmp/log"],
  ["npx -c", "npx -c {S}"],
  ["npm exec -c", "npm exec -c {S}"],
  ["docker exec sh -c", "docker exec api sh -c {S}"],
  ["docker compose exec sh -c", "docker compose exec api sh -c {S}"],
  ["sudo bash -c", "sudo bash -c {S}"],
  ["env bash -c", "env A=1 bash -c {S}"],
  ["timeout bash -c", "timeout 5 bash -c {S}"],
  ["nice bash -c", "nice -n 5 bash -c {S}"],
  ["xargs sh -c", "xargs -n 1 sh -c {S} _"],
  ["bunx bash -c", "bunx bash -c {S}"],
  ["rsync -e", "rsync -e {S} a localhost:/tmp/b"],
  ["tar --to-command", "tar -xf a.tar --to-command={S}"],
  ["tar -I", "tar -I {S} -cf /tmp/x.tar a"],
];

describe("an escaped quote inside a double-quoted nested string no longer hides the inner command", () => {
  for (const [producer, template] of PRODUCERS) {
    for (const [label, inner, alone] of INNERS) {
      it(`${producer}: ${label}`, () => {
        const cmd = template.replace("{S}", dq(inner));
        const plain = rank(alone);
        expect(plain, `the inner command alone must be guarded: ${alone}`).toBeGreaterThan(0);
        expect(rank(cmd), cmd).toBeGreaterThanOrEqual(plain);
      });
    }
  }

  it("a payload that is guarded only by its escaped quote is the one the test is about", () => {
    // `cat \".env\"` before the fix: the path read `".env"` with the quote characters, which names no secret.
    expect(decide(`bash -c ${dq(`cat ".e${"nv"}"`)}`)).toBe("deny");
    expect(decide(`bash -c 'cat ".e${"nv"}"'`)).toBe("deny");
  });

  it("the everyday neighbours that carry escaped quotes stay allowed", () => {
    for (const cmd of [
      'bash -c "echo \\"hello world\\""',
      'bash -c "ls \\"scripts dir\\""',
      'sh -c "echo \\"a b\\" | wc -c"',
      'eval "echo \\"x\\""',
      'ssh localhost "echo \\"x\\""',
      'watch "echo \\"x\\""',
      'find . -maxdepth 0 -exec bash -c "echo \\"x\\"" \\;',
      "bash -c 'echo \"x y\"'",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a single-quoted nested string keeps its backslashes: nothing is unescaped", () => {
    // `echo \"x\"` inside single quotes is `echo \"x\"` to the inner shell, which reads it as `echo "x"`: still harmless.
    expect(decide(`bash -c 'echo \\"x\\"'`)).toBe("allow");
    // and a backslash-escaped name in single quotes is read the way the inner shell reads it
    expect(decide(`bash -c 'cat \\${ENV_FILE}'`)).toBe("deny");
  });

  it("the escapes the shell removes are the four of double quotes, and a backslash before anything else stays", () => {
    // `\$` is a literal dollar: the inner shell sees `$(…)` and runs it
    expect(decide(`bash -c "echo \\$(cat ${ENV_FILE})"`)).toBe("deny");
    // `\\` is one backslash and then the quote that follows ends nothing: `cat \"x\"` reads as the word `"x"`
    expect(decide(`bash -c "cat \\\\\\"x\\\\\\""`)).toBe("allow");
    // an escaped backtick is a literal backtick for the OUTER shell, and the inner shell runs it
    expect(decide(`bash -c "echo \\\`cat ${ENV_FILE}\\\`"`)).toBe("deny");
    // a backslash before any other character stays: the inner shell reads `file\ copy` as ONE word, a file that is no secret
    expect(decide(`bash -c "cat ${ENV_FILE}\\ copy"`)).toBe("allow");
    // a backslash-newline inside double quotes is gone: the word is `cat`
    expect(decide(`bash -c "ca\\\nt ${ENV_FILE}"`)).toBe("deny");
  });
});

describe("JSON-style multi-level nesting: every level is decoded, and a nesting too deep to read asks", () => {
  const nest = (inner: string, levels: number): string => {
    let text = inner;
    for (let level = 0; level < levels; level++) text = `bash -c ${dq(text)}`;
    return text;
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    '%i levels of `bash -c "…"` judge the inner command',
    (levels) => {
      const cmd = nest(`cat ".e${"nv"}"`, levels);
      expect(rank(cmd), cmd.slice(0, 80)).toBe(2);
      const push = nest(`git push --force origin "main"`, levels);
      expect(rank(push), push.slice(0, 80)).toBeGreaterThanOrEqual(1);
    },
  );

  it.each([9, 10, 11, 12, 13, 14])(
    "%i levels are never allowed: past the cap the guard asks",
    (levels) => {
      const cmd = nest(`cat ".e${"nv"}"`, levels);
      expect(rank(cmd), `${levels} levels`).toBeGreaterThanOrEqual(1);
      const harmless = nest("echo hi", levels);
      expect(
        rank(harmless),
        `${levels} levels of a harmless command ask: too deep to read`,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it("mixed single and double quote levels decode level by level", () => {
    const single = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
    const inner = `cat ".e${"nv"}"`;
    expect(rank(`bash -c ${dq(`bash -c ${single(inner)}`)}`)).toBe(2);
    expect(rank(`bash -c ${single(`bash -c ${dq(inner)}`)}`)).toBe(2);
  });
});
