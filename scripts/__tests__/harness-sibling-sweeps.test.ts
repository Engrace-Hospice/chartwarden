/**
 * Wave 7, T2 (round-5 ADV5-3, CRITICAL). The tree sweeps the classifier already asks about (`grep -r`, `rg -u`,
 * `find … -exec cat`, `cp -r`, `tar c`) all had siblings it did not know: `ack` (recursive, reads no .gitignore), `ag
 * -u`, `fd -x cat`, `find … | cpio -p`, `pax -rw`. `sibling-sweeps.ts` rewrites each into the command line it is the
 * sibling of (`ack` as `grep -r`, `ag -u` as `rg -u`, `fd -x` as `find -exec`, `cpio -p` and `pax -rw` as `cp -r`,
 * `pax -w` and `cpio -o` as `tar c`), and the classifier judges that line with the machinery it already has.
 *
 * What reproduced and what did not (checked on this machine: fd 10.4.2, macOS cpio and pax; `ag` and `ack` are not
 * installed, their behaviour is from their documentation): `find . -depth -print | cpio -pdm DEST` and `pax -rw . DEST`
 * copy a gitignored hidden file (they ignore .gitignore); `fd` and `ag` skip gitignored files by default, so a plain
 * `fd -H … -x cat` or `ag -l X .` does not read a gitignored env file there (`fd -u` / `-I` does), but `fd -x` asks
 * like `find -exec` anyway (a repo's ignore rules are not the guard's to read) and plain `ag` stays allowed like plain
 * `rg`. `classifyBash` is pure: root, home, cwd and "exists" are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { type Feeder, siblingCommands } from "../harness/sibling-sweeps";

/** A live env file's name, built so this file never spells it out. */
const BACKEND_ENV = ["apps/backend/", ".", "env"].join("");
const withEnv = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${BACKEND_ENV}`,
};
const noEnv = { ...withEnv, exists: () => false };
const d = (cmd: string, ctx: object = withEnv) => classifyBash(cmd, ctx).decision;
const lines = (prog: string, args: string[], feeder: Feeder | null = null) =>
  siblingCommands(prog, args, feeder).map((c) => c.text);

describe("siblingCommands: the command line each sibling is judged as", () => {
  it.each<[string, string[], string[]]>([
    ["ack", ["-l", "SECRET", "."], ["grep -r -l SECRET ."]],
    ["ack", ["foo", "apps"], ["grep -r foo apps"]],
    ["ag", ["-u", "-l", "SECRET", "."], ["rg -u -u -l SECRET ."]],
    ["ag", ["--hidden", "foo"], ["rg -u --hidden foo"]],
    ["ag", ["-U", "foo", "apps"], ["rg -u -U foo apps"]],
    ["ag", ["--skip-vcs-ignores", "foo"], ["rg -u --skip-vcs-ignores foo"]],
    ["ag", ["--unrestricted", "foo"], ["rg -u --unrestricted foo"]],
    ["fd", ["-x", "cat", "{}"], ["find . -exec cat '{}' \\;"]],
    ["fd", ["-H", "-t", "f", ".", ".", "-x", "cat", "{}"], ["find . -exec cat '{}' \\;"]],
    ["fd", ["pat", "apps", "-X", "cat"], ["find apps -exec cat '{}' +"]],
    ["fd", ["--exec-batch", "grep", "foo"], ["find . -exec grep foo '{}' +"]],
    ["fd", ["-e", "ts", "-x", "cat", "{}"], ["find . -name '*.ts' -exec cat '{}' \\;"]],
    ["fd", ["-e", "ts", "-e", "env", "-x", "cat"], ["find . -exec cat '{}' \\;"]],
    ["fd", ["-I", "x", "a", "b", "--exec", "rm"], ["find a b -exec rm '{}' \\;"]],
    ["pax", ["-rw", ".", "/tmp/out"], ["cp -r . /tmp/out"]],
    ["pax", ["-rw", "-p", "e", "a", "b", "/tmp/out"], ["cp -r a b /tmp/out"]],
    ["pax", ["-w", "."], ["tar -c ."]],
    ["pax", ["-w", "-f", "/tmp/x.pax", "a", "b"], ["tar -c a b"]],
  ])("%s %j", (prog, args, expected) => {
    expect(lines(prog, args)).toEqual(expected);
  });

  it.each<[string, string[], Feeder | null, string[]]>([
    [
      "cpio",
      ["-pdm", "/tmp/out"],
      { prog: "find", args: [".", "-depth", "-print"] },
      ["cp -r . /tmp/out"],
    ],
    [
      "cpio",
      ["-0pdm", "/tmp/out"],
      { prog: "find", args: ["a", "b", "-print0"] },
      ["cp -r a b /tmp/out"],
    ],
    ["cpio", ["--pass-through", "/tmp/out"], { prog: "find", args: [] }, ["cp -r . /tmp/out"]],
    ["cpio", ["-o"], { prog: "find", args: ["."] }, ["tar -c ."]],
    ["cpio", ["--create"], { prog: "find", args: ["apps", "-type", "f"] }, ["tar -c apps"]],
    ["pax", ["-rw", "/tmp/out"], { prog: "find", args: ["apps"] }, ["cp -r apps /tmp/out"]],
    ["pax", ["-w"], { prog: "find", args: ["."] }, ["tar -c ."]],
  ])("%s %j fed by %j", (prog, args, feeder, expected) => {
    expect(lines(prog, args, feeder)).toEqual(expected);
  });

  it.each<[string, string[], Feeder | null]>([
    ["ag", ["--version"], null],
    ["ag", ["-l", "foo", "."], null],
    ["ag", ["foo", "apps"], null],
    ["ack", ["--version"], null],
    ["ack", ["--help"], null],
    ["ack", ["-f", "apps"], null],
    ["ack", ["-g", "name"], null],
    ["fd", ["-e", "ts"], null],
    ["fd", ["pattern", "src"], null],
    ["fd", ["--version"], null],
    ["cpio", ["-t"], null],
    ["cpio", ["-i"], null],
    ["cpio", ["-pdm", "/tmp/out"], null],
    ["cpio", ["-pdm", "/tmp/out"], { prog: "ls", args: [] }],
    ["cpio", ["-o"], { prog: "git", args: ["ls-files"] }],
    ["pax", ["-r"], null],
    ["pax", ["-rw", "/tmp/out"], null],
    ["pax", ["-rw", "/tmp/out"], { prog: "ls", args: [] }],
    ["cat", ["-l", "foo"], null],
    ["", [], null],
  ])("%s %j (fed by %j) is not a sweep", (prog, args, feeder) => {
    expect(lines(prog, args, feeder)).toEqual([]);
  });
});

describe("ADV5-3: the siblings ask when they sweep the repo root or a directory holding a live env file", () => {
  it.each([
    "ack -l SECRET .",
    "ack SECRET",
    "ack -i token apps",
    "ack -l foo apps/backend",
    "ag -u -l SECRET .",
    "ag --unrestricted SECRET",
    "ag --hidden -U SECRET .",
    "ag --skip-vcs-ignores -l SECRET apps",
    "fd -H -t f . . -x cat {}",
    "fd -I . . -X cat",
    "fd -x cat",
    "fd . apps -x cat {}",
    "fd --exec-batch grep foo",
    "fd -u -x head -n1 {}",
    "fd . . -x rm {}",
    "find . -depth -print | cpio -pdm /tmp/cpio-out",
    "find . -print0 | cpio -0pdm /tmp/cpio-out",
    "find apps -print | cpio -pdm /tmp/cpio-out",
    "find . | cpio -o > /tmp/x.cpio",
    "find . -type f | cpio --create > /tmp/x.cpio",
    "pax -rw . /tmp/pax-out",
    "pax -rw apps /tmp/pax-out",
    "pax -w . > /tmp/x.pax",
    "pax -w -f /tmp/x.pax .",
    "find . -print | pax -rw /tmp/pax-out",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("their controls, the sweeps the classifier already knew, still ask", () => {
    for (const cmd of [
      "grep -r SECRET .",
      "find . -type f -exec cat {} +",
      "cp -r . /tmp/cp-out",
      "tar c . > /tmp/x.tar",
    ]) {
      expect(d(cmd), cmd).toBe("ask");
    }
  });

  it("says which sibling it judged and as what", () => {
    const v = classifyBash("ack -l SECRET .", withEnv);
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/`ack`/);
    expect(v.reason).toMatch(/grep -r/);
  });
});

describe("everyday neighbours stay allowed", () => {
  it.each([
    "ag --version",
    "ag -l SECRET .",
    "ag foo apps/backend/src",
    "ag -u foo apps/backend/src",
    "ack --version",
    "ack foo apps/backend/src",
    "ack -i token scripts",
    "ack -f scripts",
    "fd -e ts",
    "fd pattern src",
    "fd -t f . scripts",
    "fd --version",
    "fd -e ts -x cat {}",
    "fd -e ts -e tsx -x grep foo {}",
    "fd . apps/web/src -x cat {}",
    "fd -e ts -x bunx biome check {}",
    "cpio -t < archive.cpio",
    "cpio -tv < archive.cpio",
    "ls | cpio -o > /tmp/x.cpio",
    "git ls-files | cpio -pdm /tmp/out",
    "find src -print | cpio -pdm /tmp/out",
    "find apps/web/src -print | cpio -pdm /tmp/out",
    "pax -rw src /tmp/out",
    "pax -w src > /tmp/x.pax",
    "pax -r < /tmp/x.pax",
    "pax -f /tmp/x.pax",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("a sweep over a directory that holds no live env file is allowed (the repo has none under apps)", () => {
    for (const cmd of [
      "ack -l SECRET apps",
      "fd . apps -x cat {}",
      "find apps -print | cpio -o > /tmp/x.cpio",
      "pax -rw apps /tmp/pax-out",
      "ag -u -l SECRET apps",
    ]) {
      expect(d(cmd, noEnv), cmd).toBe("allow");
    }
  });

  it("but the repo root asks even when no live env file exists yet (it could appear)", () => {
    for (const cmd of ["ack -l SECRET .", "fd -x cat", "pax -rw . /tmp/pax-out"]) {
      expect(d(cmd, noEnv), cmd).toBe("ask");
    }
  });
});

describe("a sibling that writes onto a protected path is judged by the machinery it maps to", () => {
  it.each([
    "find src -print | cpio -pdm scripts/harness",
    "pax -rw src scripts/harness",
    "fd -e ts . src -x rm scripts/harness/pre-tool-guard.ts",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("a deny is never turned into an ask (a secret file named by the sibling stays denied)", () => {
    expect(d(`ack token ${BACKEND_ENV}`)).toBe("deny");
  });
});
