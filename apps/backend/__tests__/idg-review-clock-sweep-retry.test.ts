// apps/backend/__tests__/idg-review-clock-sweep-retry.test.ts — the RETRY safety of M14's
// `idg.review-clock-sweep` fan-out (code review 2026-08-14).
//
// The defect: the cron swept every active org inside ONE BullMQ job with `attempts: 3`, and each org's
// `withOrgContext` COMMITS INDEPENDENTLY. A failure part-way through the loop (a) abandoned every org
// after the failing one, and (b) re-ran the WHOLE loop on retry, re-publishing `m14.review_clock.escalated`
// for every org that had already committed — a second and third `critical` escalation for every patient
// sitting exactly on T-3/T-0/T+1. The transactional outbox makes ONE org's burst all-or-nothing; it says
// nothing about the loop around it.
//
// These tests drive the loop directly with a fake db + fake outbox and a checkpoint that mimics what
// BullMQ's `job.data` does across attempts of the same job.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/14-idg/jobs/cron-store", () => ({
  // no IDG review ever stamped → every admission falls back to its activated_at
  lastReviewedByAdmissionForOrg: async () => new Map<string, string>(),
  // the M36 alert's coordinator tier read (not under test here)
  locationCoordinatorsForOrg: async () => new Map<string, string>(),
}));

const { runReviewClockSweepCron } = await import("../src/modules/14-idg/jobs/cron-workers");
type Checkpoint = Parameters<typeof runReviewClockSweepCron>[1];

const NOW = new Date("2026-06-20T12:00:00.000Z");
const ORGS = ["org-1", "org-2", "org-3"] as const;

/** A snapshot whose 15-day floor lands exactly on NOW → one `t_zero` escalation per org. */
const admissionFor = (org: string) => ({
  patientId: `pat-${org}`,
  admissionId: `adm-${org}`,
  locationId: `loc-${org}`,
  activatedAtIso: "2026-06-05T00:00:00.000Z",
});

/** Mimics BullMQ job data: the array survives across attempts of the SAME job, as Redis does. */
function jobDataCheckpoint(): { checkpoint: Checkpoint; swept: string[] } {
  const swept: string[] = [];
  return {
    swept,
    checkpoint: {
      get swept() {
        return [...swept];
      },
      async record(organizationId: string) {
        swept.push(organizationId);
      },
    } as NonNullable<Checkpoint>,
  };
}

interface Published {
  organizationId: string;
  patientId: string;
}

/** Fake db: `withOrgContext` only needs `transaction` + a `tx.execute` for the two set_config calls. */
function fakeDb() {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({ execute: async () => undefined }),
  } as never;
}

function harness(failFor: Set<string>) {
  const published: Published[] = [];
  return {
    published,
    deps: {
      connection: {} as never,
      db: fakeDb(),
      now: () => NOW,
      activeAdmissions: {
        activeAdmissionsForOrg: async (organizationId: string) => [admissionFor(organizationId)],
      },
      activeOrgs: {
        listActiveOrgs: async () => ORGS.map((organizationId) => ({ organizationId })),
      },
      outbox: {
        publish: async (_tx: unknown, e: Record<string, unknown>) => {
          const organizationId = e.organizationId as string;
          if (failFor.has(organizationId)) {
            throw new Error(`outbox blew up for ${organizationId}`);
          }
          published.push({
            organizationId,
            patientId: (e.payload as { patientId: string }).patientId,
          });
        },
      },
    },
  };
}

describe("runReviewClockSweepCron — retry safety across a mid-loop failure", () => {
  it("sweeps every org on a clean tick", async () => {
    const h = harness(new Set());
    await runReviewClockSweepCron(h.deps as never);
    expect(h.published.map((p) => p.organizationId)).toEqual(["org-1", "org-2", "org-3"]);
  });

  it("a failing org no longer aborts the orgs AFTER it, and the tick still fails loudly", async () => {
    const h = harness(new Set(["org-2"]));
    await expect(runReviewClockSweepCron(h.deps as never)).rejects.toThrow(
      /M14_REVIEW_CLOCK_SWEEP: 1 of 3 org\(s\) failed — org-2/,
    );
    // org-3 sorts after the failure and previously never ran at all.
    expect(h.published.map((p) => p.organizationId)).toEqual(["org-1", "org-3"]);
  });

  it("a RETRY does not re-escalate the orgs that already committed", async () => {
    const { checkpoint, swept } = jobDataCheckpoint();

    // Attempt 1: org-2's outbox publish throws.
    const first = harness(new Set(["org-2"]));
    await expect(runReviewClockSweepCron(first.deps as never, checkpoint)).rejects.toThrow();
    expect(first.published.map((p) => p.organizationId)).toEqual(["org-1", "org-3"]);
    expect(swept).toEqual(["org-1", "org-3"]); // only COMMITTED orgs are checkpointed

    // Attempt 2 of the SAME job: whatever was wrong with org-2 is now fixed.
    const second = harness(new Set());
    await runReviewClockSweepCron(second.deps as never, checkpoint);

    // The whole point: org-1 and org-3 are NOT escalated a second time.
    expect(second.published.map((p) => p.organizationId)).toEqual(["org-2"]);
    expect(swept).toEqual(["org-1", "org-3", "org-2"]);
  });

  it("an org that FAILED is not checkpointed, so the retry does re-run it", async () => {
    const { checkpoint, swept } = jobDataCheckpoint();
    const first = harness(new Set(["org-1", "org-2", "org-3"]));
    await expect(runReviewClockSweepCron(first.deps as never, checkpoint)).rejects.toThrow(
      /3 of 3 org\(s\) failed/,
    );
    expect(swept).toEqual([]);

    const second = harness(new Set());
    await runReviewClockSweepCron(second.deps as never, checkpoint);
    expect(second.published.map((p) => p.organizationId)).toEqual(["org-1", "org-2", "org-3"]);
  });
});
