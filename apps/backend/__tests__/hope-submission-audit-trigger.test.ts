import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@chartwarden/db";
import { M10_AUDIT_DENYLIST } from "@chartwarden/types";
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
function currentDefinition(triggerFunction = TRIGGER_FUNCTION): { file: string; body: string } {
  let found: { file: string; body: string } | undefined;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    const at = text.indexOf(`CREATE OR REPLACE FUNCTION ${triggerFunction}`);
    if (at < 0) continue;
    const end = text.indexOf("END $$;", at);
    found = { file, body: text.slice(at, end) };
  }
  if (!found) throw new Error(`no migration defines ${triggerFunction}`);
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
    expect(body).toMatch(/v_cols text\[\] := ARRAY\['acceptance_report', /);
  });

  it("scrubs exactly the columns M10_AUDIT_DENYLIST names, the two operator-typed references included", () => {
    const scrubbed = [
      ...(body.match(/v_cols text\[\] := ARRAY\[([^\]]*)\]/)?.[1] ?? "").matchAll(
        /'([a-z_0-9]+)'/g,
      ),
    ].map((m) => m[1] as string);
    expect(scrubbed.sort()).toEqual([...M10_AUDIT_DENYLIST.hope_submission].sort());
    expect(scrubbed).toEqual(
      expect.arrayContaining(["report_reference", "iqies_submission_reference"]),
    );
  });

  it("keeps jsonb_build_object under its 100-argument limit (a column added to the table must not push it over)", () => {
    const pairs = imageKeys(body, "NEW").length + 1; // + the acceptance_report placeholder
    expect(pairs * 2).toBeLessThanOrEqual(100);
  });

  it("keeps the audit event the old trigger wrote: type, resource, retention class and the scrubbed images", () => {
    expect(body).toContain("'hope_submission.' || lower(TG_OP)");
    expect(body).toContain("'hope_submission',");
    expect(body).toContain("'compliance'");
    expect(body).toContain("public.audit_scrub(");
    expect(body).toContain("), v_cols);");
  });
});

describe("audit_phi_write_hope_submission_result_event: the report reference is scrubbed with the CMS response and message", () => {
  const text = readFileSync(
    join(MIGRATIONS, "1499_m10_hope_submission_result_event_audit_scrub_reference.sql"),
    "utf8",
  );

  it("both images scrub exactly the columns M10_AUDIT_DENYLIST names", () => {
    const lists = [...text.matchAll(/audit_scrub\(to_jsonb\((OLD|NEW)\), ARRAY\[([^\]]*)\]/g)];
    expect(lists.map((m) => m[1])).toEqual(["OLD", "NEW"]);
    for (const m of lists) {
      const columns = [...(m[2] as string).matchAll(/'([a-z_0-9]+)'/g)].map((c) => c[1] as string);
      expect(columns.sort()).toEqual([...M10_AUDIT_DENYLIST.hope_submission_result_event].sort());
    }
  });

  it("is the last definition of the function (no later migration restores the old scrub list)", () => {
    const definitions = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), "utf8").includes(
          "CREATE OR REPLACE FUNCTION audit_phi_write_hope_submission_result_event()",
        ),
      );
    expect(definitions.at(-1)).toBe(
      "1499_m10_hope_submission_result_event_audit_scrub_reference.sql",
    );
  });
});

describe("audit_phi_write_hope_submission_item: the row images list every column of the table, and never read the XML", () => {
  const { file, body } = currentDefinition("audit_phi_write_hope_submission_item()");
  const columns = Object.values(getTableColumns(schema.hopeSubmissionItems)).map((c) => c.name);

  it("is the by-name definition (1500 or later), not the to_jsonb(row) one", () => {
    expect(file >= "1500").toBe(true);
    expect(body).not.toMatch(/to_jsonb\(/i);
  });

  it.each(["OLD", "NEW"] as const)(
    "the %s image names every column except the XML result, by column",
    (record) => {
      const named = imageKeys(body, record).sort();
      expect(named).toEqual(columns.filter((c) => c !== "iqies_validation_result").sort());
    },
  );

  it("never reads iqies_validation_result off the row: it is a placeholder the scrub list replaces", () => {
    expect(body).not.toMatch(/(OLD|NEW)\.iqies_validation_result/);
    expect(body.match(/'iqies_validation_result', NULL::text/g)).toHaveLength(2);
  });

  it("scrubs exactly the columns M10_AUDIT_DENYLIST names", () => {
    const scrubbed = [
      ...(body.match(/v_cols text\[\] := ARRAY\[([^\]]*)\]/)?.[1] ?? "").matchAll(
        /'([a-z_0-9]+)'/g,
      ),
    ].map((m) => m[1] as string);
    expect(scrubbed.sort()).toEqual([...M10_AUDIT_DENYLIST.hope_submission_item].sort());
  });

  it("keeps jsonb_build_object under its 100-argument limit", () => {
    const pairs = imageKeys(body, "NEW").length + 1; // + the iqies_validation_result placeholder
    expect(pairs * 2).toBeLessThanOrEqual(100);
  });

  it("keeps the audit event the old trigger wrote: type, resource, retention class and the scrubbed images", () => {
    expect(body).toContain("'hope_submission_item.' || lower(TG_OP)");
    expect(body).toContain("'hope_submission_item',");
    expect(body).toContain("'compliance'");
    expect(body).toContain("public.audit_scrub(");
    expect(body.match(/\), v_cols\);/g)).toHaveLength(2);
  });

  it("keeps SECURITY DEFINER, a pinned search_path with pg_temp last, and the audit writer as owner", () => {
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path = pg_catalog, public, pg_temp");
    const migration = readFileSync(join(MIGRATIONS, file), "utf8");
    expect(migration).toContain(
      "ALTER FUNCTION audit_phi_write_hope_submission_item() OWNER TO chartwarden_audit_writer;",
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE TRIGGER "trg_audit_hope_submission_item" AFTER INSERT OR UPDATE OR DELETE ON hope_submission_item/,
    );
  });
});
