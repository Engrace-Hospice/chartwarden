// A lapsed operator pause is resumed by an hourly sweep (product decision: the stored status follows the date).
//   - the sweep resumes a `paused` subscription whose `paused_until` has passed: status -> active, the pause's own timestamps cleared, a
//     ledger row (paused -> active) DATED AT THE OLD END DATE (so a statement's pause window does not move), and the same
//     `m35.subscription.resumed` event the operator's own resume publishes, once;
//   - it never touches an open-ended pause, a pause whose date is ahead, or a row another writer already moved (zero rows updated);
//   - it composes with the m2 `.suspended` consumer in either order without a duplicate ledger row.
// No database here: a recording transaction double whose reads encode the SQL predicates by hand (the predicates themselves are rendered and
// asserted). The live suite (m35-org-lifecycle-consumer) proves the same, and the real race, on the real NOBYPASSRLS application role.
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

/** What `status = 'paused' AND paused_until IS NOT NULL AND paused_until <= now` selects, written by hand against the double's one row. */
const isLapsed = (s: SubState, now: Date): boolean =>
  s.status === "paused" && s.pausedUntil !== null && s.pausedUntil <= now;

/** One subscription, two views: the sweep's reads (the lapse predicate) and the consumer's (the org's newest row). */
function world(
  initial: SubState,
  opts: { loseRace?: boolean; now?: Date; otherLive?: boolean } = {},
) {
  let current = initial;
  const now = opts.now ?? NOW;
  const log = {
    wheres: [] as SQL[],
    guards: [] as SQL[],
    locks: [] as unknown[],
    updates: [] as Record<string, unknown>[],
    ledger: [] as Record<string, unknown>[],
    transactions: [] as number[],
  };
  /** The tail of a select: `.orderBy().limit(n)` and `.for("update")` both end the chain with the rows (`.limit()` can still take a lock). */
  const readOf = (rows: () => unknown[]) => {
    const forUpdate = (mode: unknown) => {
      log.locks.push(mode);
      return Promise.resolve(rows());
    };
    const query = {
      orderBy: () => query,
      limit: () => Object.assign(Promise.resolve(rows()), { for: forUpdate }),
      for: forUpdate,
    };
    return query;
  };
  const tx = {
    execute: async () => undefined,
    // Three reads, told apart by the predicate each renders: the sweep's lapse read (names `paused_until`), its sibling check (names
    // `id <> ...`), and the consumer's read of the org's newest row.
    select: () => ({
      from: () => ({
        where: (c: SQL) => {
          log.wheres.push(c);
          const text = render(c).sql;
          if (text.includes('"id" <> $'))
            return readOf(() => (opts.otherLive ? [{ id: "other" }] : []));
          if (text.includes('"paused_until"'))
            return readOf(() => (isLapsed(current, now) ? [current] : []));
          return readOf(() => [current]);
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        log.updates.push(v);
        return {
          where: (c: SQL) => {
            log.guards.push(c);
            return {
              returning: async () => {
                if (opts.loseRace) return [];
                current = { ...current, ...(v as Partial<SubState>) };
                return [{ id: current.id }];
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
  return { db, log, state: () => current };
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

  it("reads the lapsed pauses under a row lock, and both the read and the write carry the lapse predicate", async () => {
    const w = world(lapsedPause());
    await runPauseResumeForOrg(deps(w.db).jobs, ORG);

    expect(w.log.locks).toEqual(["update"]);
    // the first read is the lapse read (the second, if any, is the one-live-per-org check)
    for (const predicate of [w.log.wheres[0] as SQL, w.log.guards[0] as SQL]) {
      const { sql: text, params } = render(predicate);
      expect(text).toContain('"status" = $');
      expect(text).toContain('"paused_until" is not null');
      expect(text).toContain('"paused_until" <= $');
      expect(params).toContain("paused");
    }
    // the guard names the row, so a concurrent operator action or suspension that moved it updates zero rows
    expect(render(w.log.guards[0] as SQL).sql).toContain('"id" = $');
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

  it("leaves a superseded pause alone when the org already has another live subscription (resuming it would break one-live-per-org)", async () => {
    const w = world(lapsedPause(), { otherLive: true });
    const logged: Record<string, unknown>[] = [];
    const { jobs, published } = deps(w.db, { log: (_m, detail) => void logged.push(detail) });

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.state().status).toBe("paused");
    expect(w.log.updates).toEqual([]);
    expect(published).toEqual([]);
    expect(logged).toEqual([{ organizationId: ORG, subscriptionId: SUB }]);
  });

  it("is idempotent: a second run finds nothing to do and publishes nothing more", async () => {
    const w = world(lapsedPause());
    const { jobs, published } = deps(w.db);

    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(1);
    expect(await runPauseResumeForOrg(jobs, ORG)).toBe(0);
    expect(w.log.ledger).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("a failing publish fails the org's whole transaction (the sweep retries; a transition never lacks its event)", async () => {
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
