// WP 4.4 - static guards for the escalation timers (the sibling of m36-ack-static.test.ts). The timer is the ONLY writer of the
// `escalated` status and of the three events it owns; it reaches M19 only through the guarded seam; it never writes
// `failed_unreachable` (WP 4.5) and never sleeps or polls in-process (the clock is injected, the wake-ups are BullMQ's).
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
const ESC_DIR = `${MODULE}/ack-escalation`;
const ESC_FILES = [
  ...walk(join(ROOT, ESC_DIR)).map((f) => relative(ROOT, f)),
  `${MODULE}/outbox-consumers/ack-timer-arming.ts`,
  `${MODULE}/outbox-consumers/ack-escalation-notifications.ts`,
  "packages/messaging/src/ack-requests/ack-timer-rules.ts",
];

describe("the escalation timer stays inside its lane", () => {
  it("scans the files it means to", () => {
    expect(ESC_FILES.length).toBeGreaterThan(8);
  });

  it.each(ESC_FILES)("%s", (file) => {
    const src = read(file);
    // 4.5 owns failed_unreachable and delivery failure; the timer never writes either.
    expect(src).not.toMatch(/status:\s*"failed_unreachable"|toStatus:\s*"failed_unreachable"/);
    expect(src).not.toMatch(/eventType:\s*"(delivery_failed|opened|delivered)"/);
    // No M19 / on-call import: the router is reached through the seam only.
    expect(src).not.toMatch(/from "@wardenx\/(oncall|triage)|modules\/(19|11|12|13)-/);
    // No in-process timers or polling: the clock is injected and the wake-ups are BullMQ's.
    expect(src).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
    // Never re-evaluates who owns a request by a clock later: no schedule or shift logic here (ADR-0057).
    expect(src).not.toMatch(/shift-window|scheduleContains|tenant_oncall_policy/);
  });

  it("the escalation write (`escalate`) has exactly one caller: the service's guarded settle", () => {
    const callers = [...walk(join(ROOT, "apps/backend/src"))]
      .map((f) => relative(ROOT, f))
      .filter((f) => /\btx\.escalate\(/.test(read(f)));
    expect(callers).toEqual([`${ESC_DIR}/escalation-service.ts`]);
  });

  it("the escalated status is written only by the store's escalate", () => {
    const writers = [...walk(join(ROOT, MODULE))]
      .map((f) => relative(ROOT, f))
      .filter((f) => /status:\s*"escalated"/.test(read(f)));
    expect(writers.sort()).toEqual([
      `${MODULE}/ack-requests/ack-store-db.ts`,
      `${MODULE}/ack-requests/ack-store-memory.ts`,
    ]);
  });

  it("the three timer events are published only from the escalation service", () => {
    const publishers = [...walk(join(ROOT, "apps/backend/src"))]
      .map((f) => relative(ROOT, f))
      .filter(
        (f) =>
          !f.endsWith("ack-events.ts") &&
          /M36_ACK_(ESCALATED|ROUTE_UNAVAILABLE|LADDER_EXHAUSTED)\b/.test(read(f)) &&
          /publishAckEvent\(/.test(read(f)),
      );
    expect(publishers).toEqual([`${ESC_DIR}/escalation-service.ts`]);
  });

  it("the arming consumer ignores the flag and the action consumer writes nothing", () => {
    const arming = read(`${MODULE}/outbox-consumers/ack-timer-arming.ts`);
    expect(arming).not.toMatch(/isEnabled|escalation_timers/);
    const notify = read(`${MODULE}/outbox-consumers/ack-escalation-notifications.ts`);
    expect(notify).not.toMatch(/\.update\(|\.insert\(|insertEvent|escalate\(/);
  });
});
