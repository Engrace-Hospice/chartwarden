// Step 10 holds three lines so the DoseSpot branch merges later without rework: no API of its own, no check of that branch's permission
// keys, no assumption about how step 10 settles. This reads the IMPORTS of the panel and its seam (comments stripped, so prose may name
// anything) and fails on a dependency that would give the panel one of them. The DOM suite proves the same from behaviour (no API call).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["dosespot-panel.tsx", "dosespot-registration-slot.tsx"];

const code = (file: string): string =>
  readFileSync(join(here, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the DoseSpot panel and its seam stay free of the DoseSpot branch", () => {
  it.each(FILES)("%s uses no API client, load or write hook", (file) => {
    const source = code(file);
    expect(source).not.toMatch(/\b(useApiClient|useLoad|useOpsWrite|useStepUpMemoryDraft)\b/);
    expect(source).not.toMatch(/\.(GET|POST|PUT|PATCH|DELETE)\s*\(/);
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|sendBeacon)\b/);
  });

  it.each(FILES)("%s names no DoseSpot route or permission key", (file) => {
    const source = code(file);
    expect(source).not.toMatch(/\/api\/v1\/tenant\/dosespot/);
    expect(source).not.toMatch(/prescribing\.clinic|tenant_dosespot/);
    expect(source).not.toMatch(/dosespotSettled|dosespotKickoffRecorded/);
  });

  it("still scans real files (the list is not stale)", () => {
    for (const file of FILES)
      expect(readFileSync(join(here, file), "utf8").length).toBeGreaterThan(100);
  });
});
