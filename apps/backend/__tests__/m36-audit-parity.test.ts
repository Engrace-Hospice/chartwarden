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
const migrationSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

const hasAuditTrigger = (table: string): boolean =>
  new RegExp(
    `CREATE\\s+TRIGGER\\s+"?\\w+"?\\s+AFTER[^;]*?\\bON\\s+(?:public\\.)?"?${table}"?\\s+[^;]*?EXECUTE\\s+FUNCTION\\s+(?:public\\.)?(?:wardenx_audit_trigger|audit_phi_write_\\w+)\\(`,
    "is",
  ).test(migrationSql);

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
    expect(hasAuditTrigger(table), `${table} has no audit trigger in any migration`).toBe(true);
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

  it("every emission config is a list read or names a resourceIdParam; every waiver has a reason", () => {
    for (const { file, body } of blocks) {
      if (/\bnone:/.test(body)) {
        expect(body, `${file}: empty waiver`).toMatch(/none:\s*\n?\s*"[^"]{10,}/);
        continue;
      }
      expect(body, `${file}: ${body.trim()}`).toMatch(/\blist:\s*true|\bresourceIdParam:\s*"\w+"/);
    }
  });
});
