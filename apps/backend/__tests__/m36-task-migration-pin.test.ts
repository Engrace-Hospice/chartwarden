// WP 3.4 - the TypeScript closed unions are pinned to the CHECK lists in migration 1100 and to the Drizzle schema, and
// the structural guarantees the service relies on (idempotency index, no DELETE for wardenx_app, forced RLS, both audit
// triggers) are asserted on the migration text, so a change in one place without the others fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TASK_ACTIVE_STATUSES,
  TASK_ACTOR_KINDS,
  TASK_CLOSE_REASONS,
  TASK_EVENT_TYPES,
  TASK_SOURCE_KINDS,
  TASK_STATUSES,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const sql = readFileSync(
  join(root, "packages/db/migrations/1100_m36_communication_task.sql"),
  "utf8",
);
const drizzle = readFileSync(
  join(root, "packages/db/src/schema/messaging/communication-tasks.ts"),
  "utf8",
);
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

describe("closed unions agree with the CHECK lists in SQL and Drizzle", () => {
  it.each([
    ["status", TASK_STATUSES],
    ["reason", TASK_CLOSE_REASONS],
    ["event type", TASK_EVENT_TYPES],
    ["actor kind", TASK_ACTOR_KINDS],
  ] as const)("%s", (_name, values) => {
    // Whitespace-insensitive: the SQL wraps long lists across lines.
    const flat = (s: string) => s.replace(/\s+/g, " ");
    expect(flat(sql)).toContain(`IN (${list(values)})`);
    expect(flat(drizzle)).toContain(`IN (${list(values)})`);
  });

  it("the idempotency index covers exactly the active statuses, in SQL and Drizzle", () => {
    expect(sql).toContain(`WHERE "status" IN (${list(TASK_ACTIVE_STATUSES)})`);
    expect(drizzle).toContain(`IN (${list(TASK_ACTIVE_STATUSES)})`);
    expect(sql).toContain('CREATE UNIQUE INDEX "communication_task_active_per_assignee"');
  });
});

describe("migration 1100 structure", () => {
  it("names the same constraints the Drizzle schema declares", () => {
    for (const name of [
      "communication_task_status_shape",
      "communication_task_reason_shape",
      "communication_task_reason_only_when_closed",
      "communication_task_clinical_close_needs_reason",
      "communication_task_patient_is_clinical",
      "communication_task_closed_at_shape",
      "communication_task_event_type_shape",
      "communication_task_event_actor_shape",
      "communication_task_message_org_fk",
      "communication_task_event_task_fk",
      "communication_task_org_id_uq",
    ]) {
      expect(sql, `${name} in SQL`).toContain(`"${name}"`);
      expect(drizzle, `${name} in Drizzle`).toContain(`"${name}"`);
    }
  });

  it("cascades with the message and with the task", () => {
    expect(sql).toMatch(/REFERENCES "message"\("organization_id", "id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(
      /REFERENCES "communication_task"\("organization_id", "id"\) ON DELETE CASCADE/,
    );
  });

  it("forces RLS on both tables and gives wardenx_app no DELETE and no UPDATE on the event table", () => {
    for (const t of ["communication_task", "communication_task_event"]) {
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO wardenx_destruction`);
    }
    const appGrants = [...sql.matchAll(/GRANT ([A-Z, ]+?) ON "(\w+)" TO wardenx_app/g)].map(
      (m) => [m[2], m[1]] as const,
    );
    expect(appGrants).toEqual([
      ["communication_task", "SELECT, INSERT"],
      ["communication_task_event", "SELECT, INSERT"],
    ]);
  });

  it("UPDATE is column-level and excludes patient_id, created_by, message_id and channel_id", () => {
    const grant = /GRANT UPDATE \(([^)]+)\)\s+ON "communication_task" TO wardenx_app/.exec(sql);
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    expect(cols.sort()).toEqual(
      [
        "accepted_at",
        "assignee_id",
        "closed_at",
        "closed_reason",
        "needs_owner",
        "status",
        "updated_at",
        "version",
      ].sort(),
    );
    for (const frozen of [
      "patient_id",
      "created_by",
      "message_id",
      "channel_id",
      "clinical_concern",
      "organization_id",
    ])
      expect(cols).not.toContain(frozen);
  });

  it("carries a scrubbing audit trigger on the task and the generic one on the event", () => {
    expect(sql).toContain("audit_phi_write_communication_task");
    expect(sql).toContain("ARRAY['patient_id']");
    expect(sql).toMatch(
      /ON communication_task_event\s+FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger\(\)/,
    );
  });

  it("indexes the message cascade and makes closed rows final", () => {
    expect(sql).toMatch(
      /"communication_task_message_idx"\s+ON "communication_task" \("organization_id", "message_id"\)/,
    );
    expect(sql).toContain("trg_communication_task_closed_final");
    expect(sql).toContain("communication_task_closed");
  });

  it("stores no free text: no title, body or note column on either table", () => {
    expect(sql).not.toMatch(/"(title|body|note|notes|text|description|excerpt)"/);
  });
});

describe("migration 1104 (WP 3.10 source_kind)", () => {
  const medq = readFileSync(
    join(root, "packages/db/migrations/1104_m36_task_source_kind.sql"),
    "utf8",
  );
  const flat = (v: string) => v.replace(/\s+/g, " ");

  it("source_kind CHECK equals the TypeScript union, in SQL and Drizzle", () => {
    expect(flat(medq)).toContain(`"source_kind" IN (${list(TASK_SOURCE_KINDS)})`);
    expect(flat(drizzle)).toContain(`IN (${list(TASK_SOURCE_KINDS)})`);
  });

  it("forbids a medication-question task assigned to its own creator, in SQL and Drizzle", () => {
    expect(flat(medq)).toContain(
      `CHECK ("source_kind" <> 'medication_question' OR "assignee_id" <> "created_by")`,
    );
    for (const name of [
      "communication_task_source_kind_shape",
      "communication_task_medq_not_creator",
    ]) {
      expect(medq).toContain(`"${name}"`);
      expect(drizzle).toContain(`"${name}"`);
    }
  });

  it("defaults existing rows to 'message' and adds no grant, so source_kind stays out of the UPDATE grant", () => {
    expect(medq).toContain(`"source_kind" text DEFAULT 'message' NOT NULL`);
    expect(medq).not.toMatch(/\bGRANT\b\s+(?!--)/);
    const grant = /GRANT UPDATE \(([^)]+)\)\s+ON "communication_task" TO wardenx_app/.exec(sql);
    expect(grant?.[1]).not.toContain("source_kind");
  });

  it("stores no free text and adds no table", () => {
    expect(medq).not.toMatch(/CREATE TABLE/);
    expect(medq).not.toMatch(/"(title|body|note|notes|text|description|excerpt)"/);
  });
});
