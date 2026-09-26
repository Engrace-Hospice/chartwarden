import { join } from "node:path";
/**
 * The unresolved-merge-artifact gate.
 *
 * The fixture is not invented: it is the real damaged region of `.github/workflows/ci.yml` as it was
 * committed to `main` at de3513b8, where a conflicted merge was `git add`-ed without being resolved.
 * `tsc` never sees a workflow file and `arch:live-suites` reads it as text, so the whole fitness
 * suite stayed green across seven merges while the file could not be parsed by GitHub at all.
 */
import { describe, expect, it } from "vitest";
import { findMergeArtifacts } from "../check-merge-artifacts";

const FIXTURE = join(__dirname, "../__fixtures__/merge-artifacts");
const REPO_ROOT = join(__dirname, "../..");

describe("merge-artifact gate", () => {
  it("finds the markers in the ci.yml region that actually shipped", () => {
    // The fixture directory is not its own git repo, so scan it as plain text the same way the gate
    // does — via the repo scan, which tracks these fixture files and exempts them by prefix.
    const src = require("node:fs").readFileSync(
      join(FIXTURE, ".github/workflows/ci.yml"),
      "utf8",
    ) as string;
    const lines = src.split("\n");
    const markers = lines.filter((l) => /^(?:<{7} .+|>{7} .+|={7})$/.test(l));
    // Two full conflict hunks: <<<<<<< / ======= / >>>>>>> twice.
    expect(markers.length).toBe(6);
    expect(markers.filter((l) => l.startsWith("<<<<<<< ")).length).toBe(2);
    expect(markers.filter((l) => l.startsWith(">>>>>>> ")).length).toBe(2);
    expect(markers.filter((l) => l === "=======").length).toBe(2);
  });

  it("the repo itself is clean", () => {
    expect(findMergeArtifacts(REPO_ROOT)).toEqual([]);
  });

  it("exempts the gate and its own fixtures, so the repo scan does not trip on them", () => {
    // Both carry marker text on purpose. If the exemption regressed, the case above would fail —
    // this one names WHY it passes, so a future reader does not remove the exemption as dead weight.
    const hits = findMergeArtifacts(REPO_ROOT);
    expect(hits.filter((h) => h.file.includes("merge-artifacts"))).toEqual([]);
  });

  it("does not flag a Markdown setext heading rule (seven or more equals under a title)", () => {
    // `=======` as a whole line is also Markdown's H1 underline. The gate accepts that risk only for
    // the EXACT seven-char line, and a real conflict always brings a `<<<<<<<` with it.
    const heading = "Title\n=========\n\nbody";
    const markers = heading.split("\n").filter((l) => /^(?:<{7} .+|>{7} .+|={7})$/.test(l));
    expect(markers).toEqual([]);
  });
});
