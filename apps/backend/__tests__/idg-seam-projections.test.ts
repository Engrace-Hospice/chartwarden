// Pure projections behind the M14 IDG read enrichment (no DB):
//   • M5 `toPatientDisplayLabel` — "First L." + MRN last-4, nothing more crosses the seam;
//   • M6 `projectIdgRecertWindow` — the per-patient recert/F2F window over M6's OWN window math (CMS 418.22
//     prior-to window [start-30, start-1], F2F required from the 3rd benefit period).
import { describe, expect, it } from "vitest";
import { toPatientDisplayLabel } from "../src/modules/05-patient/seams/patient-display-for-org";
import { projectIdgRecertWindow } from "../src/modules/06-admission/seams/idg-recert-windows-for-org";

describe("toPatientDisplayLabel (M5)", () => {
  it("projects legal first name + last INITIAL and the MRN last four; never the full last name or MRN", () => {
    const l = toPatientDisplayLabel({
      id: "p1",
      legalFirstName: " Ada ",
      legalLastName: "lovelace",
      mrn: "MRN-000123456",
    });
    expect(l).toEqual({ patientId: "p1", displayName: "Ada L.", mrnSuffix: "3456" });
    expect(JSON.stringify(l)).not.toContain("ovelace");
    expect(JSON.stringify(l)).not.toContain("000123");
  });
  it("handles a short/blank MRN and a missing name without throwing", () => {
    expect(
      toPatientDisplayLabel({ id: "p", legalFirstName: "Bo", legalLastName: "", mrn: "12" }),
    ).toMatchObject({ displayName: "Bo", mrnSuffix: "12" });
    expect(
      toPatientDisplayLabel({ id: "p", legalFirstName: "", legalLastName: "", mrn: "" }),
    ).toMatchObject({ displayName: "Unnamed patient", mrnSuffix: null });
  });
});

const TZ = "America/Los_Angeles";
const period = (
  id: string,
  sequence: number,
  status: string,
  start: string | null,
  end: string | null,
) => ({ id, admissionId: "adm", sequence, status, start, end });

describe("projectIdgRecertWindow (M6)", () => {
  it("period 2 active → next period is #3: F2F required, window_open inside [start-30, start-1], unattested", () => {
    const w = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods: [
        period("e1", 1, "completed", "2026-01-01", "2026-03-31"),
        period("e2", 2, "active", "2026-04-01", "2026-06-29"),
        period("e3", 3, "pending", "2026-06-30", "2026-08-28"),
      ],
      f2fByPeriodId: new Map([["e3", [{ status: "scheduled", scheduledDate: "2026-06-20" }]]]),
      today: "2026-06-10",
      timeZone: TZ,
    });
    expect(w).toMatchObject({
      currentPeriodSequence: 2,
      benefitPeriodEnd: "2026-06-29",
      nextRecertDueDate: "2026-06-30",
      nextPeriodSequence: 3,
      daysUntilNextRecert: 20,
      f2fRequired: true,
      f2fWindowStart: "2026-05-31",
      f2fWindowEnd: "2026-06-29",
      f2fStatus: "window_open",
      f2fWindowState: "window_open",
      f2fScheduledDate: "2026-06-20",
    });
  });

  it("an attested F2F closes the window (not_due); an unattested past-end window is overdue", () => {
    const periods = [
      period("e2", 2, "active", "2026-04-01", "2026-06-29"),
      period("e3", 3, "pending", "2026-06-30", "2026-08-28"),
    ];
    const attested = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods,
      f2fByPeriodId: new Map([["e3", [{ status: "attested", scheduledDate: null }]]]),
      today: "2026-06-10",
      timeZone: TZ,
    });
    expect(attested).toMatchObject({ f2fStatus: "attested", f2fWindowState: "not_due" });

    // today past windowEnd (2026-06-29) with the period still un-flipped → missed/overdue
    const overdue = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods: [period("e2", 2, "active", "2026-04-01", "2026-06-29"), periods[1]!],
      f2fByPeriodId: new Map(),
      today: "2026-06-30",
      timeZone: TZ,
    });
    expect(overdue).toMatchObject({ f2fStatus: "missed", f2fWindowState: "overdue" });
  });

  it("before the window opens → not_yet_open / not_due", () => {
    const w = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods: [period("e2", 2, "active", "2026-04-01", "2026-06-29")],
      f2fByPeriodId: new Map(),
      today: "2026-04-15",
      timeZone: TZ,
    });
    expect(w).toMatchObject({ f2fStatus: "not_yet_open", f2fWindowState: "not_due" });
  });

  it("period 1 active → next is #2: F2F not required", () => {
    const w = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods: [period("e1", 1, "active", "2026-04-01", "2026-06-29")],
      f2fByPeriodId: new Map(),
      today: "2026-06-10",
      timeZone: TZ,
    });
    expect(w).toMatchObject({
      f2fRequired: false,
      f2fStatus: "not_required",
      f2fWindowState: "not_due",
      f2fWindowStart: null,
      nextRecertDueDate: "2026-06-30",
    });
  });

  it("no resolvable current period → unknown, never a fabricated verdict", () => {
    const w = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods: [period("e1", 1, "pending", null, null)],
      f2fByPeriodId: new Map(),
      today: "2026-06-10",
      timeZone: TZ,
    });
    expect(w).toMatchObject({
      currentPeriodSequence: null,
      nextRecertDueDate: null,
      f2fStatus: "unknown",
      f2fWindowState: null,
    });
  });

  it("falls back to the dated period containing today when none is flagged active", () => {
    const w = projectIdgRecertWindow({
      patientId: "p",
      admissionId: "adm",
      periods: [period("e1", 1, "signed", "2026-04-01", "2026-06-29")],
      f2fByPeriodId: new Map(),
      today: "2026-05-01",
      timeZone: TZ,
    });
    expect(w.currentPeriodSequence).toBe(1);
  });
});
