// Phase 2 gate "edit indicator and revision" (docs/messaging-hub/03-phases-0-to-3.md, ADR-0055).
// Non-live tripwires for the clauses the DB-backed suites cannot prove because the surface does not exist yet.
// `it.fails` passes while the gap is open and FAILS the day the gap closes, forcing this file to be turned
// into a real assertion. The proven clauses (revision append-only, window, author-only) live in
// m36-channel-membership-lifecycle.live.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ResolvedMessageSchema } from "../src/modules/36-messaging/routes/messaging-typebox";

describe("M36 gate: edit indicator and revision (open gaps)", () => {
  it.fails("a read DTO carries the edited marker (time) so readers can show 'edited'", () => {
    expect(Object.keys(ResolvedMessageSchema.properties)).toContain("editedAt");
  });

  it.fails("a revision-history read route and permission exist (ADR-0055 item 5)", () => {
    const routes = readFileSync(
      new URL("../src/modules/36-messaging/routes/messaging-routes.ts", import.meta.url),
      "utf8",
    );
    expect(routes).toContain("messaging.history.read");
  });
});
