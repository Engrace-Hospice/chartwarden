/**
 * GAP-037 — the M25 → M23 remittance→claim-status feedback loop, LIVE Postgres.
 *
 * M25 has been merged, boot-bound and unconditionally publishing `m25.remittance.claim_paid` /
 * `_partial_paid` / `_denied` / `_recouped` at 835-posting time, and all four declare `m23` as a
 * consumer. M23 declared them as forward-seam DENY-STUBS whose handler threw for every one, and
 * `registerM23Consumers` skipped them by design — so no binding existed, every posting row sat `pending`
 * forever, and NO claim ever left ACK_ACCEPTED when the MAC paid it.
 *
 * The suite runs the REAL `createOutboxDispatcher` over the REAL catalog-validating publisher and the new
 * M23 consumer, as the NOBYPASSRLS `wardenx_app` role. Nothing between the outbox row and the claim row
 * is stubbed.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:remittance-feedback:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M23_OUTBOX_EVENTS,
  buildM23RemittanceConsumer,
} from "../src/modules/23-billing-medicare/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111137";
const ORG_B = "22222222-2222-2222-2222-222222222237";
const PE = "00000000-0000-0000-0000-0000000000a1";
const ADVICE = "00000000-0000-0000-0000-0000000ad0e1";
const MEMBER = "00000000-0000-0000-0000-0000000ba0cb";

/** Deterministic claim ids per scenario (the DB enum is UPPERCASE; the domain union is lowercase). */
const CLAIM = {
  paid: "00000000-0000-0000-0000-0000000c1a01",
  partial: "00000000-0000-0000-0000-0000000c1a02",
  denied: "00000000-0000-0000-0000-0000000c1a03",
  recouped: "00000000-0000-0000-0000-0000000c1a04",
  redelivered: "00000000-0000-0000-0000-0000000c1a05",
  notLegal: "00000000-0000-0000-0000-0000000c1a06",
  crossTenant: "00000000-0000-0000-0000-0000000c1a07",
} as const;

describe.skipIf(!DB_URL)("GAP-037 M25→M23 remittance feedback — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  const skips: { reason: string; claimId: string }[] = [];

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  let seededMonth = 0;
  /** Each claim gets its OWN service month: the per-leaf `claim_*_active_by_range_uidx` allows at most
   *  one active TOB-81x claim per (PE, patient, from, to), so a shared range collides on the 2nd insert. */
  async function seedClaim(id: string, org: string, state: string, ccn: string) {
    seededMonth += 1;
    const mm = String(seededMonth).padStart(2, "0");
    await admin.query(
      `INSERT INTO claim (
         id, organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id,
         tob, service_from, service_to, claim_control_number,
         mac_jurisdiction, state, total_charge_cents, sequestration_applied_pct,
         sequestration_policy_id, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'811',$12,$13,$8,'ngs_j6',$9,50000,'2.00',$10,$11)`,
      [
        id,
        org,
        PE,
        "00000000-0000-0000-0000-0000000ee001",
        "00000000-0000-0000-0000-0000000ad001",
        "00000000-0000-0000-0000-0000000ec0e1",
        "00000000-0000-0000-0000-0000000ba0e1",
        ccn,
        state,
        "00000000-0000-0000-0000-0000000f0501",
        MEMBER,
        `2026-${mm}-01`,
        `2026-${mm}-28`,
      ],
    );
  }

  /** Publish one M25 posting event through the REAL catalog-validating publisher, then drain. */
  async function postAndDrain(
    organizationId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ) {
    await withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName,
        payload,
        organizationId,
        aggregateKind: "remittance_line",
        aggregateId: "00000000-0000-0000-0000-0000000f11e1",
        callerModule: "m25",
      }),
    );
    await dispatcher.tick();
  }

  const stateOf = async (claimId: string) =>
    (await admin.query("SELECT state FROM claim WHERE id=$1", [claimId])).rows[0]?.state;

  /**
   * Pending rows for ONE event type — NOT `dispatcher.pendingDepth()`, which counts the whole
   * tenant. Two of M23's OWN emissions stay pending here by design: `.denied` declares `["m25"]`
   * (seamConsumers `["m33","m36"]`) and `.adjudicated` declares `["m30"]` (seamConsumers `["m33"]`),
   * and neither declared module binds a consumer anywhere in the codebase — a real, separate finding
   * (the same shape as M36's zero bindings against 270 declaring events). `m23.claim.paid` no longer
   * belongs on this list (F-130/F-131 dropped its only two declared consumers, m27 and m26, as
   * misdeclared — it now declares `[]` with seamConsumers `["m33"]`, so it record-onlys instead of
   * deferring). This suite scopes its drain assertion to the half GAP-037 owns rather than pretending
   * the rest is closed.
   */
  const pendingRows = async (eventType: string) =>
    Number(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND status='pending'",
          [eventType],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    for (const [org, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ]) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    await seedClaim(CLAIM.paid, ORG_A, "ACK_ACCEPTED", "CCN-PAID");
    await seedClaim(CLAIM.partial, ORG_A, "ACK_ACCEPTED", "CCN-PART");
    await seedClaim(CLAIM.denied, ORG_A, "ACK_ACCEPTED", "CCN-DENY");
    await seedClaim(CLAIM.recouped, ORG_A, "PAID", "CCN-RECP");
    await seedClaim(CLAIM.redelivered, ORG_A, "PAID", "CCN-REDL");
    await seedClaim(CLAIM.notLegal, ORG_A, "DRAFT", "CCN-DRFT");
    await seedClaim(CLAIM.crossTenant, ORG_B, "ACK_ACCEPTED", "CCN-XTEN");

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The dispatcher REFUSES to construct when a consumer binds an event the catalog does not know, or
    // when the event's `declaredConsumers` omits the consumer's module — so simply building this proves
    // M23's binding and M25's declaration agree. Before GAP-037 there was no binding to disagree with.
    const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M25_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      eventCatalog: catalog,
      consumers: [
        buildM23RemittanceConsumer({
          db: handle.db,
          outbox: {
            publish: (tx, input) =>
              publisher.publish(tx as never, { ...input, callerModule: "m23" }),
          },
          onSkipped: (info) => skips.push({ reason: info.reason, claimId: info.claimId }),
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a full-payment 835 advances ACK_ACCEPTED → PAID and records the advice on the history row", async () => {
    await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
      claimId: CLAIM.paid,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e1",
      remittanceAdviceId: ADVICE,
      paidAmount: "1234.56",
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.paid)).toBe("PAID");

    const history = await admin.query(
      "SELECT from_state, to_state, actor_kind, actor_membership_id, remittance_advice_id FROM claim_state_history WHERE claim_id=$1",
      [CLAIM.paid],
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({
      from_state: "ACK_ACCEPTED",
      to_state: "PAID",
      actor_kind: "consumer",
      // A machine principal has no acting membership. Before GAP-037 the shared `membershipForKind`
      // returned the actor's membership for `consumer`, so an empty string would have hit a uuid column.
      actor_membership_id: null,
      remittance_advice_id: ADVICE,
    });
  });

  it("emits m23.claim.paid (in CENTS) + m23.claim.adjudicated in the same unit of work", async () => {
    const events = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE event_type LIKE 'm23.%' AND payload->>'claimId'=$1 ORDER BY event_type",
      [CLAIM.paid],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      "m23.claim.adjudicated",
      "m23.claim.paid",
    ]);
    const paid = events.rows.find((r) => r.event_type === "m23.claim.paid")?.payload;
    // "1234.56" dollars → 123456 cents. The §4.10 schema is `cents`; M25's wire amount is a decimal
    // string, and a unit slip between them is a 100× misstatement of what the MAC paid.
    expect(paid.paidAmountCents).toBe(123456);
    expect(paid.paidAt).toBe("2026-03-04T05:06:07.000Z");
    const adjudicated = events.rows.find((r) => r.event_type === "m23.claim.adjudicated")?.payload;
    expect(adjudicated).toMatchObject({ outcome: "paid", remittanceAdviceId: ADVICE });
  });

  it("a partial payment lands in PARTIAL_PAID and announces adjudicated(partial_paid) — never claim.paid", async () => {
    await postAndDrain(ORG_A, "m25.remittance.claim_partial_paid", {
      claimId: CLAIM.partial,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e2",
      remittanceAdviceId: ADVICE,
      paidAmount: "400.00",
      adjustedAmount: "100.00",
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.partial)).toBe("PARTIAL_PAID");
    const events = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE event_type LIKE 'm23.%' AND payload->>'claimId'=$1",
      [CLAIM.partial],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["m23.claim.adjudicated"]);
    expect(events.rows[0].payload.outcome).toBe("partial_paid");
  });

  it("a denial 835 lands in DENIED and carries the CARC codes onto m23.claim.denied", async () => {
    await postAndDrain(ORG_A, "m25.remittance.claim_denied", {
      claimId: CLAIM.denied,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e3",
      remittanceAdviceId: ADVICE,
      carcCodes: ["16", "97"],
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.denied)).toBe("DENIED");
    const denied = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m23.claim.denied' AND payload->>'claimId'=$1",
      [CLAIM.denied],
    );
    expect(denied.rows[0].payload.denialCodes).toEqual(["16", "97"]);
  });

  it("a CLP02=22 reversal takes PAID back to ACK_ACCEPTED and emits nothing from M23", async () => {
    await postAndDrain(ORG_A, "m25.remittance.claim_recouped", {
      claimId: CLAIM.recouped,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e4",
      remittanceAdviceId: ADVICE,
      recoupedAmount: "1234.56",
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.recouped)).toBe("ACK_ACCEPTED");
    // M26 reverses its cap accrual off M25's own event (it declares `["m23","m26"]`), so a relay event
    // from M23 would only add a permanently-pending row.
    const emitted = await admin.query(
      "SELECT 1 FROM outbox_event WHERE event_type LIKE 'm23.%' AND payload->>'claimId'=$1",
      [CLAIM.recouped],
    );
    expect(emitted.rowCount).toBe(0);
    // The reversal IS on the history trail, which is the audit answer to "why is this accepted again".
    const history = await admin.query(
      "SELECT from_state, to_state FROM claim_state_history WHERE claim_id=$1",
      [CLAIM.recouped],
    );
    expect(history.rows[0]).toMatchObject({ from_state: "PAID", to_state: "ACK_ACCEPTED" });
    // …and the row STAYS pending, because `claim_recouped` declares `["m23","m26"]` and M26 binds no
    // consumer anywhere. M23's half is done; the dispatcher holds the row while any declared consumer
    // module is unbound. Asserted rather than ignored so the remaining half is visible, not assumed.
    expect(await pendingRows("m25.remittance.claim_recouped")).toBe(1);
  });

  it("a second 835 line posting the same outcome is a settled skip, not a retry storm", async () => {
    skips.length = 0;
    await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
      claimId: CLAIM.redelivered,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e5",
      remittanceAdviceId: ADVICE,
      paidAmount: "10.00",
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.redelivered)).toBe("PAID");
    expect(skips).toContainEqual({ reason: "already_applied", claimId: CLAIM.redelivered });
    // Completed, not left pending — a permanently-retrying row would degrade the readiness probe's
    // outbox-depth check.
    expect(await pendingRows("m25.remittance.claim_paid")).toBe(0);
    const history = await admin.query("SELECT 1 FROM claim_state_history WHERE claim_id=$1", [
      CLAIM.redelivered,
    ]);
    expect(history.rowCount).toBe(0);
  });

  it("an 835 against a claim the transition is not legal from is skipped with its own reason", async () => {
    skips.length = 0;
    await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
      claimId: CLAIM.notLegal,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e6",
      remittanceAdviceId: ADVICE,
      paidAmount: "10.00",
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.notLegal)).toBe("DRAFT");
    expect(skips).toContainEqual({ reason: "transition_not_legal", claimId: CLAIM.notLegal });
    expect(await pendingRows("m25.remittance.claim_paid")).toBe(0);
  });

  it("cannot pay another tenant's claim — the consumer runs under the EVENT's org (RLS)", async () => {
    skips.length = 0;
    // ORG_A's event naming ORG_B's claim: the consumer's read is org-scoped, so the row is invisible.
    await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
      claimId: CLAIM.crossTenant,
      remittanceLineId: "00000000-0000-0000-0000-0000000f11e7",
      remittanceAdviceId: ADVICE,
      paidAmount: "10.00",
      postedAt: "2026-03-04T05:06:07.000Z",
    });
    expect(await stateOf(CLAIM.crossTenant)).toBe("ACK_ACCEPTED");
    expect(skips).toContainEqual({ reason: "claim_not_found", claimId: CLAIM.crossTenant });
  });
});
