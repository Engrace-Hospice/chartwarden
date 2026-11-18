/**
 * Wave 3 (fixer W3b), the surviving mutants of the code review and ADV-M12. A whole-tree read, and a write, are
 * judged from EVERY directory the command may be running in; a `cd` to a path too long to track leaves the
 * directory unknown; a recursive search from a Codex workdir that holds a live env file asks. No test failed when
 * the guard looked at only the first candidate directory, or when the length cap on a tracked directory went.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const FILES = new Set(["/repo/apps/backend/.env", "/repo/deploy/production/.env.production"]);
const exists = (p: string) => FILES.has(p.startsWith("/") ? p : `/repo/${p}`);
const at = (cwd: string) => ({ root: "/repo", home: "/Users/dev", cwd, exists });
const d = (cmd: string, cwd = "/repo") => classifyBash(cmd, at(cwd)).decision;

describe("a whole-tree read is judged from each directory the command may run in, not the first", () => {
  // The start directory is the first candidate; the `;` keeps it, and adds the `cd` target after it. Only the SECOND
  // candidate is the root, so a guard that looked at the first alone would allow every one of these.
  it.each([
    "cd ../.. ; grep -r PASS .",
    "cd ../.. ; rg -u PASS",
    "cd ../.. ; tar c .",
    "cd ../.. ; zip -r /tmp/x.zip .",
    "cd /repo ; grep -r PASS .",
    "(cd /repo) ; grep -rn PASS",
    "true || cd /repo && grep -r PASS .",
  ])("asks before %s from apps/web", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd, "/repo/apps/web"));
  });

  it("allows the same search from a directory with no live env file, after a cd that stays below it", () => {
    expect(d("cd src ; grep -rn PASS .", "/repo/apps/web")).toBe("allow");
    expect(d("grep -rn PASS .", "/repo/apps/web")).toBe("allow");
  });
});

describe("a cd to a path too long to track leaves the directory unknown", () => {
  const long = `${"d/".repeat(600)}scripts`;

  it("asks before a relative write that would land in a protected directory from it", () => {
    // `scripts/harness` is protected only at the root; the shell may be anywhere once the path is not tracked.
    expect(d(`cd ${long} && echo x > harness/p`)).toBe("ask");
  });

  it("still tracks a path of ordinary length", () => {
    expect(d("cd d/d/scripts && echo x > harness/p")).toBe("allow");
    expect(d("cd scripts && echo x > harness/p")).toBe("ask");
  });
});

describe("a recursive search from a Codex workdir that holds a live env file asks (ADV-M12)", () => {
  it.each(["grep -r .", "grep -rn PASS", "rg -u PASS", "rg --hidden PASS .", "tar c ."])(
    "asks before %s in deploy/production",
    (cmd) => {
      expect(["ask", "deny"], cmd).toContain(d(cmd, "/repo/deploy/production"));
    },
  );

  it("asks in apps/backend, and allows in a directory that holds none", () => {
    expect(d("grep -r PASS .", "/repo/apps/backend")).toBe("ask");
    expect(d("grep -r PASS .", "/repo/apps/web")).toBe("allow");
    expect(d("grep -r PASS .", "/repo/docs")).toBe("allow");
  });
});
