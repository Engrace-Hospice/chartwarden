// #821 regression guard: M23 writes get their Idempotency-Key from useAttemptKey (kept only after a thrown fetch).
// A per-click `crypto.randomUUID()` in an M23 source file would silently re-introduce a fresh key on every retry.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_HOME = "use-attempt-key.ts";

const sources = readdirSync(MODULE_DIR).filter(
  (f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && f !== KEY_HOME,
);

describe("M23 Idempotency-Key discipline", () => {
  it("scans the module's sources", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it.each(sources)("%s mints no per-call key", (file) => {
    const text = readFileSync(join(MODULE_DIR, file), "utf8");
    expect(text).not.toMatch(/randomUUID\s*\(/);
    expect(text).not.toMatch(/"Idempotency-Key"\s*:\s*(?:idem|idempotency|newKey)\w*\(\)/i);
  });
});
