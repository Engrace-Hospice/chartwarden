// A lapsed operator pause is resumed by an hourly sweep (product decision: the stored status follows the date).
//   - the sweep acts on the org's NEWEST subscription only (`ORDER BY started_at DESC LIMIT 1`, the row every other M35 lifecycle path acts
//     on) and resumes it when it is `paused` with a `paused_until` that has passed: status -> active, the pause's own timestamps cleared, a
//     ledger row (paused -> active) DATED AT THE OLD END DATE (so a statement's pause window does not move), and the same
//     `m35.subscription.resumed` event the operator's own resume publishes, once;
//   - an older (superseded) subscription is never a candidate, whatever its status;
//   - it never touches an open-ended pause, a pause whose date is ahead, or a row another writer already moved (zero rows updated);
//   - it composes with the m2 `.suspended` consumer in either order without a duplicate ledger row.
// No database here: a recording transaction double over a LIST of subscriptions that models `ORDER BY started_at DESC` and `LIMIT`, whose
// writes land on the row the guard names (the guards themselves are rendered and asserted). The live suites (m35-org-lifecycle-consumer,
// m35-tenant-pricing) prove the same, and the real races, on the real NOBYPASSRLS application role.
import type { DbClient } from "@chartwarden/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { M35JobDeps } from "../billing-runtime/jobs";
import { runPauseResumeForOrg, runPauseResumeSweep } from "../billing-runtime/pause-resume";
import { buildM35OrgLifecycleConsumer } from "../outbox-consumers/m2-organization-lifecycle";
import { ORG_SUSPENDED_REASON_CODE, PAUSE_LAPSED_REASON_CODE } from "../routes/admin-transition";

const ORG = "a1000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "b2000000-0000-4000-8000-0000000000b2";
const SUB = "5b000000-0000-4000-8000-000000000001";
const PAUSED_AT = new Date("2026-12-01T00:00:00Z");
const UNTIL = new Date("2026-12-15T00:00:00Z");
const NOW = new Date("2026-12-20T03:05:00Z");

interface SubState {
  id: string;
  organizationId: string;
  status: string;
  pausedAt: Date | null;
  pausedUntil: Date | null;
  updatedAt: Date;
  startedAt: Date;
  cancelAtPeriodEnd: boolean;
}

const lapsedPause = (over: Partial<SubState> = {}): SubState => ({
  id: SUB,
  organizationId: ORG,
  status: "paused",
  pausedAt: PAUSED_AT,
  pausedUntil: UNTIL,
  updatedAt: PAUSED_AT,
  startedAt: new Date("2026-10-01T00:00:00Z"),
  cancelAtPeriodEnd: false,
  ...over,
});

const render = (c: SQL) => new PgDialect().sqlToQuery(c);

/** One org's subscriptions (given oldest first, to prove the sweep does not rely on heap order) behind a recording transaction. */
function world(initial: SubState | SubState[], opts: { loseRace?: boolean; now?: Date } = {}) {
  let rows = Array.isArray(initial) ? [...initial] : [initial];
  const log = {
    wheres: [] as SQL[],
    guards: [] as SQL[],
    locks: [] as unknown[],
    orderings: [] as string[],
    limits: [] as number[],
    updates: [] as Record<string, unknown>[],
    updatedIds: [] as string[],
    ledger: [] as Record<string, unknown>[],
    transactions: [] as number[],
  };
  /** A select's tail: `.orderBy()` sorts (only `started_at desc` is modelled), `.limit(n)` cuts, `.for("update")` records the lock. */
  const readOf = (base: () => SubState[]) => {
    let newestFirst = false;
    let max: number | undefined;
    const result = () => {
      const sorted = newestFirst
        ? [...base()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        : base();
      return max === undefined ? sorted : sorted.slice(0, max);
    };
    const forUpdate = (mode: unknown) => {
      log.locks.push(mode);
      return Promise.resolve(result());
    };
    const query = {
      orderBy: (...columns: SQL[]) => {
        const texts = columns.map((c) => render(c).sql);
        log.orderings.push(texts.join(", "));
        newestFirst = texts.some((t) => t.includes('"started_at" desc'));
        return query;
      },
      limit: (n: number) => {
        log.limits.push(n);
        max = n;
        return Object.assign(Promise.resolve(result()), { for: forUpdate });
      },
      for: forUpdate,
    };
    return query;
  };
  const tx = {
    execute: async () => undefined,
    // Two reads, told apart by the predicate each renders: the one-live-per-org check (names `id <> ...`) and the read of the org's rows.
    select: () => ({
      from: () => ({
        where: (c: SQL) => {
          log.wheres.push(c);
          const { sql: text, params } = render(c);
          if (text.includes('"id" <> $'))
            return readOf(() =>
              rows.filter((r) => r.id !== params[1] && !["canceled", "paused"].includes(r.status)),
            );
          return readOf(() => rows);
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        log.updates.push(v);
        return {
          where: (c: SQL) => {
            log.guards.push(c);
            const id = render(c).params[0];
            return {
              returning: async () => {
                if (opts.loseRace) return [];
                log.updatedIds.push(String(id));
                rows = rows.map((r) => (r.id === id ? { ...r, ...(v as Partial<SubState>) } : r));
                return [{ id }];
              },
            };
          },
        };
      },
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        log.ledger.push(v);
      },
    }),
  };
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      log.transactions.push(1);
      return fn(tx);
    },
  } as unknown as DbClient;
  return { db, log, state: (id: string = SUB) => rows.find((r) => r.id === id) as SubState };
}

function deps(db: DbClient, over: Partial<M35JobDeps> = {}) {
  const published: Record<string, unknown>[] = [];
  const outbox = {
    publish: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => {
      published.push(input);
    }),
  };
  const jobs: M35JobDeps = {
    db,
    platformRunner: (async () => {
      throw new Error("the sweep must not open a platform transaction");
    }) as never,
    outbox,
    listOrgs: async () => [{ organizationId: ORG }],
    now: () => NOW,
    ...over,
  };
  return { jobs, published, outbox };
}

describe("the sweep resumes a lapsed operator pause", () => {
  it("resumes the row, dates the ledger at the OLD end date, and publishes the operator's own resume event once", async () => {
    const w = world(lapsedPause());
    const { jobs, published } = deps(w.db);

    const resumed = await runPauseResumeForOrg(jobs, ORG);

    expect(resumed).toBe(1);
    expect(w.state()).toMatchObject({
      status: "active",
      pausedAt: null,
      pausedUntil: null,
      updatedAt: NOW,
    });
    expect(w.log.ledger).toEqual([
      {
        subscriptionId: SUB,
        organizationId: ORG,
        fromStatus: "paused",
        toStatus: "active",
        transitionedAt: UNTIL, // the date the pause ended on, NOT the sweep's instant
        actorMembershipId: null,
        reasonCode: PAUSE_LAPSED_REASON_CODE,
      },
    ]);
    expect(PAUSE_LAPSED_REASON_CODE).toBe("platform_ops_pause_lapsed");
    expect(published).toEqual([
      {
        eventName: "m35.subscription.resumed",
        payload: { subscriptionId: SUB, organizationId: ORG, resumedAt: UNTIL.toISOString() },
        organizationId: ORG,
        aggregateKind: "subscription",
        aggregateId: SUB,
      },
    ]);
  });

  it("reads the org's NEWEST subscription (ORDER BY started_at DESC LIMIT 1) under a row lock, and the write carries the lapse predicate", async () => {
    const w = world(lapsedPause());
    await runPauseResumeForOrg(deps(w.db).jobs, ORG);

    expect(w.log.locks).toEqual(["update"]);
    expect(w.log.limits[0]).toBe(1); // (the second limit, if any, is the one-live-per-org check)
    expect(w.log.orderings).toHaveLength(1);
    expect(w.log.orderings[0]).toContain('"started_at" desc');
    expect(render(w.log.wheres[0] as SQL).sql).toContain('"organization_id" = $');
    // the write is guarded: the row, still `paused`, its date still passed
    const { sql: text, params } = render(w.log.guards[0] as SQL);
    expect(text).toContain('"id" = $');
    expect(text).toContain('"status" = $');
    expect(text).toContain('"paused_until" is not null');
    expect(text).toContain('"paused_until" <= $');
    expect(params).toContain("paused");
  });

  it("two lapsed pauses in one org: only the NEWEST is resumed, the older one is never a candidate (whatever order the rows come in)", async () => {
    const older = lapsedPause({
      id: "5b000000-0000-4000-8000-000000000010",
      startedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const newest = lapsedPause({
      id: "5b000000-0000-4000-8000-000000000011",
      startedAt: new Date("2026-11-01T00:00:00Z"),
    });
    for (const rows of [
      [older, newest],
      [newest, older],
    ]) {
      const w = world(rows);
      const { jobs, published } = deps(w.db);

      expect(await runPauseResumeForOrg(jobs, ORG)).toBe(1);

      expect(w.state(newest.id).status).toBe("active");
      expect(w.state(older.id)).toMatchObject({ status: "paused", pausedUntil: UNTIL });
      expect(w.log.updatedIds).toEqual([newest.id]);
      expect(w.log.ledger.map((r) => r.subscriptionId)).toEqual([newest.id]);
      expect(published.map((e) => e.aggregateId)).toEqual([newest.id]);
      // and a second run (the older one is still lapsed and paused) resumes nothing
      expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    }
  });

  it("a lapsed pause under a NEWER subscription is never resurrected, whatever the newer one is (canceled, active, paused open-ended): nothing is written and nothing is logged", async () => {
    const lapsed = lapsedPause({
      id: "5b000000-0000-4000-8000-000000000020",
      startedAt: new Date("2026-09-01T00:00:00Z"),
    });
    for (const status of ["canceled", "active", "trialing", "suspended"]) {
      const newer = lapsedPause({
        id: `5b000000-0000-4000-8000-0000000000${status.length}1`,
        status,
        pausedAt: null,
        pausedUntil: null,
        startedAt: new Date("2026-11-01T00:00:00Z"),
      });
      const w = world([lapsed, newer]);
      const logged: unknown[] = [];
      const { jobs, published } = deps(w.db, { log: (...args) => void logged.push(args) });

      expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);

      expect(w.state(lapsed.id).status).toBe("paused");
      expect(w.log.updates).toEqual([]);
      expect(w.log.ledger).toEqual([]);
      expect(published).toEqual([]);
      expect(logged).toEqual([]);
    }
  });

  it("does nothing when no pause has lapsed: no write, no ledger row, no event", async () => {
    const w = world(lapsedPause({ status: "active", pausedAt: null, pausedUntil: null }));
    const { jobs, published } = deps(w.db);

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.log.updates).toEqual([]);
    expect(w.log.ledger).toEqual([]);
    expect(published).toEqual([]);
  });

  it("leaves an OPEN-ENDED pause alone (an org suspension is one: paused_until is null)", async () => {
    const w = world(lapsedPause({ pausedUntil: null }));
    const { jobs, published } = deps(w.db);

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.state().status).toBe("paused");
    expect(w.log.ledger).toEqual([]);
    expect(published).toEqual([]);
  });

  it("leaves a pause whose date is still ahead alone", async () => {
    const w = world(lapsedPause({ pausedUntil: new Date("2026-12-25T00:00:00Z") }));
    const { jobs, published } = deps(w.db);

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.state().status).toBe("paused");
    expect(published).toEqual([]);
  });

  it("resumes a pause whose date is exactly now (<=)", async () => {
    const w = world(lapsedPause({ pausedUntil: NOW }));
    expect(await runPauseResumeForOrg(deps(w.db).jobs, ORG)).toBe(1);
    expect(w.log.ledger[0]).toMatchObject({ transitionedAt: NOW });
  });

  it("a lost race (zero rows updated) writes no ledger row and publishes nothing", async () => {
    const w = world(lapsedPause(), { loseRace: true });
    const { jobs, published } = deps(w.db);

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.log.ledger).toEqual([]);
    expect(published).toEqual([]);
  });

  it("leaves the newest pause alone when an OLDER subscription of the org is live (resuming it would break one-live-per-org), logging it ONCE per row, not every hour", async () => {
    const older = lapsedPause({
      id: "5b000000-0000-4000-8000-000000000030",
      status: "active",
      pausedAt: null,
      pausedUntil: null,
      startedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const newest = lapsedPause({
      id: "5b000000-0000-4000-8000-000000000031",
      startedAt: new Date("2026-11-01T00:00:00Z"),
    });
    const w = world([older, newest]);
    const logged: Record<string, unknown>[] = [];
    const { jobs, published } = deps(w.db, { log: (_m, detail) => void logged.push(detail) });

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0); // the next hour
    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0); // and the next

    expect(w.state(newest.id).status).toBe("paused");
    expect(w.log.updates).toEqual([]);
    expect(published).toEqual([]);
    expect(logged).toEqual([{ organizationId: ORG, subscriptionId: newest.id }]); // once
  });

  it("is idempotent: a second run finds nothing to do and publishes nothing more", async () => {
    const w = world(lapsedPause());
    const { jobs, published } = deps(w.db);

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(1);
    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.log.ledger).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("a failing publish rejects the org's run, so its transaction does not commit (the rollback itself is proven live; the next hour retries)", async () => {
    const w = world(lapsedPause());
    const { jobs, outbox } = deps(w.db);
    outbox.publish.mockRejectedValueOnce(new Error("catalog refused"));

    await expect(runPauseResumeForOrg(jobs, ORG)).rejects.toThrow("catalog refused");
  });
});

describe("the sweep is the active-org fan-out: a suspended organization is never visited", () => {
  it("opens a transaction only for the organizations the enumerator lists, and isolates one org's failure", async () => {
    const w = world(lapsedPause());
    const logged: string[] = [];
    const { jobs } = deps(w.db, {
      // OTHER_ORG stands for a suspended organization: the active-org enumerator (status 'active' only) does not list it
      listOrgs: async () => [{ organizationId: ORG }],
      log: (message) => void logged.push(message),
    });

    await runPauseResumeSweep(jobs);

    expect(w.log.transactions).toHaveLength(1);
    expect(w.state().status).toBe("active");
    expect(logged).toEqual([]);
    expect(OTHER_ORG).not.toBe(ORG);
  });

  it("one org failing does not stop the next, and the job still fails afterwards", async () => {
    const good = world(lapsedPause());
    let transactions = 0;
    const routed = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        transactions += 1;
        if (transactions === 1) throw new Error("boom");
        return (good.db as unknown as { transaction: typeof fn }).transaction(fn);
      },
    } as unknown as DbClient;
    const { jobs } = deps(routed, {
      listOrgs: async () => [{ organizationId: OTHER_ORG }, { organizationId: ORG }],
      log: () => undefined,
    });

    await expect(runPauseResumeSweep(jobs)).rejects.toThrow(/pause_resume: 1 org\(s\) failed/);
    expect(good.state().status).toBe("active");
  });
});

describe("composition with the m2 `.suspended` consumer, in either order", () => {
  const suspend = (db: DbClient, outbox: ReturnType<typeof deps>["outbox"]) =>
    buildM35OrgLifecycleConsumer({ db, outbox, now: () => NOW }).handle({
      eventType: "m2.organization.suspended",
      organizationId: ORG,
      payload: { organizationId: ORG, reason: "compliance_hold" },
    });

  it("sweep first: the consumer finds an active row and takes the normal path (no second lapse row)", async () => {
    const w = world(lapsedPause());
    const { jobs, outbox } = deps(w.db);

    await runPauseResumeForOrg(jobs, ORG);
    await suspend(w.db, outbox);

    expect(w.log.ledger.map((r) => [r.fromStatus, r.toStatus, r.reasonCode])).toEqual([
      ["paused", "active", PAUSE_LAPSED_REASON_CODE], // the sweep's, dated at the old date
      ["active", "paused", "org_suspended_by_platform_admin"], // the consumer's, a plain suspension
    ]);
    expect(w.state()).toMatchObject({ status: "paused", pausedUntil: null, pausedAt: NOW });
  });

  it("consumer first: the consumer writes the lapse itself and the new pause is open-ended, so the sweep finds nothing", async () => {
    const w = world(lapsedPause());
    const { jobs, outbox, published } = deps(w.db);

    await suspend(w.db, outbox);
    const afterConsumer = [...w.log.ledger];
    published.length = 0;
    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);

    expect(afterConsumer.map((r) => [r.fromStatus, r.toStatus, r.reasonCode])).toEqual([
      ["paused", "active", PAUSE_LAPSED_REASON_CODE],
      ["active", "paused", "org_suspended_by_platform_admin"],
    ]);
    expect(w.log.ledger).toHaveLength(2); // the sweep added nothing
    expect(published).toEqual([]);
    expect(w.state()).toMatchObject({ status: "paused", pausedUntil: null });
  });

  it("the consumer reads the org's row under a row lock, so it and the sweep serialize on the row", async () => {
    const w = world(lapsedPause());
    await suspend(w.db, deps(w.db).outbox);
    expect(w.log.locks).toEqual(["update"]);
  });
});

describe("a suspension while an operator's DATED pause is still running makes it open-ended (a suspended org is billing-exempt)", () => {
  const RUNNING_UNTIL = new Date("2026-12-25T00:00:00Z"); // ahead of NOW
  const suspend = (db: DbClient, outbox: ReturnType<typeof deps>["outbox"]) =>
    buildM35OrgLifecycleConsumer({ db, outbox, now: () => NOW }).handle({
      eventType: "m2.organization.suspended",
      organizationId: ORG,
      payload: { organizationId: ORG, reason: "compliance_hold" },
    });

  it("clears the date (the pause keeps its own start), writes a paused -> paused ledger row at the suspension instant, and announces the new open-ended pause", async () => {
    const w = world(lapsedPause({ pausedUntil: RUNNING_UNTIL }));
    const { outbox, published } = deps(w.db);

    await suspend(w.db, outbox);

    // only the date is cleared: status stays paused and paused_at stays the pause's own start (the pause is continuous)
    expect(w.log.updates).toEqual([{ pausedUntil: null, updatedAt: NOW }]);
    expect(w.state()).toMatchObject({ status: "paused", pausedAt: PAUSED_AT, pausedUntil: null });
    expect(w.log.ledger).toEqual([
      {
        subscriptionId: SUB,
        organizationId: ORG,
        fromStatus: "paused",
        toStatus: "paused",
        transitionedAt: NOW,
        actorMembershipId: null,
        reasonCode: ORG_SUSPENDED_REASON_CODE,
        reasonDetail: "compliance_hold",
      },
    ]);
    expect(ORG_SUSPENDED_REASON_CODE).toBe("org_suspended_by_platform_admin");
    expect(published).toEqual([
      {
        eventName: "m35.subscription.paused",
        payload: {
          subscriptionId: SUB,
          organizationId: ORG,
          pausedAt: PAUSED_AT.toISOString(),
          pausedUntil: null,
        },
        organizationId: ORG,
        aggregateKind: "subscription",
        aggregateId: SUB,
      },
    ]);
  });

  it("a redelivery finds an open-ended pause and changes nothing", async () => {
    const w = world(lapsedPause({ pausedUntil: RUNNING_UNTIL }));
    const { outbox, published } = deps(w.db);

    await suspend(w.db, outbox);
    await suspend(w.db, outbox);

    expect(w.log.updates).toHaveLength(1);
    expect(w.log.ledger).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("an open-ended pause (an earlier suspension, or an operator's with no date) already covers the suspension: nothing is written", async () => {
    const w = world(lapsedPause({ pausedUntil: null }));
    const { outbox, published } = deps(w.db);

    await suspend(w.db, outbox);

    expect(w.log.updates).toEqual([]);
    expect(w.log.ledger).toEqual([]);
    expect(published).toEqual([]);
  });

  it("a lost race writes no ledger row and announces nothing", async () => {
    const w = world(lapsedPause({ pausedUntil: RUNNING_UNTIL }), { loseRace: true });
    const { outbox, published } = deps(w.db);

    await suspend(w.db, outbox);

    expect(w.log.ledger).toEqual([]);
    expect(published).toEqual([]);
  });

  it("a pause whose date is exactly now has lapsed: it is the lapsed path (lapse at the date, then a new pause), not the running one", async () => {
    const w = world(lapsedPause({ pausedUntil: NOW }));
    const { outbox } = deps(w.db);

    await suspend(w.db, outbox);

    expect(w.log.ledger.map((r) => [r.fromStatus, r.toStatus, r.reasonCode])).toEqual([
      ["paused", "active", PAUSE_LAPSED_REASON_CODE],
      ["active", "paused", ORG_SUSPENDED_REASON_CODE],
    ]);
  });
});
