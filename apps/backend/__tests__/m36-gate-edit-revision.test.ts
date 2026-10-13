// Phase 2 gate "edit indicator and revision" (docs/messaging-hub/03-phases-0-to-3.md, ADR-0055).
// Non-live tripwires for the clauses the DB-backed suites cannot prove because the surface does not exist yet.
// `it.fails` passes while the gap is open and FAILS the day the gap closes, forcing this file to be turned
// into a real assertion. The proven clauses (revision append-only, window, author-only) live in
// m36-channel-membership-lifecycle.live.test.ts.
//
// An `it.fails` goes green on ANY thrown error, so everything that could throw for another reason (reading the tree,
// a renamed schema) is done at module level or in a normal control test: a broken scan turns the file red, and only
// the one assertion on the gap itself can make a tripwire green.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResolvedMessageSchema } from "../src/modules/36-messaging/routes/messaging-typebox";

const MODULE_DIR = fileURLToPath(new URL("../src/modules/36-messaging/", import.meta.url));
const HISTORY_PERMISSION = "messaging.history.read";

/** Every non-test TypeScript source of the whole messaging backend module, not just the routes file. */
const moduleSources = readdirSync(MODULE_DIR, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
  .map((file) => ({
    file: relative(MODULE_DIR, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));

describe("M36 gate: the tripwire scans are real", () => {
  it("the permission scan covers the whole module, routes included", () => {
    const files = moduleSources.map((source) => source.file);
    expect(files).toContain("routes/messaging-routes.ts");
    expect(files.length).toBeGreaterThan(40);
    // A permission this module does register is found by the same scan, so "absent" is meaningful.
    expect(moduleSources.some((source) => source.text.includes("messaging.read"))).toBe(true);
  });

  it("the read DTO schema exposes properties to inspect", () => {
    expect(Object.keys(ResolvedMessageSchema.properties)).toContain("messageId");
  });
});

describe("M36 gate: edit indicator and revision (open gaps)", () => {
  it.fails("a read DTO carries the edited marker (time) so readers can show 'edited'", () => {
    expect(Object.keys(ResolvedMessageSchema.properties)).toContain("editedAt");
  });

  it.fails("a revision-history read route and permission exist (ADR-0055 item 5)", () => {
    expect(moduleSources.some((source) => source.text.includes(HISTORY_PERMISSION))).toBe(true);
  });
});
