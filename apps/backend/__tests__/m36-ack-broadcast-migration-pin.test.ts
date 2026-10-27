// ADR-0097 - migration 1200, the Drizzle schema, the manifest and the flag constant agree; the structural promises (FORCEd RLS, no app
// DELETE, the only UPDATE is the acknowledgment instant, guards, audit without names or text) are pinned on the migration text.
// Behaviour is proven live (m36-ack-broadcast.live.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACK_BROADCAST_FLAG_KEY } from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1200_m36_ack_broadcast.sql"));
const sql1202 = flat(
  read("packages/db/migrations/1202_m36_ack_broadcast_withdraw_deadline_death_board_stall.sql"),
);
const schema = flat(read("packages/db/src/schema/messaging/message-ack-broadcast.ts"));
const TABLES = ["message_ack_broadcast", "message_ack_broadcast_recipient"] as const;

describe("migration 1200 acknowledge-required broadcast", () => {
  it("both tables are FORCEd, org-isolated, three-column, in the manifest (.ts and .cjs) and the Drizzle schema", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `CREATE POLICY "${t}_org_isolation" ON "${t}" FOR ALL TO chartwarden_app`,
      );
      expect(sql).toContain(
        `CREATE TABLE "${t}" ( "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "organization_id" uuid NOT NULL`,
      );
      expect(schema).toContain(`"${t}"`);
      expect(sql).toContain(`trg_audit_${t}`);
      for (const f of ["architecture/module-manifest.ts", "architecture/module-manifest.cjs"]) {
        expect(read(f)).toContain(`"${t}"`);
      }
    }
  });

  it("the app role never deletes, never updates a broadcast, and updates only the acknowledgment instant", () => {
    expect(sql).not.toMatch(/GRANT [^;]*DELETE/);
    expect(sql).toContain(`GRANT SELECT, INSERT ON "message_ack_broadcast" TO chartwarden_app`);
    expect(sql).toContain(
      `GRANT UPDATE ("acknowledged_at") ON "message_ack_broadcast_recipient" TO chartwarden_app`,
    );
    expect(sql).not.toMatch(/GRANT UPDATE[^;]*ON "message_ack_broadcast" /);
  });

  it("the guards pin the database clock, self-only acknowledgment, once, and an author-only broadcast", () => {
    expect(sql).toContain("NEW.acknowledged_at := now()");
    expect(sql).toContain("message_ack_broadcast_recipient_self");
    expect(sql).toContain("message_ack_broadcast_recipient_once");
    expect(sql).toContain("m.author_user_id = v_actor");
    expect(sql).toContain("c.channel_kind = 'announcement'");
    expect(sql).toContain("b.created_by <> NEW.user_id");
  });

  it("migration 1202: the only new broadcast UPDATE is the withdrawal instant, guarded one-way, creator-only, database clock", () => {
    expect(sql1202).toContain(
      `GRANT UPDATE ("withdrawn_at") ON "message_ack_broadcast" TO chartwarden_app`,
    );
    expect(sql1202).not.toMatch(/GRANT [^;]*DELETE/);
    expect(sql1202).not.toMatch(
      /GRANT UPDATE \((?!"withdrawn_at"\))[^)]*\) ON "message_ack_broadcast" /,
    );
    expect(sql1202).toContain("NEW.withdrawn_at := now()");
    expect(sql1202).toContain("message_ack_broadcast_withdraw_once");
    expect(sql1202).toContain("message_ack_broadcast_withdraw_actor");
    expect(sql1202).toContain("message_ack_broadcast_born_open");
    expect(sql1202).toContain("message_ack_broadcast_recipient_withdrawn");
    expect(sql1202).toContain(
      "(to_jsonb(NEW) - 'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at')",
    );
    expect(sql1202).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE/);
    expect(sql1202).not.toMatch(/"(name|body|title|email)"/);
    expect(schema).toContain(`"withdrawn_at"`);
    expect(schema).toContain(`"deadline_at"`);
  });

  it("the audit rows carry no names or text: there is no such column to leak", () => {
    expect(sql).not.toMatch(/"(name|body|title|email)"/);
  });

  it("adds no permission: marking reuses messaging.announce, acknowledging is the recipient's own act", () => {
    expect(sql).not.toContain('INSERT INTO "permission"');
  });

  it("the flag is the documented key", () => {
    expect(ACK_BROADCAST_FLAG_KEY).toBe("messaging.ack_broadcast");
  });
});
