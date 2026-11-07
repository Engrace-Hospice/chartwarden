import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandSeedChain } from "../db/seed-all";

const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  .scripts as Record<string, string>;

describe("seed-all — db:seed:all without a shell (distroless release image)", () => {
  const steps = expandSeedChain(scripts, "db:seed:all");

  it("expands every step to a direct command, never a package.json script name", () => {
    expect(steps.length).toBe(scripts["db:seed:all"]?.split("&&").length);
    for (const argv of steps) {
      expect(argv[0]).toBe("bun");
      expect(argv.some((t) => t in scripts)).toBe(false);
    }
    expect(steps[0]).toEqual(["bun", "run", "scripts/db/seed.ts"]);
  });

  it("passes `-- args` through to the named script", () => {
    expect(steps).toContainEqual([
      "bun",
      "run",
      "scripts/db/seed-scenario-cop27-api.ts",
      "--apply",
      "--local-credentials",
      "--strict",
    ]);
  });

  it("refuses a step that would need a shell", () => {
    for (const cmd of [
      "bun run x.ts | tee log",
      "bun run x.ts &",
      "bun run *.ts",
      "bun run ~/x.ts",
    ]) {
      expect(() => expandSeedChain({ a: cmd }, "a")).toThrow(/needs a shell/);
    }
    expect(() => expandSeedChain({}, "missing")).toThrow(/no script/);
  });
});
