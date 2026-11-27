// CW-BR-10 — the pure retention rule for the rendered bereavement mailing batch files: which files are due, which a hold protects, and that the class floor
// is never undercut. No database: facts in, a plan out.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAILING_FILE_RETENTION,
  MAILING_FILE_RETENTION_FLOOR_DAYS,
  type PlanFile,
  type PlanRun,
  clampRetention,
  planMailingFilePurge,
} from "../src/modules/16-bereavement/mailings/file-purge-plan";

const DAY_MS = 86_400_000;
const NOW = new Date("2027-06-30T12:00:00.000Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const file = (id: string, createdDaysAgo: number, heldByDocumentStore = false): PlanFile => ({
  documentId: id,
  createdAt: daysAgo(createdDaysAgo),
  heldByDocumentStore,
});
const run = (over: Partial<PlanRun> & { runId: string; status: string }): PlanRun => ({
  version: 3,
  mailedAt: null,
  generatedAt: null,
  updatedAt: daysAgo(1),
  touchesHeldPatient: false,
  ...over,
});
const plan = (
  files: PlanFile[],
  runs: Record<string, PlanRun> = {},
  holds = { orgWide: false, patientScoped: false },
) =>
  planMailingFilePurge({
    files,
    runsByDocument: new Map(Object.entries(runs)),
    holds,
    retention: DEFAULT_MAILING_FILE_RETENTION,
    now: NOW,
  });

describe("CW-BR-10 mailing file purge rule", () => {
  it("the default floor is the bereavement class's 13 months (396 days)", () => {
    expect(MAILING_FILE_RETENTION_FLOOR_DAYS).toBe(396);
    expect(DEFAULT_MAILING_FILE_RETENTION.mailedDays).toBe(396);
  });

  describe("a mailed run's file", () => {
    it("is kept until 396 days after the mailing was CONFIRMED, however old the render is", () => {
      const r = run({ runId: "r1", status: "mailed", mailedAt: daysAgo(395) });
      const result = plan([file("d1", 900)], { d1: r });
      expect(result.due).toEqual([]);
      expect(result.retained).toBe(1);
    });

    it("is due at 396 days after the confirm, on the mailed_retention basis", () => {
      const r = run({ runId: "r1", status: "mailed", mailedAt: daysAgo(396) });
      expect(plan([file("d1", 400)], { d1: r }).due).toEqual([
        {
          documentId: "d1",
          basis: "mailed_retention",
          runId: "r1",
          runVersion: 3,
          cancelRunFirst: false,
        },
      ]);
    });

    it("is never due without a mailed_at", () => {
      expect(
        plan([file("d1", 900)], { d1: run({ runId: "r1", status: "mailed", mailedAt: null }) }).due,
      ).toEqual([]);
    });
  });

  describe("a cancelled run's file", () => {
    it("is kept 30 days after the cancel, then due", () => {
      const early = run({ runId: "r1", status: "cancelled", updatedAt: daysAgo(29) });
      const late = run({ runId: "r2", status: "cancelled", updatedAt: daysAgo(30) });
      expect(plan([file("d1", 60)], { d1: early }).due).toEqual([]);
      expect(plan([file("d2", 60)], { d2: late }).due[0]).toMatchObject({
        documentId: "d2",
        basis: "cancelled_grace",
      });
    });
  });

  describe("a cancelled run's file that is older than the floor (a purge-time cancel whose destroy failed retries at once)", () => {
    it("is due at once on the cancelled_past_floor basis, with no run to cancel again", () => {
      const r = run({
        runId: "r1",
        status: "cancelled",
        updatedAt: daysAgo(0),
        generatedAt: daysAgo(400),
        version: 5,
      });
      expect(plan([file("d1", 400)], { d1: r }).due).toEqual([
        {
          documentId: "d1",
          basis: "cancelled_past_floor",
          runId: "r1",
          runVersion: 5,
          cancelRunFirst: false,
        },
      ]);
    });

    it("keeps the 30-day grace for a cancelled batch generated inside the floor", () => {
      const r = run({
        runId: "r1",
        status: "cancelled",
        updatedAt: daysAgo(5),
        generatedAt: daysAgo(300),
      });
      expect(plan([file("d1", 300)], { d1: r }).due).toEqual([]);
    });
  });

  describe("a ready run's file (rendered, never mailed, never cancelled)", () => {
    it("is kept until a full floor after generation", () => {
      const r = run({ runId: "r1", status: "ready", generatedAt: daysAgo(395) });
      expect(plan([file("d1", 395)], { d1: r }).due).toEqual([]);
    });

    it("is then due as abandoned, and its run is to be cancelled first", () => {
      const r = run({ runId: "r1", status: "ready", generatedAt: daysAgo(400), version: 7 });
      expect(plan([file("d1", 400)], { d1: r }).due).toEqual([
        {
          documentId: "d1",
          basis: "abandoned_ready",
          runId: "r1",
          runVersion: 7,
          cancelRunFirst: true,
        },
      ]);
    });
  });

  it("decides nothing for a file named by a draft, generating or failed run", () => {
    for (const status of ["draft", "generating", "failed"]) {
      expect(plan([file("d1", 900)], { d1: run({ runId: "r1", status }) }).due).toEqual([]);
    }
  });

  describe("a file no run names (a regenerate detached it, a lost compare-and-set, an abandoned claim)", () => {
    it("is kept for 7 days past its render, long past any attempt in flight", () => {
      expect(plan([file("d1", 6)]).due).toEqual([]);
    });

    it("is then due on the unreferenced basis, with no run to touch", () => {
      expect(plan([file("d1", 7)]).due).toEqual([
        {
          documentId: "d1",
          basis: "unreferenced",
          runId: null,
          runVersion: null,
          cancelRunFirst: false,
        },
      ]);
    });
  });

  describe("holds beat the clock", () => {
    const aged = run({ runId: "r1", status: "mailed", mailedAt: daysAgo(900) });

    it("an M22 hold protects an otherwise due file", () => {
      const result = plan([file("d1", 900, true)], { d1: aged });
      expect(result.due).toEqual([]);
      expect(result.held).toBe(1);
    });

    it("an org-wide M4 hold protects every file, referenced or not", () => {
      const result = plan(
        [file("d1", 900), file("d2", 900)],
        { d1: aged },
        {
          orgWide: true,
          patientScoped: false,
        },
      );
      expect(result.due).toEqual([]);
      expect(result.held).toBe(2);
    });

    it("a patient-scoped M4 hold protects the runs that hold a held patient's family, and any file no run names", () => {
      const touching = run({
        runId: "r1",
        status: "mailed",
        mailedAt: daysAgo(900),
        touchesHeldPatient: true,
      });
      const result = plan(
        [file("held-run", 900), file("clear-run", 900), file("orphan", 900)],
        { "held-run": touching, "clear-run": { ...aged, runId: "r2" } },
        { orgWide: false, patientScoped: true },
      );
      expect(result.due.map((d) => d.documentId)).toEqual(["clear-run"]);
      expect(result.held).toBe(2);
    });
  });

  it("keeps the order of the files it was given (oldest first) and counts every file once", () => {
    const result = plan([file("a", 30), file("b", 20), file("c", 1)]);
    expect(result.due.map((d) => d.documentId)).toEqual(["a", "b"]);
    expect(result.due.length + result.held + result.retained).toBe(3);
  });

  describe("the floor is never undercut", () => {
    it("clamps a retention shorter than the class floor up to it, and keeps a longer one", () => {
      expect(
        clampRetention({
          mailedDays: 10,
          abandonedReadyDays: 0,
          cancelledGraceDays: 0,
          unreferencedGraceDays: -5,
        }),
      ).toEqual({
        mailedDays: 396,
        abandonedReadyDays: 396,
        cancelledGraceDays: 1,
        unreferencedGraceDays: 1,
      });
      expect(
        clampRetention({ ...DEFAULT_MAILING_FILE_RETENTION, mailedDays: 800 }).mailedDays,
      ).toBe(800);
    });

    it("treats a non-finite period as the floor, so a bad config purges later, never sooner", () => {
      expect(
        clampRetention({ ...DEFAULT_MAILING_FILE_RETENTION, mailedDays: Number.NaN }).mailedDays,
      ).toBe(396);
    });

    it("a plan with a too-short mailedDays still keeps a file 200 days after the confirm", () => {
      const r = run({ runId: "r1", status: "mailed", mailedAt: daysAgo(200) });
      const result = planMailingFilePurge({
        files: [file("d1", 300)],
        runsByDocument: new Map([["d1", r]]),
        holds: { orgWide: false, patientScoped: false },
        retention: { ...DEFAULT_MAILING_FILE_RETENTION, mailedDays: 30 },
        now: NOW,
      });
      expect(result.due).toEqual([]);
    });
  });
});
