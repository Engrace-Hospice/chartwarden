// Group g1, round 5 (HOPE docs, M10): CHANGES.md must not describe an earlier state of code that is new in the same entry.
//
// The newest entry titles M10_RECORD_BUSY "New retryable 409". An earlier bullet said "before this change the 409 was cached for
// 24 hours and a same-key retry replayed it": no earlier release answered this 409 (the code is new), so that sentence
// described a past that never shipped. What did exist before is only the unbounded wait. Reads the document and the code, so
// either side drifting fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (repoPath: string): string => readFileSync(join(process.cwd(), repoPath), "utf8");
/** Markdown is hard-wrapped, so a phrase can straddle a line break: compare with whitespace collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const CHANGES = flat(read("docs/api/CHANGES.md"));
const NEWEST = CHANGES.slice(
  CHANGES.indexOf("## 2026-11-15 — HOPE: record writes wait at most 5 seconds"),
  CHANGES.indexOf("## 2026-11-15 — HOPE: a package that was never uploaded"),
);

describe("CHANGES.md: the retry bullet does not narrate a release that never shipped", () => {
  it("has the newest entry and calls the 409 new", () => {
    expect(NEWEST.length).toBeGreaterThan(0);
    expect(NEWEST).toContain("**New retryable `409 M10_RECORD_BUSY`.**");
  });

  it("does not say the 409 was cached for 24 hours before this change", () => {
    expect(NEWEST).not.toMatch(/before this change the 409 was cached/i);
    expect(NEWEST).not.toMatch(/replayed it without running the write/i);
  });

  it("keeps the release rule that is true now: the key is released only when nothing had committed", () => {
    expect(NEWEST).toContain(
      "On those routes the same Idempotency-Key may be reused because the key is released. The key is released only when nothing of the request had committed",
    );
  });

  it("matches the code: the idempotency plugin releases M10_RECORD_BUSY (a retryable outcome), it does not cache it", () => {
    const plugin = read("apps/backend/src/bootstrap/plugins/idempotency.ts");
    expect(plugin).toMatch(
      /RETRYABLE_CONFLICT_CODES[^=]*=\s*new Set\(\[\s*"CONCURRENT_UPDATE",\s*"M10_RECORD_BUSY",?\s*\]\)/,
    );
  });
});
