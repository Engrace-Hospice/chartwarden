/**
 * Wave 7, T5, CR5-11 (round-5 code review, LOW): `bunx vitest run apps/backend/__tests__/care-plan-conformance.live`
 * and `bunx vitest run live` allowed, because the live-suite rule wanted `.live.test` (or `.live.<wildcard>`) in the
 * words and vitest filters by SUBSTRING of the file path: both run live suites, which `DROP ROLE chartwarden_app`. The
 * classifier is now handed the live suite files the tree holds (`live-suite-files.ts`, listed once and only when a
 * runner is started with a filter) and asks when a filter is a substring of one of them. Without the listing (a caller
 * that cannot list) the old, narrower rule stands. `classifyBash` is pure: the listing is injected.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listLiveSuiteFiles } from "../harness/live-suite-files";
import { classifyBash } from "../harness/patterns";
import { bashPayload, guardCopy, removeCopies, runClaude } from "./_guard-copy";

afterAll(removeCopies);

const LIVE = [
  "apps/backend/__tests__/care-plan-conformance.live.test.ts",
  "apps/backend/__tests__/m4-orders.live.test.ts",
  "apps/backend/src/bootstrap/jobs/__tests__/relay.live.test.ts",
  "packages/db/migrations/__tests__/1100-x.live.test.ts",
];
const ctx = (files: readonly string[] | undefined) => ({
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: () => false,
  ...(files === undefined ? {} : { liveSuiteFiles: () => files }),
});
const d = (cmd: string, files: readonly string[] = LIVE) => classifyBash(cmd, ctx(files)).decision;
/** A caller that cannot list the tree. */
const dNoListing = (cmd: string) => classifyBash(cmd, ctx(undefined)).decision;

describe("a runner started with a filter that names a live suite asks", () => {
  it.each([
    "bunx vitest run apps/backend/__tests__/care-plan-conformance.live",
    "bunx vitest run care-plan-conformance",
    "bunx vitest run live",
    "bunx vitest run care-plan",
    "bunx vitest care-plan-conformance",
    "bunx vitest run m4-orders",
    "bunx vitest run --reporter=dot m4-orders",
    "bunx vitest run -t something m4-orders",
    "bunx vitest run scripts/__tests__/harness-foo apps/backend/__tests__/m4-",
    "npx vitest run care-plan-conformance",
    "bun x vitest run relay",
    "bun run test -- care-plan-conformance",
    "npm test -- m4-orders",
    "yarn test relay",
    "node node_modules/.bin/vitest run care-plan",
    "vitest run 1100-x",
    "bun test care-plan-conformance",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "bunx vitest run scripts/__tests__/harness-patterns.test.ts",
    "bunx vitest run scripts/__tests__/harness-",
    // A directory filter runs the whole directory (live suites among them): a stated limit, 0.34% of real commands if asked.
    "bunx vitest run scripts/__tests__",
    "bunx vitest run apps/backend/__tests__",
    "bunx vitest run packages/db",
    "bunx vitest run apps/backend/src/bootstrap",
    "bunx vitest run zzz-no-such-file",
    "bunx vitest run apps/web/src/components",
    "bunx vitest run -t live scripts/__tests__/harness-patterns",
    "bunx vitest run --testNamePattern=live scripts/__tests__/harness-patterns",
    "bunx vitest run --reporter live scripts/__tests__/harness-patterns",
    "bunx vitest run",
    "bunx biome check care-plan-conformance",
    "bunx tsc --noEmit care-plan",
    "rg care-plan-conformance apps",
    "cat apps/backend/__tests__/care-plan-conformance.live.test.ts",
    "bun run lint",
  ])("an everyday neighbour stays allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("the old rule stands when the caller cannot list the tree", () => {
    expect(dNoListing("bunx vitest run care-plan-conformance")).toBe("allow");
    expect(dNoListing("bunx vitest run care-plan-conformance.live.test.ts")).toBe("ask");
  });

  it("the listing is asked for only when a runner has a filter", () => {
    let calls = 0;
    const counting = {
      ...ctx(LIVE),
      liveSuiteFiles: () => {
        calls++;
        return LIVE;
      },
    };
    classifyBash("git status; bunx biome check x; bunx vitest run", counting);
    expect(calls).toBe(0);
    classifyBash("bunx vitest run care-plan; bunx vitest run m4-orders", counting);
    expect(calls).toBe(1);
  });
});

describe("listLiveSuiteFiles reads the tree", () => {
  it("lists live suite files under apps, packages and scripts, and skips what is not source", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-live-suites-"));
    try {
      for (const rel of [
        "apps/backend/__tests__/a.live.test.ts",
        "apps/backend/__tests__/b.test.ts",
        "apps/backend/src/x/__tests__/c.live.test.ts",
        "packages/db/migrations/__tests__/d.live.test.ts",
        "scripts/__tests__/e.live.test.ts",
        "apps/backend/node_modules/pkg/f.live.test.ts",
        "apps/web/dist/g.live.test.ts",
      ]) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), "");
      }
      expect(listLiveSuiteFiles(root).files.slice().sort()).toEqual(
        [
          "apps/backend/__tests__/a.live.test.ts",
          "apps/backend/src/x/__tests__/c.live.test.ts",
          "packages/db/migrations/__tests__/d.live.test.ts",
          "scripts/__tests__/e.live.test.ts",
        ].sort(),
      );
      expect(listLiveSuiteFiles(join(root, "missing"))).toEqual({ files: [], complete: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the real hook lists the tree it runs in", () => {
  it("asks for a substring filter of a live suite that exists in the tree, and allows one that does not", () => {
    const dir = guardCopy();
    mkdirSync(join(dir, "apps/backend/__tests__"), { recursive: true });
    writeFileSync(join(dir, "apps/backend/__tests__/care-plan-conformance.live.test.ts"), "");
    expect(runClaude(dir, bashPayload("bunx vitest run care-plan-conformance")).decision).toBe(
      "ask",
    );
    expect(runClaude(dir, bashPayload("bunx vitest run no-such-suite")).decision).toBe("allow");
  });
});
