// ADR-0099 S1 - migrations 1233 / 1234, the Drizzle schema, the manifest, the enum mirrors, the permission mirrors and the code-side constants agree. The structural
// promises (FORCEd RLS, no app DELETE, hashes only, the 30 day / 12 hour / 5 attempt bounds, a block lifted by a second person, an access trail the database
// refuses for a dead invitation, audit without secrets, permissions only to the named roles) are pinned on the migration text. Behaviour is proven live.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { M36_CONTRIBUTED_PERMISSIONS } from "@chartwarden/auth";
import {
  FAMILY_ACCESS_ACTIONS,
  FAMILY_INVITE_MAX_DAYS,
  FAMILY_MANAGE_PERMISSION,
  FAMILY_MAX_CODE_ATTEMPTS,
  FAMILY_MODES,
  FAMILY_RESPOND_PERMISSION,
  FAMILY_REVOKE_REASONS,
  FAMILY_SESSION_IDLE_MINUTES,
  FAMILY_SESSION_MAX_HOURS,
  FAMILY_SESSION_STAGES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const enumSql = flat(read("packages/db/migrations/1233_m36_family_enum_values.sql"));
const sql = flat(read("packages/db/migrations/1234_m36_family_messaging.sql"));
const schema = flat(read("packages/db/src/schema/messaging/message-family.ts"));
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");

const TABLES = [
  "message_family_setting",
  "message_family_contact",
  "message_family_invitation",
  "message_family_session",
  "message_family_access",
] as const;

describe("migration 1233 enum values", () => {
  it("adds only the two values, and the Drizzle enums and the type mirrors carry them", () => {
    expect(enumSql).toContain(
      `ALTER TYPE "public"."channel_kind" ADD VALUE IF NOT EXISTS 'family'`,
    );
    expect(enumSql).toContain(
      `ALTER TYPE "public"."message_author_kind" ADD VALUE IF NOT EXISTS 'family_contact'`,
    );
    expect(enumSql.match(/ADD VALUE/g)?.length).toBe(2);
    expect(flat(read("packages/db/src/enums.ts"))).toContain('"family", // subject = patient_id');
    expect(flat(read("packages/db/src/enums.ts"))).toContain(
      '["user", "system", "family_contact"]',
    );
    expect(flat(read("packages/messaging/src/interfaces/kinds.ts"))).toContain('| "family"');
  });

  it("the new values are never used in the same migration that adds them", () => {
    expect(sql).not.toContain("'family_contact'");
    expect(sql).not.toMatch(/channel_kind\s*=\s*'family'/);
  });
});

describe("migration 1235 eligibility functions", () => {
  const fn = flat(read("packages/db/migrations/1235_m36_family_eligibility_functions.sql"));
  it("are SECURITY INVOKER, STABLE, bound to app.org_id, and read consent, Part 2 and involvement on the database clock", () => {
    expect(fn.match(/LANGUAGE sql STABLE SECURITY INVOKER/g)?.length).toBe(3);
    expect(fn).not.toContain("SECURITY DEFINER");
    expect(
      fn.match(/nullif\(current_setting\('app.org_id', true\), ''\)::uuid/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    for (const needle of [
      "pc.involvement_from > current_date",
      "pc.involvement_to < current_date",
      "f.invalidated_at IS NULL AND NOT ('sud' = ANY(f.flags))",
      "da.revoked_at IS NULL AND da.effective_from <= now()",
      "cr.revoked_at IS NULL",
      "cr.expires_at IS NULL OR cr.expires_at > now()",
      "cr.patient_id = pc.patient_id",
      "cr.survives_death = true",
      "make_interval(months => 13)",
    ]) {
      expect(fn, needle).toContain(needle);
    }
  });
});

describe("migration 1234 family messaging", () => {
  it("the closed sets and numeric bounds in the SQL and Drizzle CHECKs are the constants", () => {
    expect(sql).toContain(`CHECK ("mode" IN (${inList(FAMILY_MODES)}))`);
    expect(sql).toContain(`CHECK ("stage" IN (${inList(FAMILY_SESSION_STAGES)}))`);
    expect(sql).toContain(`IN (${inList(FAMILY_REVOKE_REASONS)})`);
    expect(sql).toContain(`CHECK ("action" IN (${inList(FAMILY_ACCESS_ACTIONS)}))`);
    expect(schema).toContain(`IN (${inList(FAMILY_MODES)})`);
    expect(schema).toContain(`IN (${inList(FAMILY_SESSION_STAGES)})`);
    expect(schema).toContain(`IN (${inList(FAMILY_REVOKE_REASONS)})`);
    expect(schema).toContain(`IN (${inList(FAMILY_ACCESS_ACTIONS)})`);
    expect(sql).toContain(`"created_at" + interval '${FAMILY_INVITE_MAX_DAYS} days'`);
    expect(schema).toContain(`interval '${FAMILY_INVITE_MAX_DAYS} days'`);
    expect(sql).toContain(`"code_attempts" BETWEEN 0 AND ${FAMILY_MAX_CODE_ATTEMPTS}`);
    expect(schema).toContain(`BETWEEN 0 AND ${FAMILY_MAX_CODE_ATTEMPTS}`);
  });

  it("every table has an org FK, FORCEd RLS on app.org_id, a destruction policy and an audit trigger", () => {
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
      expect(sql).toContain(
        `"organization_id" uuid ${t === "message_family_setting" ? "PRIMARY KEY " : ""}NOT NULL REFERENCES "organization"("id")`,
      );
      expect(sql).toContain(`CREATE TRIGGER "trg_audit_${t}"`);
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO chartwarden_destruction`);
    }
    expect(sql).not.toMatch(/GRANT [^;]*DELETE[^;]*TO chartwarden_app/);
  });

  it("the table that carries a patient also carries the nullable provider_entity_id / location_id of the three-column rule", () => {
    expect(sql).toContain('"provider_entity_id" uuid REFERENCES "provider_entity"("id")');
    expect(sql).toContain('"location_id" uuid REFERENCES "location"("id")');
    expect(schema).toContain('providerEntityId: uuid("provider_entity_id")');
    expect(schema).toContain('locationId: uuid("location_id")');
  });

  it("the app role updates only the lifecycle columns and the access trail never updates", () => {
    expect(sql).toContain(
      'GRANT UPDATE ("revoked_at", "revoked_by", "revoke_reason", "invite_redeemed_at", "code_attempts") ON "message_family_invitation" TO chartwarden_app',
    );
    expect(sql).toContain(
      'GRANT UPDATE ("stage", "activated_at", "token_hash", "last_seen_at") ON "message_family_session" TO chartwarden_app',
    );
    expect(sql).toContain('GRANT SELECT, INSERT ON "message_family_access" TO chartwarden_app');
    expect(sql).not.toMatch(/GRANT UPDATE[^;]*"message_family_access"/);
    // The hashes can never be rewritten by the app role.
    expect(sql).not.toMatch(/GRANT UPDATE \([^)]*"(invite_token_hash|code_hash)"/);
  });

  it("secrets are hashes only and are left out of the audit rows, which scrub the patient and caregiver ids", () => {
    expect(sql).toContain('"invite_token_hash" text NOT NULL');
    expect(sql).toContain('"code_hash" text NOT NULL');
    expect(sql).toContain('"token_hash" text NOT NULL');
    expect(sql).not.toMatch(/"(invite_token|token|code)" text/);
    expect(sql).toContain(
      "- 'invite_token_hash' - 'code_hash' - 'token_hash', ARRAY['patient_id','patient_caregiver_id']",
    );
    expect(sql).not.toMatch(/"(body|message_text|text)" text/);
  });

  it("the guards bind the acting staff member, the link is single use, a block is lifted by a second person", () => {
    expect(sql).toContain("a contact is recorded only by the staff member who invites");
    expect(sql).toContain("an invitation is recorded only by its creator");
    expect(sql).toContain("an invitation is revoked once, by the acting staff member");
    expect(sql).toContain("the link is single use");
    expect(sql).toContain("a block is lifted by a second person");
    expect(sql).toContain(
      "a session needs a live, redeemed invitation and cannot outlive it or 12 hours",
    );
    expect(sql).toContain("the conversation is named once");
    expect(
      sql.match(
        /FUNCTION message_family_\w+_guard\(\) RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER/g,
      )?.length,
    ).toBe(5);
  });

  it("session life is pinned to the constants and the access guard refuses a dead invitation or a blocked contact", () => {
    const hours = `interval '${FAMILY_SESSION_MAX_HOURS} hours'`;
    expect(sql).toContain(`CHECK ("expires_at" <= "created_at" + ${hours})`);
    expect(sql).toContain(`NEW.expires_at <= now() + ${hours}`);
    expect(schema).toContain(hours);
    expect(sql).toContain(
      `x.last_seen_at > now() - interval '${FAMILY_SESSION_IDLE_MINUTES} minutes'`,
    );
    expect(sql).toContain("i.revoked_at IS NULL AND i.expires_at > now() AND c.blocked_at IS NULL");
  });

  it("at most one live invitation per contact, and the bearer rotates with the stage", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "message_family_invitation_one_live" ON "message_family_invitation" ("organization_id", "contact_id") WHERE "revoked_at" IS NULL',
    );
    expect(sql).toContain("enrolment -> active rotates the bearer, once");
  });

  it("grants the two permissions only to the named roles and mirrors them in the catalogue", () => {
    expect(sql).toContain(
      "'messaging.family.manage', 'message_family_contact', 'manage', 'compliance'",
    );
    expect(sql).toContain("'messaging.family.respond'");
    expect(sql).toContain(
      "'clinical_supervisor', 'msw', 'bereavement_coordinator', 'compliance_officer', 'administrator', 'org_admin'",
    );
    expect(sql).not.toMatch(/'aide'|'chha'|'volunteer'/);
    expect(M36_CONTRIBUTED_PERMISSIONS[FAMILY_MANAGE_PERMISSION]).toMatchObject({
      abac: "none",
      resource: "message_family_contact",
    });
    expect(M36_CONTRIBUTED_PERMISSIONS[FAMILY_RESPOND_PERMISSION]).toMatchObject({
      abac: "none",
      resource: "message_family_contact",
    });
  });

  it("the manifest (both mirrors) owns exactly these tables", () => {
    for (const file of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
      const manifest = read(file);
      for (const t of TABLES) expect(manifest, `${file} ${t}`).toContain(`"${t}"`);
    }
  });
});
