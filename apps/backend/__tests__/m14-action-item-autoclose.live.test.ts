/**
 * F-104 — M14's §4.5 D8 action-item auto-close, END TO END over real Postgres.
 *
 * D8: an action item linked to a downstream artifact closes itself when that artifact reaches its
 * absorbing state. §4.5's table spells the effect out — "action item flips to `auto_closed`;
 * `linked_artifact_id` confirmed; `closed_at = now()`".
 *
 * Everything for it shipped except what makes it run. `transitionActionItem(_, {type:'autoClose'})` is
 * complete and unit-tested, `idg_action_item_status` carries `auto_closed`, `close_reason` exists,
 * `m14.action_item.auto_closed` is catalogued, and `planActionItemAutoClose` maps each source event to its
 * linked kind. There was no binding; three of the six source events did not declare m14, so half of it
 * could not have been bound anyway; and — underneath both — `idg_action_item.linked_artifact_id`, the
 * column the whole engine matches on, was WRITTEN BY NOTHING. The create route took the kind and not the
 * id, the INSERT wrote the kind and not the id, the view returned the kind and not the id.
 *
 * So an action item saying "sign this care plan" stayed open after the plan was signed, in every
 * deployment, and carried forward into the next meeting as an overdue commitment nobody had failed.
 *
 * Nothing is stubbed: the REAL M14 write service creates the item as the NOBYPASSRLS `wardenx_app` role,
 * a REAL upstream event is published through the REAL catalog-validating publisher, the REAL dispatcher
 * delivers it, and M14's real consumer matches and closes under RLS.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m14:autoclose:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import {
  type IdgWriteOutboxPort,
  createDbIdgBackend,
} from "../src/modules/14-idg/idg-route-service-db";
import {
  M14_OUTBOX_EVENTS,
  buildM14ActionItemAutoCloseConsumer,
} from "../src/modules/14-idg/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "33333333-3333-3333-3333-33333333aaaa"; // idg tables carry no membership FK
const OTHER_MEMBER = "33333333-3333-3333-3333-33333333bbbb";
const PATIENT = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("F-104 — M14 D8 action-item auto-close, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbIdgBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let publish: (org: string, event: string, aggId: string, payload: object) => Promise<void>;
  const locationOf: Record<string, string> = {};
  const peOf: Record<string, string> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function seedMeeting(org: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
           coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2, now(), now() + interval '2 hours', 'live', $3, '{}'::jsonb) RETURNING id`,
        [org, locationOf[org], MEMBER],
      )
    ).rows[0].id as string;
  }
  async function itemRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, close_reason, closed_at, linked_artifact_id, version FROM idg_action_item WHERE id=$1",
      [id],
    );
    return rows[0];
  }
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }
  /** Create a linked action item through the REAL write service. */
  async function linkedItem(
    org: string,
    meetingId: string,
    kind: "care_plan_version" | "order" | "medication_order" | "encounter",
    artifactId: string,
    assignee = MEMBER,
  ): Promise<string> {
    const res = await svc.createActionItem(org, USER, meetingId, {
      patientId: PATIENT,
      assignedToMembershipId: assignee,
      dueDate: new Date(Date.now() + 86_400_000).toISOString(),
      linkedArtifactKind: kind,
      linkedArtifactId: artifactId,
    });
    return res.id;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f104@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      peOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `PE ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [peOf[org]],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The four upstream catalogs plus M14's own. Each upstream event now declares m14 (three of them did
    // not until F-104), and the dispatcher refuses to construct on an event its catalog does not carry.
    const catalog = buildBootOutboxCatalog([
      M7_OUTBOX_EVENTS,
      M8_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
    ]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m14Outbox: IdgWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m14" }),
    };
    svc = createDbIdgBackend(handle.db, m14Outbox);

    // Publish an upstream event the way its owning module would: through the SAME catalog-validating
    // publisher, so a payload this suite invents but the catalog rejects fails here rather than
    // silently exercising a shape production cannot produce.
    publish = async (org, eventName, aggregateId, payload) => {
      const callerModule = eventName.slice(0, eventName.indexOf("."));
      await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
        publisher.publish(
          tx as never,
          {
            eventName,
            payload: payload as Record<string, unknown>,
            organizationId: org,
            aggregateKind: "test",
            aggregateId,
            callerModule,
          } as never,
        ),
      );
    };

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [buildM14ActionItemAutoCloseConsumer({ db: handle.db, outbox: m14Outbox })],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("writes linked_artifact_id at all — the column the engine matches on, previously always NULL", async () => {
    const meeting = await seedMeeting(ORG_A);
    const versionId = randomUUID();
    const item = await linkedItem(ORG_A, meeting, "care_plan_version", versionId);
    expect((await itemRow(item)).linked_artifact_id).toBe(versionId);
  });

  it("m7.care_plan.version_signed auto-closes the item linked to that version", async () => {
    const meeting = await seedMeeting(ORG_A);
    const versionId = randomUUID();
    const item = await linkedItem(ORG_A, meeting, "care_plan_version", versionId);

    await publish(ORG_A, "m7.care_plan.version_signed", versionId, {
      planId: randomUUID(),
      versionId,
      patientId: PATIENT,
      admissionId: randomUUID(),
      kind: "interim_revision",
      snapshotRef: "s1",
    });
    // Nothing until the relay runs: the event is a real `pending` row, which is where every one of these
    // has sat for the life of the deployment.
    expect((await itemRow(item)).status).toBe("open");

    await dispatcher.tick();

    const row = await itemRow(item);
    expect(row.status).toBe("auto_closed");
    expect(row.close_reason).toBe("auto_close_downstream");
    expect(row.closed_at).not.toBeNull();
    expect(await eventsFor(item)).toContain("m14.action_item.auto_closed");
  });

  it("leaves an item linked to a DIFFERENT artifact of the same kind open", async () => {
    const meeting = await seedMeeting(ORG_A);
    const signed = randomUUID();
    const other = randomUUID();
    const closes = await linkedItem(ORG_A, meeting, "care_plan_version", signed);
    const stays = await linkedItem(ORG_A, meeting, "care_plan_version", other);

    await publish(ORG_A, "m7.care_plan.version_signed", signed, {
      planId: randomUUID(),
      versionId: signed,
      patientId: PATIENT,
      admissionId: randomUUID(),
      kind: "interim_revision",
      snapshotRef: "s1",
    });
    await dispatcher.tick();

    expect((await itemRow(closes)).status).toBe("auto_closed");
    expect((await itemRow(stays)).status).toBe("open");
  });

  it("m11.order.signed and .completed both close an order-linked item", async () => {
    const meeting = await seedMeeting(ORG_A);
    for (const [eventName, payloadFor] of [
      [
        "m11.order.signed",
        (orderId: string) => ({
          orderId,
          kind: "dme",
          signatureId: randomUUID(),
          signerMembershipId: MEMBER,
          signedAt: new Date().toISOString(),
          viaVerbal: false,
        }),
      ],
      [
        "m11.order.completed",
        (orderId: string) => ({
          orderId,
          completedAt: new Date().toISOString(),
          kindAutoOrManual: "manual",
        }),
      ],
    ] as const) {
      const orderId = randomUUID();
      const item = await linkedItem(ORG_A, meeting, "order", orderId);
      await publish(ORG_A, eventName, orderId, payloadFor(orderId));
      await dispatcher.tick();
      expect((await itemRow(item)).status).toBe("auto_closed");
    }
  });

  it("m12.medication_order.signed closes a medication-order-linked item", async () => {
    const meeting = await seedMeeting(ORG_A);
    const orderId = randomUUID();
    const item = await linkedItem(ORG_A, meeting, "medication_order", orderId);

    await publish(ORG_A, "m12.medication_order.signed", orderId, {
      orderId,
      signerMembershipId: MEMBER,
      signedAt: new Date().toISOString(),
      viaVerbal: false,
      viaEpcs: false,
    });
    await dispatcher.tick();

    expect((await itemRow(item)).status).toBe("auto_closed");
  });

  it("m8.encounter.signed matches the ASSIGNEE, not the artifact — and only that assignee", async () => {
    // §2 / §4.5: "an `encounter_id`-linked item auto-closes when M8 emits `m8.encounter.signed` matching
    // the assignee". The encounter did not exist when the item was written, so the item's own link is a
    // different id; keyed on the artifact this item could never close.
    const meeting = await seedMeeting(ORG_A);
    const encounterId = randomUUID();
    const mine = await linkedItem(ORG_A, meeting, "encounter", randomUUID(), MEMBER);
    const theirs = await linkedItem(ORG_A, meeting, "encounter", randomUUID(), OTHER_MEMBER);

    await publish(ORG_A, "m8.encounter.signed", encounterId, {
      encounterId,
      patientId: PATIENT,
      admissionId: randomUUID(),
      encounterType: "routine_visit",
      discipline: "rn",
      signedByMembershipId: MEMBER,
      signedAt: new Date().toISOString(),
      lateEntryTier: "normal",
      layer2Involved: false,
      evvBracketState: "evv_present",
      requiresCosign: false,
      careplanLinks: [],
      documentRenderPayload: { final: "narrative", addenda: [] },
    });
    await dispatcher.tick();

    const closed = await itemRow(mine);
    expect(closed.status).toBe("auto_closed");
    // The D8 `confirm_linked_artifact` effect: the row's link is REWRITTEN to the encounter that closed
    // it, which for the assignee-matched case is the whole point — otherwise the item records a link to
    // an encounter that never happened.
    expect(closed.linked_artifact_id).toBe(encounterId);
    expect((await itemRow(theirs)).status).toBe("open");
  });

  it("is idempotent — a redelivery closes nothing twice and emits nothing twice", async () => {
    const meeting = await seedMeeting(ORG_A);
    const versionId = randomUUID();
    const item = await linkedItem(ORG_A, meeting, "care_plan_version", versionId);
    await publish(ORG_A, "m7.care_plan.version_signed", versionId, {
      planId: randomUUID(),
      versionId,
      patientId: PATIENT,
      admissionId: randomUUID(),
      kind: "interim_revision",
      snapshotRef: "s1",
    });
    await dispatcher.tick();
    // Assert the close HAPPENED before asserting it does not happen twice: without this the case passes
    // vacuously when nothing closed at all, which is exactly the pre-fix state it is meant to exclude.
    expect((await itemRow(item)).status).toBe("auto_closed");
    const after = (await eventsFor(item)).length;
    const version = (await itemRow(item)).version;

    await dispatcher.tick();
    await dispatcher.tick();

    expect((await eventsFor(item)).length).toBe(after);
    expect((await itemRow(item)).version).toBe(version);
  });

  it("does not reach across tenants — org B's item on the same artifact id stays open", async () => {
    const versionId = randomUUID();
    const a = await linkedItem(ORG_A, await seedMeeting(ORG_A), "care_plan_version", versionId);
    const b = await linkedItem(ORG_B, await seedMeeting(ORG_B), "care_plan_version", versionId);

    await publish(ORG_A, "m7.care_plan.version_signed", versionId, {
      planId: randomUUID(),
      versionId,
      patientId: PATIENT,
      admissionId: randomUUID(),
      kind: "interim_revision",
      snapshotRef: "s1",
    });
    await dispatcher.tick();

    expect((await itemRow(a)).status).toBe("auto_closed");
    expect((await itemRow(b)).status).toBe("open");
  });
});
