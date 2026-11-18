/**
 * Wave 8, T1: which names are package scripts, for `bun run X` (`package-scripts.ts`). A name with a colon is always a
 * script (`arch:fitness`); otherwise the nearest package.json at or above the working directory (and the root's) decides,
 * and a caller that cannot read one gets this repo's usual script names.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPackageScript,
  listPackageScripts,
  setPackageScriptsReader,
} from "../harness/package-scripts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-pkgscripts-"));
});
afterEach(() => {
  setPackageScriptsReader(undefined);
  rmSync(root, { recursive: true, force: true });
});

const pkg = (dir: string, scripts: unknown): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
};

describe("listPackageScripts", () => {
  it("reads the script names of the root package.json", () => {
    pkg(root, { build: "x", "lint:fix": "y" });
    expect([...listPackageScripts(root, root)].sort()).toEqual(["build", "lint:fix"]);
  });

  it("adds the nearest package.json below the root to the root's", () => {
    pkg(root, { build: "x" });
    pkg(join(root, "apps/web"), { dev: "vite" });
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    expect([...listPackageScripts(root, join(root, "apps/web/src"))].sort()).toEqual([
      "build",
      "dev",
    ]);
  });

  it("stops at the nearest package.json that has scripts", () => {
    pkg(join(root, "a"), { one: "1" });
    pkg(join(root, "a/b"), { two: "2" });
    pkg(root, { three: "3" });
    expect([...listPackageScripts(root, join(root, "a/b"))].sort()).toEqual(["three", "two"]);
  });

  it("is empty for a missing, broken or script-less package.json", () => {
    expect(listPackageScripts(root, root).size).toBe(0);
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(listPackageScripts(root, root).size).toBe(0);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: "nope" }));
    expect(listPackageScripts(root, root).size).toBe(0);
    writeFileSync(join(root, "package.json"), "null");
    expect(listPackageScripts(root, root).size).toBe(0);
  });

  it("does not look above the root", () => {
    pkg(root, { inside: "x" });
    expect([...listPackageScripts(join(root, "apps"), join(root, "apps"))]).toEqual([]);
  });
});

describe("isPackageScript", () => {
  it("a name with a colon is always a script", () => {
    setPackageScriptsReader(() => new Set());
    expect(isPackageScript("arch:fitness")).toBe(true);
    expect(isPackageScript("test:m4:care:live")).toBe(true);
  });

  it("asks the reader once and answers from its list", () => {
    let reads = 0;
    setPackageScriptsReader(() => {
      reads++;
      return new Set(["build"]);
    });
    expect(isPackageScript("build")).toBe(true);
    expect(isPackageScript("cp")).toBe(false);
    expect(isPackageScript("rm")).toBe(false);
    expect(reads).toBe(1);
  });

  it("does not read at all for a name with a colon", () => {
    let reads = 0;
    setPackageScriptsReader(() => {
      reads++;
      return new Set();
    });
    isPackageScript("a:b");
    expect(reads).toBe(0);
  });

  it("without a reader the usual script names of this repo are the list", () => {
    setPackageScriptsReader(undefined);
    for (const name of ["test", "build", "lint", "typecheck", "dev"]) {
      expect(isPackageScript(name)).toBe(true);
    }
    expect(isPackageScript("cp")).toBe(false);
    expect(isPackageScript("rm")).toBe(false);
  });

  it("a new reader forgets the last command's answer", () => {
    setPackageScriptsReader(() => new Set(["a"]));
    expect(isPackageScript("a")).toBe(true);
    setPackageScriptsReader(() => new Set(["b"]));
    expect(isPackageScript("a")).toBe(false);
    expect(isPackageScript("b")).toBe(true);
  });
});
