/**
 * `scripts/` must stay inside the type-checked project graph.
 *
 * It was outside it for the life of the repo (#34): the root `tsconfig.json` has `"files": []` and
 * 53 references, none of them `scripts/`, and no referenced project's `include` covered it — so
 * `tsc -b` never compiled 71 files and ~24.7k lines. That tree is not incidental: it is every
 * architecture gate, every report generator, and `openapi/enrichments.ts`, which defines every
 * request/response contract in `docs/api/openapi.json`.
 *
 * The cost was not hypothetical. `bun run typecheck` exited 0 while `enrichments.ts` contained a
 * `TS2300: Duplicate identifier` — the shipped defect filed as #31, in which the cross-tenant
 * platform export-job list published the tenant-scoped contract, dropping `organizationId` and every
 * SEC-052 hold field. TypeScript had the answer and was never asked.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p: string) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8"));

describe("scripts/ is type-checked", () => {
  it("has its own tsconfig, extending the shared base", () => {
    const cfg = readJson("scripts/tsconfig.json") as { extends?: string };
    expect(cfg.extends).toBe("../tsconfig.base.json");
  });

  it("is referenced from the root tsconfig, so `tsc -b` reaches it", () => {
    const root = readJson("tsconfig.json") as { references?: { path: string }[] };
    const paths = (root.references ?? []).map((r) => r.path);
    expect(
      paths,
      "scripts/ must be a project reference — without it `tsc -b` silently skips 24.7k lines (#34)",
    ).toContain("./scripts");
  });

  it("does not weaken strictness for this tree", () => {
    // The issue is explicit that a loosened `strict` or a blanket `@ts-nocheck` would defeat the
    // point. `scripts/tsconfig.json` may add libs and paths; it may not turn checking down.
    const cfg = readJson("scripts/tsconfig.json") as {
      compilerOptions?: Record<string, unknown>;
    };
    const opts = cfg.compilerOptions ?? {};
    for (const key of [
      "strict",
      "noUncheckedIndexedAccess",
      "noImplicitAny",
      "skipDefaultLibCheck",
    ]) {
      expect(opts[key], `scripts/tsconfig.json must not override \`${key}\``).toBeUndefined();
    }
  });

  it("CI runs typecheck as its own visible step", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(
      ci,
      "type safety was enforced only as a side effect of `bun run build`, which is what made the " +
        "scripts/ exclusion invisible (#34)",
    ).toContain("bun run typecheck");
  });

  it("no file in the tree opts out with @ts-nocheck", () => {
    // The cheap way to make this gate green again is to disable it per file. Nothing does today.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const tracked = execFileSync("git", ["ls-files", "scripts", "architecture"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const optedOut = tracked
      // This file names the directive in order to forbid it, so it matches itself. Same
      // self-exemption the merge-artifact gate needs, and for the same reason.
      .filter((f) => f !== "scripts/__tests__/typecheck-coverage.test.ts")
      .filter((f) => readFileSync(join(REPO_ROOT, f), "utf8").includes("@ts-nocheck"));
    expect(optedOut).toEqual([]);
  });
});
