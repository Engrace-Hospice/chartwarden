// WP 3.9 - the care-team sync code writes only through the review queue's own store, imports no other module's code or
// schema, and calls no mutating method on a cross-module seam. A removed clinician's access is cut by the live roster
// check and the membership sync; this code only queues work for a supervisor.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dirs = [
  join(__dirname, "../src/modules/36-messaging/care-team-sync"),
  join(__dirname, "../../../packages/messaging/src/care-team"),
];
const files = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ path: join(d, f), src: readFileSync(join(d, f), "utf8") })),
);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("care-team sync code queues work and writes nothing else", () => {
  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("$path imports no other module's code or schema", ({ src }) => {
    const imports = [...code(src).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/modules\/(?!36-messaging)\d{2}-/);
      expect(spec).not.toMatch(/\.\.\/\.\.\/(?!bootstrap)\d{2}-/);
    }
  });

  it.each(files)("$path issues no insert, update or delete of its own", ({ src }) => {
    expect(code(src)).not.toMatch(/\.(insert|update|delete)\(/);
  });

  it.each(files)("$path calls no seam directly", ({ src }) => {
    expect(code(src)).not.toMatch(/getSeam\(/);
  });

  it("the router only reads tasks and writes through the review store", () => {
    const router = files.find((f) => f.path.endsWith("care-team-review.ts"))?.src ?? "";
    expect(router).toContain("deps.store.queueItems");
    expect(router).not.toMatch(/taskStore\.(transition|flagNeedsOwner|createOrGetActive)/);
  });
});
