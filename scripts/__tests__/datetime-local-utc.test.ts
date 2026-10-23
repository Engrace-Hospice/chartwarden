// #595 regression guard: `new Date().toISOString().slice(0, 16)` is the UTC wall clock; fed to a datetime-local
// field it shifts the instant by the viewer's UTC offset. Use `nowLocalInput` / `toLocalInput` from @chartwarden/ui
// (#621: the hand-rolled offset-shift copies are gone, so any `toISOString().slice(0, 16)` in UI source is a finding).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const UI_SITES = ["apps/web/src", "apps/portal/src", "apps/admin/src", "packages/ui/src"];

function gitGrep(pattern: string, paths: readonly string[]) {
  const r = spawnSync("git", ["grep", "-nE", pattern, "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(r.error).toBeUndefined();
  expect(r.status === 0 || r.status === 1, r.stderr).toBe(true); // 128 = git failed, not "no match"
  return r;
}

describe("no UTC wall-clock default for datetime-local (#595)", () => {
  it("the scan reaches the app sources (positive control)", () => {
    expect(gitGrep("useState", UI_SITES).status).toBe(0);
  });

  it("no UI source builds a datetime-local value from toISOString().slice(0, 16)", () => {
    const r = gitGrep("toISOString\\(\\)\\.slice\\(0, ?16\\)", [
      ...UI_SITES,
      ":(exclude)packages/ui/src/core/dates.ts",
      ":(exclude)packages/ui/src/core/__tests__/dates.test.ts",
    ]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
  });
});
