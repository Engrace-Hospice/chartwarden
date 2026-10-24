/**
 * M11's §2.3 D3 / §4.8 `orders.verbal_timer` sweep, end-to-end over real Postgres — proving the full
 * chain this effort's background task set out to build:
 *
 *   1. M12's `recordVerbal` now actually writes M11's polymorphic `verbal_order` row (through the real
 *      published `OrderSignatureProvider.recordVerbalOrder` seam, `target_kind='medication_order'`) —
 *      previously it only flipped `medication_order.status`, so no deadline was ever stored anywhere.
 *   2. M11's `expireOverdueVerbals` (the `orders.verbal_timer` cron's real work, `runVerbalOrderExpiryFanout`
 *      the thin per-org fan-out over it) is the ONE sweep for both an M11 `order_record` verbal AND an M12
 *      `medication_order` verbal recorded through the seam above — M12's own spec's "why M12 has no
 *      parallel timer" design.
 *   3. The catalogued `m11.order.verbal_expired_unsigned` payload now carries `targetKind`, so M12's own
 *      `decideVerbalExpiry` consumer (`buildM12VerbalExpiredConsumer`) can actually discriminate its own
 *      target from M11's — previously undeliverable to a real M12 consumer for want of that one field.
 *
 * Existing non-live coverage of M11's OWN clinical-order expiry math/guards (the pure
 * `planVerbalExpiry`/`transitionOrder` decision) lives in `orders-workflow-acceptance.test.ts`
 * ("W-VO-02 — verbal order expires without signature") and is untouched by this suite — this file proves
 * the real Drizzle write path + the real cross-module M11→M12 handshake neither of those exercises.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:m12:verbal-expiry:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M11_OUTBOX_EVENTS,
  createDbOrderBackend,
  createDrizzleOrderSeamStore,
  registerOrderSeams,
} from "../src/modules/11-orders/index";
import { runVerbalOrderExpiryFanout } from "../src/modules/11-orders/jobs";
import {
  M12_OUTBOX_EVENTS,
  buildM12VerbalExpiredConsumer,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const ATTESTATION =
  "The attending physician verbally ordered this over the phone at the bedside. ".repeat(2);

describe.skipIf(!DB_URL)(
  "M11 §4.8 orders.verbal_timer — M11/M12 verbal-expiry chain, LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    let m11Backend: ReturnType<typeof createDbOrderBackend>;
    let m12Backend: ReturnType<typeof createDbDoseSpotBackend>;
    const providerOf: Record<string, string> = {};
    const locationOf: Record<string, string> = {};
    const memberOf: Record<string, string> = {};

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      // `DROP OWNED BY ... CASCADE` is per-database (safe against a dedicated throwaway database); `DROP
      // ROLE` is CLUSTER-WIDE and fails whenever another database in the same cluster still has objects
      // depending on the role — exactly the case in this shared local cluster, where other concurrent live
      // suites' databases (chartwarden_e2e, chartwarden_recovery_scratch, …) hold thousands of such objects. The
      // roles are idempotently `CREATE ROLE IF NOT EXISTS`-created by migration 0001 regardless, so this
      // suite never needs to drop them — only to disown whatever this OWN database once granted them.
      for (const r of ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; END IF; END $$;`,
        );
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    /** Seed one `medication_order` directly in a given status — mirrors
     *  `m12-reconciliation-discontinue.live.test.ts`'s own `seedMedOrder` helper. */
    async function seedMedOrder(org: string, status: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, med_class, drug_name, strength, dose_form, route, data,
         prescriber_membership_id, prescribing_physician_mdm_id, status)
       VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,$8)
       RETURNING id`,
        [
          org,
          providerOf[org],
          locationOf[org],
          randomUUID(),
          randomUUID(),
          memberOf[org],
          PHYSICIAN_MDM,
          status,
        ],
      );
      return rows[0].id as string;
    }

    /** Seed one M11 `order_record` directly in a given status (reaching one through the real create/sign
     *  route lifecycle is `orders-workflow-acceptance.test.ts`'s subject, not this suite's). */
    async function seedOrderRecord(org: string, status: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO order_record (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, kind, kind_version, data, status, drafter_membership_id, drafter_discipline,
         ordering_physician_mdm_id)
       VALUES ($1,$2,$3,$4,$5,'lab','lab.v1','{}'::jsonb,$6,$7,'rn_case_manager',$8)
       RETURNING id`,
        [
          org,
          providerOf[org],
          locationOf[org],
          randomUUID(),
          randomUUID(),
          status,
          memberOf[org],
          PHYSICIAN_MDM,
        ],
      );
      return rows[0].id as string;
    }

    /** Seed a `verbal_order` row directly targeting an M11 `order_record`, with an explicit (already-past)
     *  deadline — the direct-write counterpart to what `expireOverdueVerbals` itself scans for. Used only for
     *  the M11-own-order side of the chain; the medication-order side is driven through the REAL M12 route
     *  service (`recordVerbal`) per this file's whole point. */
    async function seedClinicalVerbalOrder(
      org: string,
      orderRecordId: string,
      deadlineAt: Date,
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO verbal_order (organization_id, target_kind, target_id, recording_membership_id,
         ordering_physician_mdm_id, verbal_attestation, read_back_verified, effective_at, received_at,
         deadline_at, deadline_policy_version, status)
       VALUES ($1,'order',$2,$3,$4,$5,true,$6,$6,$7,'v1','pending')
       RETURNING id`,
        [org, orderRecordId, memberOf[org], PHYSICIAN_MDM, ATTESTATION, deadlineAt, deadlineAt],
      );
      return rows[0].id as string;
    }

    /** GAP-017 -- age a freshly recorded medication-order verbal to overdue (received 72h ago). */
    async function ageVerbal(medId: string): Promise<void> {
      await admin.query(
        `UPDATE verbal_order SET received_at = now() - interval '72 hours',
           effective_at = now() - interval '72 hours', deadline_at = now() - interval '24 hours'
         WHERE target_kind='medication_order' AND target_id=$1`,
        [medId],
      );
    }

    async function medRow(
      id: string,
    ): Promise<{ status: string; version: number; patientId: string } | undefined> {
      const { rows } = await admin.query(
        'SELECT status, version, patient_id AS "patientId" FROM medication_order WHERE id=$1',
        [id],
      );
      return rows[0] as { status: string; version: number; patientId: string } | undefined;
    }

    async function orderRow(id: string): Promise<{ status: string } | undefined> {
      const { rows } = await admin.query("SELECT status FROM order_record WHERE id=$1", [id]);
      return rows[0] as { status: string } | undefined;
    }

    async function verbalRowByTarget(
      targetKind: string,
      targetId: string,
    ): Promise<{ id: string; status: string; deadlineAt: Date } | undefined> {
      const { rows } = await admin.query(
        'SELECT id, status, deadline_at AS "deadlineAt" FROM verbal_order WHERE target_kind=$1 AND target_id=$2',
        [targetKind, targetId],
      );
      return rows[0] as { id: string; status: string; deadlineAt: Date } | undefined;
    }

    async function eventsFor(
      aggregateId: string,
    ): Promise<Array<{ type: string; payload: unknown }>> {
      const { rows } = await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
        [aggregateId],
      );
      return rows.map((r) => ({ type: r.event_type as string, payload: r.payload }));
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m11m12verbal@x.test')`, [USER]);
      for (const org of [ORG_A, ORG_B]) {
        providerOf[org] = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
            [org, `CCN-${org.slice(0, 4)}`, `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
          )
        ).rows[0].id as string;
        locationOf[org] = (
          await admin.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [providerOf[org]],
          )
        ).rows[0].id as string;
        memberOf[org] = (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [USER, org],
          )
        ).rows[0].id as string;
      }
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      // The real M11 OrderSignatureProvider seam, over the real Drizzle store — this is what makes M12's
      // `recordVerbal` write a real `verbal_order` row rather than throwing "seam requested before
      // registration". Registered once for the whole file (a plain module-scope Map; this process runs one
      // test file).
      registerOrderSeams({ store: createDrizzleOrderSeamStore(handle.db) });

      const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M12_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      const bindM11 = {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m11" } as never),
      };
      const bindM12 = {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m12" } as never),
      };

      m11Backend = createDbOrderBackend(handle.db, bindM11 as never);
      m12Backend = createDbDoseSpotBackend(handle.db, bindM12 as never, PASSING_M12_SAFETY_GATES);
      // GAP-035 follow-up — recordVerbal refuses a named prescriber with no active roster row
      // (NAMED_PRESCRIBER_NOT_ENROLLED), so each org enrolls one prescriber for PHYSICIAN_MDM.
      for (const org of [ORG_A, ORG_B])
        await m12Backend.enrollPrescriber(org, memberOf[org] as string, [], PHYSICIAN_MDM);

      const orgs: ActiveOrgEnumerator = {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      };
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers: [buildM12VerbalExpiredConsumer({ db: handle.db, outbox: bindM12 as never })],
        eventCatalog: catalog,
        options: { log: () => {} },
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("records a medication-order verbal through the real M12 route service, writing a real polymorphic verbal_order row", async () => {
      const medId = await seedMedOrder(ORG_A, "pending_signature");
      // GAP-017 -- the clock start is bounded by server time (<= 24h look-back), so the row is recorded with
      // an in-bounds receivedAt; the "already overdue" fixtures below backdate it by SQL, as a real
      // 48h-later sweep would find it.
      const receivedAt = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(); // 20h ago

      await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        m12Backend.recordVerbal(ORG_A, memberOf[ORG_A], medId, {
          recorderDiscipline: "rn_case_manager",
          recorderDisciplines: ["rn_case_manager"],
          namedPrescriberMdmId: PHYSICIAN_MDM,
          verbalAttestation: ATTESTATION,
          receivedAt,
        }),
      );

      expect((await medRow(medId))?.status).toBe("verbal_pending");

      const v = await verbalRowByTarget("medication_order", medId);
      expect(v).toBeDefined();
      expect(v?.status).toBe("pending");
      // receivedAt (20h ago) + the 48h platform-floor default = 28h from now.
      const expectedDeadlineMs = Date.parse(receivedAt) + 48 * 60 * 60 * 1000;
      expect(Math.abs((v?.deadlineAt.getTime() ?? 0) - expectedDeadlineMs)).toBeLessThan(2000);
      expect((v?.deadlineAt.getTime() ?? Number.NEGATIVE_INFINITY) > Date.now()).toBe(true);
    });

    it("GAP-017: a receivedAt in the future, or older than the look-back, is refused before any row is written", async () => {
      const medId = await seedMedOrder(ORG_A, "pending_signature");
      for (const receivedAt of [
        new Date(Date.now() + 47 * 60 * 60 * 1000).toISOString(), // would postpone the deadline ~2 days
        new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(), // would manufacture an instant expiry
      ]) {
        await expect(
          runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
            m12Backend.recordVerbal(ORG_A, memberOf[ORG_A], medId, {
              recorderDiscipline: "rn_case_manager",
              recorderDisciplines: ["rn_case_manager"],
              namedPrescriberMdmId: PHYSICIAN_MDM,
              verbalAttestation: ATTESTATION,
              receivedAt,
            }),
          ),
        ).rejects.toMatchObject({ code: "VERBAL_RECEIVED_AT_OUT_OF_RANGE", statusCode: 422 });
      }
      expect(await verbalRowByTarget("medication_order", medId)).toBeUndefined();
      expect((await medRow(medId))?.status).toBe("pending_signature");
      // The schema floor under the services: a raw insert starting the clock in the future is refused too.
      await expect(
        admin.query(
          `INSERT INTO verbal_order (organization_id, target_kind, target_id, recording_membership_id,
             ordering_physician_mdm_id, verbal_attestation, read_back_verified, effective_at, received_at,
             deadline_at, deadline_policy_version, status)
           VALUES ($1,'medication_order',$2,$3,$4,$5,true, now(), now() + interval '2 days',
             now() + interval '4 days','v1','pending')`,
          [ORG_A, medId, memberOf[ORG_A], PHYSICIAN_MDM, ATTESTATION],
        ),
      ).rejects.toThrow(/VERBAL_RECEIVED_AT_IN_FUTURE/);
    });

    it("the worker tick expires both M11's own overdue order and M12's overdue medication order in the same pass, and dispatching flips the medication order + emits list_changed", async () => {
      // The M11 side of the chain — seeded directly (M11's own create/sign lifecycle is a different
      // suite's subject; only the expiry sweep over an already-verbal_pending row is this test's concern).
      // Seeded `pending_signature`, not `verbal_pending` directly: the §3.4 `verbal_order_set_target_pending`
      // trigger REQUIRES that starting state and is what actually flips it to `verbal_pending` on the
      // `verbal_order` insert below — mirroring the real write path rather than faking a state the trigger
      // itself is the only legitimate way to reach.
      const clinicalOrderId = await seedOrderRecord(ORG_A, "pending_signature");
      const pastDeadline = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
      await seedClinicalVerbalOrder(ORG_A, clinicalOrderId, pastDeadline);

      // The M12 side — through the real route service, same as the first test, so both target kinds are
      // genuinely overdue `verbal_order` rows the ONE sweep below must find together.
      const medId = await seedMedOrder(ORG_A, "pending_signature");
      const medReceivedAt = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
      await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        m12Backend.recordVerbal(ORG_A, memberOf[ORG_A], medId, {
          recorderDiscipline: "rn_case_manager",
          recorderDisciplines: ["rn_case_manager"],
          namedPrescriberMdmId: PHYSICIAN_MDM,
          verbalAttestation: ATTESTATION,
          receivedAt: medReceivedAt,
        }),
      );

      // Backdate to an overdue row (received 72h ago -> deadline 1 day ago): the service bounds a NEW
      // order's clock start (GAP-017), so the already-overdue state is reached the way real time reaches it.
      await admin.query(
        `UPDATE verbal_order SET received_at = now() - interval '72 hours',
           effective_at = now() - interval '72 hours', deadline_at = now() - interval '24 hours'
         WHERE target_kind='medication_order' AND target_id=$1`,
        [medId],
      );

      // A NOT-yet-due medication verbal in the same org — the negative control the same tick must leave alone.
      const notDueMedId = await seedMedOrder(ORG_A, "pending_signature");
      await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        m12Backend.recordVerbal(ORG_A, memberOf[ORG_A], notDueMedId, {
          recorderDiscipline: "rn_case_manager",
          recorderDisciplines: ["rn_case_manager"],
          namedPrescriberMdmId: PHYSICIAN_MDM,
          verbalAttestation: ATTESTATION,
          receivedAt: new Date().toISOString(), // received just now — 48h out, not overdue.
        }),
      );

      // The real hourly worker tick — the thin per-org fan-out over `OrderRouteService.expireOverdueVerbals`.
      await runVerbalOrderExpiryFanout({
        connection: {} as never,
        service: m11Backend,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });

      // M11's own order flipped straight away — no consumer hop needed, it's the same module.
      expect((await orderRow(clinicalOrderId))?.status).toBe("expired_unsigned");
      expect((await verbalRowByTarget("order", clinicalOrderId))?.status).toBe("expired_unsigned");

      const clinicalEvents = await eventsFor(clinicalOrderId);
      const clinicalExpired = clinicalEvents.find(
        (e) => e.type === "m11.order.verbal_expired_unsigned",
      );
      expect(clinicalExpired).toBeDefined();
      expect((clinicalExpired?.payload as { targetKind: string }).targetKind).toBe("order");

      // M11 wrote the `m11.order.verbal_expired_unsigned` row for the medication-order target too, but M12's
      // own machine hasn't run yet — that's the dispatcher's job, proving the cross-module handshake is real
      // rather than M11 reaching into M12's table directly.
      expect((await medRow(medId))?.status).toBe("verbal_pending");
      const medEventsBeforeDispatch = await eventsFor(medId);
      const medExpiredEvent = medEventsBeforeDispatch.find(
        (e) => e.type === "m11.order.verbal_expired_unsigned",
      );
      expect(medExpiredEvent).toBeDefined();
      expect((medExpiredEvent?.payload as { targetKind: string }).targetKind).toBe(
        "medication_order",
      );

      // The not-due order is genuinely untouched by the same sweep.
      expect((await medRow(notDueMedId))?.status).toBe("verbal_pending");
      expect((await verbalRowByTarget("medication_order", notDueMedId))?.status).toBe("pending");

      // Deliver the event to M12's real consumer.
      await dispatcher.tick();

      const afterDispatch = await medRow(medId);
      expect(afterDispatch?.status).toBe("expired_unsigned");
      expect((await verbalRowByTarget("medication_order", medId))?.status).toBe("expired_unsigned");

      const medEventsAfterDispatch = await eventsFor(medId);
      const listChanged = medEventsAfterDispatch.find(
        (e) => e.type === "m12.medication_order.list_changed",
      );
      expect(listChanged).toBeDefined();
      const lcPayload = listChanged?.payload as {
        patientId: string;
        addedOrderIds: string[];
        removedOrderIds: string[];
      };
      expect(lcPayload.removedOrderIds).toEqual([medId]);
      expect(lcPayload.addedOrderIds).toEqual([]);
      expect(lcPayload.patientId).toBe(afterDispatch?.patientId);
    });

    it("is idempotent on redelivery — a second tick against an already-expired medication order is a true no-op", async () => {
      const medId = await seedMedOrder(ORG_A, "pending_signature");
      await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        m12Backend.recordVerbal(ORG_A, memberOf[ORG_A], medId, {
          recorderDiscipline: "rn_case_manager",
          recorderDisciplines: ["rn_case_manager"],
          namedPrescriberMdmId: PHYSICIAN_MDM,
          verbalAttestation: ATTESTATION,
          receivedAt: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
        }),
      );
      await ageVerbal(medId);
      await runVerbalOrderExpiryFanout({
        connection: {} as never,
        service: m11Backend,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      await dispatcher.tick();
      const afterFirst = await medRow(medId);
      expect(afterFirst?.status).toBe("expired_unsigned");

      // A second sweep finds nothing `pending` left to expire — `expireOverdueVerbals`'s own SELECT excludes
      // it — so no second `m11.order.verbal_expired_unsigned` for this order, and the version is unchanged.
      await runVerbalOrderExpiryFanout({
        connection: {} as never,
        service: m11Backend,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      await dispatcher.tick();

      const events = await eventsFor(medId);
      const expiredEvents = events.filter((e) => e.type === "m11.order.verbal_expired_unsigned");
      expect(expiredEvents).toHaveLength(1);
      const afterSecond = await medRow(medId);
      expect(afterSecond?.version).toBe(afterFirst?.version);
    });

    it("cross-tenant: fanning out over org A never touches org B's own overdue verbal order", async () => {
      const medIdB = await seedMedOrder(ORG_B, "pending_signature");
      await runWithRequestContext({ organizationId: ORG_B, userId: USER }, () =>
        m12Backend.recordVerbal(ORG_B, memberOf[ORG_B], medIdB, {
          recorderDiscipline: "rn_case_manager",
          recorderDisciplines: ["rn_case_manager"],
          namedPrescriberMdmId: PHYSICIAN_MDM,
          verbalAttestation: ATTESTATION,
          receivedAt: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
        }),
      );
      await ageVerbal(medIdB);

      // Fan-out scoped to org A only.
      await runVerbalOrderExpiryFanout({
        connection: {} as never,
        service: m11Backend,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      await dispatcher.tick();

      expect((await medRow(medIdB))?.status).toBe("verbal_pending");
      expect((await verbalRowByTarget("medication_order", medIdB))?.status).toBe("pending");

      // Now fan out over both orgs — org B's own overdue row expires under its OWN tenant scope.
      await runVerbalOrderExpiryFanout({
        connection: {} as never,
        service: m11Backend,
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
      });
      await dispatcher.tick();

      expect((await medRow(medIdB))?.status).toBe("expired_unsigned");
    });
  },
);
