// ADR-0089 S1 - migration 1147, the Drizzle schema, the manifest and the code-side constants agree; the structural promises (FORCEd RLS,
// two people, forward-only lifecycle, 24 h expiry on the database clock, download only by the requester against a ready unexpired job,
// no app DELETE, audit without free text) are pinned on the migration text. The behaviour is proven live in WP 5.7's live suite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPORT_LINK_TTL_HOURS,
  EXPORT_MAX_RANGE_DAYS,
  MESSAGING_EXPORT_DECISION_NOTE_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MIN,
  MESSAGING_EXPORT_SCOPE_KINDS,
  MESSAGING_EXPORT_STATUSES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1147_m36_export.sql"));
const schema = flat(read("packages/db/src/schema/messaging/message-export.ts"));
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const TABLES = ["message_export_job", "message_export_download"] as const;

describe("migration 1147 restricted export", () => {
  it("the closed sets and numeric bounds in the SQL CHECKs and the Drizzle CHECKs are the constants", () => {
    expect(sql).toContain(`CHECK ("scope_kind" IN (${inList(MESSAGING_EXPORT_SCOPE_KINDS)}))`);
    expect(schema).toContain(`IN (${inList(MESSAGING_EXPORT_SCOPE_KINDS)})`);
    expect(sql).toContain(`CHECK ("status" IN (${inList(MESSAGING_EXPORT_STATUSES)}))`);
    expect(schema).toContain(`IN (${inList(MESSAGING_EXPORT_STATUSES)})`);
    const range = `BETWEEN ${MESSAGING_EXPORT_JUSTIFICATION_MIN} AND ${MESSAGING_EXPORT_JUSTIFICATION_MAX}`;
    expect(sql).toContain(range);
    expect(schema).toContain(range);
    expect(sql).toContain(`"date_to" - "date_from" <= ${EXPORT_MAX_RANGE_DAYS}`);
    expect(schema).toContain(`- ${"${t.dateFrom}"} <= ${EXPORT_MAX_RANGE_DAYS}`);
    const ttl = `interval '${EXPORT_LINK_TTL_HOURS} hours'`;
    expect(sql).toContain(`"expires_at" = "ready_at" + ${ttl}`);
    expect(sql).toContain(`NEW.expires_at := NEW.ready_at + ${ttl}`);
    expect(schema).toContain(ttl);
    expect(sql).toContain(`char_length("decision_note") <= ${MESSAGING_EXPORT_DECISION_NOTE_MAX}`);
  });

  it("the scope is exactly one of channel or patient and the counts are non-negative", () => {
    expect(sql).toContain(
      `("scope_kind" = 'channel' AND "channel_id" IS NOT NULL AND "patient_id" IS NULL) OR ("scope_kind" = 'patient' AND "patient_id" IS NOT NULL AND "channel_id" IS NULL)`,
    );
    expect(sql).toContain('coalesce("message_count", 0) >= 0');
    expect(sql).toContain('"download_count" >= 0');
    expect(sql).toContain('("date_from" IS NULL) = ("date_to" IS NULL)');
  });

  it("every table has an org FK, FORCEd RLS on app.org_id and a destruction policy", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`CREATE TABLE "${t}"`);
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `CREATE POLICY "${t}_org_isolation" ON "${t}" FOR ALL TO chartwarden_app`,
      );
      expect(sql).toContain(
        `CREATE POLICY "${t}_destruction" ON "${t}" FOR ALL TO chartwarden_destruction`,
      );
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO chartwarden_destruction`);
    }
    expect(sql).toContain(
      "USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)",
    );
  });

  it("the app role never holds DELETE and updates only the lifecycle columns of the job, nothing on the trail", () => {
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
    const upd = /GRANT UPDATE \(([^)]*)\) ON "message_export_job" TO chartwarden_app/.exec(sql);
    expect(upd).not.toBeNull();
    const cols = (upd?.[1] ?? "").split(",").map((c) => c.trim().replace(/"/g, ""));
    for (const frozen of [
      "requested_by",
      "scope_kind",
      "channel_id",
      "patient_id",
      "date_from",
      "date_to",
      "justification",
      "requested_at",
    ]) {
      expect(cols).not.toContain(frozen);
    }
    expect(sql).toContain('GRANT SELECT, INSERT ON "message_export_download" TO chartwarden_app');
    expect(sql).not.toMatch(/GRANT [^;]*UPDATE[^;(]*ON "message_export_download"/);
  });

  it("two people, forward-only transitions and every instant from the database clock", () => {
    expect(sql).toContain('CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by")');
    for (const step of [
      "OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected')",
      "OLD.status = 'pending_approval' AND NEW.status = 'cancelled'",
      "OLD.status = 'approved' AND NEW.status = 'building'",
      "OLD.status = 'building' AND NEW.status = 'ready'",
      "OLD.status = 'building' AND NEW.status = 'failed'",
      "OLD.status = 'ready' AND NEW.status = 'expired'",
    ]) {
      expect(sql).toContain(step);
    }
    expect(sql).toContain("message_export_job_transition");
    expect(sql).toContain(
      "message_export_job_immutable: the scope, requester and justification cannot change",
    );
    for (const clock of [
      "NEW.requested_at := now()",
      "NEW.decided_at := now()",
      "NEW.building_at := now()",
      "NEW.ready_at := now()",
    ]) {
      expect(sql).toContain(clock);
    }
    expect(sql).toContain("IF OLD.expires_at > now() THEN");
    expect(sql).toContain("NEW.wrapped_dek := NULL");
  });

  it("a download is recorded only by the requester against a ready, unexpired job", () => {
    expect(sql).toContain(
      "NEW.user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid",
    );
    expect(sql).toContain(
      "j.requested_by = NEW.user_id AND j.status = 'ready' AND j.expires_at > now()",
    );
    expect(sql).toContain("NEW.downloaded_at := now()");
    expect(sql).toContain(
      'CREATE TRIGGER "trg_message_export_download_guard" BEFORE INSERT ON "message_export_download"',
    );
  });

  it("every guard is SECURITY INVOKER and the audit functions leave the free text and the wrapped key out", () => {
    for (const fn of ["message_export_job_guard", "message_export_download_guard"]) {
      expect(sql).toMatch(
        new RegExp(`${fn}\\(\\) RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER`),
      );
    }
    expect(sql).toContain("to_jsonb(NEW) - 'justification' - 'decision_note' - 'wrapped_dek'");
    expect(sql).toContain("OWNER TO chartwarden_audit_writer");
    for (const t of TABLES) expect(sql).toContain(`CREATE TRIGGER "trg_audit_${t}"`);
  });

  it("the three permissions are seeded and granted to compliance_officer, administrator and org_admin only", () => {
    for (const a of ["request", "approve", "download"]) {
      expect(sql).toContain(
        `'messaging.export.${a}', 'message_export', '${a}', 'compliance', 'none'`,
      );
      const block = new RegExp(
        `SELECT r\\."organization_id", r\\."id", 'messaging\\.export\\.${a}' FROM "role" r WHERE r\\."key" IN \\(([^)]*)\\)`,
      ).exec(sql);
      expect(block, a).not.toBeNull();
      const keys = (block?.[1] ?? "").split(",").map((k) => k.trim().replace(/'/g, ""));
      expect(keys.sort()).toEqual(["administrator", "compliance_officer", "org_admin"]);
    }
  });

  it("the manifest (.ts and .cjs) owns both tables and the tenancy gate allows the download guard", () => {
    for (const f of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      const m = read(f);
      for (const t of TABLES) expect(m, `${f} ${t}`).toContain(`"${t}"`);
    }
    expect(read("scripts/check-tenancy.ts")).toContain("message_export_download_guard");
  });
});
