import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runtime Docker build context", () => {
  it("excludes git-ignored operator scratch space", () => {
    const dockerignore = readFileSync(join(process.cwd(), ".dockerignore"), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim());

    expect(dockerignore).toContain("scratchpad/");
  });
});
