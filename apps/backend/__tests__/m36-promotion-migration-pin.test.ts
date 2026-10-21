// WP 3.7 - the TypeScript closed unions are pinned to the CHECK lists in migration 1102 and to the Drizzle schema, and the
// structural guarantees the service relies on (one-proposed index, plain lookup indexes, the two guard triggers, no DELETE
// for wardenx_app, column-level UPDATE, forced RLS, the scrubbing audit trigger, the M8 / M14 attribution columns and unique
// indexes) are asserted on the migration text, so a change in one place without the others fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHART_PROMOTION_REASON_CODES,
  CHART_PROMOTION_STATUSES,
  CHART_PROMOTION_TARGETS,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const sql = readFileSync(
  join(root, "packages/db/migrations/1102_m36_m8_m14_chart_promotion.sql"),
  "utf8",
);
const read = (p: string) => readFileSync(join(root, p), "utf8");
const drizzle = read("packages/db/src/schema/messaging/chart-promotion-requests.ts");
const m8Drizzle = read("packages/db/src/schema/encounter/encounter-addenda.ts");
const m14Drizzle = read("packages/db/src/schema/idg/idg-agenda-items.ts");
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
const flat = (s: string) => s.replace(/\s+/g, " ");
const code = sql.replace(/^--.*$/gm, "");
const tableDdl =
  /CREATE TABLE "chart_promotion_request" \(([\s\S]*?)\);--> statement-breakpoint/.exec(sql)?.[1] ??
  "";

describe("closed unions agree with the CHECK lists in SQL and Drizzle", () => {
  it.each([
    ["status", CHART_PROMOTION_STATUSES],
    ["reason code", CHART_PROMOTION_REASON_CODES],
  ] as const)("%s", (_name, values) => {
    expect(flat(sql)).toContain(`IN (${list(values)})`);
    expect(flat(drizzle)).toContain(`IN (${list(values)})`);
  });

  it("the target pairs are exactly CHART_PROMOTION_TARGETS", () => {
    const pairs = CHART_PROMOTION_TARGETS.map((t) => `('${t.module}', '${t.kind}')`).join(", ");
    expect(flat(sql)).toContain(`("target_module", "target_kind") IN (${pairs})`);
    expect(flat(drizzle)).toContain(`IN (${pairs})`);
  });
});

describe("migration 1102 structure", () => {
  it("names the same constraints and indexes the Drizzle schema declares", () => {
    for (const name of [
      "chart_promotion_request_org_id_uq",
      "chart_promotion_request_target",
      "chart_promotion_request_suggested_ref",
      "chart_promotion_request_status_shape",
      "chart_promotion_request_sha_shape",
      "chart_promotion_request_accepted_shape",
      "chart_promotion_request_decided_shape",
      "chart_promotion_request_closed_shape",
      "chart_promotion_request_reason_shape",
      "chart_promotion_request_reason_by_status",
      "chart_promotion_request_one_proposed",
      "chart_promotion_request_message_idx",
      "chart_promotion_request_patient_idx",
      "chart_promotion_request_requester_idx",
    ]) {
      expect(sql, `${name} in SQL`).toContain(`"${name}"`);
      expect(drizzle, `${name} in Drizzle`).toContain(`"${name}"`);
    }
  });

  it("the partial unique index is the one-proposed arbiter and the lookup indexes are plain", () => {
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "chart_promotion_request_one_proposed" ON "chart_promotion_request" ("organization_id", "message_id", "target_module", "target_kind") WHERE "status" = \'proposed\'',
    );
    expect(flat(sql)).toMatch(
      /CREATE INDEX "chart_promotion_request_message_idx" ON "chart_promotion_request" \("organization_id", "message_id"\);/,
    );
  });

  it("has an insert guard (born proposed) and an update guard (final states, immutable identity)", () => {
    expect(sql).toMatch(/BEFORE INSERT ON chart_promotion_request/);
    expect(sql).toContain("chart_promotion_insert_state:");
    expect(sql).toMatch(/BEFORE UPDATE ON chart_promotion_request/);
    expect(sql).toContain("chart_promotion_final:");
    expect(sql).toContain("chart_promotion_closed:");
    expect(sql).toContain("chart_promotion_immutable:");
    expect(flat(sql)).toContain("OLD.status IN ('accepted', 'rejected')");
    expect(flat(sql)).toContain("NEW.status IS DISTINCT FROM 'accepted'");
  });

  it("forces RLS, gives wardenx_app no DELETE and a column-level UPDATE that excludes identity", () => {
    expect(sql).toContain('ALTER TABLE "chart_promotion_request" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "chart_promotion_request" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'GRANT SELECT, DELETE ON "chart_promotion_request" TO wardenx_destruction',
    );
    const appGrants = [...sql.matchAll(/GRANT ([A-Z, ]+?) ON "(\w+)" TO wardenx_app/g)].map((m) => [
      m[2],
      m[1],
    ]);
    expect(appGrants).toEqual([["chart_promotion_request", "SELECT, INSERT"]]);
    const grant = /GRANT UPDATE \(([^)]+)\)\s+ON "chart_promotion_request" TO wardenx_app/.exec(
      sql,
    );
    const cols = (grant?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    expect([...cols].sort()).toEqual(
      [
        "closed_at",
        "decided_at",
        "decided_by_user_id",
        "reason_code",
        "result_ref",
        "status",
        "updated_at",
        "version",
      ].sort(),
    );
    for (const frozen of [
      "message_id",
      "patient_id",
      "target_module",
      "source_body_sha256",
      "requested_by_user_id",
    ]) {
      expect(cols).not.toContain(frozen);
    }
  });

  it("scrubs the patient and the body hash from the audit trigger", () => {
    expect(sql).toContain("audit_phi_write_chart_promotion_request");
    expect(sql).toContain("ARRAY['patient_id','source_body_sha256']");
  });

  it("stores no free text: no title, body, note or summary column on the table", () => {
    expect(tableDdl.length).toBeGreaterThan(500);
    expect(tableDdl.replace(/^\s*--.*$/gm, "")).not.toMatch(
      /"(title|body|note|notes|text|description|excerpt|summary)"/,
    );
  });
});

describe("messaging.promote grant", () => {
  it("inserts the permission row and grants it to clinical roles, never aides or compliance", () => {
    expect(sql).toContain(
      "('messaging.promote', 'chart_promotion', 'request', 'clinical', 'none', '')",
    );
    const grant = /WHERE r\."key" IN \(([^)]*)\)/.exec(code)?.[1] ?? "";
    const keys = [...grant.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(
      expect.arrayContaining([
        "rn",
        "lpn",
        "physician",
        "np",
        "msw",
        "chaplain",
        "medical_director",
      ]),
    );
    for (const never of [
      "chha",
      "hospice_aide",
      "volunteer",
      "compliance_officer",
      "org_admin",
      "administrator",
    ]) {
      expect(keys).not.toContain(never);
    }
  });
});

describe("M8 and M14 attribution columns", () => {
  it.each([
    ["encounter_addendum", "encounter_addendum_promotion", m8Drizzle],
    ["idg_agenda_item", "idg_agenda_item_promotion", m14Drizzle],
  ])("%s carries five all-or-none, immutable attribution columns", (table, prefix, schemaSrc) => {
    for (const col of [
      "promotion_request_id",
      "source_message_id",
      "source_author_user_id",
      "source_sent_at",
      "source_body_sha256",
    ]) {
      expect(sql).toContain(`ADD COLUMN "${col}"`);
    }
    for (const name of [`${prefix}_shape`, `${prefix}_sha_shape`, `${prefix}_uq`]) {
      expect(sql, name).toContain(`"${name}"`);
      expect(schemaSrc, name).toContain(`"${name}"`);
    }
    expect(sql).toContain(`${table}_promotion_immutable:`);
    expect(sql).toContain(`${table}_promotion_source:`);
  });

  it("each partial unique index allows one live record per proposal", () => {
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "encounter_addendum_promotion_uq" ON "encounter_addendum" ("organization_id", "promotion_request_id") WHERE "promotion_request_id" IS NOT NULL AND "status" <> \'voided\'',
    );
    expect(flat(sql)).toContain(
      'CREATE UNIQUE INDEX "idg_agenda_item_promotion_uq" ON "idg_agenda_item" ("organization_id", "promotion_request_id") WHERE "promotion_request_id" IS NOT NULL',
    );
  });

  it("an agenda item that names a proposal must name a patient", () => {
    expect(sql).toContain('CHECK ("promotion_request_id" IS NULL OR "patient_id" IS NOT NULL)');
  });
});

describe("race guards (review M1)", () => {
  it("both INSERT guards take a share lock on the proposal row they check", () => {
    expect(code.match(/FOR SHARE OF p/g)?.length).toBeGreaterThanOrEqual(3);
    const addendumGuard =
      /FUNCTION encounter_addendum_promotion_guard\(\)[\s\S]*?END \$\$;/.exec(code)?.[0] ?? "";
    const agendaGuard =
      /FUNCTION idg_agenda_item_promotion_guard\(\)[\s\S]*?END \$\$;/.exec(code)?.[0] ?? "";
    expect(addendumGuard.match(/FOR SHARE OF p/g)?.length).toBe(2);
    expect(agendaGuard.match(/FOR SHARE OF p/g)).toHaveLength(1);
  });

  it("signing an attributed addendum re-checks the proposal is still open (never rejected or accepted)", () => {
    const guard = flat(
      /FUNCTION encounter_addendum_promotion_guard\(\)[\s\S]*?END \$\$;/.exec(code)?.[0] ?? "",
    );
    expect(guard).toContain("NEW.status = 'signed' AND OLD.status IS DISTINCT FROM 'signed'");
    expect(guard).toContain("p.status IN ('proposed', 'withdrawn', 'superseded')");
    expect(guard).not.toMatch(/IN \([^)]*'rejected'/);
  });
});
