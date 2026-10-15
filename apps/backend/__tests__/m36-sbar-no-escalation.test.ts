// WP 3.3 - the SBAR urgency hint is a sender's LABEL, never a trigger. No alert, page, notification, acknowledgement,
// event, column or routing decision may depend on it until a work package deliberately maps it. WP 4.1 does NOT: message.urgency is set only by the Urgent clinical entry and the server never reads this label. Static guard: outside the codec
// (messaging-rich-body.ts) and the validator (messaging-sbar.ts) in @wardenx/types, nothing server-side or in the
// messaging package may mention `urgencyHint`. (The web renders and sets it; that is display only and is covered by the
// web slice's own tests.)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const SCANNED = [
  "apps/backend/src",
  "packages/messaging/src",
  "packages/db/src",
  "packages/db/migrations",
  "packages/types/src",
];
const ALLOWED = new Set([
  "packages/types/src/messaging-rich-body.ts",
  "packages/types/src/messaging-sbar.ts",
  // Draft persistence: the sealed draft stores the label and validates it is one of the three enum values. It is data
  // in a private scratch document; nothing there routes, alerts or notifies on it.
  "packages/messaging/src/drafts/index.ts",
  "apps/backend/src/modules/36-messaging/routes/draft-typebox.ts",
]);
const MENTION = /urgencyHint|urgency_hint/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return /\.(ts|tsx|sql)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("SBAR urgency never escalates", () => {
  const files = SCANNED.flatMap((dir) => walk(join(ROOT, dir)));

  it("scans the code it means to", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const allowed of ALLOWED) expect(files.map((f) => relative(ROOT, f))).toContain(allowed);
  });

  it("is read only by the rich-body codec and the SBAR validator", () => {
    const offenders = files
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOWED.has(f))
      .filter((f) => MENTION.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("is not a database column anywhere", () => {
    const migrations = files.filter((f) => f.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(100);
    for (const file of migrations) expect(readFileSync(file, "utf8")).not.toMatch(MENTION);
  });
});
