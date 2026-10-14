// WP 3.4 decision D2 - M36 never touches M14. An IDG action item is not a message and arrives as an alert, and there is no
// cross-module seam to create, read or close one, so task code must not import the IDG module or name its table. If a
// later work package converts IDG alerts it must add an M14 reader/writer seam and change this test deliberately.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dirs = [
  join(__dirname, "../src/modules/36-messaging/tasks"),
  join(__dirname, "../../../packages/messaging/src/tasks"),
];
const files = dirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ path: join(d, f), src: readFileSync(join(d, f), "utf8") })),
);

describe("task code never touches M14", () => {
  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)("$path imports nothing from the IDG module and names no IDG table", ({ src }) => {
    // Comments may explain the rule; only code is judged.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["'][^"']*(14-idg|@wardenx\/idg)[^"']*["']/);
    expect(code).not.toMatch(/idg_action_item|idgActionItem|IdgActionItem/);
  });
});
