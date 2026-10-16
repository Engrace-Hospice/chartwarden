// WP 4.2 - the TypeScript enums and constants, the Drizzle schema, the manifest and migration 1107 agree, and the structural
// promises of the migration (the state machine, the deadline maximum, append-only history, grants, RLS) are asserted on its text, so a
// change in one place without the others fails here. The live suite proves the same rules against a real database.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACK_TRANSITIONS } from "@wardenx/messaging";
import {
  ACK_CLASSES,
  ACK_DEADLINE_POLICY,
  ACK_EVENT_TYPES,
  ACK_EVENT_TYPES_WRITTEN_BY_4_4,
  ACK_STATUSES,
  type AckStatus,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sql = read("packages/db/migrations/1107_m36_message_acknowledgment_request.sql");
// WP 4.4 (migration 1114) replaces the update guard in full and adds two event types; the state machine is pinned on THAT text.
const sql1114 = read("packages/db/migrations/1114_m36_ack_escalation_timers.sql");
// WP 4.5 (migration 1120) replaces the update guard in full once more (only `failed_unreachable` is new); the guard is pinned on THAT text.
const sql1120 = read("packages/db/migrations/1120_m36_ack_delivery_failure.sql");
const flat = (s: string) => s.replace(/\s+/g, " ");
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
const quoted = (values: readonly string[]) => values.map((v) => `"${v}"`).join(", ");

/** The two event types migration 1114 adds on top of 1107's list (WP 4.4). */
const ADDED_IN_1114 = ["route_unavailable", "ladder_exhausted"] as const;

describe("migration 1107 enums", () => {
  it.each([
    ["message_ack_status", ACK_STATUSES, ACK_STATUSES],
    ["message_ack_class", ACK_CLASSES, ACK_CLASSES],
    [
      "message_ack_event_type",
      ACK_EVENT_TYPES.filter((v) => !(ADDED_IN_1114 as readonly string[]).includes(v)),
      ACK_EVENT_TYPES,
    ],
  ] as const)(
    "%s has exactly the code-side values, in SQL (1107 plus 1114) and in the Drizzle enums",
    (name, createdValues, values) => {
      expect(flat(sql)).toContain(`CREATE TYPE "${name}" AS ENUM (${list(createdValues)})`);
      expect(flat(read("packages/db/src/enums.ts"))).toMatch(
        new RegExp(
          `pgEnum\\(\\s*"${name}",\\s*\\[\\s*${quoted(values).replace(/, /g, ",\\s*")},?\\s*\\]`,
        ),
      );
    },
  );
});

describe("migration 1114 event types", () => {
  it("adds exactly the two history types the timer writes beyond 1107's list, ahead of any use", () => {
    for (const value of ADDED_IN_1114) {
      expect(flat(sql1114)).toContain(
        `ALTER TYPE "message_ack_event_type" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    expect(ACK_EVENT_TYPES_WRITTEN_BY_4_4).toEqual(["escalated", ...ADDED_IN_1114]);
  });
});

describe("the update guard (migration 1120 replaces 1114's, in full) is the state machine", () => {
  const guard = flat(sql1120.slice(sql1120.indexOf("message_ack_request_update_guard()")));

  it("final states cannot change", () => {
    expect(guard).toContain("IF OLD.status IN ('resolved', 'cancelled') THEN");
  });

  it.each(ACK_STATUSES.filter((s) => ACK_TRANSITIONS[s].length > 0))(
    "the trigger allows exactly the %s transitions the code allows",
    (from: AckStatus) => {
      const expected = `WHEN '${from}' THEN NEW.status IN (${list(ACK_TRANSITIONS[from])})`;
      expect(guard).toContain(expected);
    },
  );

  it("allows only two same-status updates: a reassign of a pending request and a tier-up of an escalated one", () => {
    expect(guard).toContain(
      "OLD.status = 'pending' AND NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id",
    );
    expect(guard).toContain("OLD.status = 'escalated' AND NEW.current_tier > OLD.current_tier");
  });

  it("makes identity, class, requester and requested_at immutable and the version strictly +1", () => {
    for (const column of [
      "NEW.message_id <> OLD.message_id",
      "NEW.patient_id <> OLD.patient_id",
      "NEW.ack_class <> OLD.ack_class",
      "NEW.requester_user_id <> OLD.requester_user_id",
      "NEW.requested_at <> OLD.requested_at",
    ]) {
      expect(guard).toContain(column);
    }
    expect(guard).toContain("NEW.version <> OLD.version + 1");
  });

  it("binds who acts: acknowledge and resolve as the assigned user, reassign as a party, cancel as the sender, windows start now", () => {
    expect(guard).toContain("v_actor := NULLIF(current_setting('app.user_id', true), '')");
    expect(guard).toContain(
      "NEW.status IN ('acknowledged', 'resolved') AND OLD.status <> NEW.status AND v_actor IS DISTINCT FROM NEW.assigned_user_id::text",
    );
    expect(guard).toContain(
      "v_actor NOT IN (OLD.requester_user_id::text, OLD.assigned_user_id::text)",
    );
    expect(guard).toContain(
      "NEW.status = 'cancelled' AND v_actor IS NOT NULL AND v_actor <> OLD.requester_user_id::text",
    );
    expect(guard).toContain("abs(extract(epoch FROM (NEW.window_started_at - now()))) > 300");
  });

  it("moves the assignee only on a reassign or a timer escalation, and a reassign needs a new assignee who is an active member", () => {
    expect(guard).toContain("the assignee changes only by a reassign or an escalation");
    expect(guard).toContain("a return to pending needs a new assignee");
    expect(guard).toContain("mb.status = 'active'");
  });
});

describe("migration 1114 escalation write (kept by 1120)", () => {
  const guard = flat(sql1120.slice(sql1120.indexOf("message_ack_request_update_guard()")));

  it("is the timer's alone: a person's session (a non-empty app.user_id) cannot write an escalation", () => {
    expect(guard).toContain(
      "v_escalation := NEW.status = 'escalated' AND OLD.status IN ('pending', 'escalated')",
    );
    expect(guard).toContain("IF v_escalation AND v_actor IS NOT NULL THEN");
    expect(guard).toContain("only the escalation timer escalates a request");
  });

  it("lets an escalation hand the request to the tier's user and start the next window now, like a reassign", () => {
    expect(guard).toContain("IF NEW.status <> 'pending' AND NOT v_escalation THEN");
    expect(guard).toContain("AND NOT (v_reassign OR v_escalation) THEN");
    expect(guard).toContain(
      "IF (v_reassign OR v_escalation) AND (NEW.window_started_at < OLD.window_started_at OR abs(extract(epoch FROM (NEW.window_started_at - now()))) > 300)",
    );
  });

  it("refuses a sender as the recipient and a window that does not end within the next 60 minutes", () => {
    expect(guard).toContain("IF NEW.assigned_user_id = NEW.requester_user_id THEN");
    expect(guard).toContain(
      "IF NEW.deadline_at <= now() OR NEW.deadline_at > now() + interval '60 minutes' THEN",
    );
  });

  it("stays SECURITY DEFINER with a pinned search_path, like 1107's guard", () => {
    expect(guard).toContain(
      "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp",
    );
  });

  it("keeps the transition table and the immutable columns of 1107", () => {
    for (const status of ACK_STATUSES.filter((s) => ACK_TRANSITIONS[s].length > 0)) {
      expect(guard).toContain(
        `WHEN '${status}' THEN NEW.status IN (${list(ACK_TRANSITIONS[status])})`,
      );
    }
    expect(guard).toContain("NEW.requested_at <> OLD.requested_at");
    expect(guard).toContain("NEW.version <> OLD.version + 1");
  });

  it("adds no table, grant or policy (the 1107 ones stand)", () => {
    expect(sql1114).not.toMatch(/CREATE TABLE|GRANT |CREATE POLICY|DROP /);
  });
});

describe("migration 1120 failed_unreachable write", () => {
  const guard = flat(sql1120.slice(sql1120.indexOf("message_ack_request_update_guard()")));

  it("is the delivery-failure handler's alone: a person's session (a non-empty app.user_id) cannot write it", () => {
    expect(guard).toContain(
      "IF NEW.status = 'failed_unreachable' AND OLD.status <> 'failed_unreachable' AND v_actor IS NOT NULL THEN",
    );
    expect(guard).toContain("only the delivery-failure handler marks a request unreachable");
  });

  it("changes nothing else: the 1114 escalation rule, the version rule and SECURITY DEFINER stay", () => {
    expect(guard).toContain("IF v_escalation AND v_actor IS NOT NULL THEN");
    expect(guard).toContain("NEW.version <> OLD.version + 1");
    expect(guard).toContain(
      "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp",
    );
  });

  it("adds no table, grant, policy, enum value or drop", () => {
    expect(sql1120).not.toMatch(/CREATE TABLE|GRANT |CREATE POLICY|DROP |ALTER TYPE/);
  });
});

describe("migration 1107 insert guard", () => {
  const guard = flat(sql.slice(sql.indexOf("message_ack_request_insert_guard()")));

  it("requires the author as requester, a live message, a pending first window and an active assignee", () => {
    expect(guard).toContain("NEW.requester_user_id IS DISTINCT FROM v_author");
    expect(guard).toContain("v_status = 'deleted'");
    expect(guard).toContain("NEW.status <> 'pending' OR NEW.version <> 0 OR NEW.current_tier <> 0");
    expect(guard).toContain("mb.status = 'active'");
  });

  it("takes the patient from the care-team channel and starts the window now", () => {
    expect(guard).toContain(
      "v_kind IS DISTINCT FROM 'care_team' OR v_subject IS DISTINCT FROM NEW.patient_id",
    );
    expect(guard).toContain("abs(extract(epoch FROM (NEW.requested_at - now()))) > 300");
  });

  it("gives the critical class no writer and ties the urgent class to the named recipient", () => {
    expect(guard).toContain("NEW.ack_class = 'critical_symptom'");
    expect(guard).toContain("(v_urgency = 'urgent') <> (NEW.ack_class = 'urgent')");
    expect(guard).toContain("NEW.assigned_user_id IS DISTINCT FROM v_recipient");
  });

  it("lets a replay through to the caller's ON CONFLICT instead of refusing it", () => {
    expect(guard).toContain(
      "IF EXISTS (SELECT 1 FROM message_acknowledgment_request r WHERE r.organization_id = NEW.organization_id AND r.message_id = NEW.message_id) THEN RETURN NEW;",
    );
  });
});

describe("migration 1107 deadline maximum", () => {
  it("pins the per-class window maximum to the platform policy constants", () => {
    const check = flat(sql.slice(sql.indexOf('CONSTRAINT "message_ack_request_window"')));
    for (const ackClass of ACK_CLASSES) {
      expect(check).toContain(
        `WHEN '${ackClass}' THEN interval '${ACK_DEADLINE_POLICY[ackClass].maxMinutes} minutes'`,
      );
    }
    expect(flat(read("packages/db/src/schema/messaging/message-acknowledgments.ts"))).toContain(
      "WHEN 'important' THEN interval '120 minutes' WHEN 'urgent' THEN interval '30 minutes' WHEN 'critical_symptom' THEN interval '10 minutes'",
    );
  });

  it("every default is within its maximum", () => {
    for (const ackClass of ACK_CLASSES) {
      const { defaultMinutes, maxMinutes } = ACK_DEADLINE_POLICY[ackClass];
      expect(defaultMinutes).toBeGreaterThan(0);
      expect(defaultMinutes).toBeLessThanOrEqual(maxMinutes);
    }
  });
});

describe("migration 1107 history, grants, tenancy", () => {
  it("refuses UPDATE for every role and DELETE for all but the destruction role on the event table", () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "message_acknowledgment_event"');
    // The destruction role is recognised by what survives a referential cascade (the session's own role), not only current_user.
    const guard = flat(sql);
    expect(guard).toContain("IF TG_OP = 'DELETE' AND (");
    expect(guard).toContain("current_user = 'wardenx_destruction'");
    expect(guard).toContain("current_setting('role', true) = 'wardenx_destruction'");
    expect(guard).toContain("pg_has_role(session_user, 'wardenx_destruction', 'MEMBER')");
    expect(guard).toContain("r.rolname = session_user");
  });

  it("guards every history INSERT: the session's own actor and the request's own resulting status", () => {
    expect(sql).toContain('BEFORE INSERT ON "message_acknowledgment_event"');
    const guard = flat(sql);
    expect(guard).toContain("message_ack_event_actor");
    expect(guard).toContain("NEW.to_status IS DISTINCT FROM v_status");
  });

  it("lets only the assignee hand an acknowledged request on", () => {
    expect(flat(sql)).toContain(
      "IF v_reassign AND OLD.status = 'acknowledged' AND v_actor IS NOT NULL AND v_actor <> OLD.assigned_user_id::text THEN",
    );
  });

  it("grants wardenx_app SELECT+INSERT on the history and no DELETE anywhere", () => {
    expect(sql).toContain('GRANT SELECT, INSERT ON "message_acknowledgment_event" TO wardenx_app;');
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON "message_acknowledgment_request" TO wardenx_app;',
    );
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO wardenx_app/);
    expect(sql).not.toMatch(/GRANT UPDATE[^;]*ON "message_acknowledgment_event"/);
  });

  it.each(["message_acknowledgment_request", "message_acknowledgment_event"])(
    "%s has RLS enabled and FORCED with an org-isolation policy and an audit trigger",
    (table) => {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(flat(sql)).toMatch(
        new RegExp(
          `ON "${table}" FOR ALL TO wardenx_app USING \\(organization_id = current_setting\\('app.org_id', true\\)::uuid\\)`,
        ),
      );
      expect(sql).toMatch(new RegExp(`AFTER INSERT OR UPDATE OR DELETE ON ${table}`));
    },
  );

  it("the request update grant lists only the transition columns", () => {
    const grant = flat(
      sql.slice(
        sql.indexOf('GRANT UPDATE ("status"'),
        sql.indexOf(
          'ON "message_acknowledgment_request" TO wardenx_app;',
          sql.indexOf('GRANT UPDATE ("status"'),
        ),
      ),
    );
    for (const immutable of [
      "organization_id",
      "message_id",
      "channel_id",
      "patient_id",
      "ack_class",
      "requester_user_id",
      "requested_at",
    ]) {
      expect(grant).not.toContain(`"${immutable}"`);
    }
  });

  it("guards the message: no tombstone while the request is open, no edit once a request exists", () => {
    expect(sql).toContain('CREATE TRIGGER "trg_message_ack_request_message_guard"');
    expect(flat(sql)).toContain("NEW.status = 'deleted' AND OLD.status <> 'deleted' AND EXISTS");
    expect(flat(sql)).toContain(
      "NEW.edited_at IS NOT NULL AND NEW.edited_at IS DISTINCT FROM OLD.edited_at",
    );
  });

  it("registers both tables as M36-owned in the manifest (.ts and .cjs)", () => {
    for (const file of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      const text = read(file);
      expect(text).toContain('"message_acknowledgment_request"');
      expect(text).toContain('"message_acknowledgment_event"');
    }
  });
});
