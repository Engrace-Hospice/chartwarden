// Phase 2 gate "edit indicator and revision" (docs/messaging-hub/03-phases-0-to-3.md, ADR-0055).
// Non-live checks for the clauses the DB-backed suites cannot prove: the read DTO carries `editedAt`, and the
// revision-history read permission (`messaging.history.read`) is DELIBERATELY absent: deferred to Phase 5 by
// ADR-0055 items 5 and 7. Adding it must force someone to revisit this file. The proven clauses (revision
// append-only, window, author-only, editedAt on every read path) live in m36-channel-membership-lifecycle.live.test.ts.
//
// The scan is made at module level and its reach is proven by the control tests, so an empty or broken scan turns
// the file red instead of making the "absent" assertions vacuously true.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { M36_CONTRIBUTED_PERMISSIONS, allPermissionMirrorRows } from "@wardenx/auth";
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

  it("the permission catalog scan sees the module's real keys", () => {
    expect(Object.keys(M36_CONTRIBUTED_PERMISSIONS)).toContain("messaging.read");
  });

  it("the read DTO schema exposes properties to inspect", () => {
    expect(Object.keys(ResolvedMessageSchema.properties)).toContain("messageId");
  });
});

describe("M36 gate: edit indicator and revision", () => {
  it("a read DTO carries the edited marker (time) so readers can show 'edited'", () => {
    expect(Object.keys(ResolvedMessageSchema.properties)).toContain("editedAt");
  });

  it("messaging.history.read is deliberately absent: deferred to Phase 5 by ADR-0055 items 5 and 7", () => {
    expect(moduleSources.some((source) => source.text.includes(HISTORY_PERMISSION))).toBe(false);
    expect(Object.keys(M36_CONTRIBUTED_PERMISSIONS)).not.toContain(HISTORY_PERMISSION);
    expect(allPermissionMirrorRows().map((row) => row.key)).not.toContain(HISTORY_PERMISSION);
  });
});
