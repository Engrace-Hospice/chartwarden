import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSEMBLE_CANDIDATE_LIMIT } from "../src/modules/10-hope/hope-assemble-candidates";
import { BULK_CHUNK_ROWS } from "../src/modules/10-hope/hope-submission-result-writes";

// The documents say what the code does (database review, pre-PR): the numbers they quote are the code's constants, and the
// claims about the unit of the acceptance rate and about the lock the package build takes are the ones the code makes.
const ROOT = process.cwd();
const read = (repoPath: string): string => readFileSync(join(ROOT, repoPath), "utf8");
const flat = (text: string): string => text.replace(/\s+/g, " ");

const SPEC = flat(read("docs/modules/CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md"));
const CHANGES = flat(read("docs/api/CHANGES.md"));
const ENRICHMENTS = flat(read("scripts/openapi/enrichments.ts"));
const SERVICE = read("apps/backend/src/modules/10-hope/hope-route-service-db.ts");

describe("assemble: the documents quote the code's cap", () => {
  it("names the number of records one call looks at, in the spec, the change log and the route summary", () => {
    expect(ASSEMBLE_CANDIDATE_LIMIT).toBe(200);
    expect(SPEC).toContain("**One call looks at no more than 200 records**");
    expect(CHANGES).toContain("looks at no more than 200 eligible records");
    expect(ENRICHMENTS).toContain("one call looks at no more than 200 eligible records");
  });

  it("says a second call packages the rest, and that the response does not say more remain", () => {
    expect(SPEC).toContain("call again to package the next ones");
    expect(CHANGES).toContain("the response has no field that says more remain");
    expect(ENRICHMENTS).toContain("a second call packages the rest");
  });

  it("the route reads its candidates through the capped read, serialises unlocked, and re-judges and share-locks them just before the batch is written", () => {
    const body = SERVICE.slice(SERVICE.indexOf("async assembleSubmission("));
    const at = (needle: string): number => body.indexOf(needle);
    const read_ = at("readAssembleCandidateIds(");
    const validated = at("validateCandidates(");
    const rows = at("readPackageableRecords(");
    const serialised = at("serializeHopeAssessmentXml(");
    const relock = at("lockPackageableRecords(");
    const insertBatch = at(".insert(SUB)");
    const insertItems = at(".insert(SUBITEM)");
    expect(read_).toBeGreaterThan(-1);
    expect(validated).toBeGreaterThan(read_);
    expect(rows).toBeGreaterThan(validated);
    expect(serialised).toBeGreaterThan(rows);
    // the share lock is NOT held through the serialising: it is taken after it and before the first write
    expect(relock).toBeGreaterThan(serialised);
    expect(insertBatch).toBeGreaterThan(relock);
    expect(insertItems).toBeGreaterThan(insertBatch);
    // one multi-row insert of the items, not a statement per item
    expect(body.slice(insertItems, insertItems + 200)).toContain("toPackage.map(");
    expect(body.slice(insertBatch, insertItems)).not.toMatch(/for \(const/);
  });
});

describe("the submission list and the result import: the documents quote the code's bounds", () => {
  it("the list says 500, newest first, as the code does", () => {
    expect(SERVICE).toContain("const SUBMISSION_LIST_LIMIT = 500;");
    expect(SERVICE).toContain(".orderBy(desc(SUB.createdAt), desc(SUB.id))");
    for (const text of [SPEC, CHANGES, ENRICHMENTS]) expect(text).toContain("at most 500 batches");
  });

  it("the import writes 500 rows per statement, as the spec says", () => {
    expect(BULK_CHUNK_ROWS).toBe(500);
    expect(SPEC).toContain("one statement per 500 rows");
    expect(CHANGES).toContain("one statement per 500 rows");
  });

  it("the report reference column and the audit trigger are named by their migrations, which exist", () => {
    expect(SPEC).toContain("`hope_submission.report_reference` (migration 1496)");
    expect(SPEC).toContain("the trigger, migration 1497,");
    expect(read("packages/db/migrations/1496_m10_hope_submission_report_reference.sql")).toContain(
      "-- compat: expand",
    );
    expect(
      read("packages/db/migrations/1497_m10_hope_submission_audit_no_package_read.sql"),
    ).toContain("-- compat: expand");
  });
});

describe("the dashboard's rate and M30's rollup agree on which batches count, not on the unit", () => {
  it("the code comment, the spec and the route summary say so, and no document claims they cannot disagree", () => {
    expect(SERVICE).toContain("so the two agree on WHICH");
    expect(SPEC).toContain("per BATCH");
    expect(ENRICHMENTS).toContain("counts BATCHES");
    expect(SPEC).not.toMatch(/cannot disagree on which batches count/);
    expect(read("apps/backend/src/modules/10-hope/hope-submission-result.ts")).not.toContain(
      "cannot disagree",
    );
  });
});
