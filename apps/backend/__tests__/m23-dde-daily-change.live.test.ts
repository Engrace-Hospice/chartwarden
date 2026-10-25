/**
 * M23 DDE daily change report ingest (#793, ADR-0103), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role: the real
 * Drizzle cursor/exception store, the real DDE queue service (system actor) and the real catalog-validating outbox, in
 * front of the in-memory DdeAccessProvider.
 *
 *   - accepted/returned outcomes apply with source `dde_provider`, as a `system` history actor, and emit
 *     `m23.dde_item.state_changed`; the cursor persists per operator and a replay changes nothing;
 *   - a finalised item is never moved backwards; an unknown reference is ignored with one deduped trace;
 *   - a poison event is refused, then quarantined after the cap, and the event behind it still applies;
 *   - another tenant's rows are invisible and unreachable (RLS), and the app role cannot delete cursor/exception rows;
 *   - the MBI reaches the provider call in memory only: it is in no row, event, audit entry or log line.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:dde-daily-change:live
 */
import { randomUUID } from "node:crypto";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import type { DdeAccessProvider, DdeContext, DdeOperation } from "@chartwarden/x12-837-client";
import { InMemoryDdeProvider } from "@chartwarden/x12-837-client/testing";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleDdeChangeStore } from "../src/modules/23-billing-medicare/dde-change-store";
import {
  type DdeChangeStore,
  MAX_REFUSALS_PER_CHANGE,
  ingestDdeChanges,
} from "../src/modules/23-billing-medicare/jobs/dde-daily-change";
import {
  DDE_BENEFICIARY_NOT_ON_FILE,
  type DdeBeneficiaryPort,
} from "../src/modules/23-billing-medicare/services/dde-beneficiary";
import { buildDdeQueueService } from "../src/modules/23-billing-medicare/services/dde-queue-service";
import {
  BASE,
  type DdeLiveDb,
  MEMBERSHIP_A,
  ORG_A,
  ORG_B,
  USER_A,
  USER_B,
  buildDdeApp,
  connectDdeLiveDb,
  seedNoe,
} from "./_dde-live-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MBI = "1EG4TE5MK73";
const MAC_DAY = new Date("2026-01-17T15:00:00Z");

class SpyProvider implements DdeAccessProvider {
  readonly vendor = "in_memory" as const;
  readonly seenMbis: (string | undefined)[] = [];
  constructor(readonly inner: InMemoryDdeProvider) {}
  submitOperation(ctx: DdeContext, op: DdeOperation) {
    this.seenMbis.push(op.beneficiary?.mbi);
    return this.inner.submitOperation(ctx, op);
  }
  fetchOutcomes(ctx: DdeContext, cursor: string | null) {
    return this.inner.fetchOutcomes(ctx, cursor);
  }
  fetchOperationStatus(ctx: DdeContext, ref: string) {
    return this.inner.fetchOperationStatus(ctx, ref);
  }
}

describe.skipIf(!DB_URL)("M23 DDE daily change ingest, LIVE Postgres (#793)", () => {
  let live: DdeLiveDb;
  let admin: Client;
  let app: FastifyInstance;
  let counter = 0;
  const spy = new SpyProvider(new InMemoryDdeProvider({ now: () => MAC_DAY }));
  let beneficiary: DdeBeneficiaryPort = {
    unlock: async () => ({
      mbi: MBI,
      lastName: "Doe",
      firstName: "Jane",
      dateOfBirth: "1950-01-01",
    }),
  };
  const logs: string[] = [];
  const logger = {
    warn: (o: Record<string, unknown>, m: string) => void logs.push(JSON.stringify({ o, m })),
  };
  const realStore = () => createDrizzleDdeChangeStore(live.handle.db);
  const service = () =>
    buildDdeQueueService(live.handle.db as never, {
      outbox: live.bound("m23"),
      now: () => MAC_DAY,
    });

  const asA = (extra: Record<string, string> = {}) => ({
    "x-test-user": USER_A,
    "idempotency-key": `dde-chg-${++counter}`,
    ...extra,
  });
  const post = (path: string, headers: Record<string, string>, payload: unknown = {}) =>
    app.inject({ method: "POST", url: `${BASE}${path}`, headers, payload: payload as never });
  const row = async (id: string) =>
    (await admin.query("SELECT * FROM dde_work_item WHERE id=$1", [id])).rows[0];

  /** An item submitted through the provider on its own provider entity (its own feed partition). */
  async function submitted(
    pe: string,
    tenant: { org: string; user: string } = { org: ORG_A, user: USER_A },
  ) {
    const asUser = (extra: Record<string, string> = {}) => ({
      ...asA(extra),
      "x-test-user": tenant.user,
    });
    const noeId = await seedNoe(admin, {
      orgId: tenant.org,
      providerEntityId: pe,
      windowTarget: "2026-01-20",
      electionDate: "2026-01-15",
    });
    const created = await post("", asUser(), { itemType: "noe", subjectId: noeId });
    const id = created.json().ddeWorkItemId as string;
    await post(`/${id}/claim`, asUser(), { expectedVersion: 0 });
    await post(`/${id}/start`, asUser(), { expectedVersion: 1 });
    const sent = await post(`/${id}/submit-via-provider`, asUser({ "x-test-step-up": "1" }), {
      expectedVersion: 2,
    });
    expect(sent.statusCode).toBe(200);
    return { id, noeId, ref: sent.json().providerReference as string };
  }
  const scopeOf = (pe: string) => ({
    organizationId: ORG_A,
    providerEntityId: pe,
    usage: "production" as const,
  });
  /** The store, reading only this test's provider entity (other tests leave submitted items behind). */
  const storeFor = (pe: string): DdeChangeStore => ({
    ...realStore(),
    awaitingOperators: async (o, l) =>
      (await realStore().awaitingOperators(o, l)).filter((x) => x.providerEntityId === pe),
  });
  const tick = (pe: string, store: DdeChangeStore = storeFor(pe)) =>
    ingestDdeChanges(
      { provider: spy, usage: "production", store, applier: service(), logger },
      ORG_A,
    );
  const controlNumberOf = async (noeId: string) =>
    (await admin.query("SELECT noe_control_number FROM noe_record WHERE id=$1", [noeId])).rows[0]
      .noe_control_number as string;

  beforeAll(async () => {
    live = await connectDdeLiveDb(DB_URL as string);
    admin = live.admin;
    app = await buildDdeApp(live, {
      ddeProvider: spy,
      ddeUsage: "production",
      now: () => MAC_DAY,
      ddeBeneficiary: { unlock: (r) => beneficiary.unlock(r) },
    });
  }, 300_000);
  afterAll(async () => {
    await app?.close();
    await live?.handle.close();
    await admin?.end();
  });

  it("applies an acceptance as the system actor with source dde_provider and persists the operator's cursor", async () => {
    const pe = randomUUID();
    const { id, noeId, ref } = await submitted(pe);
    spy.inner.fissAnswers(scopeOf(pe), ref, "accepted", []);
    const result = await tick(pe);
    expect(result).toMatchObject({ applied: 1, failures: [], quarantined: [] });

    expect(await row(id)).toMatchObject({ state: "accepted", outcome_code: "accepted" });
    const noe = (
      await admin.query("SELECT payer_status_date_source FROM noe_record WHERE id=$1", [noeId])
    ).rows[0];
    expect(noe.payer_status_date_source).toBe("dde_provider");
    const history = await admin.query(
      "SELECT actor_kind, actor_membership_id, detail FROM dde_work_event WHERE work_item_id=$1 AND event='accept'",
      [id],
    );
    expect(history.rows[0]).toMatchObject({ actor_kind: "system", actor_membership_id: null });
    const events = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m23.dde_item.state_changed' AND payload->>'ddeItemId'=$1 AND payload->>'event'='accept'",
      [id],
    );
    expect(events.rowCount).toBe(1);
    const cursor = await admin.query(
      "SELECT operator_membership_id, cursor, version FROM dde_change_cursor WHERE provider_entity_id=$1",
      [pe],
    );
    expect(cursor.rows).toEqual([
      { operator_membership_id: MEMBERSHIP_A, cursor: "1", version: "1" },
    ]);
  });

  it("applies a return through the RTP path", async () => {
    const pe = randomUUID();
    const { id, ref } = await submitted(pe);
    spy.inner.fissAnswers(scopeOf(pe), ref, "returned", ["U5003"]);
    expect(await tick(pe)).toMatchObject({ applied: 1, failures: [] });
    expect(await row(id)).toMatchObject({ state: "returned", rtp_reason_code: "U5003" });
  });

  it("is idempotent: replaying the whole feed from a lost cursor changes nothing", async () => {
    const pe = randomUUID();
    const { id, ref } = await submitted(pe);
    // A second item keeps the operator awaiting, so the replay really reads the feed again.
    await submitted(pe);
    spy.inner.fissAnswers(scopeOf(pe), ref, "accepted", []);
    await tick(pe);
    const count = async () =>
      Number(
        (await admin.query("SELECT count(*) FROM dde_work_event WHERE work_item_id=$1", [id]))
          .rows[0].count,
      );
    const before = await count();
    await admin.query("UPDATE dde_change_cursor SET cursor = NULL WHERE provider_entity_id=$1", [
      pe,
    ]);
    const replay = await tick(pe);
    expect(replay).toMatchObject({ applied: 0, already: 1, failures: [] });
    expect(await count()).toBe(before);
    expect((await row(id)).state).toBe("accepted");
  });

  it("never moves a finalised item backwards when a later contradicting answer arrives", async () => {
    const pe = randomUUID();
    const { id, noeId, ref } = await submitted(pe);
    spy.inner.fissAnswers(scopeOf(pe), ref, "accepted", []);
    spy.inner.injectOutcome(scopeOf(pe), {
      eventId: "evt-contradict",
      providerReference: ref,
      controlNumber: await controlNumberOf(noeId),
      disposition: "returned",
      occurredAt: "2026-01-17",
      reasonCodes: ["U5003"],
    });
    expect(await tick(pe)).toMatchObject({ applied: 1, already: 1, failures: [] });
    expect((await row(id)).state).toBe("accepted");
  });

  it("ignores an unknown reference and another tenant's item, with one deduped trace", async () => {
    const pe = randomUUID();
    const foreign = await submitted(randomUUID(), { org: ORG_B, user: USER_B });
    for (const [eventId, providerReference] of [
      ["evt-unknown", "dde-unknown-9"],
      ["evt-foreign", foreign.ref],
    ] as const) {
      spy.inner.injectOutcome(scopeOf(pe), {
        eventId,
        providerReference,
        controlNumber: "cn-x",
        disposition: "accepted",
        occurredAt: "2026-01-17",
        reasonCodes: [],
      });
    }
    // Something must be awaiting for the operator to be read (and keep awaiting, so the replay reads again).
    const { ref } = await submitted(pe);
    await submitted(pe);
    spy.inner.fissAnswers(scopeOf(pe), ref, "accepted", []);
    const first = await tick(pe);
    // The page with the unknown references is held for one tick (an answer can beat its own submit's commit).
    expect(first).toMatchObject({ unmatched: 2, applied: 0, failures: [] });
    expect(
      (await admin.query("SELECT 1 FROM dde_change_cursor WHERE provider_entity_id=$1", [pe]))
        .rowCount,
    ).toBe(0);
    const traces = await admin.query(
      "SELECT event_id, kind, seen_count FROM dde_change_exception WHERE provider_entity_id=$1 ORDER BY event_id",
      [pe],
    );
    expect(traces.rows).toEqual([
      { event_id: "evt-foreign", kind: "unmatched", seen_count: 1 },
      { event_id: "evt-unknown", kind: "unmatched", seen_count: 1 },
    ]);
    const loggedBefore = logs.filter((l) => l.includes("evt-unknown")).length;
    await admin.query("UPDATE dde_change_cursor SET cursor = NULL WHERE provider_entity_id=$1", [
      pe,
    ]);
    const second = await tick(pe);
    expect(second).toMatchObject({ applied: 1, failures: [] });
    expect(logs.filter((l) => l.includes("evt-unknown")).length).toBe(loggedBefore);
    const again = await admin.query(
      "SELECT seen_count FROM dde_change_exception WHERE provider_entity_id=$1 AND event_id='evt-unknown'",
      [pe],
    );
    expect(again.rows[0].seen_count).toBe(2);
    expect((await row(foreign.id)).state).toBe("submitted");
  });

  it("refuses then quarantines a poison event and the event behind it still applies", async () => {
    const pe = randomUUID();
    const poisoned = await submitted(pe);
    const good = await submitted(pe);
    spy.inner.injectOutcome(scopeOf(pe), {
      eventId: "evt-poison",
      providerReference: poisoned.ref,
      controlNumber: await controlNumberOf(poisoned.noeId),
      disposition: "accepted",
      occurredAt: "2099-01-01",
      reasonCodes: [],
    });
    spy.inner.fissAnswers(scopeOf(pe), good.ref, "accepted", []);
    for (let i = 1; i < MAX_REFUSALS_PER_CHANGE; i++) {
      const r = await tick(pe);
      expect(r.failures).toHaveLength(1);
      expect((await row(good.id)).state).toBe("submitted");
    }
    const last = await tick(pe);
    expect(last.failures).toEqual([]);
    expect(last.quarantined).toHaveLength(1);
    expect(last).toMatchObject({ applied: 1 });
    expect((await row(good.id)).state).toBe("accepted");
    expect((await row(poisoned.id)).state).toBe("submitted");
    const x = await admin.query(
      "SELECT kind, seen_count, quarantined_at IS NOT NULL AS q FROM dde_change_exception WHERE provider_entity_id=$1",
      [pe],
    );
    expect(x.rows).toEqual([{ kind: "refused", seen_count: MAX_REFUSALS_PER_CHANGE, q: true }]);
    // Quarantined: reported on a replay, never retried.
    await admin.query("UPDATE dde_change_cursor SET cursor = NULL WHERE provider_entity_id=$1", [
      pe,
    ]);
    const replay = await tick(pe);
    expect(replay.quarantined).toHaveLength(1);
    expect(replay.failures).toEqual([]);
  });

  it("leaves an item another operator submitted to that operator's own stream", async () => {
    const pe = randomUUID();
    const { id, noeId, ref } = await submitted(pe);
    const outcome = {
      eventId: "evt-other-op",
      providerReference: ref,
      controlNumber: await controlNumberOf(noeId),
      disposition: "accepted" as const,
      occurredAt: "2026-01-17",
      reasonCodes: [],
    };
    const other = await service().applyProviderChange(ORG_A, pe, outcome, randomUUID());
    expect(other).toBe("already");
    expect((await row(id)).state).toBe("submitted");
    expect(await service().applyProviderChange(ORG_A, pe, outcome, MEMBERSHIP_A)).toBe("applied");
  });

  it("two overlapping ticks cannot regress or double-advance the cursor", async () => {
    const pe = randomUUID();
    const { ref } = await submitted(pe);
    spy.inner.fissAnswers(scopeOf(pe), ref, "accepted", []);
    await Promise.all([tick(pe), tick(pe)]);
    const c = await admin.query(
      "SELECT cursor, version FROM dde_change_cursor WHERE provider_entity_id=$1",
      [pe],
    );
    expect(c.rows).toEqual([{ cursor: "1", version: "1" }]);
  });

  it("isolates tenants: the app role sees only its org's rows and cannot delete either table", async () => {
    const pe = randomUUID();
    await admin.query(
      "INSERT INTO dde_change_cursor (organization_id, provider_entity_id, vendor, usage, operator_membership_id, cursor) VALUES ($1,$2,'in_memory','production',$3,'9')",
      [ORG_B, pe, randomUUID()],
    );
    await admin.query(
      "INSERT INTO dde_change_exception (organization_id, provider_entity_id, vendor, usage, event_id, kind, reason_code) VALUES ($1,$2,'in_memory','production','evt-b','unmatched','DDE_ITEM_UNKNOWN')",
      [ORG_B, pe],
    );
    const seenByA = await withOrgContext(live.handle.db, systemOrgContext(ORG_A), async (tx) => ({
      cursors: await tx.select().from(schema.ddeChangeCursor),
      exceptions: await tx.select().from(schema.ddeChangeException),
    }));
    expect(seenByA.cursors.some((c) => c.organizationId === ORG_B)).toBe(false);
    expect(seenByA.exceptions.some((c) => c.organizationId === ORG_B)).toBe(false);
    // The store opens the context of the key it is given: org A's key never reaches org B's position.
    const mine = await realStore().readCursor({
      organizationId: ORG_A,
      providerEntityId: pe,
      vendor: "in_memory",
      usage: "production",
      operatorMembershipId: (
        await admin.query(
          "SELECT operator_membership_id FROM dde_change_cursor WHERE provider_entity_id=$1",
          [pe],
        )
      ).rows[0].operator_membership_id,
    });
    expect(mine).toEqual({ cursor: null, version: 0 });

    const appClient = new Client({ connectionString: live.appUrl });
    await appClient.connect();
    try {
      for (const table of ["dde_change_cursor", "dde_change_exception"]) {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
        await expect(appClient.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
        await appClient.query("ROLLBACK");
      }
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      const cross = await appClient.query(
        "SELECT count(*) FROM dde_change_cursor WHERE organization_id=$1",
        [ORG_B],
      );
      expect(cross.rows[0].count).toBe("0");
      await expect(
        appClient.query("UPDATE dde_change_cursor SET organization_id=$1", [ORG_A]),
      ).rejects.toThrow(/permission denied/);
      await appClient.query("ROLLBACK");
      // No org context at all: the policy cannot evaluate, so the read fails closed instead of returning rows.
      await expect(appClient.query("SELECT count(*) FROM dde_change_cursor")).rejects.toThrow();
    } finally {
      await appClient.end();
    }
  });

  it("audits cursor and exception writes", async () => {
    const audited = await admin.query(
      "SELECT DISTINCT event_type FROM audit_event WHERE event_type IN ('dde_change_cursor.insert','dde_change_cursor.update','dde_change_exception.insert')",
    );
    expect(audited.rows.map((r) => r.event_type).sort()).toEqual([
      "dde_change_cursor.insert",
      "dde_change_cursor.update",
      "dde_change_exception.insert",
    ]);
  });

  it("refuses to send when no beneficiary can be unlocked, before any vendor call", async () => {
    const pe = randomUUID();
    const noeId = await seedNoe(admin, { providerEntityId: pe });
    const created = await post("", asA(), { itemType: "noe", subjectId: noeId });
    const id = created.json().ddeWorkItemId as string;
    await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
    await post(`/${id}/start`, asA(), { expectedVersion: 1 });
    const before = spy.seenMbis.length;
    const original = beneficiary;
    beneficiary = {
      unlock: () =>
        Promise.reject(
          new ChartWardenError(
            DDE_BENEFICIARY_NOT_ON_FILE,
            "no beneficiary identifier is on file",
            422,
          ),
        ),
    };
    try {
      const res = await post(`/${id}/submit-via-provider`, asA({ "x-test-step-up": "1" }), {
        expectedVersion: 2,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe(DDE_BENEFICIARY_NOT_ON_FILE);
      expect((await row(id)).state).toBe("in_progress");
      expect(spy.seenMbis.length).toBe(before);
    } finally {
      beneficiary = original;
    }
  });

  it("hands the MBI to the provider call in memory only: it is in no row, event, audit entry or log", async () => {
    expect(spy.seenMbis.filter((m) => m === MBI).length).toBeGreaterThan(0);
    const needle = `%${MBI}%`;
    const scans: [string, string][] = [
      ["outbox_event", "payload::text"],
      ["dde_work_event", "detail::text"],
      ["dde_work_item", "dde_work_item::text"],
      ["audit_event", "audit_event::text"],
      ["dde_change_cursor", "dde_change_cursor::text"],
      ["dde_change_exception", "dde_change_exception::text"],
    ];
    for (const [table, expr] of scans) {
      const hit = await admin.query(`SELECT count(*) FROM ${table} WHERE ${expr} LIKE $1`, [
        needle,
      ]);
      expect(hit.rows[0].count, table).toBe("0");
    }
    expect(logs.join("\n")).not.toContain(MBI);
  });
});
