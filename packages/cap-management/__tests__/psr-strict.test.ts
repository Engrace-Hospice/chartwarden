import { describe, expect, it } from "vitest";
import {
  aggregatePsrRows,
  dollarsToCentsStrict,
  formatPsrRejection,
  parsePsrCsvStrict,
  quarantineEffect,
  reconcilePsr,
  reconcilePsrInpatientDays,
  summarizePsrQuarantine,
} from "../src/index";

describe("dollarsToCentsStrict (GAP-078)", () => {
  it("parses plain, thousands-separated, dollar-signed and parenthesised amounts exactly", () => {
    expect(dollarsToCentsStrict("100")).toBe(10_000);
    expect(dollarsToCentsStrict("$33,494.01")).toBe(3_349_401);
    expect(dollarsToCentsStrict("0.5")).toBe(50);
    expect(dollarsToCentsStrict("(50.00)")).toBe(-5_000);
    expect(dollarsToCentsStrict("-12.34")).toBe(-1_234);
  });
  it("rejects anything that is not a money amount (no silent zero)", () => {
    for (const bad of ["", "abc", "12.345", "1,23", "$", "1e5", "12 34"])
      expect(dollarsToCentsStrict(bad)).toBeNull();
  });
});

describe("parsePsrCsvStrict (GAP-078)", () => {
  const csv =
    '﻿MBI,Paid Amount,Inpatient Days\r\n1EG4-TE5-MK73," $1,000.00 ",2\r\n2AB4TE5MK74,50.25,0\r\n';

  it("tolerates a BOM, CRLF, whitespace and dashed MBIs", () => {
    const r = parsePsrCsvStrict(csv, "palmetto");
    expect(r.issues).toEqual([]);
    expect(r.hasInpatientDays).toBe(true);
    expect(r.rows).toEqual([
      { mbi: "1EG4TE5MK73", paidCents: 100_000, inpatientDays: 2 },
      { mbi: "2AB4TE5MK74", paidCents: 5_025, inpatientDays: 0 },
    ]);
  });

  it("rejects a file with no recognised paid-amount column instead of reading every row as $0", () => {
    const r = parsePsrCsvStrict("MBI,Mystery\n1EG4TE5MK73,5\n", "ngs");
    expect(r.issues).toEqual([{ line: 1, code: "missing_paid_amount_column" }]);
    expect(r.rows).toEqual([]);
  });

  it("flags a missing MBI column and an empty file as structural (whole-file) issues", () => {
    expect(parsePsrCsvStrict("", "cgs").issues).toEqual([{ line: 0, code: "empty_file" }]);
    expect(parsePsrCsvStrict("Paid Amount\n5\n", "cgs").issues[0]?.code).toBe("missing_mbi_column");
  });

  it("a malformed ROW is quarantined, not fatal: good rows survive, codes carry line numbers only", () => {
    const lines = ["MBI,Paid Amount"];
    for (let i = 0; i < 9; i++) lines.push(`1EG4TE5MK7${i},10.00`);
    lines.push("1EG4TE5MK80,oops");
    const r = parsePsrCsvStrict(lines.join("\n"), "cgs");
    expect(r.issues).toEqual([]);
    expect(r.rows).toHaveLength(9);
    expect(r.quarantined).toEqual([
      { line: 11, code: "invalid_paid_amount", recoveredMbi: "1EG4TE5MK80" },
    ]);
    const summary = summarizePsrQuarantine(r.quarantined);
    expect(summary).toEqual({
      rowsQuarantined: 1,
      detail: {
        lines: [{ line: 11, code: "invalid_paid_amount" }],
        truncated: false,
        flaggedBeneficiaries: 1,
        unattributableRows: 0,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("1EG4TE5MK80");
  });

  it("classifies bad MBI shape, empty MBI and wrong column count; only well-formed MBIs are recovered", () => {
    const lines = ["MBI,Paid Amount,Inpatient Days"];
    for (let i = 0; i < 20; i++) lines.push(`1EG4TE5MK${String(i).padStart(2, "0")},1.00,0`);
    lines.push("SHORT,5.00,0", ",5.00,0", "1EG4TE5MK99,5.00", "1EG4TE5MK98,5.00,x");
    const r = parsePsrCsvStrict(lines.join("\n"), "cgs");
    expect(r.issues).toEqual([]);
    expect(r.quarantined).toEqual([
      { line: 22, code: "invalid_mbi", recoveredMbi: null },
      { line: 23, code: "missing_mbi", recoveredMbi: null },
      { line: 24, code: "wrong_column_count", recoveredMbi: "1EG4TE5MK99" },
      { line: 25, code: "invalid_inpatient_days", recoveredMbi: "1EG4TE5MK98" },
    ]);
  });

  it("a file with no good row, or over the 20% quarantine ceiling, is rejected as a whole", () => {
    const all = parsePsrCsvStrict("MBI,Paid Amount\n1EG4TE5MK73,oops\n,5\n", "cgs");
    expect(all.issues).toEqual([{ line: 0, code: "all_rows_quarantined" }]);
    const mk = (bad: number) =>
      ["MBI,Paid Amount"]
        .concat(
          Array.from(
            { length: 10 },
            (_, i) => `1EG4TE5MK${String(i).padStart(2, "0")},${i < bad ? "x" : "1.00"}`,
          ),
        )
        .join("\n");
    expect(parsePsrCsvStrict(mk(2), "cgs").issues).toEqual([]); // exactly 20% is allowed
    const over = parsePsrCsvStrict(mk(3), "cgs");
    expect(over.issues).toEqual([{ line: 0, code: "quarantine_ceiling_exceeded" }]);
    const text = formatPsrRejection(over);
    expect(text).toBe(
      "quarantine_ceiling_exceeded; line 2: invalid_paid_amount; line 3: invalid_paid_amount; line 4: invalid_paid_amount",
    );
    expect(text).not.toContain("1EG4TE5MK");
  });

  it("uses the per-MAC header aliases", () => {
    const r = parsePsrCsvStrict("HICN,Payments\n1EG4TE5MK73,10\n", "novitas");
    expect(r.issues).toEqual([]);
    expect(r.hasInpatientDays).toBe(false);
  });
});

describe("PS&R variance with quarantined rows (GAP-078 follow-up)", () => {
  const ledger = [
    { mbiNormalized: "A", patientId: "p-a", paidCents: 100_000 },
    { mbiNormalized: "B", patientId: "p-b", paidCents: 100_000 },
  ];
  const good = [{ mbi: "A", paidCents: 100_000, inpatientDays: 0 }];

  it("a quarantined row with a recovered MBI raises no variance line for it (not a false $0 / timing)", () => {
    const effect = quarantineEffect([{ line: 3, code: "invalid_paid_amount", recoveredMbi: "B" }]);
    const lines = reconcilePsr(ledger, good, 5_000, effect);
    expect(lines.filter((l) => l.scope === "beneficiary")).toEqual([]);
    const agg = lines.find((l) => l.scope === "agency_aggregate");
    expect(agg).toMatchObject({
      m26AccrualCents: 100_000,
      psrAmountCents: 100_000,
      varianceCents: 0,
    });
    // control: without the quarantine effect the same inputs raise a false -$1,000 timing line
    const naive = reconcilePsr(ledger, good, 5_000).filter((l) => l.scope === "beneficiary");
    expect(naive).toHaveLength(1);
  });

  it("an unreadable-MBI row suppresses ledger-only lines and the aggregate, still raising real mismatches", () => {
    const effect = quarantineEffect([{ line: 3, code: "invalid_mbi", recoveredMbi: null }]);
    const lines = reconcilePsr(
      ledger,
      [{ mbi: "A", paidCents: 90_000, inpatientDays: 0 }],
      5_000,
      effect,
    );
    expect(lines.map((l) => [l.scope, l.patientId, l.varianceCents])).toEqual([
      ["beneficiary", "p-a", -10_000],
    ]);
  });
});

describe("PS&R variance (GAP-078)", () => {
  it("folds repeated MBIs by summing before the diff", () => {
    const rows = aggregatePsrRows([
      { mbi: "A", paidCents: 100, inpatientDays: 1 },
      { mbi: "A", paidCents: 250, inpatientDays: 2 },
    ]);
    expect(rows).toEqual([{ mbi: "A", paidCents: 350, inpatientDays: 3 }]);
  });

  it("only above-threshold lines are raised; a PS&R-only beneficiary has no patient link", () => {
    const lines = reconcilePsr(
      [
        { mbiNormalized: "A", patientId: "p-a", paidCents: 100_000 },
        { mbiNormalized: "B", patientId: "p-b", paidCents: 100_000 },
      ],
      [
        { mbi: "A", paidCents: 100_100, inpatientDays: 0 }, // $1 off — under the $50 default
        { mbi: "B", paidCents: 90_000, inpatientDays: 0 }, // −$100
        { mbi: "C", paidCents: 20_000, inpatientDays: 0 }, // PS&R-only
      ],
    ).filter((l) => l.aboveThreshold);
    const bene = lines.filter((l) => l.scope === "beneficiary");
    expect(bene.map((l) => [l.patientId, l.varianceCents])).toEqual([
      ["p-b", -10_000],
      [null, 20_000],
    ]);
  });

  it("inpatient days: any non-zero difference is a line, equal days are not", () => {
    expect(reconcilePsrInpatientDays(10, 10)).toBeNull();
    expect(reconcilePsrInpatientDays(10, 12)).toEqual({
      m26InpatientDays: 10,
      psrInpatientDays: 12,
      varianceDays: 2,
    });
  });
});
