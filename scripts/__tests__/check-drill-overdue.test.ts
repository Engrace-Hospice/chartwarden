import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AGE_DAYS,
  DRILL_KIND,
  evaluateDrills,
  judgeRecord,
} from "../backup/check-drill-overdue";

// backup:drill-overdue (CW-CP-01): the alarm for "nobody restored production this month". Only a complete, witnessed,
// passing PRODUCTION drill counts; the synthetic drills prove tooling, never that production restores.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../backup/check-drill-overdue.ts");
const TODAY = new Date("2026-12-10T00:00:00Z");

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: DRILL_KIND,
  drilledOn: "2026-12-05",
  result: "pass",
  conductedBy: "Operator One",
  witness: "Second Person",
  snapshotId: "20261205T020000Z",
  restoreWallSeconds: 1500,
  rtoTargetSeconds: 3600,
  snapshotAgeSeconds: 600,
  rpoTargetSeconds: 900,
  verifierExitCode: 0,
  phiCopyDestroyedOn: "2026-12-05",
  notes: "synthetic fixture",
  ...over,
});
const verdict = (...raws: unknown[]) =>
  evaluateDrills(
    raws.map((raw, i) => ({ file: `r${i}.json`, raw })),
    TODAY,
  );

describe("evaluateDrills", () => {
  it("is overdue when nothing is recorded", () => {
    const v = verdict();
    expect(v.overdue).toBe(true);
    expect(v.summary).toMatch(/no witnessed production restore drill/);
    expect(v.lastPassOn).toBeNull();
  });

  it("never counts the synthetic drills", () => {
    const v = verdict(
      { runId: "abc123", startedAt: "2026-12-08T00:00:00Z", passed: true, checks: [] },
      { kind: "coordinated-backup-drill", drilledOn: "2026-12-08", result: "pass" },
    );
    expect(v.overdue).toBe(true);
  });

  it("is fresh for a recent passing drill, using the newest of several", () => {
    const v = verdict(record({ drilledOn: "2026-10-01" }), record({ drilledOn: "2026-12-05" }));
    expect(v.overdue).toBe(false);
    expect(v.lastPassOn).toBe("2026-12-05");
    expect(v.ageDays).toBe(5);
  });

  it("allows exactly the limit and is overdue one day later", () => {
    const edge = new Date(TODAY.getTime() - DEFAULT_MAX_AGE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(verdict(record({ drilledOn: edge, phiCopyDestroyedOn: edge })).overdue).toBe(false);
    const late = new Date(TODAY.getTime() - (DEFAULT_MAX_AGE_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const v = verdict(record({ drilledOn: late, phiCopyDestroyedOn: late }));
    expect(v.overdue).toBe(true);
    expect(v.summary).toMatch(/36 days ago/);
  });

  it("honours a different limit", () => {
    const v = evaluateDrills([{ file: "r.json", raw: record() }], TODAY, 3);
    expect(v.overdue).toBe(true);
  });

  it("alarms when the latest drill FAILED, even though an older one passed", () => {
    const v = verdict(
      record({ drilledOn: "2026-11-20", phiCopyDestroyedOn: "2026-11-20" }),
      record({ drilledOn: "2026-12-05", result: "fail", verifierExitCode: 1 }),
    );
    expect(v.overdue).toBe(true);
    expect(v.summary).toMatch(/FAILED/);
  });

  it("alarms on a FAILED record that is incomplete (no witness, no snapshot, nothing restored to destroy)", () => {
    const v = verdict(record({ drilledOn: "2026-11-20", phiCopyDestroyedOn: "2026-11-20" }), {
      kind: DRILL_KIND,
      drilledOn: "2026-12-05",
      result: "fail",
      conductedBy: "Operator One",
      notes: "the off-site key did not open the repository",
    });
    expect(v.overdue).toBe(true);
    expect(v.summary).toMatch(/FAILED/);
  });

  it("does not let a failure dated in the future (or an impossible date) stand in for a drill", () => {
    const v = verdict(
      record(),
      { kind: DRILL_KIND, drilledOn: "2026-12-30", result: "fail" },
      { kind: DRILL_KIND, drilledOn: "2026-02-30", result: "fail" },
    );
    expect(v.overdue).toBe(false);
  });

  it("is fresh again once a passing drill follows the failure", () => {
    const v = verdict(
      record({
        drilledOn: "2026-12-01",
        result: "fail",
        verifierExitCode: 1,
        phiCopyDestroyedOn: "2026-12-01",
      }),
      record({ drilledOn: "2026-12-06", phiCopyDestroyedOn: "2026-12-06" }),
    );
    expect(v.overdue).toBe(false);
  });
});

describe("evaluateDrills: fail closed on a record it cannot read", () => {
  const withFile = (file: string, raw: unknown) =>
    evaluateDrills(
      [
        { file: "2026-12-05-production-restore.json", raw: record() },
        { file, raw },
      ],
      TODAY,
    );

  it("alarms when a file named like a production restore record is unparseable (it may be the failed one)", () => {
    const v = withFile("2026-12-08-production-restore.json", null);
    expect(v.overdue).toBe(true);
    expect(v.summary).toMatch(/2026-12-08-production-restore\.json/);
  });

  it("alarms when such a file has the wrong or no kind", () => {
    expect(withFile("2026-12-08-production-restore.json", { result: "fail" }).overdue).toBe(true);
    expect(
      withFile("2026-12-08-production-restore.json", { kind: "production-restore", result: "fail" })
        .overdue,
    ).toBe(true);
  });

  it("does not alarm for other evidence files that parse (the synthetic drills' records, a stray object)", () => {
    expect(withFile("2026-11-08-coordinated-backup-drill.json", { passed: true }).overdue).toBe(
      false,
    );
    expect(withFile("notes.json", { note: "stray" }).overdue).toBe(false);
  });

  it("alarms on an unparseable file under ANY name (a damaged failure record cannot be told apart)", () => {
    const v = withFile("2026-12-08-restore-drill.json", null);
    expect(v.overdue).toBe(true);
    expect(v.summary).toMatch(/2026-12-08-restore-drill\.json/);
  });

  it.each([["failed"], ["FAIL"], ["Pass"], ["pass or fail"]])(
    "reads a dated record whose result is %j as a failure, not as nothing",
    (result) => {
      const v = withFile(
        "2026-12-08-production-restore.json",
        record({ drilledOn: "2026-12-08", result }),
      );
      expect(v.overdue).toBe(true);
      expect(v.summary).toMatch(/FAILED/);
    },
  );

  it("does not count a pass whose PHI copy is recorded as destroyed on a date still to come", () => {
    const v = verdict(record({ drilledOn: "2026-12-05", phiCopyDestroyedOn: "2027-01-01" }));
    expect(v.overdue).toBe(true);
    expect(v.warnings.join("\n")).toMatch(/phiCopyDestroyedOn is in the future/);
  });
});

describe("judgeRecord", () => {
  it.each([
    ["a self-witnessed drill", { witness: "operator one" }, /second person/],
    ["an empty witness", { witness: " " }, /witness is empty/],
    ["a pass the verifier did not confirm", { verifierExitCode: 1 }, /did not exit 0/],
    [
      "a record that never destroyed the PHI copy",
      { phiCopyDestroyedOn: "" },
      /phiCopyDestroyedOn/,
    ],
    [
      "a PHI copy destroyed before the drill",
      { phiCopyDestroyedOn: "2026-12-01" },
      /before drilledOn/,
    ],
    [
      "a future date",
      { drilledOn: "2026-12-11", phiCopyDestroyedOn: "2026-12-11" },
      /in the future/,
    ],
    ["an impossible date", { drilledOn: "2026-02-30" }, /not a YYYY-MM-DD date/],
    ["a malformed snapshot id", { snapshotId: "latest" }, /snapshotId/],
    ["a missing timing", { restoreWallSeconds: undefined }, /restoreWallSeconds/],
    [
      "template placeholders left at zero",
      { restoreWallSeconds: 0 },
      /restoreWallSeconds.*positive/,
    ],
    ["a snapshot age left at zero", { snapshotAgeSeconds: 0 }, /snapshotAgeSeconds.*positive/],
    ["a result that is neither pass nor fail", { result: "ok" }, /result must be/],
  ])("does not count %s", (_name, over, problem) => {
    const j = judgeRecord(record(over), TODAY);
    expect(j?.counts).toBe(false);
    expect(j?.problems.join("\n")).toMatch(problem);
  });

  it("counts a complete record but says when the restore missed its targets", () => {
    const j = judgeRecord(record({ restoreWallSeconds: 7200, snapshotAgeSeconds: 1800 }), TODAY);
    expect(j?.counts).toBe(true);
    expect(j?.notes.join("\n")).toMatch(/RTO target of 3600/);
    expect(j?.notes.join("\n")).toMatch(/RPO target of 900/);
  });

  it("ignores records of any other kind", () => {
    expect(judgeRecord({ kind: "something-else" }, TODAY)).toBeNull();
    expect(judgeRecord(null, TODAY)).toBeNull();
    expect(judgeRecord([record()], TODAY)).toBeNull();
  });
});

const hasBun = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).status === 0;
const cli = hasBun ? describe : describe.skip;
const scratch = mkdtempSync(join(tmpdir(), "drill-overdue-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

cli("backup:drill-overdue CLI", () => {
  const run = (dir: string, ...extra: string[]) =>
    spawnSync("bun", [SCRIPT, `--dir=${dir}`, "--today=2026-12-10", ...extra], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });

  it("exits 1 on an empty evidence directory and ignores TEMPLATE files", () => {
    const dir = mkdtempSync(join(scratch, "empty-"));
    writeFileSync(join(dir, "TEMPLATE-production-restore.json"), JSON.stringify(record()));
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/OVERDUE: no witnessed production restore drill/);
    expect(res.stderr).toMatch(/no alert was posted/);
  });

  it("exits 0 when a passing record is fresh, and warns about a record that does not count", () => {
    const dir = mkdtempSync(join(scratch, "fresh-"));
    writeFileSync(join(dir, "2026-12-05-production-restore.json"), JSON.stringify(record()));
    writeFileSync(
      join(dir, "2026-12-01-production-restore.json"),
      JSON.stringify(record({ drilledOn: "2026-12-01", witness: "Operator One" })),
    );
    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/OK: the last passing production restore drill was 5 days ago/);
    expect(res.stderr).toMatch(/second person/);
  });

  it("exits 1 for an unparseable file under ANY name, even beside a fresh pass (it may be the damaged failure)", () => {
    const dir = mkdtempSync(join(scratch, "stray-"));
    writeFileSync(join(dir, "2026-12-05-production-restore.json"), JSON.stringify(record()));
    writeFileSync(join(dir, "broken.json"), "{ nope");
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/broken\.json: not valid JSON/);
    expect(res.stderr).toMatch(/OVERDUE: not a valid production restore record.*broken\.json/);
  });

  it("exits 1 when a production restore record is unparseable, even beside a fresh pass", () => {
    const dir = mkdtempSync(join(scratch, "damaged-"));
    writeFileSync(join(dir, "2026-12-05-production-restore.json"), JSON.stringify(record()));
    writeFileSync(join(dir, "2026-12-09-production-restore.json"), '{ "kind": ');
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/OVERDUE: not a valid production restore record.*2026-12-09/);
  });

  it("exits 2 for an unreadable directory or a bad date", () => {
    expect(run(join(scratch, "does-not-exist")).status).toBe(2);
    const dir = mkdtempSync(join(scratch, "x-"));
    expect(
      spawnSync("bun", [SCRIPT, `--dir=${dir}`, "--today=soon"], { encoding: "utf8" }).status,
    ).toBe(2);
  });
});
