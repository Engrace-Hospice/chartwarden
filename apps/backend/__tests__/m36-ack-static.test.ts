// WP 4.2 - static guards for the acknowledgment-request aggregate (the sibling of m36-urgent-no-escalation.test.ts). 4.2 ADDS the
// right to write acknowledgment rows; it still must not time, route, escalate or page anyone (WP 4.3 - 4.5), must never acknowledge
// from a read, an open or a receipt, and must keep every writer inside the aggregate's own directory.
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

const ACK_DIR = "apps/backend/src/modules/36-messaging/ack-requests";
const ACK_FILES = [
  ...walk(join(ROOT, ACK_DIR)).map((f) => relative(ROOT, f)),
  "apps/backend/src/modules/36-messaging/routes/ack-routes.ts",
  "apps/backend/src/modules/36-messaging/routes/ack-typebox.ts",
  "apps/backend/src/modules/36-messaging/outbox-consumers/ack-notifications.ts",
  "apps/backend/src/bootstrap/plugins/ack-rate-limit.ts",
  "packages/messaging/src/ack-requests/ack-rules.ts",
];

/** WP 4.4: the two store implementations of the timer's single `escalated` write (`escalate`). */
const ESCALATE_STORES = new Set([`${ACK_DIR}/ack-store-db.ts`, `${ACK_DIR}/ack-store-memory.ts`]);

describe("the aggregate does not time, route, escalate or page (WP 4.3 - 4.5)", () => {
  it("scans the files it means to", () => {
    expect(ACK_FILES.length).toBeGreaterThan(12);
  });

  it.each(ACK_FILES)("%s", (file) => {
    const src = read(file);
    expect(src).not.toMatch(
      /escalat(e|ion)Router|EscalationRouter|oncall|on_call|pager|bullmq|setTimeout|setInterval|cron/i,
    );
    expect(src).not.toMatch(/from "@chartwarden\/(oncall|triage)|modules\/(19|11|12|13)-/);
    // 4.2 never writes a state or an event type that belongs to a later package. WP 4.4's one `escalated` write is the store's
    // `escalate` (the timer lives in ack-escalation/, outside this directory); `failed_unreachable` stays 4.5's.
    expect(src).not.toMatch(/status:\s*"failed_unreachable"/);
    expect(src).not.toMatch(/toStatus:\s*"(escalated|failed_unreachable)"/);
    if (!ESCALATE_STORES.has(file)) expect(src).not.toMatch(/status:\s*"escalated"/);
    expect(src).not.toMatch(
      /eventType:\s*"(opened|delivered|overdue|escalated|delivery_failed|route_unavailable|ladder_exhausted)"/,
    );
  });
});

describe("only an explicit transition writes an acknowledgment", () => {
  const service = read(`${ACK_DIR}/ack-service.ts`);
  const between = (from: string, to: string) =>
    service.slice(service.indexOf(from), service.indexOf(to));

  it("get and listForChannel never write a row, an event or an outbox message", () => {
    const readers = between(
      "    async get(actor, requestId)",
      "    async acknowledge(actor, requestId)",
    );
    expect(readers.length).toBeGreaterThan(100);
    expect(readers).not.toMatch(/insertEvent|\.update\(|\.insert\(|publishAckEvent/);
  });

  it("the GET routes call only the read methods (the two lists and the two ADR-0078 candidate reads)", () => {
    const routes = read("apps/backend/src/modules/36-messaging/routes/ack-routes.ts");
    const getBlocks = routes
      .split("app.get(")
      .slice(1)
      .map((b) => b.split("app.post(")[0] ?? "");
    expect(getBlocks.length).toBe(4);
    for (const block of getBlocks) {
      expect(block).not.toMatch(
        /service\.(create|acknowledge|reassign|resolve|supervisorReassign)\(/,
      );
    }
  });

  it("the supervisor reassign (ADR-0078) can only move a waiting request back to pending: it never writes acknowledged, resolved or an acknowledgment", () => {
    const file = read(`${ACK_DIR}/ack-supervisor.ts`);
    const supervisor = file.slice(file.indexOf("async function reassign("));
    expect(supervisor.length).toBeGreaterThan(500);
    expect(supervisor).not.toMatch(/status:\s*"(acknowledged|resolved|cancelled|escalated)"/);
    expect(supervisor).not.toMatch(
      /acknowledgedAt:\s*at|acknowledgedByUserId:\s*actor|resolvedAt|M36_ACK_(ACKNOWLEDGED|RESOLVED)/,
    );
    expect(supervisor).toContain('status: "pending"');
    expect(supervisor).toContain("isWaiting(");
    // It never asks whether the supervisor can see the channel: that is the point, and it must not start reading the thread either.
    expect(supervisor).not.toMatch(/channelFacts|messageFacts|listForChannel/);
  });

  it("the acknowledged status is written in exactly one place: the acknowledge transition", () => {
    const hits = service.match(/status:\s*"acknowledged"/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(service.indexOf('status: "acknowledged"')).toBeGreaterThan(
      service.indexOf("    async acknowledge(actor, requestId)"),
    );
    expect(service.indexOf('status: "acknowledged"')).toBeLessThan(
      service.indexOf("    async resolve(actor, requestId)"),
    );
  });

  it("no receipt, read, presence or delivery code imports the aggregate", () => {
    const importers = [
      ...walk(join(ROOT, "apps/backend/src")),
      ...walk(join(ROOT, "packages/messaging/src")),
    ]
      .map((f) => relative(ROOT, f))
      .filter((f) => !f.startsWith(ACK_DIR) && /ack-requests\//.test(read(f)))
      .sort();
    expect(importers).toEqual(
      [
        // WP 4.5 (ADR-0071): the delivery-failure handler and its two consumers sit beside the aggregate, like the timers.
        "apps/backend/src/modules/36-messaging/ack-delivery-failure/delivery-failure-service.ts",
        "apps/backend/src/modules/36-messaging/ack-delivery-failure/route-rules.ts",
        "apps/backend/src/modules/36-messaging/outbox-consumers/ack-unreachable-notifications.ts",
        // ADR-0081: the role-send binding wires the aggregate's select-only role-replay lookup (the urgent code must not name the request table).
        "apps/backend/src/modules/36-messaging/oncall-directory/binding.ts",
        // WP 4.8 (ADR-0075): the deep-link resolver names the open request on a message through the aggregate's own read (a type and a lookup port), never its tables.
        "apps/backend/src/modules/36-messaging/delivery-target/delivery-target-service.ts",
        // WP 5.9 (ADR-0084): workforce offboarding calls the aggregate's service (the supervisor reassign) and names its row type/class; it writes nothing itself.
        "apps/backend/src/modules/36-messaging/offboarding/binding.ts",
        "apps/backend/src/modules/36-messaging/offboarding/steps-owned-work.ts",
        // WP 4.4 (ADR-0070): the escalation timers sit beside the aggregate and use its store port, events and row types.
        "apps/backend/src/modules/36-messaging/ack-escalation/binding.ts",
        "apps/backend/src/modules/36-messaging/ack-escalation/escalation-service.ts",
        // ADR-0079 (G-5): the unreachable watch reads the aggregate's store port (a list of unreachable requests); it writes nothing.
        "apps/backend/src/modules/36-messaging/ack-escalation/unreachable-watch.ts",
        // WP 6.1 (ADR-0091): the smart inbox types the aggregate's unacknowledged service (the assignee-narrowed read); it writes nothing.
        "apps/backend/src/modules/36-messaging/inbox/binding.ts",
        "apps/backend/src/modules/36-messaging/index.ts",
        "apps/backend/src/modules/36-messaging/messaging-route-service-db.ts",
        "apps/backend/src/modules/36-messaging/outbox-consumers/ack-escalation-notifications.ts",
        "apps/backend/src/modules/36-messaging/outbox-consumers/ack-notifications.ts",
        "apps/backend/src/modules/36-messaging/outbox-consumers/ack-timer-arming.ts",
        "apps/backend/src/modules/36-messaging/routes/ack-routes.ts",
        // WP 4.9 (ADR-0076): the supervisor queue route types its service from the aggregate's directory; the service and reader live inside it.
        "apps/backend/src/modules/36-messaging/routes/unacknowledged-routes.ts",
        "packages/messaging/src/index.ts",
      ].sort(),
    );
  });
});

describe("one writer of the aggregate's tables", () => {
  it("no file outside the aggregate names the tables or their Drizzle handles", () => {
    const allowed = new Set([
      "packages/db/src/schema/messaging/message-acknowledgments.ts",
      // The audit resource kind of the read audit, a label and not a table access.
      "apps/backend/src/modules/36-messaging/routes/ack-routes.ts",
      // WP 4.9: the same label for the supervisor queue's read audit; the route reads through the aggregate's own service, never a table.
      "apps/backend/src/modules/36-messaging/routes/unacknowledged-routes.ts",
      // WP 4.10 (ADR-0077): snooze and reminders READ the request table (is a request open for this caller / message?) to refuse a snooze or a
      // reminder, and the snooze lookup excludes users who hold one. Select only: m36-snooze-reminder.test.ts pins that neither file inserts, updates or deletes it.
      "apps/backend/src/modules/36-messaging/snooze-reminders/snooze-reminder-store-db.ts",
      "apps/backend/src/modules/36-messaging/snooze-reminders/snoozed-users-port.ts",
      // WP 4.4: the audit resource kind of a dead timer job's `m36.dlq_job` row, again a label and not a table access.
      "apps/backend/src/modules/36-messaging/ack-escalation/dlq-audit.ts",
      // WP 5.9 (ADR-0084): offboarding READS the request table (the waiting / acknowledged requests assigned to a departed user, the open ones they
      // sent, and "urgent message with no request"). Select only: offboarding-static.test.ts pins that it never inserts, updates or deletes it; every
      // move goes through the aggregate's supervisor reassign.
      "apps/backend/src/modules/36-messaging/offboarding/steps-owned-work.ts",
      // WP 6.2 (ADR-0092): response analytics READS the request and event tables to aggregate latency, escalation and handoff figures. Select only
      // (no insert, update or delete), under RLS, and no row id, user or message leaves the module: the contract carries counts and durations only.
      "apps/backend/src/modules/36-messaging/analytics/response-analytics-reader.ts",
    ]);
    const offenders = [
      ...walk(join(ROOT, "apps/backend/src")),
      ...walk(join(ROOT, "packages/messaging/src")),
    ]
      .map((f) => relative(ROOT, f))
      .filter(
        (f) =>
          !f.startsWith(ACK_DIR) &&
          !allowed.has(f) &&
          /messageAckRequests|messageAckEvents|message_acknowledgment_/.test(read(f)),
      );
    expect(offenders).toEqual([]);
  });
});

describe("the request schemas carry no class, status, deadline or role", () => {
  it("CreateAckBodySchema and ReassignAckBodySchema accept only ids", () => {
    const src = read("apps/backend/src/modules/36-messaging/routes/ack-typebox.ts");
    const requests = src
      .split(/export const (?=\w+Schema)/)
      .filter((s) => /^(Create|Reassign|Empty)AckBodySchema/.test(s))
      .map((s) => s.split("\n\n")[0] ?? "");
    expect(requests).toHaveLength(3);
    for (const schema of requests) {
      expect(schema).not.toMatch(/ack_class|status|deadline|required_role|urgency|tier/);
      expect(schema).toContain("additionalProperties: false");
    }
  });

  it("the ordinary send, edit, schedule and draft schemas still accept no ack field", () => {
    for (const file of [
      "apps/backend/src/modules/36-messaging/routes/messaging-typebox.ts",
      "apps/backend/src/modules/36-messaging/routes/scheduled-send-typebox.ts",
      "apps/backend/src/modules/36-messaging/routes/draft-typebox.ts",
    ]) {
      expect(read(file)).not.toMatch(/ack_class|assigned_user_id|message_acknowledgment/);
    }
  });
});

describe("the urgent code stays unaware of the aggregate except through the generic hook", () => {
  it("urgent files neither import nor name the aggregate", () => {
    for (const f of walk(join(ROOT, "apps/backend/src/modules/36-messaging/urgent"))) {
      expect(readFileSync(f, "utf8")).not.toMatch(/ack-requests|messageAck|AckService/);
    }
  });
});
