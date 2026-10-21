// WP 4.1 - the TypeScript enum, the Drizzle schema, the code-side permission keys and migration 1105 agree, and the
// structural promises of the migration (immutable urgency, recipient shape, no grant to the wrong roles) are asserted
// on its text, so a change in one place without the others fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MESSAGE_URGENCIES,
  URGENT_RECEIVE_PERMISSION,
  URGENT_SEND_PERMISSION,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sql = read("packages/db/migrations/1105_m36_message_urgency.sql");
const flat = (s: string) => s.replace(/\s+/g, " ");
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

describe("migration 1105", () => {
  it("creates the enum with exactly the code-side values, in the Drizzle enums too", () => {
    expect(flat(sql)).toContain(
      `CREATE TYPE "message_urgency" AS ENUM (${list(MESSAGE_URGENCIES)})`,
    );
    expect(flat(read("packages/db/src/enums.ts"))).toContain(
      `pgEnum("message_urgency", [${MESSAGE_URGENCIES.map((v) => `"${v}"`).join(", ")}])`,
    );
  });

  it("defaults every message to routine and ties the recipient to urgent with a CHECK, in SQL and Drizzle", () => {
    expect(sql).toContain(`"urgency" "message_urgency" DEFAULT 'routine' NOT NULL`);
    expect(flat(sql)).toContain(
      `CHECK (("urgency" = 'urgent') = ("urgent_recipient_user_id" IS NOT NULL))`,
    );
    const drizzle = flat(read("packages/db/src/schema/messaging/messages.ts"));
    expect(drizzle).toContain(`(urgency = 'urgent') = (urgent_recipient_user_id IS NOT NULL)`);
    expect(drizzle).toContain('"message_urgency_shape"');
    expect(drizzle).toContain('"message_urgent_recipient_idx"');
  });

  it("makes both columns immutable with a BEFORE UPDATE trigger", () => {
    expect(sql).toContain('CREATE TRIGGER "trg_message_urgency_immutable"');
    expect(sql).toContain('BEFORE UPDATE ON "message"');
    expect(sql).toMatch(/IS DISTINCT FROM OLD\.urgency/);
    expect(sql).toMatch(/IS DISTINCT FROM OLD\.urgent_recipient_user_id/);
  });

  it("backs the recipient with a DB check that they are an active member of the message's organization", () => {
    expect(sql).toContain('CREATE TRIGGER "trg_message_urgent_recipient_in_org"');
    expect(sql).toContain('BEFORE INSERT ON "message"');
    expect(flat(sql)).toContain("m.organization_id = NEW.organization_id AND m.status = 'active'");
  });

  it("registers the two permission keys the code names, as clinical RBAC-only keys", () => {
    for (const key of [URGENT_SEND_PERMISSION, URGENT_RECEIVE_PERMISSION]) {
      expect(sql).toContain(`'${key}'`);
      expect(read("packages/auth/src/permissions/contributed.ts")).toContain(`"${key}"`);
    }
  });

  it("never grants the receive key to aides, volunteers, lpn, msw, chaplain, admins or compliance", () => {
    const receive = sql.slice(
      sql.indexOf('SELECT r."organization_id", r."id", \'messaging.urgent.receive\''),
      sql.indexOf('SELECT r."organization_id", r."id", \'messaging.urgent.send\''),
    );
    expect(receive.length).toBeGreaterThan(100);
    for (const role of [
      "chha",
      "aide",
      "hospice_aide",
      "home_health_aide",
      "volunteer",
      "lpn",
      "msw",
      "chaplain",
      "org_admin",
      "administrator",
      "compliance",
    ]) {
      expect(receive).not.toContain(`'${role}'`);
    }
  });

  it("never grants the send key to org admins or compliance", () => {
    const send = sql.slice(
      sql.indexOf('SELECT r."organization_id", r."id", \'messaging.urgent.send\''),
    );
    for (const role of ["org_admin", "administrator", "compliance", "volunteer"]) {
      expect(send).not.toContain(`'${role}'`);
    }
  });
});
