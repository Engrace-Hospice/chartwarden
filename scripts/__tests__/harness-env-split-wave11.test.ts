/**
 * Wave 11 part C, C1 (R8-ADV-1, CRITICAL, a deny-to-allow regression of wave 10): `env -S STRING` is read by env's own split grammar.
 * Wave 10 read the string with the shell's word reader, so `env -S 'cat\_.env'` (a `\_` is a separator), `env -S 'cat .env\c'` (`\c` ends
 * the string), quotes inside the string, `${NAME}` and nested `env -S` hid the command from every rule. Every escape, every producer path
 * and every spelling of a guarded command is tested here, and the grammar is held against the REAL env where one is installed (echo only).
 * The live env file and the non-local host are built from parts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitEnvString } from "../harness/env-split";
import { classifyBash } from "../harness/patterns";

const ENV_FILE = `.e${"nv"}`;
const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const words = (text: string, vars: Record<string, string> = {}) =>
  splitEnvString(text, (name) => vars[name]);

describe("the split grammar of env -S, escape by escape", () => {
  it.each([
    ["echo a b", ["echo", "a", "b"]],
    ["  echo   a   ", ["echo", "a"]],
    ["echo\\_A\\_B", ["echo", "A", "B"]],
    ["echo a\\_\\_b", ["echo", "a", "b"]],
    ["echo X\\cY", ["echo", "X"]],
    ["echo a\\c b", ["echo", "a"]],
    ["echo a\\tb", ["echo", "a\tb"]],
    ["echo a\\nb", ["echo", "a\nb"]],
    ["echo a\\rb\\fc\\vd", ["echo", "a\rb\fc\vd"]],
    ["echo a\\\\b", ["echo", "a\\b"]],
    ['echo a\\"b', ["echo", 'a"b']],
    ["echo a\\'b", ["echo", "a'b"]],
    ["echo a\\$b", ["echo", "a$b"]],
    ["echo a\\#b", ["echo", "a#b"]],
    ["echo a #comment", ["echo", "a"]],
    ["echo a #c b", ["echo", "a"]],
    ["echo a#b", ["echo", "a#b"]],
    ["#echo a", []],
    ["echo a\\ b", null],
    ['echo "a  b"', ["echo", "a  b"]],
    ["echo 'a  b'", ["echo", "a  b"]],
    ['echo "a\\"b"', ["echo", 'a"b']],
    ["echo 'a\\'b'", ["echo", "a'b"]],
    ["echo 'a\\\\b'", ["echo", "a\\b"]],
    ["echo 'a\\_b'", ["echo", "a\\_b"]],
    ["echo 'a\\tb'", ["echo", "a\\tb"]],
    ['echo "a\\_b"', ["echo", "a b"]],
    ['echo "a\\tb"', ["echo", "a\tb"]],
    ['echo "a"b"c"', ["echo", "abc"]],
    ["echo a'b c'd", ["echo", "ab cd"]],
    ['echo ""', ["echo", ""]],
    ["echo ''", ["echo", ""]],
    ["echo ${F}", ["echo", "FVAL"]],
    ["echo ${F}x", ["echo", "FVALx"]],
    ["echo ${F}${X}", ["echo", "FVALxval"]],
    ['echo "a ${F} b"', ["echo", "a FVAL b"]],
    ["echo 'a ${F} b'", ["echo", "a ${F} b"]],
    ["echo ${NOPE}x", ["echo", "x"]],
    ["env -S 'echo nested'", ["env", "-S", "echo nested"]],
  ] as const)("%s", (text, expected) => {
    const got = words(text, { F: "FVAL", X: "xval", NOPE: "" });
    if (expected === null) {
      // a backslash before a blank is an error to env: nothing runs, so the guard asks
      expect(got.unplaced).toBeDefined();
      return;
    }
    expect(got.unplaced, text).toBeUndefined();
    expect([...got.words]).toEqual(expected);
  });

  it.each([
    "echo a\\xb",
    "echo a\\",
    "echo \\",
    'echo "a\\cb"',
    'echo "a\\zb"',
    "echo $F",
    'echo "$F"',
    "echo ${F",
    "echo ${}b",
    "echo ${1}",
    "echo ${F:-d}",
    'echo "unterminated',
    "echo 'unterminated",
  ])("env rejects %j: the guard asks, it does not guess", (text) => {
    expect(words(text, { F: "x" }).unplaced, text).toBeDefined();
  });

  it("a variable the guard cannot place is a question, never an empty string", () => {
    expect(splitEnvString("echo ${UNKNOWN}").unplaced).toMatch(/UNKNOWN/);
  });
});

describe("the grammar agrees with the REAL env (echo only; skipped where env has no -S)", () => {
  const REAL = "/usr/bin/env";
  const hasSplit =
    existsSync(REAL) && spawnSync(REAL, ["-S", "echo ok"], { encoding: "utf8" }).stdout === "ok\n";
  const CASES = [
    "a b",
    "a\\_b",
    "a\\cb",
    "a\\tb",
    "a\\nb",
    "a\\\\b",
    'a\\"b',
    "a\\'b",
    "a\\$b",
    "a\\#b",
    "a #c",
    "a#b",
    '"a  b"',
    "'a  b'",
    '"a\\"b"',
    "'a\\'b'",
    "'a\\\\b'",
    "'a\\_b'",
    '"a\\_b"',
    "a${F}b",
    '"a ${F} b"',
    "'a ${F} b'",
    '"a"b"c"',
    "a'b c'd",
    '""',
    "''",
    "a\\_\\_b",
    "a\\fb\\vc",
  ];
  it.skipIf(!hasSplit).each(CASES)("echo %s", (text) => {
    const real = spawnSync(REAL, ["-S", `echo ${text}`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", F: "FVAL" },
    });
    const ours = splitEnvString(`echo ${text}`, (name) => (name === "F" ? "FVAL" : undefined));
    expect(real.status, `env rejected ${text}: ${real.stderr}`).toBe(0);
    expect(ours.unplaced).toBeUndefined();
    expect(`${ours.words.slice(1).join(" ")}\n`).toBe(real.stdout);
  });
});

/** An `env -S` string for the command `words`, in a spelling env reads back as those words. */
const SPELLINGS: ReadonlyArray<readonly [string, (w: readonly string[]) => string]> = [
  ["spaces", (w) => w.join(" ")],
  ["\\_ separators", (w) => w.join("\\_")],
  ["double-quoted words", (w) => w.map((x) => `"${x}"`).join(" ")],
  ["single-quoted words", (w) => w.map((x) => `'${x}'`).join(" ")],
  ["tabs", (w) => w.join("\\t").replaceAll("\\t", "\t")],
  ["a \\c suffix", (w) => `${w.join(" ")}\\c junk`],
  ["a comment suffix", (w) => `${w.join(" ")} # comment`],
  ["leading blanks", (w) => `   ${w.join("   ")}   `],
  ["a ${V} expansion", (w) => w.join(" ").replace(w[0] as string, "${V}")],
];
const outerSingle = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
const outerDouble = (text: string): string => `"${text.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;

const GUARDED: ReadonlyArray<readonly [label: string, words: readonly string[]]> = [
  ["a force push", ["git", "push", "--force", "origin", "main"]],
  ["a hook bypass", ["git", "commit", "--no-verify", "-m", "x"]],
  ["a non-local database", ["psql", "-h", HOST, "-c", "select 1"]],
  ["a protected write", ["cp", "/tmp/x", ".claude/settings.json"]],
  ["a secret read", ["cat", ENV_FILE]],
];

describe("MONOTONICITY: env -S never makes a guarded command weaker, in any spelling and any outer quoting", () => {
  for (const [label, command] of GUARDED) {
    it(label, () => {
      const alone = rank(command.map((w) => (/[ ;]/.test(w) ? `'${w}'` : w)).join(" "));
      expect(alone, `${label} alone`).toBeGreaterThanOrEqual(1);
      const weaker: string[] = [];
      for (const [name, spell] of SPELLINGS) {
        const text = spell(command);
        for (const outer of [outerSingle, outerDouble]) {
          for (const flag of ["-S", "--split-string", "-iS", "-vS"]) {
            const invocation = flag.startsWith("--")
              ? `env ${flag}=${outer(text)}`
              : `env ${flag} ${outer(text)}`;
            // a `${V}` spelling needs the variable in front of env, as `F=.env env -S 'cat ${F}'` has it
            const cmd = name.includes("${V}") ? `V=${command[0]} ${invocation}` : invocation;
            if (rank(cmd) < alone) weaker.push(`${name}: ${cmd}`);
          }
        }
      }
      expect(weaker.slice(0, 5)).toEqual([]);
    });
  }
});

describe("producer paths: every way the string reaches env", () => {
  const NO_VERIFY = "git commit --no-verify -m x";
  it.each([
    `env -S '${NO_VERIFY}'`,
    `env -S${"'"}${NO_VERIFY}${"'"}`,
    `env --split-string='${NO_VERIFY}'`,
    `env --split-string '${NO_VERIFY}'`,
    `env -iS '${NO_VERIFY}'`,
    `env -i -S '${NO_VERIFY}'`,
    `env -u X -S '${NO_VERIFY}'`,
    `env -S 'env -S '\\''${NO_VERIFY}'\\'''`,
    `env -S 'env -i -S '\\''${NO_VERIFY}'\\'''`,
    `sudo env -S '${NO_VERIFY}'`,
    `nice env -S '${NO_VERIFY}'`,
    `/usr/bin/env -S '${NO_VERIFY}'`,
    `timeout 5 env -S '${NO_VERIFY}'`,
    `env -S 'FOO=1 ${NO_VERIFY}'`,
    `bunx env -S '${NO_VERIFY}'`,
    `env -S "git\\_commit\\_--no-verify\\_-m\\_x"`,
    `env -S "git commit --no-verify -m x"`,
    `env -S git\\ commit\\ --no-verify\\ -m\\ x`,
  ])("%s is judged", (cmd) => {
    expect(rank(cmd), cmd).toBe(2);
  });

  it("a backslash the outer shell reads is the outer shell's, the one env reads is env's", () => {
    // outer double quotes turn `\\_` into `\_`, which env reads as a separator
    expect(rank(`env -S "cat\\\\_${ENV_FILE}"`)).toBe(2);
    expect(rank(`env -S "cat \\"${ENV_FILE}\\""`)).toBe(2);
  });

  it("a variable in front of env fills ${NAME}; another one asks", () => {
    expect(rank(`F=${ENV_FILE} env -S 'cat \${F}'`)).toBe(2);
    expect(rank("F=x.txt env -S 'cat ${F}'")).toBe(0);
    expect(rank(`export F=${ENV_FILE}; env -S 'cat \${F}'`)).toBeGreaterThanOrEqual(1);
    expect(rank("env -S 'cat ${NOT_SET_ANYWHERE}'")).toBeGreaterThanOrEqual(1);
  });

  it("a string env would reject asks (nothing would run, but a guessed reading must not stand)", () => {
    for (const cmd of [
      "env -S 'git push \\z'",
      "env -S 'git push $F'",
      "env -S 'echo \"x'",
      "env -S 'echo \"x\\cy\"'",
    ]) {
      expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
    }
  });

  it("the everyday env -S forms stay allowed", () => {
    for (const cmd of [
      "env -S 'echo a b'",
      "env -S 'bun run test'",
      "env -S 'ls -l scripts'",
      "env -iS 'echo hi'",
      "env -S 'FOO=bar ls'",
      "env FOO=bar ls",
      "env -u FOO ls",
      "/usr/bin/env -S 'echo \"a b\"'",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
