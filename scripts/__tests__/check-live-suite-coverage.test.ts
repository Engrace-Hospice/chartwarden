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

  it("defers only the admin/portal browser smoke (#852), and says so out loud", () => {
    // Not a formality. A deferral that outlives its blocker is a live suite nothing runs wearing a
    // reason that has stopped being true — the same silence the gate exists to break, one level up.
    // The list is pinned so a NEW deferral needs a deliberate edit here; retire this entry by
    // starting apps/admin + apps/portal in the e2e job, then make this list empty again.
    expect(report.deferred).toEqual(["test:e2e:apps"]);
  });
});
