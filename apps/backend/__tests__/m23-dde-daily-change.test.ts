// #793 - the DDE daily change report ingest: cursor advance, cycle detection, poison quarantine that does not stall the
// stream, idempotent replay, operator isolation, and no MBI anywhere in its output. No database: the store is an
// in-memory CAS fake (the real one has a live suite), the applier a recording fake, the provider the in-memory reference.
import { ChartWardenError, ConflictError, NotFoundError } from "@chartwarden/types";
import { DDE, type DdeAccessProvider, type DdeOutcome } from "@chartwarden/x12-837-client";
import { InMemoryDdeProvider } from "@chartwarden/x12-837-client/testing";
import { describe, expect, it } from "vitest";
import {
  ANSWER_INVALID_CODE,
  runDdeDailyChangeCron,
  type DdeChangeApplier,
  type DdeChangeCursorKey,
  type DdeChangeStore,
  MAX_CHANGE_PAGES_PER_TICK,
  MAX_NEW_UNMATCHED_TRACES_PER_TICK,
  MAX_REFUSALS_PER_CHANGE,
  ingestDdeChanges,
} from "../src/modules/23-billing-medicare/jobs/dde-daily-change";
import { ddeProviderAnswerRejected } from "../src/modules/23-billing-medicare/services/dde-provider-ops";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG2 = "22222222-2222-4222-8222-222222222222";
const PE = "33333333-3333-4333-8333-333333333333";
const OP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MBI = "1EG4TE5MK73";
const SCOPE = { organizationId: ORG, providerEntityId: PE, usage: "production" as const };
const keyOf = (k: DdeChangeCursorKey) => Object.values(k).join("|");

function fakeStore(operators: { providerEntityId: string; operatorMembershipId: string }[]) {
  const cursors = new Map<string, { cursor: string | null; version: number }>();
  const exceptions = new Map<string, { kind: string; count: number; quarantined: boolean }>();
  const loseNextAdvance = { value: false };
  const store: DdeChangeStore = {
    readCursor: async (k) => cursors.get(keyOf(k)) ?? { cursor: null, version: 0 },
    advanceCursor: async (k, expected, next) => {
      if (loseNextAdvance.value) {
        loseNextAdvance.value = false;
        return false;
      }
      const cur = cursors.get(keyOf(k)) ?? { cursor: null, version: 0 };
      if (cur.version !== expected) return false;
      cursors.set(keyOf(k), { cursor: next, version: expected + 1 });
      return true;
    },
    isQuarantined: async (k, id) => exceptions.get(`${keyOf(k)}|${id}`)?.quarantined === true,
    recordRefusal: async (k, id, _code, cap) => {
      const key = `${keyOf(k)}|${id}`;
      const prev = exceptions.get(key);
      const count = (prev?.count ?? 0) + 1;
      const next = {
        kind: "refused",
        count,
        quarantined: prev?.quarantined === true || count >= cap,
      };
      exceptions.set(key, next);
      return { count, quarantined: next.quarantined };
    },
    clearRefusals: async (k, id) => {
      const key = `${keyOf(k)}|${id}`;
      const prev = exceptions.get(key);
      if (prev && !prev.quarantined) exceptions.set(key, { ...prev, count: 1 });
    },
    traceUnmatched: async (k, id) => {
      const key = `${keyOf(k)}|${id}`;
      const prev = exceptions.get(key);
      exceptions.set(key, {
        kind: prev?.kind ?? "unmatched",
        count: (prev?.count ?? 0) + 1,
        quarantined: prev?.quarantined === true,
      });
      return { firstSeen: prev === undefined, seenCount: (prev?.count ?? 0) + 1 };
    },
    awaitingOperators: async () => operators,
  };
  return { store, cursors, exceptions, loseNextAdvance };
}

/** Records every call; behaviour per provider reference: unknown / already / poison / transient. */
function fakeApplier(
  behaviour: (o: DdeOutcome) => "applied" | "already" | "unmatched" | "poison" | "transient",
) {
  const calls: DdeOutcome[] = [];
  const applier: DdeChangeApplier = {
    applyProviderChange: async (_org, _pe, o) => {
      calls.push(o);
      const b = behaviour(o);
      if (b === "poison") throw ddeProviderAnswerRejected("unusable");
      if (b === "transient") throw new Error("connection reset");
      return b;
    },
  };
  return { applier, calls };
}

async function seeded(provider: InMemoryDdeProvider, n: number, op = OP_A) {
  for (let i = 1; i <= n; i++) {
    const r = await provider.submitOperation(
      { ...SCOPE, operatorMembershipId: op, correlationId: "c" },
      {
        kind: "noe",
        controlNumber: `cn-${op.slice(0, 2)}-${i}`,
        idempotencyKey: `k-${op}-${i}`,
        payload: { format: "json", document: {} },
      },
    );
    if (!r.ok) throw new Error("seed");
    provider.fissAnswers(SCOPE, r.data.providerReference, "accepted", []);
  }
}

const deps = (
  provider: DdeAccessProvider,
  store: DdeChangeStore,
  applier: DdeChangeApplier,
  logs: unknown[] = [],
) => ({
  provider,
  usage: "production" as const,
  store,
  applier,
  logger: { warn: (o: Record<string, unknown>, m: string) => void logs.push({ o, m }) },
});

describe("DDE daily change ingest", () => {
  it("pins the refusal code to the service's own", () => {
    expect(ddeProviderAnswerRejected("x").code).toBe(ANSWER_INVALID_CODE);
  });

  it("applies every event, persists the cursor per page, and is a no-op on replay", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 5);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const a = fakeApplier(() => "applied");
    const first = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(first).toMatchObject({ applied: 5, failures: [], backlog: [] });
    expect([...s.cursors.values()]).toEqual([{ cursor: "5", version: 3 }]);
    const again = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(again.applied).toBe(0);
    expect(a.calls).toHaveLength(5);
  });

  it("an item already finalised is counted, never reapplied (replay after a cursor loss)", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 3);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const a = fakeApplier(() => "already");
    const r = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(r).toMatchObject({ applied: 0, already: 3, failures: [] });
  });

  it("detects a cursor cycle and leaves the stored position at the last good page", async () => {
    const inner = new InMemoryDdeProvider();
    await seeded(inner, 3);
    const looping: DdeAccessProvider = {
      vendor: "in_memory",
      submitOperation: (c, o) => inner.submitOperation(c, o),
      fetchOperationStatus: (c, r) => inner.fetchOperationStatus(c, r),
      fetchOutcomes: async (c, cursor) => {
        const r = await inner.fetchOutcomes(c, cursor === "A" ? null : cursor);
        return r.ok ? { ok: true, data: { ...r.data, nextCursor: "A", hasMore: true } } : r;
      },
    };
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const r = await ingestDdeChanges(
      deps(looping, s.store, fakeApplier(() => "applied").applier),
      ORG,
    );
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("did not advance");
    expect([...s.cursors.values()]).toEqual([{ cursor: "A", version: 1 }]);
  });

  it("never resets a cursor the provider refuses", async () => {
    const provider = new InMemoryDdeProvider();
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    s.cursors.set(
      keyOf({
        organizationId: ORG,
        providerEntityId: PE,
        vendor: "in_memory",
        usage: "production",
        operatorMembershipId: OP_A,
      }),
      { cursor: "garbage", version: 4 },
    );
    const r = await ingestDdeChanges(
      deps(provider, s.store, fakeApplier(() => "applied").applier),
      ORG,
    );
    expect(r.failures[0]).toContain("cursor not reset");
    expect(r.failures[0]).toContain(DDE.INVALID_REQUEST);
    expect([...s.cursors.values()][0]).toEqual({ cursor: "garbage", version: 4 });
  });

  it("quarantines a poison event after the cap and the stream moves on past it", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 4);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const poison = "dde-evt-2";
    const a = fakeApplier((o) => (o.eventId === poison ? "poison" : "applied"));
    for (let tick = 1; tick < MAX_REFUSALS_PER_CHANGE; tick++) {
      const r = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]).toContain(`${tick}/${MAX_REFUSALS_PER_CHANGE}`);
    }
    // The cursor stood still while the poison event was retried (it is on page 1, events 1-2).
    expect([...s.cursors.values()]).toEqual([]);
    const last = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(last.failures).toEqual([]);
    expect(last.quarantined).toHaveLength(1);
    expect(last.quarantined[0]).toContain(poison);
    expect(last.applied).toBe(3);
    expect([...s.cursors.values()][0]?.cursor).toBe("4");
    // Quarantined: skipped and reported, never offered to the applier again.
    const before = a.calls.length;
    s.cursors.clear();
    const replay = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(replay.quarantined).toHaveLength(1);
    expect(a.calls.slice(before).some((o) => o.eventId === poison)).toBe(false);
  });

  it("a transient failure never counts toward quarantine and never moves the cursor", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 2);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const a = fakeApplier(() => "transient");
    for (let i = 0; i < MAX_REFUSALS_PER_CHANGE + 2; i++) {
      const r = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
      expect(r.failures).toHaveLength(1);
      expect(r.quarantined).toEqual([]);
    }
    expect(s.exceptions.size).toBe(0);
    expect(s.cursors.size).toBe(0);
  });

  it("holds a page with an unknown reference for one tick, then ignores it with one deduped trace", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 3);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const logs: unknown[] = [];
    const a = fakeApplier(() => "unmatched");
    // Tick 1 sees page 1 for the first time: an answer can beat its own submit's commit, so the cursor is held.
    const first = await ingestDdeChanges(deps(provider, s.store, a.applier, logs), ORG);
    expect(first).toMatchObject({ unmatched: 2, failures: [] });
    expect(s.cursors.size).toBe(0);
    // Tick 2: page 1 is a second sighting (ignored, cursor moves), page 2 is new (held). Tick 3 finishes.
    await ingestDdeChanges(deps(provider, s.store, a.applier, logs), ORG);
    expect([...s.cursors.values()][0]?.cursor).toBe("2");
    await ingestDdeChanges(deps(provider, s.store, a.applier, logs), ORG);
    expect([...s.cursors.values()][0]?.cursor).toBe("3");
    expect(logs).toHaveLength(3); // one trace per event, however many ticks saw it
    expect([...s.exceptions.values()].map((e) => e.count).sort()).toEqual([2, 2, 2]);
  });

  it("an answer that beat its own submit's commit is applied on the next tick, not lost", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 1);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    let committed = false;
    const a = fakeApplier(() => (committed ? "applied" : "unmatched"));
    await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(s.cursors.size).toBe(0);
    committed = true;
    const next = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(next.applied).toBe(1);
    expect([...s.cursors.values()][0]?.cursor).toBe("1");
  });

  it("quarantines a deterministic 409 after the cap; the cursor passes it and its neighbours apply", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 4);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const applied: string[] = [];
    const applier: DdeChangeApplier = {
      applyProviderChange: async (_o, _p, outcome) => {
        // `ConflictError` is a 409 with code CONFLICT: an invalid transition recurs on every tick.
        if (outcome.eventId === "dde-evt-2") throw new ConflictError("cannot accept in this state");
        applied.push(outcome.eventId);
        return "applied";
      },
    };
    for (let tick = 1; tick < MAX_REFUSALS_PER_CHANGE; tick++) {
      const r = await ingestDdeChanges(deps(provider, s.store, applier), ORG);
      expect(r.failures).toHaveLength(1);
    }
    expect(s.cursors.size).toBe(0);
    const last = await ingestDdeChanges(deps(provider, s.store, applier), ORG);
    expect(last.failures).toEqual([]);
    expect(last.quarantined).toHaveLength(1);
    expect([...s.exceptions.values()]).toEqual([
      { kind: "refused", count: MAX_REFUSALS_PER_CHANGE, quarantined: true },
    ]);
    expect([...s.cursors.values()][0]?.cursor).toBe("4");
    expect(new Set(applied)).toEqual(new Set(["dde-evt-1", "dde-evt-3", "dde-evt-4"]));
  });

  it("retries a VERSION_CONFLICT forever and never quarantines it (nor a 5xx)", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 1);
    for (const error of [
      new ChartWardenError("VERSION_CONFLICT", "stale", 412),
      new ChartWardenError("DB_DOWN", "x", 503),
    ]) {
      const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
      const applier: DdeChangeApplier = { applyProviderChange: async () => Promise.reject(error) };
      for (let i = 0; i < MAX_REFUSALS_PER_CHANGE + 3; i++) {
        const r = await ingestDdeChanges(deps(provider, s.store, applier), ORG);
        expect(r.failures).toHaveLength(1);
        expect(r.quarantined).toEqual([]);
      }
      expect(s.exceptions.size).toBe(0);
      expect(s.cursors.size).toBe(0);
    }
  });

  it("counts a deterministic 4xx (a missing notice) toward quarantine", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 1);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const applier: DdeChangeApplier = {
      applyProviderChange: async () => Promise.reject(new NotFoundError("notice")),
    };
    for (let i = 0; i < MAX_REFUSALS_PER_CHANGE; i++) {
      await ingestDdeChanges(deps(provider, s.store, applier), ORG);
    }
    expect([...s.exceptions.values()][0]?.quarantined).toBe(true);
    expect([...s.cursors.values()][0]?.cursor).toBe("1");
  });

  it("reduces an unknown error to a fixed code: no message, MBI or claim id reaches the thrown error, logs or rows", async () => {
    const CLAIM = "CLM-987654321";
    const leak = `boom MBI ${MBI} claim ${CLAIM}`;
    const inner = new InMemoryDdeProvider();
    await seeded(inner, 2);
    const throwing: DdeAccessProvider = {
      vendor: "in_memory",
      submitOperation: (c, o) => inner.submitOperation(c, o),
      fetchOperationStatus: (c, r) => inner.fetchOperationStatus(c, r),
      fetchOutcomes: async (c, cursor) =>
        cursor === "2" ? Promise.reject(new Error(leak)) : inner.fetchOutcomes(c, cursor),
    };
    await seeded(inner, 2);
    const logs: unknown[] = [];
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const applierThrows: DdeChangeApplier = {
      applyProviderChange: async () => Promise.reject(new Error(leak)),
    };
    const cron = (provider: DdeAccessProvider, applier: DdeChangeApplier) =>
      runDdeDailyChangeCron({
        ...deps(provider, s.store, applier, logs),
        connection: {},
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      });
    const errors = [
      await cron(throwing, fakeApplier(() => "applied").applier).catch((e: Error) => e),
      await cron(inner, applierThrows).catch((e: Error) => e),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("DDE_INGEST_ERROR");
    }
    const text = JSON.stringify({
      errors: errors.map((e) => (e as Error).message),
      logs,
      exceptions: [...s.exceptions],
      cursors: [...s.cursors],
    });
    expect(text).not.toContain(MBI);
    expect(text).not.toContain(CLAIM);
    expect(text).not.toContain("boom");
  });

  it("bounds the new trace rows per tick", async () => {
    const provider = new InMemoryDdeProvider();
    const total = MAX_NEW_UNMATCHED_TRACES_PER_TICK + 20;
    for (let i = 0; i < total; i++) {
      provider.injectOutcome(SCOPE, {
        eventId: `e-${i}`,
        providerReference: `ref-${i}`,
        controlNumber: "cn",
        disposition: "accepted",
        occurredAt: "2026-01-01",
        reasonCodes: [],
      });
    }
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    // One page holds the whole feed (the in-memory page size is 2, which would hit the page cap first).
    const onePage: DdeAccessProvider = {
      vendor: "in_memory",
      submitOperation: (c, o) => provider.submitOperation(c, o),
      fetchOperationStatus: (c, r) => provider.fetchOperationStatus(c, r),
      fetchOutcomes: async () => ({
        ok: true,
        data: { items: provider.feed(SCOPE), nextCursor: "1", hasMore: false },
      }),
    };
    const r = await ingestDdeChanges(
      deps(onePage, s.store, fakeApplier(() => "unmatched").applier),
      ORG,
    );
    expect(r.unmatched).toBe(total);
    expect(s.exceptions.size).toBe(MAX_NEW_UNMATCHED_TRACES_PER_TICK);
    expect(r.failures).toEqual([]);
  });

  it("skips a malformed event (unusable ids or disposition) without stalling the page", async () => {
    const provider = new InMemoryDdeProvider();
    const base = {
      providerReference: "ref-1",
      controlNumber: "cn",
      occurredAt: "2026-01-01",
      reasonCodes: [],
    };
    provider.injectOutcome(SCOPE, {
      ...base,
      eventId: "bad id with spaces",
      disposition: "accepted",
    });
    provider.injectOutcome(SCOPE, { ...base, eventId: "e-2", disposition: "weird" as never });
    provider.injectOutcome(SCOPE, { ...base, eventId: "e-3", disposition: "accepted" });
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const a = fakeApplier(() => "applied");
    const r = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(r).toMatchObject({ malformed: 2, applied: 1, failures: [] });
    expect(a.calls.map((o) => o.eventId)).toEqual(["e-3"]);
  });

  it("refuses an MBI-shaped event id and a cursor outside the plain token alphabet", async () => {
    const provider = new InMemoryDdeProvider();
    provider.injectOutcome(SCOPE, {
      eventId: MBI,
      providerReference: "ref-1",
      controlNumber: "cn",
      disposition: "accepted",
      occurredAt: "2026-01-01",
      reasonCodes: [],
    });
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const a = fakeApplier(() => "applied");
    const r = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(r.malformed).toBe(1);
    expect(a.calls).toEqual([]);
    const odd: DdeAccessProvider = {
      ...provider,
      vendor: "in_memory",
      submitOperation: (c, o) => provider.submitOperation(c, o),
      fetchOperationStatus: (c, ref) => provider.fetchOperationStatus(c, ref),
      fetchOutcomes: async () => ({
        ok: true,
        data: { items: [], nextCursor: `${MBI} Doe`, hasMore: false },
      }),
    };
    const s2 = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const bad = await ingestDdeChanges(deps(odd, s2.store, a.applier), ORG);
    expect(bad.failures).toHaveLength(1);
    expect(JSON.stringify(bad)).not.toContain(MBI);
    expect(s2.cursors.size).toBe(0);
  });

  it("keeps one cursor per operator (a DDE ID is per person) and one operator's failure does not stop another", async () => {
    const provider = new InMemoryDdeProvider({ unenrolledOperators: new Set([OP_B]) });
    await seeded(provider, 2, OP_A);
    const s = fakeStore([
      { providerEntityId: PE, operatorMembershipId: OP_B },
      { providerEntityId: PE, operatorMembershipId: OP_A },
    ]);
    const r = await ingestDdeChanges(
      deps(provider, s.store, fakeApplier(() => "applied").applier),
      ORG,
    );
    expect(r.applied).toBe(2);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain(DDE.OPERATOR_NOT_ENROLLED);
    expect(r.failures[0]).toContain(OP_B);
    expect([...s.cursors.keys()].every((k) => k.includes(OP_A))).toBe(true);
  });

  it("stops when another tick won the compare-and-set and does not regress its position", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 5);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    s.loseNextAdvance.value = true;
    const r = await ingestDdeChanges(
      deps(provider, s.store, fakeApplier(() => "applied").applier),
      ORG,
    );
    expect(r.failures).toEqual([]);
    expect(s.cursors.size).toBe(0);
  });

  it("reports a backlog at the page cap and resumes next tick", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, (MAX_CHANGE_PAGES_PER_TICK + 3) * 2);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const a = fakeApplier(() => "applied");
    const first = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(first.backlog).toHaveLength(1);
    expect(first.applied).toBe(MAX_CHANGE_PAGES_PER_TICK * 2);
    const second = await ingestDdeChanges(deps(provider, s.store, a.applier), ORG);
    expect(second.backlog).toEqual([]);
    expect(first.applied + second.applied).toBe((MAX_CHANGE_PAGES_PER_TICK + 3) * 2);
  });

  it("makes no vendor call for an org with nothing awaiting, nor with the unbound provider", async () => {
    const calls: string[] = [];
    const spy: DdeAccessProvider = {
      vendor: "in_memory",
      submitOperation: () => Promise.reject(new Error("no")),
      fetchOperationStatus: () => Promise.reject(new Error("no")),
      fetchOutcomes: async () => {
        calls.push("fetch");
        return { ok: false, degraded: { code: DDE.UNAVAILABLE, reason: "x" } };
      },
    };
    const idle = fakeStore([]);
    await ingestDdeChanges(deps(spy, idle.store, fakeApplier(() => "applied").applier), ORG2);
    const unbound = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    await ingestDdeChanges(
      deps({ ...spy, vendor: "not_wired" }, unbound.store, fakeApplier(() => "applied").applier),
      ORG,
    );
    expect(calls).toEqual([]);
  });

  it("carries no MBI in its result, failures or logs, even if the provider echoes one", async () => {
    const inner = new InMemoryDdeProvider();
    await seeded(inner, 4);
    const leaky: DdeAccessProvider = {
      vendor: "in_memory",
      submitOperation: (c, o) => inner.submitOperation(c, o),
      fetchOperationStatus: (c, r) => inner.fetchOperationStatus(c, r),
      fetchOutcomes: async (c, cursor) =>
        cursor === "2"
          ? { ok: false, degraded: { code: DDE.UNAVAILABLE, reason: `MBI ${MBI}` } }
          : inner.fetchOutcomes(c, cursor),
    };
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const logs: unknown[] = [];
    const bad = fakeApplier(() => "unmatched");
    const r = await ingestDdeChanges(deps(leaky, s.store, bad.applier, logs), ORG);
    s.cursors.clear();
    const r2 = await ingestDdeChanges(deps(leaky, s.store, bad.applier, logs), ORG);
    const text = JSON.stringify({ r, r2, logs, exceptions: [...s.exceptions] });
    expect(text).not.toContain(MBI);
    expect(r2.failures.join()).toContain(DDE.UNAVAILABLE);
  });

  it("treats only the answer-invalid code as a refusal", async () => {
    const provider = new InMemoryDdeProvider();
    await seeded(provider, 1);
    const s = fakeStore([{ providerEntityId: PE, operatorMembershipId: OP_A }]);
    const other = new ChartWardenError("VERSION_CONFLICT", "stale", 412);
    const applier: DdeChangeApplier = { applyProviderChange: async () => Promise.reject(other) };
    const r = await ingestDdeChanges(deps(provider, s.store, applier), ORG);
    expect(r.failures).toHaveLength(1);
    expect(s.exceptions.size).toBe(0);
  });
});
