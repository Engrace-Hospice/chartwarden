// #595 regression guard: `toISOString().slice(0, 16)` is the UTC wall clock; fed to a datetime-local field (or
// read back from one) it shifts the instant by the viewer's UTC offset. Use `nowLocalInput` / `isoToLocalInput`
// from @chartwarden/ui.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("no UTC wall-clock slicing in app code (#595)", () => {
  it("apps/ and packages/ui never slice an ISO string to 16 characters", () => {
    const r = spawnSync(
      "git",
      [
        "grep",
        "-nE",
        "toISOString\\(\\)\\.slice\\(0, ?16\\)",
        "--",
        "apps/*/src",
        "packages/ui/src",
        ":(exclude)packages/ui/src/core/dates.ts",
        ":(exclude)packages/ui/src/core/__tests__/dates.test.ts",
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1); // 1 = no match
    expect(r.stdout).toBe("");
  });
});
