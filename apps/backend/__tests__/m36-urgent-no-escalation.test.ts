// WP 4.1 - the urgency model is a marker and a validated entry, nothing more. Static guards:
//   1. the ONLY callers that pass an urgent recipient into a send are the urgent service and the two cores;
//   2. the urgent code neither pages, escalates, times nor acknowledges (WP 4.2 - 4.4 own that), imports no M19/oncall seam,
//      and never reads message text or the SBAR hint;
//   3. the ordinary send, schedule and draft routes accept no urgency field.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const URGENT_DIRS = ["apps/backend/src/modules/36-messaging/urgent"];
const URGENT_FILES = [
  ...URGENT_DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => relative(ROOT, f)),
  "apps/backend/src/modules/36-messaging/outbox-consumers/urgent-notifications.ts",
  "apps/backend/src/modules/36-messaging/routes/urgent-routes.ts",
  "packages/messaging/src/urgent/urgent-rules.ts",
];

describe("urgent writer is singular", () => {
  const ALLOWED = new Set([
    "apps/backend/src/modules/36-messaging/urgent/urgent-service.ts",
    // Reads the recipient of an existing send (the replay lookup); writes nothing.
    "apps/backend/src/modules/36-messaging/urgent/deps.ts",
    "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts",
    "apps/backend/src/modules/36-messaging/messaging-write-core.ts",
    "apps/backend/src/modules/36-messaging/messaging-message-hydration.ts",
    "packages/messaging/src/store/in-memory-service.ts",
    "packages/messaging/src/interfaces/route-service.ts",
    // WP 4.2: READ the message's urgency and named recipient to derive the request's class and enforce that an urgent request names
    // that recipient. None of them writes `urgency` or the recipient (the one writer stays the urgent service plus the two cores).
    "apps/backend/src/modules/36-messaging/ack-requests/ack-service.ts",
    "apps/backend/src/modules/36-messaging/ack-requests/ack-store-db.ts",
    "apps/backend/src/modules/36-messaging/ack-requests/ack-store-memory.ts",
    "apps/backend/src/modules/36-messaging/ack-requests/ack-types.ts",
    // ADR-0081: the role-replay lookup (moved from urgent/deps.ts) READS the stored recipient of an existing send; it writes nothing.
    "apps/backend/src/modules/36-messaging/ack-requests/role-replay-lookup.ts",
    // WP 5.9 (ADR-0084): offboarding COUNTS urgent messages addressed to a departed user that have no acknowledgment request (select only).
    "apps/backend/src/modules/36-messaging/offboarding/steps-owned-work.ts",
  ]);
  const scanned = ["apps/backend/src", "packages/messaging/src"].flatMap((d) =>
    walk(join(ROOT, d)).map((f) => relative(ROOT, f)),
  );

  it("scans the code it means to", () => {
    expect(scanned.length).toBeGreaterThan(300);
    for (const f of ALLOWED) expect(scanned).toContain(f);
  });

  it("no other file mentions urgentRecipientUserId or sets urgency to urgent", () => {
    const offenders = scanned.filter(
      (f) =>
        !ALLOWED.has(f) &&
        /urgentRecipientUserId|urgent_recipient_user_id|urgency:\s*"urgent"/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});

describe("urgent code does not page, escalate, time or acknowledge", () => {
  it.each(URGENT_FILES)("%s", (file) => {
    const src = read(file);
    expect(src).not.toMatch(
      /escalat(e|ion)Router|EscalationRouter|oncall|on_call|pager|bullmq|setTimeout|setInterval/i,
    );
    expect(src).not.toMatch(/acknowledg(e|ment)_request|acknowledgeMessage|\backnowledg\w*\(/i);
    expect(src).not.toMatch(/urgencyHint|urgency_hint/);
    expect(src).not.toMatch(/from "@chartwarden\/(oncall|triage)|modules\/19-/);
  });

  it("the service and consumer never read message text (no body, plainText or bodyDoc inspection)", () => {
    for (const f of [
      "apps/backend/src/modules/36-messaging/urgent/urgent-service.ts",
      "apps/backend/src/modules/36-messaging/outbox-consumers/urgent-notifications.ts",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/\.(includes|match|test|indexOf|startsWith)\(.*(body|text)/);
      expect(src).not.toMatch(/JSON\.stringify\(.*body/);
    }
  });
});

describe("the ordinary paths accept no urgency", () => {
  it.each([
    "apps/backend/src/modules/36-messaging/routes/messaging-typebox.ts",
    "apps/backend/src/modules/36-messaging/routes/scheduled-send-typebox.ts",
    "apps/backend/src/modules/36-messaging/routes/draft-typebox.ts",
  ])("%s has no request field named urgency or recipient", (file) => {
    const src = read(file);
    // `urgency` appears once in messaging-typebox as a RESPONSE marker; it must not be in any request schema.
    const requestSchemas = src
      .split(/export const (?=\w+Schema)/)
      .filter((s) => /BodySchema/.test(s.split("\n")[0] ?? ""));
    for (const schema of requestSchemas) expect(schema).not.toMatch(/\burgency\b|urgent_recipient/);
  });
});
