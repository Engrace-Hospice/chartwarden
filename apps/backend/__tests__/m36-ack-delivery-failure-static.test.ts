// WP 4.5 - static guards for delivery-failure handling (the sibling of m36-ack-escalation-static.test.ts). The delivery-failure service is
// the ONLY writer of the `failed_unreachable` status, of the `delivery_failed` history row and of `m36.ack.failed_unreachable`; its
// consumers write nothing themselves; it reaches the router only through the timer's ladder walk (no M19 import); and it never sleeps.
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

const MODULE = "apps/backend/src/modules/36-messaging";
const SERVICE = `${MODULE}/ack-delivery-failure/delivery-failure-service.ts`;
const backendFiles = walk(join(ROOT, "apps/backend/src")).map((f) => relative(ROOT, f));

describe("delivery-failure handling stays inside its lane", () => {
  it("failed_unreachable is written by exactly one file", () => {
    const writers = backendFiles.filter((f) => /status:\s*"failed_unreachable"/.test(read(f)));
    expect(writers).toEqual([SERVICE]);
  });

  it("the delivery_failed history row is written by exactly one file", () => {
    const writers = backendFiles.filter((f) => /eventType:\s*"delivery_failed"/.test(read(f)));
    expect(writers).toEqual([SERVICE]);
  });

  it("m36.ack.failed_unreachable is published only from the service", () => {
    const publishers = backendFiles.filter(
      (f) =>
        !f.endsWith("ack-events.ts") &&
        /M36_ACK_FAILED_UNREACHABLE\b/.test(read(f)) &&
        /publishAckEvent\(/.test(read(f)),
    );
    expect(publishers).toEqual([SERVICE]);
  });

  it("the early escalation reuses the timer's one escalation write instead of a second one", () => {
    expect(read(SERVICE)).toMatch(/writeEscalation\(/);
    expect(read(SERVICE)).not.toMatch(/\.escalate\(/);
  });

  it("neither consumer writes a request, a history row or an event", () => {
    for (const file of [
      `${MODULE}/outbox-consumers/ack-delivery-failure.ts`,
      `${MODULE}/outbox-consumers/ack-unreachable-notifications.ts`,
    ]) {
      expect(read(file)).not.toMatch(
        /\.update\(|\.insert\(|insertEvent|escalate\(|publishAckEvent/,
      );
    }
  });

  it("no M19 import, no in-process timers, no schedule logic in the delivery-failure files", () => {
    const files = [
      ...walk(join(ROOT, `${MODULE}/ack-delivery-failure`)).map((f) => relative(ROOT, f)),
      `${MODULE}/outbox-consumers/ack-delivery-failure.ts`,
      `${MODULE}/outbox-consumers/ack-unreachable-notifications.ts`,
    ];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const src = read(file);
      expect(src, file).not.toMatch(/from "@chartwarden\/(oncall|triage)|modules\/(19|11|12|13)-/);
      expect(src, file).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
      expect(src, file).not.toMatch(/shift-window|scheduleContains|tenant_oncall_policy/);
    }
  });

  it("invents no delivery vendor and no channel: it reads the delivery rows that exist", () => {
    for (const file of [
      `${MODULE}/ack-delivery-failure/delivery-failure-service.ts`,
      `${MODULE}/outbox-consumers/ack-delivery-failure.ts`,
    ]) {
      expect(read(file)).not.toMatch(/twilio|postmark|webpush|web-push|fcm|apns/i);
    }
  });
});
