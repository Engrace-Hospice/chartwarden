import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0094 decision 2 (option A rejected): browser speech recognition streams the audio to Google or Apple, vendors with no BAA, so it is
// never used - not even behind a flag. Dictation, if it is ever built, is server-side only. This keeps option A from coming back silently.
// The word is assembled so this file is not its own finding.
const FORBIDDEN = new RegExp(`\\b(webkit)?${"Speech"}${"Recognition"}\\b`);
const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = ["apps/web/src", "apps/admin/src"].map((root) => join(here, "../../../../..", root));
const SOURCE = /\.(ts|tsx|js|jsx)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : SOURCE.test(name) ? [path] : [];
  });
}

describe("no browser speech recognition in the web apps (ADR-0094 option A)", () => {
  const files = ROOTS.flatMap(sourceFiles);

  it("scans real files (the roots are not stale)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("references neither the standard nor the webkit-prefixed API", () => {
    const offenders = files
      .filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")))
      .map((file) => relative(join(here, "../../../../.."), file));
    expect(offenders).toEqual([]);
  });
});
