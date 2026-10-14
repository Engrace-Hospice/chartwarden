// M36 WP 1.8 — audit parity ratchet (SG-03).
//  1. Every M36-owned table carries a write-audit trigger (wardenx_audit_trigger or audit_phi_write_*) in the
//     migration corpus, or sits in AUDIT_TRIGGER_EXCEPTIONS WITH a reason (a ratchet: the list only shrinks).
//  2. Every M36 GET that declares a read-audit emission names a resourceIdParam (single resource) or is a list
//     read. Without the param the read event's resource id is empty, the audit insert fails on the uuid cast and
//     the best-effort emitter swallows it, so the read leaves no trail (CLAUDE.md). Waivers carry a reason.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../../../architecture/module-manifest";

const REPO = join(__dirname, "../../..");
const MIGRATIONS = join(REPO, "packages/db/migrations");
const ROUTES = join(REPO, "apps/backend/src/modules/36-messaging/routes");

/** Owned tables with no write-audit trigger, each WITH a reason. Empty on purpose. */
const AUDIT_TRIGGER_EXCEPTIONS: Readonly<Record<string, string>> = {};

const m36Tables = (MODULES.find((m) => m.id === 36)?.ownedTables ?? []) as readonly string[];
const AUDIT_FUNCTION = /^(?:wardenx_audit_trigger|audit_phi_write_\w+)$/;
const CREATE_TRIGGER =
  /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(\w+)"?[^;]*?\bON\s+(?:public\.)?"?(\w+)"?[^;]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?(\w+)\(/gis;
const DROP_TRIGGER =
  /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi;

/** Replay CREATE/DROP TRIGGER in migration order: the audit triggers that survive, as `table` -> trigger names. */
function survivingAuditTriggers(): Map<string, Set<string>> {
  const live = new Map<string, Set<string>>();
  for (const f of readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const events = [
      ...[...sql.matchAll(CREATE_TRIGGER)].map((m) => ({
        at: m.index ?? 0,
        op: "create",
        name: m[1] ?? "",
        table: m[2] ?? "",
        fn: m[3] ?? "",
      })),
      ...[...sql.matchAll(DROP_TRIGGER)].map((m) => ({
        at: m.index ?? 0,
        op: "drop",
        name: m[1] ?? "",
        table: m[2] ?? "",
        fn: "",
      })),
    ].sort((x, y) => x.at - y.at);
    for (const e of events) {
      const names = live.get(e.table) ?? new Set<string>();
      if (e.op === "drop") names.delete(e.name);
      else if (AUDIT_FUNCTION.test(e.fn)) names.add(e.name);
      else names.delete(e.name); // replaced by a non-audit function
      live.set(e.table, names);
    }
  }
  return live;
}
const surviving = survivingAuditTriggers();
const hasAuditTrigger = (table: string): boolean => (surviving.get(table)?.size ?? 0) > 0;

describe("M36 write-audit parity", () => {
  it("reads the M36 table list from the manifest", () => {
    expect(m36Tables.length).toBeGreaterThan(15);
  });

  it.each(m36Tables)("%s has a write-audit trigger or a reasoned exception", (table) => {
    const reason = AUDIT_TRIGGER_EXCEPTIONS[table];
    if (reason) {
      expect(
        hasAuditTrigger(table),
        `${table} is excepted but has a trigger: drop it from the list`,
      ).toBe(false);
      return;
    }
    expect(
      hasAuditTrigger(table),
      `${table} has no audit trigger after replaying every migration`,
    ).toBe(true);
  });
});

describe("M36 read-audit declarations", () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith("-routes.ts"));
  const blocks = files.flatMap((f) => {
    const src = readFileSync(join(ROUTES, f), "utf8");
    return [...src.matchAll(/auditRead:\s*\{([\s\S]*?)\n?\s*\},?\s*\n?\s*\}/g)].map((m) => ({
      file: f,
      body: m[1] ?? "",
    }));
  });

  it("finds the declarations", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(6);
  });

  it("every emission config is a list read or names a resource id (a param, or a payload path for a POST that creates or answers the resource); every waiver has a reason", () => {
    for (const { file, body } of blocks) {
      if (/\bnone:/.test(body)) {
        expect(body, `${file}: empty waiver`).toMatch(/none:\s*\n?\s*"[^"]{10,}/);
        continue;
      }
      expect(body, `${file}: ${body.trim()}`).toMatch(
        /\blist:\s*true|\bresourceIdParam:\s*"\w+"|\b(?:resourceId|patientId)PayloadPath:\s*"[\w.]+"/,
      );
    }
  });
});

/** GET routes with no auditRead declaration, each WITH a reason. */
const GET_EXEMPTIONS: Readonly<Record<string, string>> = {
  "/api/v1/alert-rules": "alert rule configuration only; no message, attachment or patient content",
  "/api/v1/admin/messaging/alert-deliveries":
    "writes its own org-less platform audit event before the response (admin-alert-deliveries-routes.ts)",
};

describe("M36 GET routes are all audited or exempt", () => {
  const gets = readdirSync(ROUTES)
    .filter((f) => f.endsWith("-routes.ts"))
    .flatMap((f) => {
      const parts = readFileSync(join(ROUTES, f), "utf8").split(
        /(?=\bapp\.(?:get|post|put|patch|delete)\()/,
      );
      return parts
        .filter((p) => p.startsWith("app.get("))
        .map((p) => ({
          file: f,
          path: /"([^"]+)"/.exec(p)?.[1] ?? "",
          declared: /auditRead:/.test(p),
        }));
    });

  it("finds the GET routes", () => {
    expect(gets.length).toBeGreaterThanOrEqual(9);
  });

  it("each declares auditRead or sits in GET_EXEMPTIONS", () => {
    for (const g of gets) {
      if (g.declared) {
        expect(
          GET_EXEMPTIONS[g.path],
          `${g.path} is exempt but declares auditRead: drop the exemption`,
        ).toBeUndefined();
      } else {
        expect(
          GET_EXEMPTIONS[g.path],
          `${g.file}: GET ${g.path} has no auditRead and no exemption`,
        ).toBeTruthy();
      }
    }
  });
});
