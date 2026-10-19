// WP 4.10 (ADR-0077) - the pieces that must agree across packages without a database: the constants and migration 1125 say the same
// numbers, the snooze can reach only the allowlisted alert, no snooze/reminder file can write an acknowledgment request or touch an
// urgent path, the seeded reminder rule is addressed to its owner alone, and the flag is the existing one (off by default).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DESIGNATED_EVENT_TYPES,
  PLATFORM_DEFAULT_ALERT_RULES,
  SNOOZABLE_EVENT_TYPES,
} from "@wardenx/messaging";
import {
  NOTIFICATION_POLICY_FLAG_KEY,
  REMINDER_ALERT_EVENT,
  REMINDER_MAX_HORIZON_DAYS,
  SNOOZE_MAX_MINUTES,
  SNOOZE_REMINDER_FLAG_KEY,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const migration = read("packages/db/migrations/1125_m36_snooze_reminder.sql").replace(/\s+/g, " ");
const DIR = "apps/backend/src/modules/36-messaging/snooze-reminders";
const files = readdirSync(join(ROOT, DIR)).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

describe("migration 1125 agrees with the constants", () => {
  it("the hard snooze maximum and the reminder horizon are in the CHECKs", () => {
    expect(SNOOZE_MAX_MINUTES).toBe(24 * 60);
    expect(migration).toContain(`"snoozed_at" + interval '24 hours'`);
    expect(REMINDER_MAX_HORIZON_DAYS).toBe(30);
    expect(migration).toContain(`"set_at" + interval '30 days'`);
  });

  it("both tables are owner-strict, FORCEd and cascade with the channel/message", () => {
    for (const table of ["message_snooze", "message_reminder"]) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "${table}_owner_isolation"`);
      expect(migration).toContain(`TRIGGER "trg_audit_${table}"`);
    }
    expect(migration).toContain("user_id = NULLIF(current_setting('app.user_id', true), '')::uuid");
    expect(migration).toContain('REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE');
    expect(migration).toContain(
      'REFERENCES "message"("organization_id", "channel_id", "id") ON DELETE CASCADE',
    );
  });

  it("the urgent refusals are triggers, not only service checks", () => {
    expect(migration).toContain("message_snooze_urgent");
    expect(migration).toContain("message_reminder_urgent");
    expect(migration).toMatch(/BEFORE INSERT OR UPDATE ON "message_snooze"/);
    expect(migration).toMatch(/BEFORE INSERT OR UPDATE ON "message_reminder"/);
    for (const status of ["pending", "acknowledged", "escalated", "failed_unreachable"]) {
      expect(migration).toContain(`'${status}'`);
    }
  });

  it("the two system readers are tenant-pinned, bounded and not executable by PUBLIC", () => {
    for (const fn of [
      "message_snoozed_users_for_channel(uuid, uuid, jsonb)",
      "message_reminder_due(uuid, integer, integer)",
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO wardenx_app`);
      expect(migration).toContain(`ALTER FUNCTION ${fn} OWNER TO wardenx_admin`);
    }
    expect(
      migration.match(
        /p_organization_id = NULLIF\(current_setting\('app\.org_id', true\), ''\)::uuid/g,
      ),
    ).toHaveLength(2);
    expect(migration).toContain("jsonb_array_length(p_user_ids) > 500");
    expect(migration).toContain("LEAST(GREATEST(p_limit, 0), 500)");
    // Column grants: the admin role can read no cipher-like or free-text column (there is none) and nothing beyond ids and instants.
    expect(migration).toContain(
      `GRANT SELECT ("organization_id", "user_id", "channel_id", "snoozed_until") ON "message_snooze" TO wardenx_admin`,
    );
  });

  it("wardenx_app cannot move identity or owner: UPDATE is column-limited", () => {
    expect(migration).toContain(
      `GRANT UPDATE ("snoozed_at", "snoozed_until", "updated_at") ON "message_snooze" TO wardenx_app`,
    );
    expect(migration).toContain(
      `GRANT UPDATE ("set_at", "remind_at", "updated_at") ON "message_reminder" TO wardenx_app`,
    );
  });
});

describe("the snooze reaches only what it is meant to", () => {
  it("the allowlist is the conversation mention and disjoint from the designated routes", () => {
    expect([...SNOOZABLE_EVENT_TYPES]).toEqual(["m36.message.mentioned"]);
    for (const eventType of DESIGNATED_EVENT_TYPES) {
      expect(SNOOZABLE_EVENT_TYPES.has(eventType)).toBe(false);
    }
  });

  it("the fan-out applies a snooze only on the non-designated path", () => {
    const src = read("packages/messaging/src/resolution/fan-out.ts");
    expect(src).toContain(
      "const snoozeApplies = !designated && isSnoozableEvent(input.alert.eventType);",
    );
    // The designated branch `continue`s before the snooze branch can run.
    expect(src.indexOf("if (designated) {")).toBeLessThan(src.indexOf("if (snoozed) {"));
    // The in-app floor row is pushed before anything snooze-related is read.
    expect(src.indexOf("channel: FLOOR_CHANNEL")).toBeLessThan(src.indexOf("snoozedUserIds?.has"));
  });

  it("the snooze reuses the existing flag and never a new one", () => {
    expect(SNOOZE_REMINDER_FLAG_KEY).toBe(NOTIFICATION_POLICY_FLAG_KEY);
    for (const f of files) expect(read(`${DIR}/${f}`)).not.toMatch(/"messaging\.[a-z_]+"/);
  });
});

describe("the snooze and reminder code can never touch an urgent path", () => {
  it.each(files)("%s reads acknowledgment requests but never writes one", (file) => {
    const src = read(`${DIR}/${file}`);
    // Any reference to the request table must be a select.
    if (/messageAckRequests|ACK\b/.test(src)) {
      expect(src).not.toMatch(/\.(insert|update|delete)\(\s*ACK\b/);
    }
    expect(src).not.toMatch(/ack-service|ack-store|publishAckEvent|createForUrgentSend/);
    expect(src).not.toMatch(/outbox|HintOutboxPort/i);
  });

  it("the sweep raises only the reminder alert, addressed to the owner alone", () => {
    const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === REMINDER_ALERT_EVENT);
    expect(rule).toMatchObject({
      category: "clinical_routine",
      severityFloor: "info",
      recipientResolver: "role_set",
      resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
      systemLocked: false,
    });
    const sweep = read(`${DIR}/reminder-sweep.ts`);
    expect(sweep.match(/eventType:/g)).toHaveLength(1);
    expect(sweep).toContain("eventType: REMINDER_ALERT_EVENT");
  });

  it("nothing is added to the user's routing: the reminder rule has no channel override and is not designated", () => {
    const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === REMINDER_ALERT_EVENT);
    expect(rule?.channelsOverride).toBeNull();
    expect(DESIGNATED_EVENT_TYPES.has(REMINDER_ALERT_EVENT)).toBe(false);
  });
});
