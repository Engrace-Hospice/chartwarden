// WP 3.8 - the lifecycle-no-delete gate for the review queue: nothing here removes a row or imports another module's code
// or schema. The only write outside the review table is the module's own communication task, moved through the shared
// task store (reviewOverride). Reads of the task and channel tables are fine.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const reviewDir = join(__dirname, "../src/modules/36-messaging/review");
const consumer = join(
  __dirname,
  "../src/modules/36-messaging/outbox-consumers/patient-lifecycle-review.ts",
);
const dirs = [reviewDir, join(__dirname, "../../../packages/messaging/src/review")];
const files = [
  ...dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "review-test-kit.ts")
      .map((f) => join(d, f)),
  ),
  ...(existsSync(consumer) ? [consumer] : []),
].map((path) => ({ path, src: readFileSync(path, "utf8") }));
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("review code never removes a row", () => {
  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)("$path has no delete call, delete statement or truncate", ({ src }) => {
    const c = code(src);
    expect(c).not.toMatch(/\.delete\(/);
    expect(c).not.toMatch(/DELETE\s+FROM/i);
    expect(c).not.toMatch(/TRUNCATE/i);
  });

  it.each(files)("$path imports no other module's code or schema", ({ src }) => {
    const imports = [...code(src).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/modules\/(?!36-messaging)\d{2}-/);
      expect(spec).not.toMatch(/\.\.\/\.\.\/(?!bootstrap)\d{2}-/);
    }
  });

  it.each(files)("$path inserts and updates only the review table", ({ src }) => {
    for (const m of code(src).matchAll(/\.(insert|update)\(\s*([A-Za-z_.]+)\s*\)/g)) {
      const target = (m[2] ?? "").replace(/^schema\./, "");
      expect(["R", "messagingReviewItems"].includes(target), `${m[0]}`).toBe(true);
    }
  });

  it("moves a task only through the shared task store with an explicit review override", () => {
    const service = files.find((f) => f.path.endsWith("review-service.ts"))?.src ?? "";
    expect(service).toContain("taskStore.transition");
    expect(service).toContain("reviewOverride: true");
    expect(service).toContain('reassignReason: "review"');
  });
});
