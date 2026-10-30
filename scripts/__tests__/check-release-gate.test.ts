// #846 — the release gate: `release` must need the full CI, `deploy` must need `release`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseGateProblems } from "../check-release-gate";

const wf = (jobs: string) => `name: x\non:\n  push:\njobs:\n${jobs}`;
const DEBOUNCE = "  debounce:\n    runs-on: x\n";
const VERIFY = "  verify:\n    needs: debounce\n    uses: ./.github/workflows/ci.yml\n";
const DEPLOY = "  deploy:\n    needs: release\n    runs-on: x\n";

describe("check-release-gate", () => {
  it("passes the real deploy.yml", () => {
    const real = readFileSync(join(__dirname, "../../.github/workflows/deploy.yml"), "utf8");
    expect(releaseGateProblems(real)).toEqual([]);
  });

  it("passes when release needs verify (flow list form)", () => {
    const y = wf(`${DEBOUNCE}${VERIFY}  release:\n    needs: [debounce, verify]\n${DEPLOY}`);
    expect(releaseGateProblems(y)).toEqual([]);
  });

  it("passes when release needs verify (block list form)", () => {
    const y = wf(
      `${DEBOUNCE}${VERIFY}  release:\n    needs:\n      - debounce\n      - verify\n${DEPLOY}`,
    );
    expect(releaseGateProblems(y)).toEqual([]);
  });

  it("fails when verify is commented out and release needs only debounce — the 2026-10-01 shape", () => {
    const commented = VERIFY.split("\n")
      .map((l) => (l ? `  # ${l.trim()}` : l))
      .join("\n");
    const y = wf(
      `${DEBOUNCE}${commented}  release:\n    needs: debounce\n    # needs: verify\n${DEPLOY}`,
    );
    expect(releaseGateProblems(y)).toEqual([
      "`release` does not (transitively) need a job that `uses: ./.github/workflows/ci.yml`",
    ]);
  });

  it("fails when deploy does not need release", () => {
    const y = wf(
      `${DEBOUNCE}${VERIFY}  release:\n    needs: verify\n  deploy:\n    needs: verify\n`,
    );
    expect(releaseGateProblems(y)).toEqual(["`deploy` does not need `release`"]);
  });

  it("passes the real idiom: !cancelled() plus an explicit success check", () => {
    const y = wf(
      `${DEBOUNCE}${VERIFY}  release:\n    needs: [debounce, verify] # gate\n    if: \${{ !cancelled() && needs.verify.result == 'success' }}\n  deploy:\n    needs: release\n    if: \${{ !cancelled() && needs.release.result == 'success' }}\n`,
    );
    expect(releaseGateProblems(y)).toEqual([]);
  });

  it("fails when release's if: runs it regardless of the CI result", () => {
    for (const cond of ["always()", "${{ !cancelled() && needs.debounce.result == 'skipped' }}"]) {
      const y = wf(
        `${DEBOUNCE}${VERIFY}  release:\n    needs: [debounce, verify]\n    if: ${cond}\n${DEPLOY}`,
      );
      expect(releaseGateProblems(y)).toEqual([
        "`release` has an `if:` that does not require the CI job's result == 'success'",
      ]);
    }
  });

  it("fails when deploy's if: does not require release success", () => {
    const y = wf(
      `${DEBOUNCE}${VERIFY}  release:\n    needs: verify\n  deploy:\n    needs: release\n    if: always()\n`,
    );
    expect(releaseGateProblems(y)).toEqual([
      "`deploy` has an `if:` that does not require needs.release.result == 'success'",
    ]);
  });

  it("fails when the needed job calls a different workflow", () => {
    const other = VERIFY.replace("ci.yml", "lint-only.yml");
    const y = wf(`${DEBOUNCE}${other}  release:\n    needs: verify\n${DEPLOY}`);
    expect(releaseGateProblems(y)).toHaveLength(1);
  });

  const NO_CI = `${DEBOUNCE}  release:\n    needs: debounce\n${DEPLOY}`;
  const WAIVER = "# release-gate: ci-waived — owner decision, test\n";

  it("passes a recorded waiver even though release does not need CI", () => {
    expect(releaseGateProblems(WAIVER + wf(NO_CI))).toEqual([]);
  });

  it("still requires deploy to need release under a waiver", () => {
    const y = WAIVER + wf(`${DEBOUNCE}  release:\n    needs: debounce\n  deploy:\n    runs-on: x\n`);
    expect(releaseGateProblems(y)).toEqual(["`deploy` does not need `release`"]);
  });

  it("ignores a waiver with no reason", () => {
    expect(releaseGateProblems(`# release-gate: ci-waived\n${wf(NO_CI)}`)).not.toEqual([]);
  });
});
