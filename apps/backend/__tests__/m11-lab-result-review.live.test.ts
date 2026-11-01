/**
 * #909 -- the clinician REVIEW of a returned lab, on real Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Covers: a review is recorded (membership + discipline + DB-stamped instant) and takes the order out of
 * `resultsPendingReview`; an AMENDED result re-opens it; a double review is idempotent; a non-prescriber is refused;
 * a wrong-tenant caller cannot see or review (RLS); the review table is append-only; and the 24 h sweep alerts once
 * per observation (re-armed by an amendment), never inside the window and never for a reviewed result.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m11:lab-result-review:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzleOrderEraseStore } from "../src/modules/11-orders/erasers/orders-eraser";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { sweepLabResultsUnreviewed } from "../src/modules/11-orders/order-sweeps";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { buildM11LabResultsApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-results-applier";
import type { OrderDetailActor } from "../src/modules/11-orders/routes/service";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_B = "33333333-3333-3333-3333-333333333334";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const HOUR_MS = 3_600_000;
const obs = (n: number): string => `aaaaaaaa-0909-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!DB_URL)("#909 lab result review — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let memberA: string;
  let memberB: string;
  let outbox: OrderWriteOutboxPort;
  let applier: ReturnType<typeof buildM11LabResultsApplierConsumer>;
  let service: ReturnType<typeof createDbOrderBackend>;

  const actor = (
    organizationMembership: string,
    userId: string,
    disciplines: readonly string[],
  ): OrderDetailActor => ({
    membershipId: organizationMembership,
    userId,
    roles: disciplines,
    disciplines,
    permissions: new Set(["orders.complete"]),
    orgWide: true,
  });
  const physician = () => actor(memberA, USER, ["hospice_physician"]);

  async function seedLab(): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id, signed_at, priority)
       VALUES ($1,$2,$3,gen_random_uuid(),'lab','v1','{}'::jsonb,'active',$4,'rn_case_manager',$5,
               now() - interval '2 days', 'routine') RETURNING id`,
      [ORG_A, providerA, PATIENT, memberA, PHYSICIAN_MDM],
    );
    const id = rows[0].id as string;
    await admin.query(
      "UPDATE order_record SET results_status='awaiting_results', transmission_status='transmitted' WHERE id=$1",
      [id],
    );
    return id;
  }
  const attach = (orderId: string, observationId: string) =>
    applier.handle({
      eventType: "m29.lab_observation.attached",
      organizationId: ORG_A,
      payload: {
        observationId,
        organizationId: ORG_A,
        patientId: PATIENT,
        orderRecordId: orderId,
        loincCode: "2345-7",
        abnormalFlag: null,
        observationDatetime: new Date().toISOString(),
      },
    } as never);
  const queueIds = async (): Promise<string[]> =>
    (await service.resultsPendingReview(ORG_A)).orders.map((o) => o.id);
  const reviewCount = async (orderId: string): Promise<number> =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM order_result_review WHERE order_record_id=$1",
        [orderId],
      )
    ).rows[0].n as number;
  const unreviewedAlerts = async (orderId: string) =>
    (
      await admin.query(
        `SELECT payload FROM outbox_event
          WHERE event_type='m11.order.recovery_alert_requested' AND aggregate_id=$1
            AND payload->>'alertType'='m11.order.results_unreviewed' ORDER BY created_at`,
        [orderId],
      )
    ).rows;
  const sweepAt = (offsetMs: number) =>
    sweepLabResultsUnreviewed(
      { db: handle.db, outbox, now: () => new Date(Date.now() + offsetMs) },
      ORG_A,
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [id, slug] of [
      [ORG_A, "r909-a"],
      [ORG_B, "r909-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'R909','R909')",
        [id, slug],
      );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'r909a@x.test'),($2,'r909b@x.test')`,
      [USER, USER_B],
    );
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'R909-A','Provider A','1300000013','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    memberA = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    memberB = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER_B, ORG_B],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    applier = buildM11LabResultsApplierConsumer({ db: handle.db, outbox });
    service = createDbOrderBackend(handle.db, outbox);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("records a review (membership, discipline, DB-stamped instant) and the order leaves the queue", async () => {
    const order = await seedLab();
    await attach(order, obs(1));
    expect(await queueIds()).toContain(order);

    const before = Date.now();
    const review = await service.reviewLabResults(ORG_A, order, obs(1), physician());

    expect(review).toMatchObject({
      orderId: order,
      observationId: obs(1),
      reviewerMembershipId: memberA,
      reviewerDiscipline: "hospice_physician",
      alreadyReviewed: false,
    });
    expect(Math.abs(new Date(review.reviewedAt).getTime() - before)).toBeLessThan(60_000);
    expect(await queueIds()).not.toContain(order);
    const audit = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='order_result_review' AND event_type='order_result_review.insert'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("a double review is an idempotent no-op that returns the original review", async () => {
    const order = await seedLab();
    await attach(order, obs(2));
    const first = await service.reviewLabResults(ORG_A, order, obs(2), physician());
    const second = await service.reviewLabResults(
      ORG_A,
      order,
      obs(2),
      actor(memberA, USER, ["np"]), // a different discipline must not rewrite history
    );
    const racers = await Promise.all(
      [1, 2, 3].map(() => service.reviewLabResults(ORG_A, order, obs(2), physician())),
    );

    expect(second.alreadyReviewed).toBe(true);
    expect(second.reviewedAt).toBe(first.reviewedAt);
    expect(second.reviewerDiscipline).toBe("hospice_physician");
    expect(racers.every((r) => r.alreadyReviewed)).toBe(true);
    expect(await reviewCount(order)).toBe(1);
  });

  it("an AMENDED result re-opens review: the order re-enters the queue and needs a new review", async () => {
    const order = await seedLab();
    await attach(order, obs(3));
    await service.reviewLabResults(ORG_A, order, obs(3), physician());
    expect(await queueIds()).not.toContain(order);

    await attach(order, obs(4)); // the amendment

    expect(await queueIds()).toContain(order);
    const second = await service.reviewLabResults(ORG_A, order, obs(4), physician());
    expect(second.observationId).toBe(obs(4));
    expect(second.alreadyReviewed).toBe(false);
    expect(await reviewCount(order)).toBe(2);
    expect(await queueIds()).not.toContain(order);
  });

  it("refuses a non-prescriber (403) and an order with no returned result (409)", async () => {
    const order = await seedLab();
    await attach(order, obs(5));

    await expect(
      service.reviewLabResults(ORG_A, order, obs(5), actor(memberA, USER, ["rn_case_manager"])),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.reviewLabResults(ORG_A, order, obs(5), actor(memberA, USER, ["social_worker"])),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await reviewCount(order)).toBe(0);

    const awaiting = await seedLab();
    await expect(
      service.reviewLabResults(ORG_A, awaiting, obs(99), physician()),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("wrong tenant: org B cannot review or see org A's order, and cannot write a review row for it", async () => {
    const order = await seedLab();
    await attach(order, obs(6));

    await expect(
      service.reviewLabResults(ORG_B, order, obs(6), actor(memberB, USER_B, ["hospice_physician"])),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.resultsPendingReview(ORG_B)).orders).toEqual([]);
    expect(await reviewCount(order)).toBe(0);

    // Straight SQL as the app role under org B's GUC: the RLS WITH CHECK refuses an org-A row.
    const { withOrgContext } = await import("@chartwarden/tenancy");
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, async (tx) => {
        await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
          (await import("drizzle-orm")).sql`INSERT INTO order_result_review
            (organization_id, order_record_id, observation_id, reviewer_membership_id, reviewer_discipline)
            VALUES (${ORG_A}, ${order}, ${obs(6)}, ${memberB}, 'np')`,
        );
      }),
    ).rejects.toThrow();
    expect(await reviewCount(order)).toBe(0);
  });

  it("the review table is append-only for the app role and for the superuser", async () => {
    const order = await seedLab();
    await attach(order, obs(7));
    await service.reviewLabResults(ORG_A, order, obs(7), physician());

    await expect(
      admin.query(
        "UPDATE order_result_review SET reviewer_discipline='np' WHERE order_record_id=$1",
        [order],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query("DELETE FROM order_result_review WHERE order_record_id=$1", [order]),
    ).rejects.toThrow(/append-only/);
    expect(await reviewCount(order)).toBe(1);
  });

  it("review must name the observation the clinician viewed: view A, amendment B lands, review(A) is 409 and B stays unreviewed", async () => {
    const order = await seedLab();
    await attach(order, obs(20)); // A: what the clinician opened
    await attach(order, obs(21)); // B: the amendment lands before they click

    await expect(
      service.reviewLabResults(ORG_A, order, obs(20), physician()),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await reviewCount(order)).toBe(0);
    expect(await queueIds()).toContain(order);
    const ok = await service.reviewLabResults(ORG_A, order, obs(21), physician());
    expect(ok.observationId).toBe(obs(21));
  });

  it("the sweep skips a discontinued order, and an order whose result predates the review feature (no received stamp)", async () => {
    const cancelled = await seedLab();
    await attach(cancelled, obs(22));
    await admin.query("UPDATE order_record SET status='discontinued' WHERE id=$1", [cancelled]);
    const legacy = await seedLab();
    await attach(legacy, obs(23));
    await admin.query("UPDATE order_record SET results_last_received_at=NULL WHERE id=$1", [
      legacy,
    ]);

    await sweepAt(40 * HOUR_MS);

    expect(await unreviewedAlerts(cancelled)).toHaveLength(0);
    expect(await unreviewedAlerts(legacy)).toHaveLength(0);
  });

  it("DESTRUCTION: a destruction-role erase removes the review rows and critical_lab_result rows it would otherwise be blocked by; the app role and superuser still cannot delete", async () => {
    const order = await seedLab();
    await attach(order, obs(24));
    await service.reviewLabResults(ORG_A, order, obs(24), physician());
    const patient = "44444444-4444-4444-4444-4444444444d1";
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,'r909-d1','Dee','Synthetic','1950-01-01','female','active')`,
      [patient, ORG_A],
    );
    await admin.query(
      `INSERT INTO critical_lab_result (organization_id, patient_id, observation_id, loinc_code, critical_flag, disposition, respond_by)
       VALUES ($1,$2,$3,'2345-7','HH','quarantined_no_order', now())`,
      [ORG_A, patient, obs(25)],
    );
    await expect(admin.query("DELETE FROM patient WHERE id=$1", [patient])).rejects.toThrow();
    const orderPatient = (
      await admin.query("SELECT patient_id FROM order_record WHERE id=$1", [order])
    ).rows[0].patient_id as string;
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='r909_destroyer') THEN
       CREATE ROLE r909_destroyer LOGIN PASSWORD 'r909_destroyer_pw' IN ROLE chartwarden_destruction;
     END IF; END $$;`,
    );
    const url = new URL(DB_URL as string);
    url.username = "r909_destroyer";
    url.password = "r909_destroyer_pw";
    const destroyer = createDbClient({ connectionString: url.toString() });
    const { withOrgContext } = await import("@chartwarden/tenancy");
    const { sql } = await import("drizzle-orm");
    try {
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`DELETE FROM critical_lab_result WHERE patient_id = ${patient}`),
        ),
      ).rejects.toThrow();
      await expect(
        admin.query("DELETE FROM order_result_review WHERE order_record_id=$1", [order]),
      ).rejects.toThrow(/append-only/);
      await expect(
        withOrgContext(destroyer.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(
            sql`UPDATE order_result_review SET reviewer_discipline='np' WHERE order_record_id = ${order}`,
          ),
        ),
      ).rejects.toThrow();

      const store = createDrizzleOrderEraseStore(destroyer.db as never);
      const boundary = new Date(Date.now() + 86_400_000).toISOString();
      const foreign = await store.eraseOrdersSubtree(ORG_B, orderPatient, boundary);
      expect(foreign).toMatchObject({ resultReviews: 0, criticalLabResults: 0, orders: 0 });
      const counts = await store.eraseOrdersSubtree(ORG_A, orderPatient, boundary);
      expect(counts.resultReviews).toBeGreaterThanOrEqual(1);
      const dee = await store.eraseOrdersSubtree(ORG_A, patient, boundary);
      expect(dee.criticalLabResults).toBe(1);
    } finally {
      await destroyer.close();
      await admin.query("DROP OWNED BY r909_destroyer");
      await admin.query("DROP ROLE r909_destroyer");
    }
    expect(await reviewCount(order)).toBe(0);
    // With the ledger rows gone the patient row is deletable (the restrict FK no longer blocks destruction).
    await admin.query("DELETE FROM patient WHERE id=$1", [patient]);
  });

  it("the 24 h sweep alerts once per observation, never early, never for a reviewed result; an amendment re-arms it", async () => {
    const stale = await seedLab();
    await attach(stale, obs(8));
    const reviewed = await seedLab();
    await attach(reviewed, obs(9));
    await service.reviewLabResults(ORG_A, reviewed, obs(9), physician());

    await sweepAt(HOUR_MS); // inside the 24 h window
    expect(await unreviewedAlerts(stale)).toHaveLength(0);

    await sweepAt(25 * HOUR_MS);
    const alerts = await unreviewedAlerts(stale);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload).toMatchObject({
      alertType: "m11.order.results_unreviewed",
      severity: "warn",
      correlationId: `m11.order.results_unreviewed:${stale}:${obs(8)}`,
      alertPayload: { orderId: stale, patientId: PATIENT, observationId: obs(8) },
    });
    expect(alerts[0].payload.alertPayload.hoursUnreviewed).toBeGreaterThanOrEqual(24);
    expect(await unreviewedAlerts(reviewed)).toHaveLength(0);

    await sweepAt(26 * HOUR_MS); // idempotent
    expect(await unreviewedAlerts(stale)).toHaveLength(1);

    await attach(stale, obs(10)); // amended: new observation, new clock, alert re-armed
    await sweepAt(2 * HOUR_MS); // the amendment is 2 h old: inside its own window
    expect(await unreviewedAlerts(stale)).toHaveLength(1);
    await sweepAt(27 * HOUR_MS);
    expect(await unreviewedAlerts(stale)).toHaveLength(2);
  });

  it("the unreviewed-results alert type is a seeded platform alert rule", async () => {
    const { PLATFORM_DEFAULT_ALERT_RULES } = await import("@chartwarden/messaging");
    expect(
      PLATFORM_DEFAULT_ALERT_RULES.some((r) => r.eventType === "m11.order.results_unreviewed"),
    ).toBe(true);
  });
});
