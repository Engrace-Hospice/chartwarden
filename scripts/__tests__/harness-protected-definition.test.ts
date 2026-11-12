/**
 * Wave 6, CR-M5 (round-4 code review): "protected" had five definitions that disagreed. `PROTECTED_PATH` (the patterns)
 * is the one; the rest derive from it or are held to it here. The gaps the reviewer listed: a bare `CODEOWNERS` was in
 * the patterns and not in `PROTECTED_FRAGMENT` (so inline code that wrote it was not seen), `.gitleaks.toml` was in the
 * patterns and not in `PROTECTED_SAMPLES` (so a wildcard that reaches it was not seen), the find samples were a hand list
 * (now read from the tree: `harness-protected-names.test.ts`), and the Stop gate's `arch:compliance` map had a regular
 * expression of its own that left out `deploy/production`, `.github/workflows`, `bunfig.toml` and the rest.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { PROTECTED_FRAGMENT, PROTECTED_SAMPLES, isProtectedPath } from "../harness/protected-paths";
import { gatesFor } from "../harness/stop-gate";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const squashed = (text: string) => text.replace(/['"`+\\\s]/g, "");
/** What the classifier does with inline code: the text as written, and the text with quotes and spaces squashed out. */
const flagged = (text: string) =>
  PROTECTED_FRAGMENT.test(text) || PROTECTED_FRAGMENT.test(squashed(text));

describe("PROTECTED_FRAGMENT sees the protected files inline code can name", () => {
  it.each([
    "open('CODEOWNERS','w')",
    "open('docs/CODEOWNERS','w')",
    "open('.github/CODEOWNERS','a')",
    "Path('codeowners').write_text('x')",
    "open('.gitleaks.toml','w')",
  ])("flags %s", (text) => {
    expect(flagged(text), text).toBe(true);
  });
  it.each(["open('docs/guide.md')", "open('OWNERS.md')", "print('code owners')"])(
    "leaves %s",
    (text) => {
      expect(flagged(text), text).toBe(false);
    },
  );
  it("inline python that writes CODEOWNERS asks", () => {
    expect(d(`python3 -c "open('CODEOWNERS','w').write('x')"`)).not.toBe("allow");
  });
});

describe("PROTECTED_SAMPLES hold the files a wildcard can reach", () => {
  it("names .gitleaks.toml and a bare CODEOWNERS, and every sample is protected", () => {
    expect(PROTECTED_SAMPLES).toContain(".gitleaks.toml");
    expect(PROTECTED_SAMPLES).toContain("codeowners");
    for (const sample of PROTECTED_SAMPLES) expect(isProtectedPath(sample), sample).toBe(true);
  });
  it.each([
    "git checkout -- '.gitleaks*'",
    "git checkout -- '.gitl*'",
    "git checkout HEAD -- 'CODE*'",
  ])("a pathspec wildcard that reaches the file asks: %s", (cmd) => {
    expect(d(cmd), cmd).not.toBe("allow");
  });
});

describe("the Stop gate runs arch:compliance for every protected path", () => {
  const tracked = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => f !== "" && isProtectedPath(f));

  it("goes over every tracked protected file", () => {
    expect(tracked.length).toBeGreaterThan(100);
    const missed = tracked.filter((f) => !gatesFor([f]).includes("arch:compliance"));
    expect(missed).toEqual([]);
  });
  it("and still runs it for .gitignore, which the gate reads", () => {
    expect(gatesFor([".gitignore"])).toContain("arch:compliance");
  });
  it("and not for an ordinary file", () => {
    expect(gatesFor(["apps/web/src/x.ts"])).not.toContain("arch:compliance");
    expect(gatesFor(["docs/guide.md"])).not.toContain("arch:compliance");
  });
});
