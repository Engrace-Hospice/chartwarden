import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@chartwarden/db";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

// Migration 1497 builds the `hope_submission` audit images from the columns BY NAME, so the package column
// (`acceptance_report`, a multi-MB base64 ZIP) is never read by the trigger. The price is that a column added to the table
// must be added to that list, or its changes stop being audited. This test reads the migration text (no database), so the
// drift fails in the unit run; the live suite (m10-hope-submission-result.live.test.ts) proves the audit rows equal the old
// `audit_scrub(to_jsonb(row), ...)` ones.
const MIGRATIONS = join(process.cwd(), "packages/db/migrations");
const TRIGGER_FUNCTION = "audit_phi_write_hope_submission()";

/** The LAST migration that (re)defines the trigger function: the one that decides what the trigger does. */
function currentDefinition(): { file: string; body: string } {
  let found: { file: string; body: string } | undefined;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    const at = text.indexOf(`CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION}`);
    if (at < 0) continue;
    const end = text.indexOf("END $$;", at);
    found = { file, body: text.slice(at, end) };
  }
  if (!found) throw new Error("no migration defines the hope_submission audit trigger function");
  return found;
}

const imageKeys = (body: string, record: "OLD" | "NEW"): string[] =>
  [...body.matchAll(new RegExp(`'([a-z_0-9]+)', ${record}\\.[a-z_0-9]+`, "g"))].map(
    (m) => m[1] as string,
  );

describe("audit_phi_write_hope_submission: the row images list every column of the table, and never read the package", () => {
  const { file, body } = currentDefinition();
  const columns = Object.values(getTableColumns(schema.hopeSubmissions)).map((c) => c.name);

  it("is the by-name definition (1497 or later), not the to_jsonb(row) one", () => {
    expect(file >= "1497").toBe(true);
    expect(body).not.toMatch(/to_jsonb\(/i);
  });

  it.each(["OLD", "NEW"] as const)(
    "the %s image names every column except the package, by column",
    (record) => {
      const named = imageKeys(body, record).sort();
      expect(named).toEqual(columns.filter((c) => c !== "acceptance_report").sort());
    },
  );

  it("never reads acceptance_report off the row: it is a placeholder the scrub list replaces", () => {
    expect(body).not.toMatch(/(OLD|NEW)\.acceptance_report/);
    expect(body).toContain("'acceptance_report', NULL::text");
    expect(body).toMatch(
      /v_cols text\[\] := ARRAY\['acceptance_report', 'envelope_storage_uri', 'envelope_sha256'\]::text\[\]/,
    );
  });

  it("keeps the audit event the old trigger wrote: type, resource, retention class and the scrubbed images", () => {
    expect(body).toContain("'hope_submission.' || lower(TG_OP)");
    expect(body).toContain("'hope_submission',");
    expect(body).toContain("'compliance'");
    expect(body).toContain("public.audit_scrub(");
    expect(body).toContain("), v_cols);");
  });
});
