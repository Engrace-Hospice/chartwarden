// WP 3.5 - the TypeScript closed unions and policy bounds are pinned to the CHECK lists in migration 1101 and to the
// Drizzle schema, and the structural guarantees the service relies on (pair and one-pending indexes, plain cascade index,
// the two guard triggers, no DELETE for wardenx_app, column-level UPDATE, forced RLS, scrubbing audit trigger) are asserted
// on the migration text, so a change in one place without the others fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HANDOFF_ACTOR_KINDS,
  HANDOFF_CLOSE_REASONS,
  HANDOFF_EVENT_TYPES,
  HANDOFF_EXPIRY_MIN_MINUTES,
  HANDOFF_EXPIRY_PLATFORM_MINUTES,
  HANDOFF_ITEM_KINDS,
  HANDOFF_ITEM_STATES,
  HANDOFF_STATES,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const sql = readFileSync(
  join(root, "packages/db/migrations/1101_m36_clinical_handoff.sql"),
  "utf8",
);
const drizzle = readFileSync(
  join(root, "packages/db/src/schema/messaging/clinical-handoffs.ts"),
  "utf8",
);
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("closed unions agree with the CHECK lists in SQL and Drizzle", () => {
  it.each([
    ["handoff state", HANDOFF_STATES],
    ["item state", HANDOFF_ITEM_STATES],
    ["item kind", HANDOFF_ITEM_KINDS],
    ["close reason", HANDOFF_CLOSE_REASONS],
    ["event type", HANDOFF_EVENT_TYPES],
    ["actor kind", HANDOFF_ACTOR_KINDS],
  ] as const)("%s", (_name, values) => {
    expect(flat(sql)).toContain(`IN (${list(values)})`);
    expect(flat(drizzle)).toContain(`IN (${list(values)})`);
  });
});

describe("policy bounds", () => {
  it("the SQL and Drizzle CHECK pin the same range as HANDOFF_EXPIRY_*", () => {
    const range = `BETWEEN ${HANDOFF_EXPIRY_MIN_MINUTES} AND ${HANDOFF_EXPIRY_PLATFORM_MINUTES}`;
    expect(sql).toContain(`CHECK ("expiry_minutes" ${range})`);
    expect(drizzle).toContain(range);
  });
});

describe("migration 1101 structure", () => {
  it("names the same constraints and indexes the Drizzle schema declares", () => {
    for (const name of [
      "clinical_handoff_org_id_uq",
      "clinical_handoff_state_shape",
      "clinical_handoff_parties",
      "clinical_handoff_deadline",
      "clinical_handoff_reason_shape",
      "clinical_handoff_closed_shape",
      "clinical_handoff_accepted_shape",
      "clinical_handoff_open_per_pair",
      "clinical_handoff_item_handoff_fk",
      "clinical_handoff_item_kind_shape",
      "clinical_handoff_item_state_shape",
      "clinical_handoff_item_resolved_shape",
      "clinical_handoff_item_patient_anchor",
      "clinical_handoff_item_unique_in_handoff",
      "clinical_handoff_item_one_pending",
      "clinical_handoff_item_handoff_idx",
      "clinical_handoff_item_patient_idx",
      "clinical_handoff_event_handoff_fk",
      "clinical_handoff_event_type_shape",
      "clinical_handoff_event_actor_shape",
      "tenant_handoff_policy_expiry",
    ]) {
      expect(sql, `${name} in SQL`).toContain(`"${name}"`);
      expect(drizzle, `${name} in Drizzle`).toContain(`"${name}"`);
    }
  });

  it("the pair index is the open-handoff arbiter and the item index is the one-pending arbiter", () => {
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "clinical_handoff_open_per_pair" ON "clinical_handoff" ("organization_id", "from_user_id", "to_user_id") WHERE "state" = \'offered\'',
    );
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "clinical_handoff_item_one_pending" ON "clinical_handoff_item" ("organization_id", "item_kind", "ref_id") WHERE "state" = \'pending\'',
    );
  });

  it("serves the cascade with a plain, NON-partial (organization_id, handoff_id) index", () => {
    expect(flat(sql)).toMatch(
      /CREATE INDEX "clinical_handoff_item_handoff_idx" ON "clinical_handoff_item" \("organization_id", "handoff_id"\);/,
    );
    expect(flat(sql)).toMatch(
      /CREATE INDEX "clinical_handoff_event_handoff_idx" ON "clinical_handoff_event" \("organization_id", "handoff_id", "created_at"\);/,
    );
    expect(sql).toMatch(
      /REFERENCES "clinical_handoff"\("organization_id", "id"\) ON DELETE CASCADE/,
    );
  });

  it("makes a closed handoff and a resolved item final, and guards accountability", () => {
    expect(sql).toContain("trg_clinical_handoff_closed_final");
    expect(sql).toContain("clinical_handoff_closed:");
    expect(sql).toContain("trg_clinical_handoff_item_guard");
    expect(sql).toContain("clinical_handoff_item_final:");
    expect(sql).toContain("clinical_handoff_item_accountability:");
    expect(flat(sql)).toContain("NEW.accountable_user_id IS DISTINCT FROM v_to");
    expect(flat(sql)).toContain("NEW.accountable_user_id IS DISTINCT FROM OLD.accountable_user_id");
  });

  it("makes a new item pending and owned by the offering sender (BEFORE INSERT guard)", () => {
    expect(sql).toContain("trg_clinical_handoff_item_insert_guard");
    expect(sql).toMatch(/BEFORE INSERT ON clinical_handoff_item/);
    expect(sql).toContain("clinical_handoff_item_insert_state:");
    expect(sql).toContain("clinical_handoff_item_insert_accountability:");
    expect(flat(sql)).toContain("NEW.state IS DISTINCT FROM 'pending'");
    expect(flat(sql)).toContain("NEW.accountable_user_id IS DISTINCT FROM v_from");
  });

  it("forces RLS everywhere and gives wardenx_app no DELETE on the three handoff tables", () => {
    for (const t of [
      "clinical_handoff",
      "clinical_handoff_item",
      "clinical_handoff_event",
      "tenant_handoff_policy",
    ]) {
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO wardenx_destruction`);
    }
    const appGrants = [...sql.matchAll(/GRANT ([A-Z, ]+?) ON "(\w+)" TO wardenx_app/g)].map(
      (m) => [m[2], m[1]] as const,
    );
    expect(appGrants).toEqual([
      ["clinical_handoff", "SELECT, INSERT"],
      ["clinical_handoff_item", "SELECT, INSERT"],
      ["clinical_handoff_event", "SELECT, INSERT"],
      ["tenant_handoff_policy", "SELECT, INSERT, UPDATE, DELETE"],
    ]);
  });

  it.each([
    [
      "clinical_handoff",
      ["accepted_at", "closed_at", "closed_reason", "state", "updated_at", "version"],
      ["from_user_id", "to_user_id", "expires_at", "offered_at", "organization_id"],
    ],
    [
      "clinical_handoff_item",
      ["accountable_user_id", "resolved_at", "state"],
      ["patient_id", "ref_id", "item_kind", "handoff_id", "organization_id"],
    ],
  ])("UPDATE on %s is column-level and excludes the identity columns", (table, allowed, frozen) => {
    const grant = new RegExp(`GRANT UPDATE \\(([^)]+)\\)\\s+ON "${table}" TO wardenx_app`).exec(
      sql,
    );
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    expect([...cols].sort()).toEqual([...allowed].sort());
    for (const col of frozen) expect(cols).not.toContain(col);
  });

  it("scrubs the patient and the work item from the item audit trigger; the others are id/enum only", () => {
    expect(sql).toContain("audit_phi_write_clinical_handoff_item");
    expect(sql).toContain("ARRAY['patient_id','ref_id']");
    expect(sql).toMatch(
      /ON clinical_handoff\s+FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger\(\)/,
    );
    expect(sql).toMatch(
      /ON clinical_handoff_event\s+FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger\(\)/,
    );
    expect(sql).toContain("trg_audit_tenant_handoff_policy");
  });

  it("stores no free text: no title, body, note or summary column on any table", () => {
    const code = sql.replace(/^--.*$/gm, "");
    expect(code).not.toMatch(/"(title|body|note|notes|text|description|excerpt|summary)"/);
  });
});
