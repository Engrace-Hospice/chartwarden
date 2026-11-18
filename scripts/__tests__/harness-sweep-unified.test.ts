/**
 * Wave 7, T5, CR5-6 (round-5 code review, HIGH): five sweep rules, two readings of "this operand reaches a live env
 * file". `grep -r` and `diff -r` placed wildcards, ancestors and operands that cannot be placed; `cp -r`, `rsync -a`,
 * `tar c` and `find -exec cat` did not, so `apps/*`, `~/Apps`, `..`, `~`, `deploy/*` asked for the first two and allowed
 * the rest, a variable operand (`D=.; grep -r x $D`) was placed as a literal, and `find . -name '*.ts' -o -type f -exec
 * cat {} +` counted the `-name` that sat in the other branch of the `-o` as narrowing. Now every sweep asks through
 * `treeOperandReaches`, and `find` is read as the boolean expression it is. `classifyBash` is pure; names built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { literalValues, withKnownVariables } from "../harness/shell-assignments";

const BACKEND_ENV = ["apps/backend/", ".", "env"].join("");
const PROD_ENV = ["deploy/production/", ".", "env", ".production"].join("");
/** The repo under the home directory, as on a developer machine: `~` and `~/Apps` are above it. */
const ROOT = "/Users/dev/Apps/repo";
const ctx = {
  root: ROOT,
  home: "/Users/dev",
  cwd: ROOT,
  exists: (p: string) => p === `${ROOT}/${BACKEND_ENV}` || p === `${ROOT}/${PROD_ENV}`,
};
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

/** Each sweep, as a function of the operand it reads. */
const SWEEPS: Array<[string, (operand: string) => string]> = [
  ["grep -r", (o) => `grep -r SECRET ${o}`],
  ["diff -r", (o) => `diff -r /var/empty ${o}`],
  ["cp -r", (o) => `cp -r ${o} /tmp/o`],
  ["rsync -a", (o) => `rsync -a ${o} /tmp/o`],
  ["tar c", (o) => `tar c ${o} > /tmp/o.tar`],
  ["find -exec cat", (o) => `find ${o} -type f -exec cat {} +`],
];

describe("every sweep asks about the same operands", () => {
  describe.each(SWEEPS)("%s", (_name, command) => {
    it.each([
      "apps/*",
      "'apps/*'",
      "apps/b*",
      "deploy/*",
      "~/Apps",
      "~",
      "..",
      "../..",
      ".",
      "apps",
      "apps/backend",
      "deploy/production",
      "{apps,docs}",
      "$SRC",
      '"$SRC"',
      "${D}/x",
      "$(pwd)/..",
    ])("operand %s", (operand) => {
      expect(d(command(operand)), command(operand)).toBe("ask");
    });

    it.each(["docs", "packages/x", "scripts", "apps/web/src", "src", "./docs/guide"])(
      "a directory that holds no live env file stays allowed: %s",
      (operand) => {
        expect(d(command(operand)), command(operand)).toBe("allow");
      },
    );
  });
});

describe("find is read as a boolean expression: `-o` narrows nothing", () => {
  it.each([
    "find . -name '*.ts' -o -type f -exec cat {} +",
    "find apps -name '*.md' -o -exec cat {} +",
    "find . -type f -exec cat {} + -o -name '*.ts'",
    "find . ! -name '*.ts' -exec cat {} +",
    "find . -name '*' -exec cat {} +",
    "find . -name '*.sh.bak' -exec cat {} +",
    "find . \\( -name '*.ts' -o -name '*.log' \\) -exec cat {} +",
    "find . -type f -exec cat {} +",
  ])("asks: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
  it.each([
    "find . -name '*.env' -exec cat {} +",
    "find . \\( -name '*.ts' -o -name '.env' \\) -exec cat {} +",
  ])("a name test that names a secret file is a deny, never narrowed away: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
  it.each([
    "find . -name '*.ts' -exec cat {} +",
    "find . -type f -name '*.md' -exec grep foo {} +",
    "find apps -iname '*.json' -exec cat {} \\;",
    "find . \\( -name '*.ts' -o -name '*.tsx' \\) -exec cat {} +",
    "find . -name '*.ts' -type f -exec head -n1 {} +",
    "find docs -type f -exec cat {} +",
    "find . -type f -print",
    "find . -name '*.tmp' -delete",
  ])("a source-file name test ANDed in front stays allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("a plain variable operand is placed or asks", () => {
  it.each([
    "D=.; grep -r SECRET $D",
    "D=.; cp -r $D /tmp/o",
    'SRC=apps; tar c "$SRC" > /tmp/o.tar',
    "grep -r SECRET $HOME_UNKNOWN",
  ])("asks: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
  it.each([
    "S=/tmp/scratch; diff -r $S/a $S/b",
    "S=/tmp/scratch; grep -rn foo ${S}/src",
    "DIR=docs; tar c $DIR > /tmp/o.tar",
    "export OUT=/tmp/out; cp -r docs $OUT",
    "A=/tmp/a B=/tmp/b; diff -r $A $B",
  ])("a variable the same command line sets to a literal is placed there: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
  it.each(["grep -r SECRET $PWD/docs", "cp -r $HOME/notes /tmp/o", "grep -r x $(pwd)/docs"])(
    "a placed variable is judged by where it lands: %s",
    (cmd) => {
      expect(d(cmd), cmd).toBe("allow");
    },
  );
  it("a children read (a plain diff of two directories) is not asked about an unplaceable operand", () => {
    expect(d("diff $A $B")).toBe("allow");
  });
});

describe("literalValues and withKnownVariables", () => {
  it("keeps plain literals, the last assignment wins, and drops anything the shell would expand", () => {
    const known = literalValues([
      "D=.",
      "D=docs",
      "S=/tmp/x",
      "E=$HOME/x",
      "F=a b",
      "G=$(pwd)",
      "H=`x`",
    ]);
    expect([...known]).toEqual([
      ["D", "docs"],
      ["S", "/tmp/x"],
    ]);
  });
  it("substitutes $NAME and ${NAME}, and leaves an unknown variable as written", () => {
    const known = new Map([["D", "docs"]]);
    expect(withKnownVariables("$D/a", known)).toBe("docs/a");
    expect(withKnownVariables("${D}x/$E", known)).toBe("docsx/$E");
    expect(withKnownVariables("plain", known)).toBe("plain");
    expect(withKnownVariables("$D", new Map())).toBe("$D");
  });
});
