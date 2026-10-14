// WP 3.5 - the handoff code writes only its own tables. The only write outside them is the module's own communication task
// (reassigned through the task store when its handoff item is accepted). It imports no other module's code or schema and
// calls no mutating method on a cross-module seam; every seam it reads is on an explicit read-only list.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dirs = [
  join(__dirname, "../src/modules/36-messaging/handoffs"),
  join(__dirname, "../../../packages/messaging/src/handoffs"),
];
const files = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "handoff-test-kit.ts")
    .map((f) => ({ path: join(d, f), src: readFileSync(join(d, f), "utf8") })),
);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OWN_TABLES = new Set([
  "clinicalHandoffs",
  "clinicalHandoffItems",
  "clinicalHandoffEvents",
  "tenantHandoffPolicies",
]);
/** Seam methods the handoff code may call: every one is a read. */
const READ_ONLY_SEAM_CALLS = new Set([
  "nextScheduledVisitForPatient",
  "linkSummary",
  "getPendingRefillsForPatient",
  "getRefillRequestById",
  "openSfvs",
]);

describe("handoff code writes only its own tables", () => {
  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(files)("$path imports no other module's code or schema", ({ src }) => {
    const imports = [...code(src).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/modules\/(?!36-messaging)\d{2}-/);
      expect(spec).not.toMatch(/\.\.\/\.\.\/(?!bootstrap)\d{2}-/);
    }
  });

  it.each(files)(
    "$path inserts, updates and deletes only handoff tables (or the task store)",
    ({ src }) => {
      for (const m of code(src).matchAll(/\.(insert|update|delete)\(\s*([A-Za-z_.]+)\s*\)/g)) {
        const target = (m[2] ?? "").replace(/^schema\./, "");
        // `H`, `I`, `E`, `P` are the local aliases of the four owned tables in the two store files.
        expect(OWN_TABLES.has(target) || ["H", "I", "E", "P"].includes(target), `${m[0]}`).toBe(
          true,
        );
      }
    },
  );

  it.each(files)("$path calls only read-only methods on cross-module seams", ({ src }) => {
    for (const m of code(src).matchAll(/getSeam\("(\w+)"\)\.(\w+)\(/g)) {
      expect(READ_ONLY_SEAM_CALLS.has(m[2] ?? ""), `${m[1]}.${m[2]}`).toBe(true);
    }
  });

  it("the task transfer goes through the task store, with an explicit handoff reason", () => {
    const service = files.find((f) => f.path.endsWith("handoff-service.ts"))?.src ?? "";
    expect(service).toContain("taskStore.transition");
    expect(service).toContain('reassignReason: "handoff"');
  });
});
