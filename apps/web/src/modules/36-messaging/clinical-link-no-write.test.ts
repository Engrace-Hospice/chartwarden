import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WP 3.2: a link only READS its source. The web files that implement the chip, the picker and the candidate source may
// call the typed client with GET and nothing else; a write verb (or a raw fetch/XHR) here is a regression.
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "clinical-link-chip.tsx",
  "clinical-link-picker.tsx",
  "clinical-link-kinds.ts",
  "use-clinical-link-source.ts",
  "use-draft-clinical-links.ts",
];

describe("clinical link web files never write", () => {
  it.each(FILES)("%s issues no non-GET request", (file) => {
    const source = readFileSync(join(here, file), "utf8").replace(/\/\/.*$/gm, "");

    expect(source).not.toMatch(/\.(POST|PUT|PATCH|DELETE)\s*\(/);
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|sendBeacon)\b/);
    expect(source).not.toMatch(/method\s*:\s*["'](?!GET)/i);
  });

  it("still scans real files (the allowlist is not stale)", () => {
    for (const file of FILES)
      expect(readFileSync(join(here, file), "utf8").length).toBeGreaterThan(100);
  });
});
