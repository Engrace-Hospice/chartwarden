// WP 3.9 (ADR-0066 D8) - sockets join `careteam:<patientId>` at connect, but nothing emits to that room: a removed
// clinician's open socket therefore receives no care-team content through it. Realtime hints go to per-user rooms resolved
// from live channel_member rows. If anything ever emits to a care-team room, revisit this decision before changing the test.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : walk(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = walk(join(__dirname, "../src")).map((p) => ({
  p,
  src: code(readFileSync(p, "utf8")),
}));

describe("the care-team room is join-only", () => {
  it("scans the backend sources", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("no backend source calls careTeamRoom( or names a careteam: room", () => {
    const offenders = sources
      .filter(({ src }) => /careTeamRoom\s*\(/.test(src) || /["'`]careteam:/.test(src))
      .map(({ p }) => p);
    expect(offenders).toEqual([]);
  });
});
