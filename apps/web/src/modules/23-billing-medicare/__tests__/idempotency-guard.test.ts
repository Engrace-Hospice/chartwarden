// #821 regression guard: M23 writes get their Idempotency-Key from the shared useAttemptKey (@chartwarden/ui: kept across no answer, a
// gateway page and the in-flight 409, renewed by any other answer). A per-click `crypto.randomUUID()` in an M23 source file would
// silently re-introduce a fresh key on every retry.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const sources = readdirSync(MODULE_DIR).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));

describe("M23 Idempotency-Key discipline", () => {
  it("scans the module's sources", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it.each(sources)("%s mints no per-call key", (file) => {
    const text = readFileSync(join(MODULE_DIR, file), "utf8");
    expect(text).not.toMatch(/randomUUID/);
    // Any file that sets the header must get its key from the hook.
    if (text.includes("Idempotency-Key"))
      expect(text).toMatch(/useAttemptKey[\s\S]*from "@chartwarden\/ui"/);
  });
});
