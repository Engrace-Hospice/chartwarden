/**
 * M23 DDE work queue: LIST SCOPING and the filing-window WATCH'S RESPAWN RULE (ADR-0052 D4/D6), LIVE Postgres as the
 * NOBYPASSRLS `wardenx_app` role through the real routes, resolver and catalog-validating publisher.
 *
 *   - `GET /dde-items` returns only items of provider entities the actor may reach (the rule the detail route's
 *     `provider_entity_billing_scope` applies): an entity-scoped actor sees only its entity, an org-wide role sees both,
 *     an actor with no reach sees nothing, a forged `providerEntityId` filter outside the reach is an empty page, and
 *     pagination across a mixed set stays correct (the filter is in the query, not after the page).
 *   - the watch files a new item for a notice whose latest item was CLOSED while the notice is still unaccepted, at most
 *     once per closure; a cancelled item never respawns; an open item blocks it; an accepted notice never respawns;
 *     two concurrent ticks create one.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m23:dde-queue-scope:live
 */
import { randomUUID } from "node:crypto";
import { withOrgContext } from "@wardenx/tenancy";
import type { FastifyInstance } from "fastify";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type M23WorkerDeps,
  runNoeWindowWatch,
  runNotrWindowWatch,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { buildDdeWatchdog } from "../src/modules/23-billing-medicare/services/dde-watchdog";
import {
  BASE,
  type DdeLiveDb,
  ORG_A,
  ORG_B,
  PE_A,
  PE_B,
  USER_A,
  buildDdeApp,
  connectDdeLiveDb,
  seedNoe,
  seedNotr,
} from "./_dde-live-harness";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const NOW = "2026-05-01T15:00:00Z";

describe.skipIf(!DB_URL)(
  "M23 DDE work queue, list scope and respawn, LIVE Postgres (ADR-0052)",
  () => {
    let live: DdeLiveDb;
    let admin: Client;
    let app: FastifyInstance;
    let counter = 0;
    const hdr = (extra: Record<string, string> = {}) => ({
      "x-test-user": USER_A,
      "idempotency-key": `dde-scope-${++counter}`,
      ...extra,
    });
    const stepUp = { "x-test-step-up": "1" };
    const post = (path: string, headers: Record<string, string>, payload: unknown) =>
      app.inject({ method: "POST", url: `${BASE}${path}`, headers, payload: payload as never });
    const list = async (headers: Record<string, string>, query = "") => {
      const res = await app.inject({
        method: "GET",
        url: `${BASE}${query ? `?${query}` : ""}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      return res.json() as {
        items: { ddeWorkItemId: string; providerEntityId: string }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
    };
    const depsAt = (iso: string): M23WorkerDeps =>
      ({
        connection: {},
        db: live.handle.db as never,
        now: () => new Date(iso),
        outbox: live.bound("m23"),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        noticeWindow: { recordBreach: async () => undefined },
        alerts: { dispatch: async () => undefined },
        ddeWatchdog: buildDdeWatchdog({ outbox: live.bound("m23") }),
      }) as unknown as M23WorkerDeps;
    const itemsFor = async (noe: string) =>
      (
        await admin.query(
          "SELECT id, state, source, respawned_from_id FROM dde_work_item WHERE subject_id=$1 ORDER BY created_at, id",
          [noe],
        )
      ).rows as { id: string; state: string; source: string; respawned_from_id: string | null }[];

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
      await app?.close();
      app = await buildDdeApp(live);
    });

    describe("GET /dde-items is scoped to the actor's provider-entity reach", () => {
      const idsOf = (page: { items: { ddeWorkItemId: string }[] }) =>
        page.items.map((i) => i.ddeWorkItemId);
      const made: { a: string[]; b: string[] } = { a: [], b: [] };

      beforeAll(async () => {
        // interleaved creation order so a post-pagination filter would produce short or empty pages
        app = await buildDdeApp(live);
        for (const pe of [PE_A, PE_B, PE_B, PE_A, PE_B, PE_A, PE_A]) {
          const noe = await seedNoe(admin, { providerEntityId: pe });
          const res = await post("", hdr(), { itemType: "noe", subjectId: noe });
          expect(res.statusCode).toBe(201);
          (pe === PE_A ? made.a : made.b).push(res.json().ddeWorkItemId);
        }
      });

      it("an actor scoped to entity A lists only A's items, and one scoped to B only B's", async () => {
        const a = await list(
          hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_A }),
          "limit=100",
        );
        expect(idsOf(a).sort()).toEqual([...made.a].sort());
        expect(a.items.every((i) => i.providerEntityId === PE_A)).toBe(true);
        const b = await list(
          hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_B }),
          "limit=100",
        );
        expect(idsOf(b).sort()).toEqual([...made.b].sort());
      });

      it("an org-wide billing role lists both", async () => {
        for (const roles of ["org_admin", "compliance_officer"]) {
          const all = await list(hdr({ "x-test-roles": roles }), "limit=100");
          expect(idsOf(all).sort()).toEqual([...made.a, ...made.b].sort());
        }
      });

      it("an actor with no reach lists nothing, never everything", async () => {
        expect(
          (await list(hdr({ "x-test-roles": "billing_manager", "x-test-pe": "" }))).items,
        ).toEqual([]);
        expect((await list(hdr({ "x-test-roles": "billing_manager" }))).items).toEqual([]);
      });

      it("a forged providerEntityId filter outside the reach is an empty page, not an error", async () => {
        const forged = await list(
          hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_A }),
          `providerEntityId=${PE_B}`,
        );
        expect(forged).toMatchObject({ items: [], hasMore: false, nextCursor: null });
        // and inside the reach it filters as usual
        const own = await list(
          hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_A }),
          `providerEntityId=${PE_A}`,
        );
        expect(own.items.length).toBe(made.a.length);
      });

      it("pages through a mixed set correctly: full pages, no foreign rows, no repeats", async () => {
        const headers = hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_A });
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await list(
            headers,
            `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          pages += 1;
          if (page.hasMore) expect(page.items.length).toBe(2);
          seen.push(...idsOf(page));
          cursor = page.nextCursor;
        } while (cursor);
        expect(pages).toBe(Math.ceil(made.a.length / 2));
        expect([...seen].sort()).toEqual([...made.a].sort());
        expect(new Set(seen).size).toBe(seen.length);
      });

      it("the detail route still agrees: an entity-scoped actor cannot open the other entity's item", async () => {
        const own = await app.inject({
          method: "GET",
          url: `${BASE}/${made.a[0]}`,
          headers: hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_A }),
        });
        const foreign = await app.inject({
          method: "GET",
          url: `${BASE}/${made.b[0]}`,
          headers: hdr({ "x-test-roles": "billing_manager", "x-test-pe": PE_A }),
        });
        expect(own.statusCode).toBe(200);
        expect(foreign.statusCode).toBe(404);
      });
    });

    describe("the watch respawns a closed, still-unaccepted item (once per closure)", () => {
      /** Drive an item to `closed` WITHOUT an acceptance: claim, start, key it, return it, close it. */
      async function closeUnaccepted(id: string): Promise<void> {
        let v = 0;
        for (const [path, body, headers] of [
          ["claim", {}, hdr()],
          ["start", {}, hdr()],
          ["record-submission", {}, hdr(stepUp)],
          ["record-outcome", { outcome: "returned", rtpReasonCode: "37001" }, hdr()],
          ["close", {}, hdr()],
        ] as const) {
          const res = await post(`/${id}/${path}`, headers, { expectedVersion: v, ...body });
          expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
          v += 1;
        }
      }
      const tick = (iso = NOW) => runNoeWindowWatch(depsAt(iso));

      it("closed + unaccepted respawns exactly once, linked to the closed item", async () => {
        const noe = await seedNoe(admin, { windowTarget: "2026-05-02" });
        await tick();
        const [first] = await itemsFor(noe);
        expect(first).toMatchObject({ source: "watchdog", respawned_from_id: null });
        await closeUnaccepted((first as { id: string }).id);

        await tick();
        await tick();
        const items = await itemsFor(noe);
        expect(items.length).toBe(2);
        expect(items[1]).toMatchObject({
          state: "queued",
          source: "watchdog",
          respawned_from_id: (first as { id: string }).id,
        });
        // the respawn is visible on the item and in its history
        const view = await app.inject({
          method: "GET",
          url: `${BASE}/${items[1]?.id}`,
          headers: hdr(),
        });
        expect(view.json()).toMatchObject({ respawnedFromId: (first as { id: string }).id });
        expect(JSON.stringify(view.json().events)).toContain((first as { id: string }).id);
      });

      it("a second closure is followed by one more respawn, and no more", async () => {
        const noe = await seedNoe(admin, { windowTarget: "2026-05-02" });
        await tick();
        await closeUnaccepted((await itemsFor(noe))[0]?.id as string);
        await tick();
        await closeUnaccepted((await itemsFor(noe))[1]?.id as string);
        await tick();
        await tick();
        const items = await itemsFor(noe);
        expect(items.length).toBe(3);
        expect(items[2]?.respawned_from_id).toBe(items[1]?.id);
      });

      it("a cancelled item never respawns", async () => {
        const noe = await seedNoe(admin, { windowTarget: "2026-05-02" });
        await tick();
        const id = (await itemsFor(noe))[0]?.id as string;
        expect((await post(`/${id}/cancel`, hdr(), { expectedVersion: 0 })).statusCode).toBe(200);
        await tick();
        await tick();
        expect((await itemsFor(noe)).length).toBe(1);
      });

      it("an open item blocks a respawn", async () => {
        const noe = await seedNoe(admin, { windowTarget: "2026-05-02" });
        await tick();
        await closeUnaccepted((await itemsFor(noe))[0]?.id as string);
        // someone queues the work by hand before the next tick: it is open, so the watch does nothing
        expect((await post("", hdr(), { itemType: "noe", subjectId: noe })).statusCode).toBe(201);
        await tick();
        const items = await itemsFor(noe);
        expect(items.length).toBe(2);
        expect(items[1]?.source).toBe("manual");
      });

      it("an accepted notice never respawns, even if its closed item is the latest", async () => {
        const noe = await seedNoe(admin, { windowTarget: "2026-05-02" });
        await tick();
        const id = (await itemsFor(noe))[0]?.id as string;
        let v = 0;
        for (const [path, body, headers] of [
          ["claim", {}, hdr()],
          ["start", {}, hdr()],
          ["record-submission", {}, hdr(stepUp)],
          ["record-acceptance", { macAcceptedOn: "2026-04-30" }, hdr(stepUp)],
          ["close", {}, hdr()],
        ] as const) {
          const res = await post(`/${id}/${path}`, headers, { expectedVersion: v, ...body });
          expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
          v += 1;
        }
        await tick();
        expect((await itemsFor(noe)).length).toBe(1);
        // belt and braces: were the notice somehow unaccepted again, a closure that FOLLOWED an acceptance still is not
        // respawned (the candidate query and the rule agree)
        await admin.query("UPDATE noe_record SET state='READY' WHERE id=$1", [noe]);
        await tick();
        expect((await itemsFor(noe)).length).toBe(1);
      });

      it("the NOTR path respawns a closed unaccepted item once, and never a cancelled one", async () => {
        const notr = await seedNotr(admin, { windowTarget: "2026-05-02" });
        const tickNotr = () => runNotrWindowWatch(depsAt(NOW));
        await tickNotr();
        const [first] = await itemsFor(notr);
        expect(first).toMatchObject({ source: "watchdog", respawned_from_id: null });
        await closeUnaccepted((first as { id: string }).id);
        await tickNotr();
        await tickNotr();
        const items = await itemsFor(notr);
        expect(items.length).toBe(2);
        expect(items[1]?.respawned_from_id).toBe((first as { id: string }).id);

        const cancelled = await seedNotr(admin, { windowTarget: "2026-05-02" });
        await tickNotr();
        const id = (await itemsFor(cancelled))[0]?.id as string;
        expect((await post(`/${id}/cancel`, hdr(), { expectedVersion: 0 })).statusCode).toBe(200);
        await tickNotr();
        expect((await itemsFor(cancelled)).length).toBe(1);
      });

      it("two concurrent ticks create one respawn", async () => {
        const noe = await seedNoe(admin, { windowTarget: "2026-05-02" });
        await tick();
        const closedId = (await itemsFor(noe))[0]?.id as string;
        await closeUnaccepted(closedId);
        const watchdog = buildDdeWatchdog({ outbox: live.bound("m23") });
        const notice = {
          organizationId: ORG_A,
          itemType: "noe" as const,
          noticeId: noe,
          providerEntityId: PE_A,
          patientId: "00000000-0000-4000-8000-000000000001",
          deadlineAt: "2026-05-02",
        };
        const results = await Promise.all(
          [0, 1].map(() =>
            withOrgContext(live.handle.db as never, { organizationId: ORG_A, userId: "" }, (tx) =>
              // no catch: an unrelated rejection must FAIL the test, not count as "did not create"
              watchdog
                .ensureNoticeItem(tx as never, notice)
                .then((r) => r.created),
            ),
          ),
        );
        expect(results.filter(Boolean).length).toBe(1);
        expect((await itemsFor(noe)).length).toBe(2);
      });
    });

    describe("schema guards on dde_work_item", () => {
      const insert = (over: Record<string, unknown>) => {
        const row = {
          organization_id: ORG_A,
          provider_entity_id: PE_A,
          patient_id: randomUUID(),
          item_type: "noe",
          subject_kind: "noe_record",
          subject_id: randomUUID(),
          state: "queued",
          source: "watchdog",
          respawned_from_id: null,
          ...over,
        };
        const cols = Object.keys(row);
        return admin.query(
          `INSERT INTO dde_work_item (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
          Object.values(row),
        );
      };

      it("pins the unique indexes, so the target-less ON CONFLICT DO NOTHING in insertIfNoOpen covers exactly these", async () => {
        const { rows } = await admin.query(
          `SELECT i.relname FROM pg_index x
             JOIN pg_class i ON i.oid = x.indexrelid
             JOIN pg_class t ON t.oid = x.indrelid
            WHERE t.relname = 'dde_work_item' AND x.indisunique ORDER BY i.relname`,
        );
        expect(rows.map((r) => r.relname)).toEqual([
          "dde_work_item_open_subject_uq",
          "dde_work_item_pkey",
          "dde_work_item_respawn_once_uq",
        ]);
      });

      it("refuses a respawn link across organizations, subjects or types, or to a parent that is not closed", async () => {
        const subject = randomUUID();
        const parent = (await insert({ subject_id: subject, state: "closed", source: "manual" }))
          .rows[0].id;
        const open = (await insert({ subject_id: randomUUID(), state: "queued", source: "manual" }))
          .rows[0].id;
        // sanity: a proper follow-up of the closed parent is accepted
        await expect(
          insert({ subject_id: subject, respawned_from_id: parent }),
        ).resolves.toBeTruthy();
        const guard = /respawn must follow a closed item/;
        // cross-organization (org B points at org A's closed item)
        await expect(
          insert({ organization_id: ORG_B, subject_id: subject, respawned_from_id: parent }),
        ).rejects.toThrow(guard);
        // cross-subject
        await expect(
          insert({ subject_id: randomUUID(), respawned_from_id: parent }),
        ).rejects.toThrow(guard);
        // cross-type
        await expect(
          insert({
            item_type: "notr",
            subject_kind: "notr_record",
            subject_id: subject,
            respawned_from_id: parent,
          }),
        ).rejects.toThrow(guard);
        // parent still open
        await expect(insert({ subject_id: randomUUID(), respawned_from_id: open })).rejects.toThrow(
          guard,
        );
      });

      it("lets each closed item be respawned once (respawn_once_uq on its own, with no open item involved)", async () => {
        const subject = randomUUID();
        const parent = (await insert({ subject_id: subject, state: "closed", source: "manual" }))
          .rows[0].id;
        const first = (await insert({ subject_id: subject, respawned_from_id: parent })).rows[0].id;
        // the first respawn is no longer open, so only the once-per-closure index can object to a second one
        await admin.query("UPDATE dde_work_item SET state='cancelled' WHERE id=$1", [first]);
        await expect(insert({ subject_id: subject, respawned_from_id: parent })).rejects.toThrow(
          /dde_work_item_respawn_once_uq/,
        );
      });
    });

    describe("list inputs that must not become a 500", () => {
      it("answers a forged but well-formed cursor with a 400", async () => {
        const forge = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
        for (const cursor of [
          forge({ createdAt: "not-a-date", id: randomUUID() }),
          forge({ createdAt: "2026-05-01T00:00:00.000Z", id: "not-a-uuid" }),
          forge({ createdAt: "2026-13-99T00:00:00.000Z", id: randomUUID() }),
        ]) {
          const res = await app.inject({
            method: "GET",
            url: `${BASE}?cursor=${cursor}`,
            headers: hdr(),
          });
          expect(res.statusCode, cursor).toBe(400);
        }
      });

      it("treats a malformed provider-entity id in the actor's reach as no reach, not an error", async () => {
        const res = await app.inject({
          method: "GET",
          url: BASE,
          headers: hdr({ "x-test-roles": "billing_manager", "x-test-pe": "not-a-uuid,'; --" }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().items).toEqual([]);
      });
    });
  },
);
