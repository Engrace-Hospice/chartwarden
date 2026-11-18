/**
 * Wave 3 (fixer W3b), ADV-M4 and ADV-M5: destructive operations on the repo root's ANCESTORS, and the `find`
 * narrowing escape hatch. Every payload under an "asks" heading answered `allow` at the base of this wave. The
 * everyday cleanups next to them (`rm -rf dist`, `find . -name '*.tmp' -delete`) must stay allowed.
 * `classifyBash` is pure: root, home and cwd are injected, no file system is read.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findActions, protectedFindSamples } from "../harness/find-expr";
import { classifyBash, isProtectedPath } from "../harness/patterns";

const ctx = { root: "/Users/dev/Apps/repo", home: "/Users/dev", cwd: "/Users/dev/Apps/repo" };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;
const allowed = (cmd: string) => {
  const verdict = v(cmd);
  expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
};

describe("a recursive or moving operation on an ancestor of the repo root takes the root with it", () => {
  it.each([
    "rm -rf ..",
    "rm -rf ../",
    "rm -rf ../..",
    "rm -rf /Users/dev/Apps",
    "rm -rf /USERS/DEV/APPS",
    "rm -rf ~/Apps",
    "rm -rf ~",
    "rm -rf $HOME/Apps",
    "rm -rf /Users",
    "rm -rf /",
    "cd .. && rm -rf repo",
    "cd / && rm -rf Users",
    "chmod -R 000 ..",
    "chmod -R 000 ~/Apps",
    "chmod --rec 000 .",
    "chmod --recursive 000 ..",
    "chown -R x ..",
    "chgrp -R x ..",
    "setfacl -R -m u:x:rwx ..",
    "chflags -R nouchg ..",
    "xattr -r -c ..",
    "find .. -delete",
    "find ~/Apps -delete",
    "mv . /tmp/x",
    "mv ../repo ../x",
    "mv /Users/dev/Apps/repo /tmp/x",
    "mv ~/Apps /tmp/x",
    "rm --rec --force .",
    "rm --recursive --force .",
    "rm --r -f .",
    "rm -R .",
    "tar xf a.tar -C ..",
    "bsdtar xf a.tar -C ..",
    "bsdtar xf a.tar",
    "gtar -xzf a.tgz",
    "7z x a.7z",
    "7z x a.7z -o.",
    "7za x a.7z -o..",
    "cpio -idv < a.cpio",
    "cpio --extract < a.cpio",
    "ditto -x a.zip .",
    "ditto a.zip .",
    "ditto a ..",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "rm -rf dist",
    "rm -rf ./dist",
    "rm -rf /tmp/other",
    "rm -rf ../other",
    "rm -rf ~/Downloads/x",
    "rm -rf ~/Apps/other",
    "rm -rf /Users/dev/Apps/repo/dist",
    "rm -rf apps/web/dist apps/web/.turbo",
    "rm -f ../notes.txt",
    "rm -r ../other/dist",
    "mv a b",
    "mv dist dist.old",
    "mv ../other /tmp/y",
    "mv ../repo-notes.txt .",
    "chmod -R 755 dist",
    "chmod -R u+x ../other",
    "chown -R x /tmp/y",
    "cp -r a ../other",
    "find ../other -name '*.tmp' -delete",
    "tar xf a.tar -C /tmp/x",
    "bsdtar xf a.tar -C /tmp/x",
    "bsdtar tf a.tar",
    "7z x a.7z -o/tmp/x",
    "7z l a.7z",
    "cpio -o < list > /tmp/a.cpio",
    "cpio -idv -D /tmp/x < a.cpio",
    "ditto a /tmp/b",
  ])("keeps the everyday %s allowed", allowed);
});

describe("a find action is narrowed only by a test that cannot match a protected file", () => {
  it.each([
    "find . -name '*' -delete",
    "find . -path '*' -delete",
    "find . -regex '.*' -delete",
    "find . -name '*.ts' -delete",
    "find . -name '*.yaml' -delete",
    "find . -name '*.md' -delete",
    "find . -name '*.json' -delete",
    "find . -iname '*.TS' -delete",
    "find . -name 'p*' -delete",
    "find . -name '*.t?' -delete",
    "find . -name '*[s]' -delete",
    "find . -name '*.ts' -exec rm {} +",
    "find . -name '*' -exec rm {} +",
    "find . \\( -name x -o -true \\) -delete",
    "find . \\( -name '*.tmp' -o -true \\) -delete",
    "find . \\( -name '*.tmp' -o -name '*.ts' \\) -delete",
    "find . -name '*.tmp' -o -delete",
    "find . -name x -o -exec rm {} +",
    "find . ! -name '*.tmp' -delete",
    "find . -not -name '*.tmp' -delete",
    "find . -type f -delete",
    "find . -mtime +30 -delete",
    "find . -exec sh -c 'rm -rf {}' \\;",
    "find . -exec bash -c 'rm -f {}' \\;",
    "find . -exec env rm -rf {} \\;",
    "find . -exec sudo rm -rf {} \\;",
    "find . -exec nice rm -rf {} \\;",
    "find . -exec timeout 5 rm {} \\;",
    "find . -exec perl -pi -e s/a/b/ {} \\;",
    "find . -exec gsed -i s/a/b/ {} \\;",
    "find . -exec ruby -i -pe 1 {} \\;",
    "find . -execdir rm {} \\;",
    "find . -ok rm {} \\;",
    "find . \\( -name '*.ts' -a -type f \\) -delete",
    "find . -regex '.*\\.ts' -delete",
    "find . -regex '.*[.]yaml' -delete",
    "find . -regex '^\\./scripts/.*' -delete",
    "find . -path './scripts/*' -delete",
    "find . -path '*/harness/*' -delete",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "find . -name '*.tmp' -delete",
    "find . -name '*.log' -delete",
    "find . -name '*.map' -delete",
    "find . -name '*~' -delete",
    "find . -name '.DS_Store' -delete",
    "find . -iname '*.TMP' -delete",
    "find . -name '*.tmp' -exec rm {} +",
    "find . -name '*.tmp' -exec sh -c 'rm -f {}' \\;",
    "find . -type f -name '*.tmp' -delete",
    "find . -mtime +30 -name '*.log' -delete",
    "find . \\( -name '*.tmp' -o -name '*.log' \\) -delete",
    "find . -name '*.tmp' -o -name '*.log' -delete",
    "find . -name node_modules -prune -o -name '*.map' -delete",
    "find . -path '*/node_modules/*' -delete",
    "find . -path './dist/*' -delete",
    "find . -regex '.*\\.tmp' -delete",
    "find apps -name '*.tmp' -delete",
    "find dist -delete",
    "find . -name '*.ts' -exec grep -l x {} +",
    "find . -exec sh -c 'echo {}' \\;",
    "find . -name '*.ts' -exec grep -l x {} +",
    "find . -type f -name '*.ts' -print",
    "find . \\( -type f -name '*.tmp' \\) -delete",
    "find . -exec sh -c 'rm -f /tmp/x' \\;",
    "find . -name '*.ts' -exec sh -c 'cat {}' \\;",
  ])("keeps the everyday %s allowed", allowed);
});

describe("findActions", () => {
  const narrowed = (...args: string[]) => findActions(args, () => false).map((a) => a.narrowed);

  it("narrows an action by the tests ANDed before it, and by nothing else", () => {
    expect(narrowed("-name", "*.tmp", "-delete")).toEqual([true]);
    expect(narrowed("-name", "*.ts", "-delete")).toEqual([false]);
    expect(narrowed("-delete")).toEqual([false]);
    expect(narrowed("-type", "f", "-name", "*.tmp", "-delete")).toEqual([true]);
    expect(narrowed("!", "-name", "*.tmp", "-delete")).toEqual([false]);
  });

  it("reads parentheses and -o as a boolean expression", () => {
    expect(narrowed("(", "-name", "*.tmp", "-o", "-name", "*.log", ")", "-delete")).toEqual([true]);
    expect(narrowed("(", "-name", "*.tmp", "-o", "-true", ")", "-delete")).toEqual([false]);
    expect(narrowed("-name", "*.tmp", "-o", "-delete")).toEqual([false]);
    expect(narrowed("-name", "*.tmp", "-o", "-name", "*.log", "-delete")).toEqual([true]);
    expect(narrowed("-name", "x", "-prune", "-o", "-name", "*.map", "-delete")).toEqual([true]);
  });

  it("reports each action with the kind and the words of an -exec", () => {
    const found = findActions(["-name", "*.tmp", "-exec", "rm", "{}", "+", "-delete"], () => true);
    expect(found.map((a) => a.kind)).toEqual(["exec", "delete"]);
    expect(found[0]?.words).toEqual(["rm", "{}"]);
    expect(findActions(["-exec", "grep", "x", "{}", "+"], () => false)).toEqual([]);
  });

  it("only counts an -exec the caller says writes", () => {
    expect(findActions(["-exec", "rm", "{}", "+"], () => true)).toHaveLength(1);
    expect(findActions(["-exec", "rm", "{}", "+"], () => false)).toHaveLength(0);
  });
});

describe("the protected name samples cover every protected file the repository tracks", () => {
  // Round 4 (CR-C3): the list used to be hand-kept and accepted "or an extension it has a sample for", which hid 63
  // missing names (`hard-deadline.ts` among them). It is read from the tree now, and every file is held BY NAME.
  const tracked = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => f !== "" && isProtectedPath(f));
  const sampleSet = new Set(protectedFindSamples());

  it("finds protected files to check", () => {
    expect(tracked.length).toBeGreaterThan(20);
  });

  it("holds each by its exact path, with no extension standing in for a name", () => {
    expect(tracked.filter((f) => !sampleSet.has(f))).toEqual([]);
  });

  it("holds only names that are protected themselves, or an extension sample", () => {
    for (const sample of protectedFindSamples()) {
      expect(isProtectedPath(sample) || /^x\.[\w-]+$/.test(sample), sample).toBe(true);
    }
  });
});
