// WP 3.7 - the promotion code writes only its own table. It imports no other module's code, never writes an M8 / M14 / M7 /
// M11 table, and calls only the read-only IDG meeting summary on a cross-module seam. The reviewer's decision reaches M36 only
// through the owning module's outbox event (the outcome consumer), never through a write from here.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dirs = [
  join(__dirname, "../src/modules/36-messaging/promotions"),
  join(__dirname, "../../../packages/messaging/src/promotions"),
];
const files = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "promotion-test-kit.ts")
    .map((f) => ({ path: join(d, f), src: readFileSync(join(d, f), "utf8") })),
);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** `T` is the local alias of chartPromotionRequests in the two store files. */
const OWN_TABLE_ALIASES = new Set(["T", "chartPromotionRequests"]);
/** Seams the promotion code may read, and the only method it may call on them. */
const READ_ONLY_SEAMS = new Map([["IdgScheduleProvider", "linkSummary"]]);

describe("promotion code writes only its own table", () => {
  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)("$path imports no other module's code or schema", ({ src }) => {
    const imports = [...code(src).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/modules\/(?!36-messaging)\d{2}-/);
      expect(spec).not.toMatch(/\.\.\/\.\.\/(?!bootstrap)\d{2}-/);
    }
  });

  it.each(files)("$path inserts, updates and deletes only chart_promotion_request", ({ src }) => {
    for (const m of code(src).matchAll(/\.(insert|update|delete)\(\s*([A-Za-z_.]+)\s*\)/g)) {
      const target = (m[2] ?? "").replace(/^schema\./, "");
      expect(OWN_TABLE_ALIASES.has(target), `${m[0]}`).toBe(true);
    }
  });

  it.each(files)("$path reaches a cross-module seam only to read an IDG meeting", ({ src }) => {
    for (const m of code(src).matchAll(/getSeam\("(\w+)"\)/g)) {
      expect(READ_ONLY_SEAMS.has(m[1] ?? ""), `${m[1]}`).toBe(true);
    }
    for (const m of code(src).matchAll(/getSeam\("(\w+)"\)(?: as \w+)?\)?\.(\w+)\(/g)) {
      expect(READ_ONLY_SEAMS.get(m[1] ?? ""), `${m[1]}.${m[2]}`).toBe(m[2]);
    }
  });

  it("the service never decides: it has no accepted/rejected writer other than applyOutcome", () => {
    const service = code(files.find((f) => f.path.endsWith("promotion-service.ts"))?.src ?? "");
    const writers = [...service.matchAll(/store\.(markAccepted|markRejected)\(/g)];
    expect(writers).toHaveLength(2);
    const applyAt = service.indexOf("async applyOutcome(");
    for (const w of writers) expect(w.index ?? 0).toBeGreaterThan(applyAt);
  });
});
