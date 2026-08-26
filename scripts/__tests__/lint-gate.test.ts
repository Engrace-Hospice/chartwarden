/**
 * `bun run lint` must be able to FAIL the build.
 *
 * It could not, for the life of the repo: the CI step carried `continue-on-error: true`, so the gate
 * ran, reported 187 diagnostics, and was discarded on every commit (#33). That is the same shape as
 * #18 (`arch:fitness` short-circuiting) and #16 (deploy not gated on CI) — a check that exists,
 * appears to run, and cannot fail anything.
 *
 * It matters more than a style gate normally would: biome is the repo's only automated accessibility
 * enforcement outside the E2E axe scans, and it is what found #31 (a cross-tenant ops route
 * publishing the wrong response contract, via `noRedeclare`) and #32 (four drawers unreachable by
 * keyboard, via `useKeyWithClickEvents`) — both filed only because someone read the discarded output.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** The `build-and-verify` job's block, which is where the lint step lives. */
function buildAndVerifyBlock(): string {
  const start = CI.indexOf("  build-and-verify:");
  expect(start, "build-and-verify job not found in ci.yml").toBeGreaterThan(-1);
  // Up to the next top-level job key (two-space indent, then a name and a colon).
  const rest = CI.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the lint gate is blocking", () => {
  it("ci.yml runs `bun run lint`", () => {
    expect(buildAndVerifyBlock()).toContain("bun run lint");
  });

  it("the lint step carries no continue-on-error", () => {
    const block = buildAndVerifyBlock();
    const lines = block.split("\n");
    const stepIndex = lines.findIndex((l) => l.includes("run: bun run lint"));
    expect(stepIndex).toBeGreaterThan(-1);
    // `continue-on-error` may sit either side of `run:` within the same step, so scan the step: from
    // the preceding `- name:` to the next one.
    let from = stepIndex;
    while (from > 0 && !lines[from]!.trimStart().startsWith("- name:")) from -= 1;
    let to = stepIndex + 1;
    while (to < lines.length && !lines[to]!.trimStart().startsWith("- name:")) to += 1;
    const step = lines.slice(from, to).join("\n");
    expect(
      step,
      "the lint step must be able to fail the build — `continue-on-error: true` makes it advisory " +
        "and it reported 187 discarded diagnostics for the life of the repo (#33)",
    ).not.toMatch(/continue-on-error:\s*true/);
  });

  it("`lint` is still the biome check, not something weakened to pass", () => {
    // A gate can also be neutralised by making the COMMAND trivial. This pins what it runs.
    expect(PKG.scripts.lint).toContain("biome check");
    expect(PKG.scripts.lint).not.toContain("--max-diagnostics");
  });
});
