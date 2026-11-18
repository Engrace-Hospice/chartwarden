/**
 * Wave 3 (fixer W3b), ADV-H3: the repo root and the home directory are matched as text, so another SPELLING of
 * the same directory slipped past: upper case (APFS and NTFS ignore case), the `/System/Volumes/Data` firmlink
 * prefix, `/tmp` against `/private/tmp`. Every payload under an "asks" heading answered `allow` at the base of
 * this wave. `classifyBash` is pure: root, home and cwd are injected, no file system is read.
 */
import { describe, expect, it } from "vitest";
import { relativeTo } from "../harness/path-alias";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/Users/dev/repo", home: "/Users/dev", cwd: "/Users/dev/repo" };
const tmpCtx = { root: "/private/tmp/cw", home: "/Users/dev", cwd: "/private/tmp/cw" };
const d = (cmd: string, c: object = ctx) => classifyBash(cmd, c).decision;

describe("another spelling of the repo root names the same protected file", () => {
  it.each([
    "echo x > /USERS/DEV/REPO/scripts/harness/pre-tool-guard.ts",
    "echo x > /users/dev/repo/scripts/harness/pre-tool-guard.ts",
    "echo x > /Users/Dev/Repo/Compliance/controls.yaml",
    "echo x > /System/Volumes/Data/Users/dev/repo/scripts/harness/pre-tool-guard.ts",
    "echo x > /SYSTEM/VOLUMES/DATA/USERS/DEV/REPO/scripts/harness/x",
    "cd /USERS/DEV/REPO/scripts/harness && echo x > pre-tool-guard.ts",
    "cd /System/Volumes/Data/Users/dev/repo && echo x > scripts/harness/x",
    "cd ~/REPO && echo x > scripts/harness/x",
    "cd ~/REPO/scripts && echo x > harness/x",
    "rm /USERS/DEV/REPO/scripts/harness/pre-tool-guard.ts",
    "rm -rf /USERS/DEV/REPO",
    "sed -i s/a/b/ /System/Volumes/Data/Users/dev/repo/.claude/settings.json",
    "tee /users/dev/repo/.codex/hooks.json",
    "cp x ~/REPO/scripts/harness/",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "echo x > /PRIVATE/TMP/CW/scripts/harness/x",
    "echo x > /tmp/cw/scripts/harness/x",
    "echo x > /TMP/CW/scripts/harness/x",
    "echo x > /System/Volumes/Data/private/tmp/cw/scripts/harness/x",
    "cd /TMP/cw/scripts && echo x > harness/x",
  ])("asks before %s when the root is the real /private/tmp path", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd, tmpCtx));
  });

  it("asks for /private/tmp spellings when the root was given as /tmp", () => {
    const c = { root: "/tmp/cw", home: "/Users/dev", cwd: "/tmp/cw" };
    expect(d("echo x > /private/tmp/cw/scripts/harness/x", c)).toBe("ask");
    expect(d("echo x > /System/Volumes/Data/private/tmp/cw/scripts/harness/x", c)).toBe("ask");
  });
});

describe("another spelling of the home directory names the same startup file", () => {
  it.each([
    "echo x >> /USERS/DEV/.zshenv",
    "echo x >> /System/Volumes/Data/Users/dev/.zshrc",
    "ln -sf /usr/bin/true /users/dev/.bun/bin/bun",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });
});

describe("a path that only starts like the root is not the root", () => {
  it.each([
    "echo x > /Users/dev/repo-other/scripts/harness/x",
    "echo x > /Users/dev/repository/compliance/x",
    "echo x > /Users/dev/notes.txt",
    "echo x > /USERS/DEV/notes.txt",
    "echo x > /System/Volumes/Data/Users/dev/notes.txt",
    "cd /USERS/DEV/REPO && touch notes.txt",
    "cd /System/Volumes/Data/Users/dev/repo/apps && touch notes.txt",
    "cd ~/REPO && rm -rf dist",
    "echo x > /System/Volumes/Data/Users/dev/other/scripts/harness/x",
  ])("allows %s", (cmd) => {
    const verdict = classifyBash(cmd, ctx);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("relativeTo", () => {
  it("returns the rest of the path below a base, empty for the base itself, null elsewhere", () => {
    expect(relativeTo("/a/b/c/d", "/a/b")).toBe("c/d");
    expect(relativeTo("/a/b", "/a/b")).toBe("");
    expect(relativeTo("/a/bc/d", "/a/b")).toBeNull();
    expect(relativeTo("/a", "/a/b")).toBeNull();
  });

  it("folds case, and reads the firmlink and /private spellings of both sides", () => {
    expect(relativeTo("/A/B/c", "/a/b")).toBe("c");
    expect(relativeTo("/System/Volumes/Data/a/b/c", "/a/b")).toBe("c");
    expect(relativeTo("/System/Volumes/Data", "/a")).toBeNull();
    expect(relativeTo("/tmp/x/y", "/private/tmp/x")).toBe("y");
    expect(relativeTo("/private/var/x/y", "/var/x")).toBe("y");
    expect(relativeTo("/private/tmp/x/y", "/tmp/x")).toBe("y");
  });

  it("keeps the remainder's own spelling", () => {
    expect(relativeTo("/A/B/Scripts/Harness", "/a/b")).toBe("Scripts/Harness");
  });
});
