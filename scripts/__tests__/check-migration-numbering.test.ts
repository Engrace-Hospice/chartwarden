// F-026 — the migration ORDINAL uniqueness gate.
//
// The four-digit prefix is the migration's position in the apply order, and `migrate.ts` sorts
// filenames lexicographically. Nothing enforced that two files do not claim the same number, so on
// a branch-per-change workflow two branches opened the same afternoon pick the same "next" one and
// every gate stays green. The collisions below are the REAL ones, taken from four audit branches
// open at the time this gate was written.
import { describe, expect, it } from "vitest";
import { analyze, readMigrations } from "../check-migration-numbering";

describe("ordinal uniqueness", () => {
  it("flags the real 0215/0216 collision four open branches had already created", () => {
    const { duplicates } = analyze([
      "0214_pre_org_membership_picker_empty_user.sql",
      // #20 (F-001) and #47 (F-018) each took 0215; #23 (F-005) and #52 (F-021) each took 0216.
      "0215_m10_hope_patient_id_repair.sql",
      "0215_pre_org_membership_picker_definer.sql",
      "0216_admission_location_backfill.sql",
      "0216_m36_notification_preferences_org_scope.sql",
    ]);
    expect([...duplicates.keys()].sort()).toEqual([215, 216]);
    expect(duplicates.get(215)).toEqual([
      "0215_m10_hope_patient_id_repair.sql",
      "0215_pre_org_membership_picker_definer.sql",
    ]);
  });

  it("names EVERY claimant, not just the extra one", () => {
    // The fix is a rename, and which file to rename is a judgement about which landed second — so
    // reporting one of the pair would hide the half the reader needs to make it.
    const { duplicates } = analyze(["0007_a.sql", "0007_b.sql", "0007_c.sql"]);
    expect(duplicates.get(7)).toHaveLength(3);
  });

  it("passes when every ordinal is claimed once", () => {
    const { duplicates, malformed } = analyze(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
    expect(duplicates.size).toBe(0);
    expect(malformed).toEqual([]);
  });
});

describe("gaps are advisory, not fatal", () => {
  it("reports a gap a sibling PR is expected to fill", () => {
    // #23's branch genuinely has this shape: it took 0216 and left 0215 for #20. That is the
    // coordination this gate exists to support, so it must not be an error.
    const { gaps, duplicates } = analyze(["0214_x.sql", "0216_m36_notification_prefs.sql"]);
    expect(gaps).toContain(215);
    expect(duplicates.size).toBe(0);
  });
});

describe("filename shape", () => {
  it("rejects a .sql file with no four-digit ordinal", () => {
    // Without a prefix the file still APPLIES — `migrate.ts` globs `*.sql` — it just has no defined
    // place in the order, which is worse than a duplicate: nobody even sees a number to argue about.
    const { malformed } = analyze(["0001_ok.sql", "fixup_hotpatch.sql", "215_three_digits.sql"]);
    expect(malformed).toEqual(["fixup_hotpatch.sql", "215_three_digits.sql"]);
  });
});

describe("the repo baseline", () => {
  const report = analyze(readMigrations());

  it("reads the real corpus, so the assertions below are not vacuous", () => {
    expect(report.migrations.length).toBeGreaterThan(200);
  });

  it("has no duplicate ordinal and no malformed filename on this branch", () => {
    expect([...report.duplicates.keys()]).toEqual([]);
    expect(report.malformed).toEqual([]);
  });
});
