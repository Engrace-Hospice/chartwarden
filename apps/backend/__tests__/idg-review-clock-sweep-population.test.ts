// apps/backend/__tests__/idg-review-clock-sweep-population.test.ts — GAP-042 (§4.8 / §418.56(d)). The
// review-clock sweep's POPULATION is every ACTIVE admission (M6 seam), not "patients with a packet": a
// never-reviewed admission with no packet at all must still escalate off its `activated_at`, the M6 read
// is keyset-paged, a stamped review wins over activation, and an unbound / oversized population fails loud.
import { describe, expect, it, vi } from "vitest";

const reviewed = vi.hoisted(() => ({ byAdmission: new Map<string, string>() }));

vi.mock("../src/modules/14-idg/jobs/cron-store", () => ({
  lastReviewedByAdmissionForOrg: async () => reviewed.byAdmission,
  locationCoordinatorsForOrg: async () => new Map<string, string>(),
}));

const { runReviewClockSweepCron } = await import("../src/modules/14-idg/jobs/cron-workers");
const { REVIEW_CLOCK_MAX_PAGES, REVIEW_CLOCK_PAGE_SIZE } = await import(
  "../src/modules/14-idg/jobs/index"
);

const NOW = new Date("2026-06-20T12:00:00.000Z");
const ORG = "org-1";
const admission = (id: string, activatedAtIso: string) => ({
  admissionId: id,
  patientId: `pat-${id}`,
  locationId: "loc-1",
  activatedAtIso,
});

function run(
  admissions: (after: string | null, limit: number) => ReturnType<typeof admission>[],
  published: Record<string, unknown>[] = [],
) {
  const calls: { after: string | null; limit: number }[] = [];
  const deps = {
    connection: {} as never,
    db: {
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn({ execute: async () => undefined }),
    } as never,
    now: () => NOW,
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
    activeAdmissions: {
      activeAdmissionsForOrg: async (_o: string, after: string | null, limit: number) => {
        calls.push({ after, limit });
        return admissions(after, limit);
      },
    },
    outbox: {
      publish: async (_tx: unknown, e: { payload: Record<string, unknown> }) => {
        published.push(e.payload);
      },
    },
  };
  return { deps, calls, published };
}

describe("runReviewClockSweepCron — GAP-042 active-admission population", () => {
  it("escalates a 13-day-old never-reviewed admission that has NO packet (t_minus_3 off activated_at)", async () => {
    reviewed.byAdmission = new Map(); // no packet ⇒ no review stamp
    const h = run(() => [admission("a1", "2026-06-08T00:00:00.000Z")]); // + 15d = 2026-06-23
    await runReviewClockSweepCron(h.deps as never);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({
      admissionId: "a1",
      patientId: "pat-a1",
      lastIdgReviewedAt: null,
      stage: "t_minus_3",
      severity: "clinical_routine",
    });
  });

  it("a stamped review overrides the activation origin (reviewed recently ⇒ no escalation)", async () => {
    reviewed.byAdmission = new Map([["a2", "2026-06-18T00:00:00.000Z"]]);
    const h = run(() => [admission("a2", "2026-06-05T00:00:00.000Z")]); // activation alone would be t_zero
    await runReviewClockSweepCron(h.deps as never);
    expect(h.published).toEqual([]);
  });

  it("pages M6 by keyset until a short page and covers every admission across pages", async () => {
    reviewed.byAdmission = new Map();
    const all = Array.from({ length: REVIEW_CLOCK_PAGE_SIZE + 1 }, (_, i) =>
      admission(`a${String(i).padStart(4, "0")}`, "2026-06-05T00:00:00.000Z"),
    );
    const h = run((after, limit) => {
      const start = after === null ? 0 : all.findIndex((a) => a.admissionId === after) + 1;
      return all.slice(start, start + limit);
    });
    await runReviewClockSweepCron(h.deps as never);
    expect(h.calls.map((c) => c.after)).toEqual([
      null,
      all[REVIEW_CLOCK_PAGE_SIZE - 1]?.admissionId,
    ]);
    expect(h.published).toHaveLength(REVIEW_CLOCK_PAGE_SIZE + 1);
  });

  it("throws (never silently truncates) when the population exceeds the page ceiling", async () => {
    reviewed.byAdmission = new Map();
    let n = 0;
    const h = run(() =>
      Array.from({ length: REVIEW_CLOCK_PAGE_SIZE }, () =>
        admission(`b${n++}`, "2026-06-05T00:00:00.000Z"),
      ),
    );
    const failure = await runReviewClockSweepCron(h.deps as never).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]?.message).toMatch(/more than/);
    expect(h.calls).toHaveLength(REVIEW_CLOCK_MAX_PAGES);
    expect(h.published).toEqual([]);
  });

  it("fails closed when the M6 active-admission port is unbound", async () => {
    const h = run(() => []);
    const deps = { ...h.deps, activeAdmissions: undefined };
    const failure = await runReviewClockSweepCron(deps as never).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]?.message).toMatch(/M14_WORKER_PORT_UNBOUND/);
  });
});
