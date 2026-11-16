/**
 * Wave 8, T8 (round-6 ADV6-13): a variable the command line rebinds is no longer its first literal. A sweep operand `$S` is
 * placed from the literal the same command assigns to S, but `S=/tmp/x; read S <<< apps/portal; cp -r $S /tmp/o` (and
 * `printf -v`, `for`, `eval`, `+=`, `select`, `while read`, `let`, `source <(echo S=…)`) rebound it after the first literal
 * and the guard kept trusting that one: every one was allowed. A rebound variable is UNKNOWN, so an operand using it cannot be
 * placed and a sweep over it asks; a variable set once to a harmless literal still allows (`D=src; ls $D`).
 * `classifyBash` is pure: the live env files are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { reboundNames } from "../harness/variable-rebinding";

const ENV = [".", "env"].join("");
const PORTAL = `apps/portal/${ENV}`;
const ctx = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${PORTAL}`,
  liveEnvFiles: () => [PORTAL],
};
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

describe("reboundNames: which variables a command line binds by more than one `NAME=value`", () => {
  it.each<[string, string[]]>([
    ["S=a; cp -r $S /tmp/o", []],
    ["D=src; ls $D", []],
    ["S=a; S=b", ["S"]],
    ["S=a; S+=b", ["S"]],
    ["S+=b", ["S"]],
    ["S=a; read S", ["S"]],
    ["read A B", ["A", "B"]],
    ["read -r -p 'x' S", ["S"]],
    ["while read S; do :; done", ["S"]],
    ["S=a; printf -v S x", ["S"]],
    ["S=a; for S in x; do :; done", ["S"]],
    ["S=a; select S in x; do :; done", ["S"]],
    ['S=a; eval "S=b"', ["S"]],
    ["S=a; let S=3", ["S"]],
    ["S=a; (( S += 1 ))", ["S"]],
    ["S=a; mapfile -t S <<< x", ["S"]],
    ["S=a; readarray S", ["S"]],
    ["S=a; getopts ab S", ["S"]],
    [": ${S:=apps}", ["S"]],
    ["S=a; source <(echo S=b)", ["S"]],
    ["S=a; bash -c 'S=b; true'", ["S"]],
    ["A=1; B=2; echo $A $B", []],
    ["S=a; let S++", ["S"]],
    ["S=a; (( S++ ))", ["S"]],
    ["grep --include=a --include=b x", []],
    ["[ a==b ] && [ a==c ]", []],
    ["[[ x =~ a ]] && [[ x =~ b ]]", []],
    ["git log --format=%H", []],
    ["curl 'http://x/?a=1&b=2'", []],
    ["export S=a; export S=b", ["S"]],
    ["declare -x S=a; local S=b", ["S"]],
    ["echo a==b", []],
    ["[[ $x =~ y ]]", []],
  ])("%s", (cmd, expected) => {
    expect([...reboundNames(cmd)].sort()).toEqual(expected);
  });
});

describe("ADV6-13: the reviewer's rebinding forms ask, the controls do not", () => {
  it.each([
    "S=/tmp/x; read S <<< apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; read -r S <<< apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; printf -v S apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; for S in apps/portal; do cp -r $S /tmp/o; done",
    'S=/tmp/x; eval "S=apps/portal"; cp -r $S /tmp/o',
    "S=/tmp/x; S+=apps/portal; cp -r $S /tmp/o",
    "S=apps; S+=/portal; cp -r $S /tmp/o",
    "S=/tmp/x; select S in apps/portal; do cp -r $S /tmp/o; done",
    "S=/tmp/x; while read S; do cp -r $S /tmp/o; done <<< apps/portal",
    "S=/tmp/x; source <(echo S=apps/portal); cp -r $S /tmp/o",
    "S=/tmp/x; let S=apps; cp -r $S /tmp/o",
    "S=/tmp/x; mapfile -t S <<< apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; S=apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; export S=apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; : ${S:=apps/portal}; cp -r $S /tmp/o",
    "S=/tmp/x; declare S=apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; local S=apps/portal; cp -r $S /tmp/o",
    "S=/tmp/x; getopts a S; cp -r $S /tmp/o",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "S=apps/portal; cp -r $S /tmp/o",
    "export S=apps/portal; cp -r $S /tmp/o",
    "S=apps/portal && grep -r X $S",
    "S=apps/portal; tar cf /tmp/o.tar $S",
  ])("control: %s still asks (placed from its single literal)", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "D=src; ls $D",
    "D=lib; cp -r $D /tmp/o",
    "S=/tmp/x; cp -r $S /tmp/o",
    "S=/tmp/x; S2=/tmp/y; cp -r $S /tmp/o",
    "A=lib; B=docs-x; cp -r $A $B",
    "export D=lib; grep -r X $D",
    "S=lib; grep -r X $S",
  ])("control: %s still allows (set once to a harmless literal)", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("a rebound variable is unknown even when every binding is harmless (an ask, not a miss)", () => {
    expect(d("S=lib; read S <<< x; cp -r $S /tmp/o")).toBe("ask");
  });

  it("a rebinding of a variable the sweep does not use changes nothing", () => {
    expect(d("T=1; read T <<< x; D=lib; cp -r $D /tmp/o")).toBe("allow");
  });
});
