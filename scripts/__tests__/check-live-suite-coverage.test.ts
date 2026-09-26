// #41 — the live-suite CI coverage gate.
//
// The gate used to recognise suites by NAME, with a pattern whose middle segment allowed hyphens but
// not colons. `test:m6:t3:write:live` has two middle segments, so it never matched: 24 tests / 97
// assertions over M6's write lifecycles had no CI runner, and neither did the 18-test Playwright
// suite with the repo's only axe-core WCAG scans. These tests pin the shapes that hole was made of.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  invokedInCi,
  liveFiles,
  liveScripts,
  namedByAScript,
  run,
} from "../check-live-suite-coverage";

const names = (scripts: Record<string, string>) => liveScripts(scripts).map((s) => s.name);

describe("detection derives from the command, not the script name", () => {
  it("sees a multi-segment name the old pattern could not — the #41 regression", () => {
    // `m\d+:[a-z0-9-]*:live` cannot match `m6:t3:write:live`. This is the exact miss.
    expect(
      names({ "test:m6:t3:write:live": "vitest run apps/x/m6-election-cti-write.live.test.ts" }),
    ).toEqual(["test:m6:t3:write:live"]);
  });

  it("sees a suite whose name follows no convention at all", () => {
    expect(
      names({ "check:something": "vitest run packages/db/__tests__/whatever.live.test.ts" }),
    ).toEqual(["check:something"]);
  });

  it("sees the `-live.test.ts` spelling as well as `.live.test.ts`", () => {
    expect(
      names({ a: "vitest run apps/backend/__tests__/gap-048-dsar-export-live.test.ts" }),
    ).toEqual(["a"]);
  });

  it("sees a Playwright suite", () => {
    expect(names({ "test:e2e": "playwright test --config=e2e/playwright.config.ts" })).toEqual([
      "test:e2e",
    ]);
  });

  it("excludes the interactive --ui mode, which can never be a CI job", () => {
    expect(
      names({ "test:e2e:ui": "playwright test --config=e2e/playwright.config.ts --ui" }),
    ).toEqual([]);
  });

  it("ignores ordinary scripts", () => {
    expect(names({ build: "tsc -b", test: "vitest run", lint: "biome check" })).toEqual([]);
  });
});

describe("the ci.yml invocation check", () => {
  it("matches a script a job runs", () => {
    expect(invokedInCi("test:m6:read:live", "        run: bun run test:m6:read:live\n")).toBe(true);
  });

  it("does not let a longer sibling cover a shorter name", () => {
    // `test:rls:live` must NOT look covered by `test:rls:live:m6` — the word-boundary rule.
    expect(invokedInCi("test:rls:live", 'script: "test:rls:live:m6"')).toBe(false);
  });

  it("matches a name inside a space-separated multi-suite matrix row", () => {
    const ci = 'scripts: "test:m6:read:live test:m6:t3:write:live"';
    expect(invokedInCi("test:m6:t3:write:live", ci)).toBe(true);
  });
});

describe("the repo baseline", () => {
  const report = run();

  it("has every live suite wired into a ci.yml job or explicitly deferred", () => {
    expect(report.unwired).toEqual([]);
  });

  it("carries no stale deferral — a deferred suite that CI now runs must lose its entry", () => {
    expect(report.staleDeferrals).toEqual([]);
  });

  it("still detects the full corpus, so a passing gate is not a vacuous one", () => {
    // If LIVE_COMMAND ever stops matching, every assertion above passes over an empty set. The
    // corpus is ~90 scripts; this is the guard on the guard.
    expect(report.live.length).toBeGreaterThan(80);
  });

  it("runs the three M6 lifecycle suites that #41 found unwired", () => {
    for (const name of [
      "test:m6:t3:write:live",
      "test:m6:t4:write:live",
      "test:m6:t5:write:live",
    ]) {
      expect(report.unwired, `${name} must have a CI runner`).not.toContain(name);
      expect(report.deferred, `${name} passes today — it must be RUN, not deferred`).not.toContain(
        name,
      );
    }
  });

  it("runs the Redis-gated suite, which no Postgres job could have covered", () => {
    expect(report.unwired).not.toContain("test:rate-limit-store:live");
    expect(report.deferred).not.toContain("test:rate-limit-store:live");
  });

  it("runs the browser suite — six axe-core WCAG scans included", () => {
    // #41 wired the deferral so an unrunnable suite stayed distinguishable from a forgotten one;
    // #56 and #39 made it runnable and this is the other half: it must now be RUN, not registered.
    expect(report.unwired).not.toContain("test:e2e");
    expect(report.deferred).not.toContain("test:e2e");
  });

  it("defers nothing today, and says so out loud", () => {
    // Not a formality. A deferral that outlives its blocker is a live suite nothing runs wearing a
    // reason that has stopped being true — the same silence the gate exists to break, one level up.
    expect(report.deferred).toEqual([]);
  });
});

describe("the deferral rule itself", () => {
  // DEFERRED is empty now that `test:e2e` is wired, so the repo baseline can no longer exercise
  // either branch. These do, against the real package.json/ci.yml with an injected map.
  it("excuses an unwired suite only while an entry explains it", () => {
    const unwiredName = "test:__not_in_ci__:live";
    const withEntry = run(undefined, { [unwiredName]: "blocked on a fictional issue" });
    expect(withEntry.deferred).toEqual([unwiredName]);
    // The name is fictional, so it is in neither package.json nor ci.yml: the map is consulted only
    // for scripts that exist, which is why it cannot be used to excuse something into existence.
    // Asserted on THIS name rather than on an empty list, so the case stays about the deferral rule
    // instead of doubling as a second baseline check that fails for an unrelated reason.
    expect(withEntry.unwired).not.toContain(unwiredName);
  });

  it("reports a deferral as STALE once CI runs the script", () => {
    // `test:e2e` is invoked by the `e2e` job now, so deferring it is exactly the obsolete entry the
    // gate must refuse — a suite would look excused while it was running and passing all along.
    const stale = run(undefined, { "test:e2e": "a reason that stopped being true" });
    expect(stale.staleDeferrals).toEqual(["test:e2e"]);
  });
});

describe("the FILE direction — does every suite have a script at all (#59)", () => {
  const report = run();

  it("finds the suite files on disk, so the check below is not vacuous", () => {
    // If the walk breaks, `unscripted` is empty and every assertion here passes over nothing —
    // the identical failure mode the script-side guard exists for, one direction over.
    expect(report.files.length).toBeGreaterThan(100);
  });

  it("has a package.json script for every live suite file", () => {
    // 29 files had none. Nothing ran them: not CI, not a git hook, and not `bun run test`, which
    // never sets WARDENX_TEST_DATABASE_URL — so `skipIf` reported them SKIPPED, never failed.
    expect(report.unscripted).toEqual([]);
  });

  it("has a script for the suite that was actually RED while unscripted", () => {
    // m6-abac-scope-resolver (GAP-011) was green on `main` and red on the F-017 stack, broken by a
    // fail-closed guard added in another module. It is the reason this direction is a gate and not
    // a note: 28 of the 29 passing proved nothing about the 29th.
    expect(report.unscripted).not.toContain(
      "apps/backend/__tests__/m6-abac-scope-resolver.live.test.ts",
    );
  });

  it("matches BOTH suffixes the command matcher already accepts", () => {
    // `.live.test.ts` and `-live.test.ts` are both in use (7 files use the hyphen form). A walk that
    // saw only one would silently under-report — which is exactly how the first count of this
    // finding came out at 22 instead of 29.
    const names = liveFiles(join(import.meta.dirname, "..", "..")).map((f) => f.split("/").pop());
    expect(names).toContain("m25-835-ingestion.live.test.ts");
    expect(names).toContain("gap-096-alert-emitter-live.test.ts");
  });

  it("matches a command that names the file through any relative path", () => {
    const file = "apps/backend/__tests__/m25-835-ingestion.live.test.ts";
    expect(
      namedByAScript(file, ["vitest run apps/backend/__tests__/m25-835-ingestion.live.test.ts"]),
    ).toBe(true);
    expect(namedByAScript(file, ["vitest run ./m25-835-ingestion.live.test.ts"])).toBe(true);
    expect(namedByAScript(file, ["vitest run apps/backend/__tests__/m25-remit.live.test.ts"])).toBe(
      false,
    );
  });
});
