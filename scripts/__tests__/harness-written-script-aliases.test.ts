/**
 * Wave 6, CR-M1 (round-4 code review): a script written by one command line and run by the same line is matched by
 * path, and the match folded aliases only against the repo root and the home directory. `cat > /tmp/x.sh <<'EOF'
 * rm scripts/harness/io.ts EOF; bash /private/tmp/x.sh` wrote one spelling and ran another and allowed, where the
 * base asked about any heredoc body: `/tmp` is `/private/tmp`, `/var` is `/private/var`, `/etc` is `/private/etc`,
 * `/System/Volumes/Data` is the boot volume's firmlink, and the file system ignores case. Both keys now go through
 * `path-alias.ts` `fold()`. The same spelling both times asked already and still does.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
// Absolute: a relative path would be judged from the directory the script runs in (`cd /tmp && bash x.sh` is not the repo).
const BAD = "rm /repo/scripts/harness/io.ts";
/** A script written with a heredoc, then run by `how`. */
const writeThenRun = (written: string, how: string) =>
  `cat > ${written} <<'EOF'\n${BAD}\nEOF\n${how}`;

describe("a written script is found under any spelling of its path", () => {
  it.each([
    // Same spelling: asked at the base.
    ["/tmp/x.sh", "bash /tmp/x.sh"],
    // The reviewer's repros.
    ["/tmp/x.sh", "bash /private/tmp/x.sh"],
    ["/private/tmp/x.sh", "bash /tmp/x.sh"],
    ["/tmp/x.sh", "bash /TMP/x.sh"],
    ["/tmp/x.sh", "bash /System/Volumes/Data/private/tmp/x.sh"],
    ["/var/tmp/x.sh", "bash /private/var/tmp/x.sh"],
    ["/private/var/tmp/x.sh", "bash /var/tmp/x.sh"],
    ["/etc/x.sh", "bash /private/etc/x.sh"],
    ["/tmp/x.sh", "cd /private/tmp && bash x.sh"],
    ["/private/tmp/x.sh", "cd /tmp && bash x.sh"],
    ["/tmp/x.sh", "sh /tmp//x.sh"],
    ["/tmp/x.sh", "source /private/tmp/x.sh"],
    ["/tmp/x.sh", "chmod +x /tmp/x.sh && /private/tmp/x.sh"],
    ["/tmp/X.sh", "bash /tmp/x.SH"],
  ])("written to %s, run as `%s`", (written, how) => {
    expect(d(writeThenRun(written, how)), `${written} -> ${how}`).not.toBe("allow");
  });

  it.each([
    ["/tmp/x.sh", "bash /tmp/y.sh"],
    ["/tmp/x.sh", "bash /private/tmp/y.sh"],
    ["/tmp/x.sh", "bash /tmp/other/x.sh"],
    ["/tmp/x.sh", "bash /var/tmp/x.sh"],
  ])("written to %s, a different file run as `%s`, is not the written script", (written, how) => {
    // The text is harmless to run: nothing written there is run, so the line is as allowed as it was.
    expect(d(`cat > ${written} <<'EOF'\necho hi\nEOF\n${how}`)).toBe("allow");
    // And a script that is a different file does not borrow the bad text.
    expect(d(writeThenRun(written, how)), `${written} -> ${how}`).toBe("allow");
  });

  it("a script that only echoes is allowed under every spelling", () => {
    for (const how of ["bash /tmp/x.sh", "bash /private/tmp/x.sh", "bash /TMP/x.sh"]) {
      expect(d(`cat > /tmp/x.sh <<'EOF'\necho hi\nEOF\n${how}`), how).toBe("allow");
    }
  });
});
