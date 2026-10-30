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
    // Fixed date: waiver expiry is enforced by `arch:release-gate` (wall clock), not by every unit-test run.
    expect(releaseGateProblems(real, new Date("2026-10-30T00:00:00Z"))).toEqual([]);
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

  const STEPS = "    steps:\n      - run: bun run typecheck\n      - run: bun run lint\n";
  const QUALITY = `  quality:\n    needs: debounce\n    runs-on: x\n${STEPS}`;
  const RELEASE_IF = "    if: ${{ !cancelled() && needs.quality.result == 'success' }}\n";
  const RELEASE = `  release:\n    needs: [debounce, quality]\n${RELEASE_IF}`;
  const NO_CI = `${DEBOUNCE}${QUALITY}${RELEASE}${DEPLOY}`;
  const WAIVER = "# release-gate: ci-waived until 2099-01-01 — owner decision, test\n";

  it("fails a waiver with no expiry date", () => {
    const y = `# release-gate: ci-waived — owner decision, test\n${wf(NO_CI)}`;
    expect(releaseGateProblems(y)).toEqual([
      "the CI waiver has no `until YYYY-MM-DD` expiry (a waiver must be time-boxed)",
    ]);
  });

  it("does not accept an `until <date>` buried in the waiver reason as the expiry", () => {
    const y = `# release-gate: ci-waived — restore after audit, until 2099-01-01\n${wf(NO_CI)}`;
    expect(releaseGateProblems(y)).toEqual([
      "the CI waiver has no `until YYYY-MM-DD` expiry (a waiver must be time-boxed)",
    ]);
  });

  it("fails a waiver whose expiry has passed, and passes on the expiry day itself", () => {
    const y = `# release-gate: ci-waived until 2026-11-29 — owner decision, test\n${wf(NO_CI)}`;
    expect(releaseGateProblems(y, new Date("2026-11-29T23:59:59Z"))).toEqual([]);
    expect(releaseGateProblems(y, new Date("2026-11-30T00:00:00Z"))).toEqual([
      "the CI waiver expired on 2026-11-29: restore `verify` or renew the waiver deliberately",
    ]);
  });

  it("passes a recorded waiver when release still needs the quality job", () => {
    expect(releaseGateProblems(WAIVER + wf(NO_CI))).toEqual([]);
  });

  it("fails a waiver under which release no longer needs the quality job", () => {
    const y = WAIVER + wf(`${DEBOUNCE}${QUALITY}  release:\n    needs: debounce\n${DEPLOY}`);
    expect(releaseGateProblems(y)).toEqual([
      "`release` has a CI waiver but does not need the `quality` job (typecheck and lint)",
    ]);
  });

  it("still requires deploy to need release under a waiver", () => {
    const y = WAIVER + wf(`${DEBOUNCE}${QUALITY}${RELEASE}  deploy:\n    runs-on: x\n`);
    expect(releaseGateProblems(y)).toEqual(["`deploy` does not need `release`"]);
  });

  it("fails a waiver whose quality job lost its lint step or is disabled", () => {
    const noLint = QUALITY.replace("      - run: bun run lint\n", "");
    expect(releaseGateProblems(WAIVER + wf(`${DEBOUNCE}${noLint}${RELEASE}${DEPLOY}`))).toEqual([
      "the `quality` job does not run `bun run lint`",
    ]);
    const off = QUALITY.replace("    runs-on: x\n", "    if: false\n    runs-on: x\n");
    expect(releaseGateProblems(WAIVER + wf(`${DEBOUNCE}${off}${RELEASE}${DEPLOY}`))).toEqual([
      "the `quality` job is disabled by a constant `if:`",
    ]);
  });

  it("fails a waiver whose release if: ignores the quality result", () => {
    const rel = "  release:\n    needs: [debounce, quality]\n    if: always()\n";
    expect(releaseGateProblems(WAIVER + wf(`${DEBOUNCE}${QUALITY}${rel}${DEPLOY}`))).toEqual([
      "`release` has a CI waiver but its `if:` does not require needs.quality.result == 'success'",
    ]);
  });

  it("ignores a waiver line buried inside a script block", () => {
    const y = wf(`${DEBOUNCE}${QUALITY}${RELEASE}${DEPLOY}`).replace(
      "      - run: bun run lint\n",
      "      - run: |\n          # release-gate: ci-waived — sneaky\n          bun run lint\n",
    );
    expect(releaseGateProblems(y)).not.toEqual([]);
  });

  it("ignores a waiver with no reason", () => {
    expect(releaseGateProblems(`# release-gate: ci-waived\n${wf(NO_CI)}`)).not.toEqual([]);
  });
});
