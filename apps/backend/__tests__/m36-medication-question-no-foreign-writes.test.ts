// WP 3.10 - the medication-question code writes only the module's own task tables (through the task store) and the outbox.
// It imports no other module's code or schema and calls no mutating method on a cross-module seam.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dirs = [
  join(__dirname, "../src/modules/36-messaging/medication-questions"),
  join(__dirname, "../src/modules/36-messaging/tasks"),
  join(__dirname, "../../../packages/messaging/src/medication-question"),
];
const files = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ path: join(d, f), src: readFileSync(join(d, f), "utf8") })),
);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** `T` and `E` are the local aliases of the two task tables in the task store. */
const OWN_TABLE_TARGETS = new Set(["T", "E", "communicationTasks", "communicationTaskEvents"]);
/** Seam methods this code may call: both are reads (they live in tasks/binding.ts). */
const READ_ONLY_SEAM_CALLS = new Set(["careTeamMembers", "primaryRnUserId"]);

describe("medication-question code writes only its own task tables", () => {
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

  it.each(files)("$path inserts, updates and deletes only task tables", ({ src }) => {
    for (const m of code(src).matchAll(/\.(insert|update|delete)\(\s*([A-Za-z_.]+)\s*\)/g)) {
      const target = (m[2] ?? "").replace(/^schema\./, "");
      expect(OWN_TABLE_TARGETS.has(target), `${m[0]}`).toBe(true);
    }
  });

  it.each(files)("$path calls only read-only methods on cross-module seams", ({ src }) => {
    for (const m of code(src).matchAll(/getSeam\("(\w+)"\)(?:\s+as\s+\w+\))?\.(\w+)\(/g)) {
      expect(READ_ONLY_SEAM_CALLS.has(m[2] ?? ""), `${m[1]}.${m[2]}`).toBe(true);
    }
  });

  it("the task is created through the task store, tagged as a medication question", () => {
    const service = files.find((f) => f.path.endsWith("medication-question-service.ts"))?.src ?? "";
    expect(service).toContain("taskStore.createOrGetActive");
    expect(service).toContain('sourceKind: "medication_question"');
  });
});
