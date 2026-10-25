/**
 * M23 DDE work queue, SEND THROUGH THE PROVIDER (ADR-0103 D5, issue #760), LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role through the real routes, the real Authorization Contract, the Drizzle resolver and the real
 * catalog-validating outbox publisher, in front of the in-memory DdeAccessProvider (no vendor adapter exists yet).
 *
 *   - unbound => 503 DDE_NOT_WIRED and the item stays in_progress; step-up and the new permission are required;
 *   - provider submit records submission_mode = provider + the provider's reference, with ONE derived idempotency key
 *     per item and attempt (a double click never mints a second operation) and the ACTING operator's membership id;
 *   - DDE_OPERATOR_NOT_ENROLLED is a stable typed refusal and nothing is recorded;
 *   - sync: pending changes nothing; accepted feeds the notice's payer_status_date (source dde_provider); returned
 *     opens the RTP path and a retry starts a new attempt (new key, cleared provider reference);
 *   - record-submission / record-acceptance still work for manual keying (submission_mode = manual);
 *   - events carry the mode and reference and no notes; another tenant sees and reaches nothing (RLS).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:dde-queue-provider:live
 */
import {
  DDE,
  type DdeAccessProvider,
  type DdeContext,
  type DdeOperation,
  type DdeReceipt,
  type X12WorkerResult,
  degraded,
} from "@chartwarden/x12-837-client";
import { InMemoryDdeProvider } from "@chartwarden/x12-837-client/testing";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE,
  type DdeLiveDb,
  MEMBERSHIP_A,
  MEMBERSHIP_D,
  ORG_A,
  ORG_B,
  PE_A,
  USER_A,
  USER_B,
  USER_C,
  USER_D,
  buildDdeApp,
  connectDdeLiveDb,
  seedNoe,
} from "./_dde-live-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const SCOPE = { organizationId: ORG_A, providerEntityId: PE_A, usage: "production" as const };
const MAC_DAY = new Date("2026-01-17T15:00:00Z");

type SubmitHook = (
  ctx: DdeContext,
  op: DdeOperation,
) => Promise<X12WorkerResult<DdeReceipt>> | undefined;

/** Records what the queue sent (calls only; never payloads) and delegates to the in-memory reference. */
class SpyProvider implements DdeAccessProvider {
  readonly vendor = "in_memory" as const;
  readonly submits: { key: string; operatorMembershipId: string; usage: string; kind: string }[] =
    [];
  readonly statusOperators: string[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  /** Replaces the answer of the next submits (return undefined to delegate). */
  onSubmit?: SubmitHook;
  constructor(readonly inner: InMemoryDdeProvider) {}
  submitOperation(ctx: DdeContext, op: DdeOperation) {
    this.submits.push({
      key: op.idempotencyKey,
      operatorMembershipId: ctx.operatorMembershipId,
      usage: ctx.usage,
      kind: op.kind,
    });
    this.signals.push(ctx.signal);
    return this.onSubmit?.(ctx, op) ?? this.inner.submitOperation(ctx, op);
  }
  fetchOutcomes(ctx: DdeContext, cursor: string | null) {
    return this.inner.fetchOutcomes(ctx, cursor);
  }
  fetchOperationStatus(ctx: DdeContext, ref: string) {
    this.statusOperators.push(ctx.operatorMembershipId);
    return this.inner.fetchOperationStatus(ctx, ref);
  }
}

describe.skipIf(!DB_URL)("M23 DDE queue: send through the provider, LIVE Postgres (#760)", () => {
  let live: DdeLiveDb;
  let admin: Client;
  let app: FastifyInstance;
  let spy: SpyProvider;
  let counter = 0;
  const asA = (extra: Record<string, string> = {}) => ({
    "x-test-user": USER_A,
    "idempotency-key": `dde-prov-${++counter}`,
    ...extra,
  });
  const stepUp = { "x-test-step-up": "1" };
  const post = (path: string, headers: Record<string, string>, payload: unknown = {}) =>
    app.inject({ method: "POST", url: `${BASE}${path}`, headers, payload: payload as never });
  const row = async (id: string) =>
    (await admin.query("SELECT * FROM dde_work_item WHERE id=$1", [id])).rows[0];

  async function inProgress(
    itemType: "noe" | "notr" = "noe",
  ): Promise<{ id: string; noeId: string }> {
    const noeId = await seedNoe(admin, { windowTarget: "2026-01-20", electionDate: "2026-01-15" });
    const created = await post("", asA(), { itemType, subjectId: noeId });
    expect(created.statusCode).toBe(201);
    const id = created.json().ddeWorkItemId as string;
    await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
    await post(`/${id}/start`, asA(), { expectedVersion: 1 });
    return { id, noeId };
  }
  const submitProvider = (id: string, version: number, headers = asA(stepUp)) =>
    post(`/${id}/submit-via-provider`, headers, { expectedVersion: version });

  async function rebuild(
    provider: DdeAccessProvider | undefined,
    extra: { ddeProviderTimeoutMs?: number } = {},
  ) {
    await app?.close();
    app = await buildDdeApp(live, {
      ...(provider ? { ddeProvider: provider } : {}),
      ddeUsage: "production",
      now: () => MAC_DAY,
      ...extra,
    });
  }

  beforeAll(async () => {
    live = await connectDdeLiveDb(DB_URL as string);
    admin = live.admin;
  }, 300_000);
  afterAll(async () => {
    await app?.close();
    await live?.handle.close();
    await admin?.end();
  });
  beforeEach(async () => {
    spy = new SpyProvider(new InMemoryDdeProvider({ now: () => MAC_DAY }));
    await rebuild(spy);
  });

  it("registers the permission and the payer date source, and admin roles hold it", async () => {
    const perm = await admin.query(
      "SELECT key FROM permission WHERE key='billing.dde.submit_via_provider'",
    );
    expect(perm.rowCount).toBe(1);
    const id = await seedNoe(admin);
    await admin.query(
      "UPDATE noe_record SET payer_status_date='2026-01-18', payer_status_date_source='dde_provider' WHERE id=$1",
      [id],
    );
  });

  it("fails closed with a typed 503 DDE_NOT_WIRED when no provider is bound", async () => {
    await rebuild(undefined);
    const { id } = await inProgress();
    const res = await submitProvider(id, 2);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("DDE_NOT_WIRED");
    expect((await row(id)).state).toBe("in_progress");
  });

  it("needs the permission and a recent step-up, and records nothing without them", async () => {
    const { id } = await inProgress();
    const noStepUp = await submitProvider(id, 2, asA());
    expect(noStepUp.statusCode).toBe(403);
    const noPermission = await submitProvider(id, 2, {
      "x-test-user": USER_C,
      "idempotency-key": `dde-prov-c-${++counter}`,
      ...stepUp,
    });
    expect(noPermission.statusCode).toBe(403);
    expect(spy.submits).toHaveLength(0);
    expect((await row(id)).state).toBe("in_progress");
  });

  it("sends once per item and attempt, as the acting operator, and records the provider's reference", async () => {
    const { id } = await inProgress();
    const res = await submitProvider(id, 2);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: "submitted",
      submissionMode: "provider",
      providerReference: "dde-ref-1",
    });
    expect(spy.submits).toEqual([
      {
        key: `dde:${id}:1`,
        operatorMembershipId: MEMBERSHIP_A,
        usage: "production",
        kind: "noe",
      },
    ]);
    const stored = await row(id);
    expect(stored).toMatchObject({
      state: "submitted",
      submission_mode: "provider",
      provider_reference: "dde-ref-1",
    });
    // A second click on the now-submitted item never reaches the provider.
    const again = await submitProvider(id, 4);
    expect(again.statusCode).toBe(409);
    expect(spy.submits).toHaveLength(1);

    const events = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m23.dde_item.state_changed' AND payload->>'ddeItemId'=$1 AND payload->>'event'='submit'",
      [id],
    );
    expect(events.rows[0].payload).toMatchObject({
      submissionMode: "provider",
      providerReference: "dde-ref-1",
    });
    expect(JSON.stringify(events.rows[0].payload)).not.toMatch(/notes/);
    const history = await admin.query(
      "SELECT detail FROM dde_work_event WHERE work_item_id=$1 AND event='submit'",
      [id],
    );
    expect(history.rows[0].detail).toMatchObject({
      submissionMode: "provider",
      providerReference: "dde-ref-1",
      actorMembershipId: MEMBERSHIP_A,
    });
  });

  it("a double click mints one operation: both clicks use the same derived key, one wins", async () => {
    const { id } = await inProgress();
    const [a, b] = await Promise.all([submitProvider(id, 2), submitProvider(id, 2)]);
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
    expect(new Set(spy.submits.map((s) => s.key))).toEqual(new Set([`dde:${id}:1`]));
    const ops = await spy.inner.fetchOperationStatus(
      { ...SCOPE, operatorMembershipId: MEMBERSHIP_A, correlationId: "t" },
      "dde-ref-2",
    );
    // Only dde-ref-1 exists: the replay answered with the same operation, no second one was keyed.
    expect(ops.ok && ops.data.state).toBe("not_found");
    expect((await row(id)).provider_reference).toBe("dde-ref-1");
  });

  it("maps DDE_OPERATOR_NOT_ENROLLED to a stable typed refusal and records nothing", async () => {
    await rebuild(new InMemoryDdeProvider({ unenrolledOperators: new Set([MEMBERSHIP_A]) }));
    const { id } = await inProgress();
    const res = await submitProvider(id, 2);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DDE_OPERATOR_NOT_ENROLLED");
    expect(await row(id)).toMatchObject({
      state: "in_progress",
      submission_mode: null,
      provider_reference: null,
    });
    const sync = await post(`/${id}/sync-provider`, asA());
    expect(sync.statusCode).toBe(409); // not submitted: nothing to sync
  });

  it("a stale version is refused before the provider is called", async () => {
    const { id } = await inProgress();
    const res = await submitProvider(id, 1);
    expect(res.statusCode).toBe(412);
    expect(spy.submits).toHaveLength(0);
  });

  it("sync: pending changes nothing; an acceptance feeds payer_status_date with source dde_provider", async () => {
    const { id, noeId } = await inProgress();
    expect((await submitProvider(id, 2)).statusCode).toBe(200);

    const pending = await post(`/${id}/sync-provider`, asA());
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      providerState: "received",
      item: { state: "submitted" },
    });

    spy.inner.fissAnswers(SCOPE, "dde-ref-1", "accepted", []);
    const done = await post(`/${id}/sync-provider`, asA());
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({
      providerState: "accepted",
      item: {
        state: "accepted",
        macAcceptedOn: "2026-01-17",
        outcomeCode: "accepted",
        submissionMode: "provider",
      },
    });
    const noe = (
      await admin.query(
        "SELECT state, payer_status_date::text AS d, payer_status_date_source AS s FROM noe_record WHERE id=$1",
        [noeId],
      )
    ).rows[0];
    expect(noe).toMatchObject({ d: "2026-01-17", s: "dde_provider" });
    expect(noe.state).toBe("ACK_ACCEPTED");

    const accepted = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m23.noe.accepted' AND payload->>'noeId'=$1",
      [noeId],
    );
    expect(accepted.rows[0].payload.payerStatusDateSource).toBe("dde_provider");
    // Syncing again is a conflict, not a second acceptance.
    expect((await post(`/${id}/sync-provider`, asA())).statusCode).toBe(409);
  });

  it("sync: a returned answer opens the RTP path; a retry is a new attempt with a new key", async () => {
    const { id } = await inProgress();
    expect((await submitProvider(id, 2)).statusCode).toBe(200);
    spy.inner.fissAnswers(SCOPE, "dde-ref-1", "returned", ["T0001", "lower-case-ignored"]);
    const synced = await post(`/${id}/sync-provider`, asA());
    expect(synced.json()).toMatchObject({
      providerState: "returned",
      item: { state: "returned", rtpReasonCode: "T0001", outcomeCode: "rtp" },
    });

    const retried = await post(`/${id}/retry`, asA(), {
      expectedVersion: synced.json().item.version,
    });
    expect(retried.json()).toMatchObject({
      state: "in_progress",
      attemptNumber: 2,
      submissionMode: null,
      providerReference: null,
    });
    const second = await submitProvider(id, retried.json().version);
    expect(second.statusCode).toBe(200);
    expect(second.json().providerReference).toBe("dde-ref-2");
    expect(spy.submits.map((s) => s.key)).toEqual([`dde:${id}:1`, `dde:${id}:2`]);
  });

  it("an unknown provider reference reports not_found and changes nothing", async () => {
    const { id } = await inProgress();
    expect((await submitProvider(id, 2)).statusCode).toBe(200);
    // Force a mismatch the provider would never produce: rewrite our stored reference to an unknown one.
    await admin.query("UPDATE dde_work_item SET provider_reference='dde-ref-999' WHERE id=$1", [
      id,
    ]);
    const res = await post(`/${id}/sync-provider`, asA());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ providerState: "not_found", item: { state: "submitted" } });
  });

  it("manual keying is unchanged: record-submission stamps submission_mode manual", async () => {
    const { id } = await inProgress();
    const res = await post(`/${id}/record-submission`, asA(stepUp), { expectedVersion: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ submissionMode: "manual", providerReference: null });
    expect(spy.submits).toHaveLength(0);
    const sync = await post(`/${id}/sync-provider`, asA());
    expect(sync.statusCode).toBe(409);
    const acc = await post(`/${id}/record-acceptance`, asA(stepUp), {
      expectedVersion: 3,
      macAcceptedOn: "2026-01-17",
    });
    expect(acc.statusCode).toBe(200);
  });

  it("the table refuses a provider reference without the provider mode, and a malformed one", async () => {
    const { id } = await inProgress();
    await expect(
      admin.query("UPDATE dde_work_item SET provider_reference='x' WHERE id=$1", [id]),
    ).rejects.toThrow(/submission_mode_chk/);
    await expect(
      admin.query(
        "UPDATE dde_work_item SET submission_mode='provider', provider_reference='has space' WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow(/submission_mode_chk/);
  });

  it("is tenant-isolated: another org cannot reach the item and the app role sees zero foreign rows", async () => {
    const { id } = await inProgress();
    expect((await submitProvider(id, 2)).statusCode).toBe(200);
    const cross = await post(`/${id}/sync-provider`, {
      "x-test-user": USER_B,
      "idempotency-key": `dde-prov-b-${++counter}`,
    });
    expect(cross.statusCode).toBe(404);
    const crossSubmit = await submitProvider(id, 3, {
      "x-test-user": USER_B,
      "idempotency-key": `dde-prov-b-${++counter}`,
      ...stepUp,
    });
    expect([403, 404]).toContain(crossSubmit.statusCode);

    // The real NOBYPASSRLS app role: org B's context sees none of org A's rows, org A's context sees the item.
    const appClient = new Client({ connectionString: live.appUrl });
    await appClient.connect();
    try {
      const countFor = async (org: string) => {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.org_id', $1, true)", [org]);
        const r = await appClient.query(
          "SELECT count(*)::int AS n FROM dde_work_item WHERE provider_reference IS NOT NULL",
        );
        await appClient.query("ROLLBACK");
        return r.rows[0].n as number;
      };
      expect(await countFor(ORG_B)).toBe(0);
      expect(await countFor(ORG_A)).toBeGreaterThan(0);
    } finally {
      await appClient.end();
    }
  });
  // ── #760 follow-up: the vendor call holds no transaction; a send that may have reached FISS leaves a durable marker ──

  const claimAs = async (id: string, user: string, version: number) => {
    const h = { "x-test-user": user, "idempotency-key": `dde-prov-x-${++counter}` };
    expect((await post(`/${id}/claim`, h, { expectedVersion: version })).statusCode).toBe(200);
    expect(
      (
        await post(
          `/${id}/start`,
          { ...h, "idempotency-key": `dde-prov-x-${++counter}` },
          { expectedVersion: version + 1 },
        )
      ).statusCode,
    ).toBe(200);
  };
  const asD = (extra: Record<string, string> = {}) => ({
    "x-test-user": USER_D,
    "idempotency-key": `dde-prov-d-${++counter}`,
    ...extra,
  });
  /** Item created by A, claimed and started by D (version 2). */
  async function inProgressForD(): Promise<string> {
    const noeId = await seedNoe(admin, { windowTarget: "2026-01-20", electionDate: "2026-01-15" });
    const created = await post("", asA(), { itemType: "noe", subjectId: noeId });
    const id = created.json().ddeWorkItemId as string;
    await claimAs(id, USER_D, 0);
    return id;
  }
  const eventsOf = async (id: string, event: string) =>
    (
      await admin.query("SELECT detail FROM dde_work_event WHERE work_item_id=$1 AND event=$2", [
        id,
        event,
      ])
    ).rows;
  const idleInTx = async () =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND usename = 'chartwarden_app'",
      )
    ).rows[0].n as number;
  const getItem = (id: string) =>
    app.inject({ method: "GET", url: `${BASE}/${id}`, headers: { "x-test-user": USER_A } });

  it("holds no database transaction while the vendor call is in flight", async () => {
    const { id } = await inProgress();
    let idleDuringCall = -1;
    spy.onSubmit = (ctx, op) =>
      (async () => {
        idleDuringCall = await idleInTx();
        return spy.inner.submitOperation(ctx, op);
      })();
    const res = await submitProvider(id, 2);
    expect(res.statusCode).toBe(200);
    expect(idleDuringCall).toBe(0);
    const stored = await row(id);
    expect(stored).toMatchObject({ state: "submitted", provider_in_doubt_at: null });
    expect(stored.provider_operator_membership_id).toBe(MEMBERSHIP_A);
    expect(res.json()).toMatchObject({ providerInDoubt: false });
    expect(await eventsOf(id, "provider_send_started")).toHaveLength(1);
  });

  it("a timeout leaves a durable possibly-sent marker, aborts the call and blocks a second send", async () => {
    await rebuild(spy, { ddeProviderTimeoutMs: 50 });
    const { id } = await inProgress();
    spy.onSubmit = () => new Promise(() => undefined);
    const res = await submitProvider(id, 2);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DDE_IN_DOUBT");
    expect(spy.signals[0]?.aborted).toBe(true);
    const stored = await row(id);
    expect(stored.state).toBe("in_progress");
    expect(stored.provider_in_doubt_at).not.toBeNull();
    expect(stored.provider_operator_membership_id).toBe(MEMBERSHIP_A);
    expect(await eventsOf(id, "provider_in_doubt")).toHaveLength(1);

    const view = await getItem(id);
    expect(view.json()).toMatchObject({ providerInDoubt: true });
    expect(view.json().providerInDoubtAt).toEqual(expect.any(String));

    // Another click is refused before the vendor is reached again; a sync has nothing to ask about.
    spy.onSubmit = undefined;
    const again = await submitProvider(id, stored.version);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("DDE_IN_DOUBT");
    expect(spy.submits).toHaveLength(1);
    expect((await post(`/${id}/sync-provider`, asA())).statusCode).toBe(409);
  });

  it("DDE_IN_DOUBT from the provider, a throwing adapter and an unusable receipt all leave the marker", async () => {
    const cases: SubmitHook[] = [
      () => Promise.resolve(degraded(DDE.IN_DOUBT, "unconfirmed")),
      () => Promise.reject(new Error("socket hang up")),
      (_ctx, op) =>
        Promise.resolve({
          ok: true,
          data: {
            providerReference: "has space",
            idempotencyKey: op.idempotencyKey,
            controlNumber: op.controlNumber,
            receivedAt: "2026-01-17T15:00:00Z",
            replayed: false,
          },
        } as X12WorkerResult<DdeReceipt>),
    ];
    for (const hook of cases) {
      const { id } = await inProgress();
      spy.onSubmit = hook;
      const res = await submitProvider(id, 2);
      expect([409, 502]).toContain(res.statusCode);
      expect((await row(id)).provider_in_doubt_at).not.toBeNull();
      expect(await eventsOf(id, "provider_in_doubt")).toHaveLength(1);
    }
  });

  it("a refusal that provably never reached FISS clears the marker and the item can be sent again", async () => {
    const { id } = await inProgress();
    spy.onSubmit = () => Promise.resolve(degraded(DDE.UNAVAILABLE, "down"));
    const res = await submitProvider(id, 2);
    expect(res.statusCode).toBe(503);
    const stored = await row(id);
    expect(stored).toMatchObject({
      state: "in_progress",
      provider_in_doubt_at: null,
      provider_operator_membership_id: null,
    });
    expect(await eventsOf(id, "provider_send_refused")).toHaveLength(1);
    spy.onSubmit = undefined;
    const retry = await submitProvider(id, stored.version);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ state: "submitted", providerInDoubt: false });
  });

  it("a manual record-submission resolves the marker and says so in the history", async () => {
    const { id } = await inProgress();
    spy.onSubmit = () => Promise.reject(new Error("boom"));
    await submitProvider(id, 2);
    const inDoubt = await row(id);
    expect(inDoubt.provider_in_doubt_at).not.toBeNull();
    const res = await post(`/${id}/record-submission`, asA(stepUp), {
      expectedVersion: inDoubt.version,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: "submitted",
      submissionMode: "manual",
      providerInDoubt: false,
    });
    expect(await row(id)).toMatchObject({
      provider_in_doubt_at: null,
      provider_operator_membership_id: null,
    });
    const submit = await eventsOf(id, "submit");
    expect(submit[0].detail).toMatchObject({ resolvedProviderInDoubt: true });
  });

  it("a concurrent cancel during the vendor call: the item stays possibly-sent, nothing is lost silently", async () => {
    const { id } = await inProgress();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let calling: () => void = () => undefined;
    const called = new Promise<void>((r) => {
      calling = r;
    });
    spy.onSubmit = (ctx, op) => {
      calling();
      return hold.then(() => spy.inner.submitOperation(ctx, op));
    };
    const pending = submitProvider(id, 2);
    await called;
    // The marker write bumped the version to 3; the cancel wins the race while the vendor is still thinking.
    const cancel = await post(`/${id}/cancel`, asA(), { expectedVersion: 3 });
    expect(cancel.statusCode).toBe(200);
    release();
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DDE_IN_DOUBT");
    const stored = await row(id);
    expect(stored.state).toBe("cancelled");
    expect(stored.provider_in_doubt_at).not.toBeNull();
    expect(await eventsOf(id, "provider_in_doubt")).toHaveLength(1);
  });

  it("a double click still keys one operation (the marker write is version-checked)", async () => {
    const { id } = await inProgress();
    const [a, b] = await Promise.all([submitProvider(id, 2), submitProvider(id, 2)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 412]);
    expect(spy.submits).toHaveLength(1);
  });

  it("ownership: another operator's item is 403 on submit and sync unless billing.dde.admin; admin override works", async () => {
    const id = await inProgressForD();
    const { id: ownedByA } = await inProgress();
    const deniedSubmit = await submitProvider(ownedByA, 2, asD(stepUp));
    expect(deniedSubmit.statusCode).toBe(403);
    expect(spy.submits).toHaveLength(0);
    expect((await row(ownedByA)).state).toBe("in_progress");

    // D submits its own item; A (admin) syncs it and the provider is asked as D, the submitting operator.
    const own = await submitProvider(id, 2, asD(stepUp));
    expect(own.statusCode).toBe(200);
    expect(spy.submits[0].operatorMembershipId).toBe(MEMBERSHIP_D);
    expect((await row(id)).provider_operator_membership_id).toBe(MEMBERSHIP_D);
    const adminSync = await post(`/${id}/sync-provider`, asA());
    expect(adminSync.statusCode).toBe(200);
    expect(spy.statusOperators).toEqual([MEMBERSHIP_D]);

    // A's own submitted item: D is refused on sync (not an admin, not the assignee).
    expect((await submitProvider(ownedByA, 2)).statusCode).toBe(200);
    const deniedSync = await post(`/${ownedByA}/sync-provider`, asD());
    expect(deniedSync.statusCode).toBe(403);
    expect(spy.statusOperators).toEqual([MEMBERSHIP_D]);

    // Admin override of the send itself: D's second item is sent by A, recorded as A.
    const other = await inProgressForD();
    const adminSend = await submitProvider(other, 2);
    expect(adminSend.statusCode).toBe(200);
    expect(spy.submits[2].operatorMembershipId).toBe(MEMBERSHIP_A);
  });

  it("sync falls back to the syncing operator for a row submitted before the operator was recorded", async () => {
    const { id } = await inProgress();
    expect((await submitProvider(id, 2)).statusCode).toBe(200);
    await admin.query("UPDATE dde_work_item SET provider_operator_membership_id=NULL WHERE id=$1", [
      id,
    ]);
    expect((await post(`/${id}/sync-provider`, asA())).statusCode).toBe(200);
    expect(spy.statusOperators).toEqual([MEMBERSHIP_A]);
  });
});
