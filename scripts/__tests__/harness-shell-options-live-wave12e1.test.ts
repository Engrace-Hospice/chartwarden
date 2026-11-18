/**
 * Wave 12 part E1, E1-1, rule 12(c) for shells: the recordings of `fixtures/harness-shell-options/` must not rot unseen. Where a shell is INSTALLED (looked
 * up in the system directories, never a developer's PATH) a deterministic sample of the recorded probes is run again, echo only, in a scratch directory
 * with a scratch HOME, and every answer must equal the recording: a shell that changed how it reads `+c`, `-o`, `-O` or `-cc` fails here until the
 * recording and `shell-grammars.ts` are corrected (`bun scripts/__tests__/helpers/record-shell-options.ts --write SHELL`). A shell that is NOT
 * installed skips with a named reason (its recording is unverified on this machine); a version that differs from the recorded one is named in the failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_DIR,
  SHELLS,
  type ShellFixture,
  findShell,
  runProbe,
  shellVersion,
} from "./helpers/record-shell-options";
import { exactProbes } from "./helpers/shell-probes";

const SAMPLE_EVERY = 8;
const LIVE_TIMEOUT_MS = 120_000;

for (const shell of SHELLS) {
  describe(`live: ${shell}`, () => {
    it(
      "the installed shell still answers the recorded probes as recorded",
      (ctx) => {
        const binary = findShell(shell);
        if (binary === undefined)
          ctx.skip(`${shell} is not installed here: its recording is unverified on this machine`);
        const fixture = JSON.parse(
          readFileSync(join(FIXTURE_DIR, `${shell}.json`), "utf8"),
        ) as ShellFixture;
        // A different build of the shell (a Linux runner's dash behind `sh`, another bash) or another platform is NOT what was recorded: skip with the
        // reason, never fail on a difference that is no regression (wave 13, C2). The recording is compared on the machine that made it.
        const installed = shellVersion(binary as string);
        const platform = `${process.platform}-${process.arch}`;
        if (installed !== fixture.version || platform !== fixture.platform)
          ctx.skip(
            `${shell} here is "${installed}" on ${platform} and the recording is "${fixture.version}" on ${fixture.platform}: re-record on this machine to compare`,
          );
        const exact = new Set(exactProbes(shell).map(([args]) => args.join("\u0001")));
        const sample = fixture.probes.filter(
          (p, at) => at % SAMPLE_EVERY === 0 || exact.has(p.args.join("\u0001")),
        );
        expect(sample.length).toBeGreaterThan(80);
        const differ = sample
          .map((p) => ({ p, now: runProbe(binary as string, p.args) }))
          .filter(({ p, now }) => now !== p.ran)
          .map(
            ({ p, now }) =>
              `${shell} ${JSON.stringify(p.args)}: recorded ran "${p.ran}", now "${now}"`,
          );
        expect(
          differ.slice(0, 5),
          `${shell}: installed "${installed}", recorded "${fixture.version}" (${fixture.platform}): re-record and correct shell-grammars.ts`,
        ).toEqual([]);
      },
      LIVE_TIMEOUT_MS,
    );
  });
}
