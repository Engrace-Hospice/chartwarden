// ADR-0001: hospice claims carry NO HIPPS rate code. The per-diem class code (`derivePerDiemClassCode`) is an INTERNAL
// placeholder that is persisted for reproducibility and never transmitted. This guards both halves of that statement:
//   1. no outbound claim document / 837I segment builder / claim-line row mentions HIPPS or the per-diem class code;
//   2. the `hipps` name is gone from the billing package and the M23 schema (migration 1069 rename).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const BILLING_SRC = join(__dirname, "..", "src");
const DB_BILLING_SCHEMA = join(__dirname, "..", "..", "db", "src", "schema", "billing");

/** Everything that shapes bytes sent to a MAC / clearinghouse: X12 segment builders and the transfer-notice document. */
const OUTBOUND_FILES = [
  join(BILLING_SRC, "claim-codes", "x12-segments.ts"),
  join(BILLING_SRC, "claim-codes", "admission-codes.ts"),
  join(BILLING_SRC, "claim-codes", "discharge-codes.ts"),
  join(BILLING_SRC, "transfer-notice", "document.ts"),
  join(BILLING_SRC, "claim-lines", "claim-snapshot.ts"),
  join(BILLING_SRC, "claim-lines", "physician-npis.ts"),
];

const PER_DIEM_CLASS_NAME = /hipps|per[_-]?diem[_-]?class/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Code with comments stripped, so prose explaining ADR-0001 does not trip the guard. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("hospice claims never carry a HIPPS / per-diem class code", () => {
  it.each(OUTBOUND_FILES.map((f) => [relative(BILLING_SRC, f), f]))(
    "outbound builder %s names neither HIPPS nor the internal per-diem class code",
    (_name, file) => {
      expect(code(file as string)).not.toMatch(PER_DIEM_CLASS_NAME);
    },
  );

  it("the claim_line table has no per-diem class / HIPPS column", () => {
    const claimLine = code(join(DB_BILLING_SCHEMA, "claim-line.ts"));
    expect(claimLine).not.toMatch(PER_DIEM_CLASS_NAME);
  });

  it("the claim table has no per-diem class / HIPPS column", () => {
    expect(code(join(DB_BILLING_SCHEMA, "claim.ts"))).not.toMatch(PER_DIEM_CLASS_NAME);
  });

  it("the `hipps` name no longer appears in billing source or the M23 schema (migration 1069)", () => {
    const offenders = [...walk(BILLING_SRC), ...walk(DB_BILLING_SCHEMA)]
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /hipps/.test(code(f)) || /hipps/.test(f));
    expect(offenders.map((f) => relative(join(__dirname, "..", ".."), f))).toEqual([]);
  });
});
