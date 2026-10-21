/**
 * GAP-038 - the inpatient cap's day ledger, end to end, LIVE Postgres.
 *
 * Proves, through the REAL outbox dispatcher over the REAL catalog-validating publisher, as the NOBYPASSRLS
 * `wardenx_app` role, with M23's remittance consumer and M26's upstream consumer both live:
 *   1. an 835 payment moves a claim to PAID, M23 announces its day lines and M26 counts them (numerator AND
 *      denominator);
 *   2. a PAID claim driven to VOIDED through the REAL claim state machine (TOB 818) takes its days back out
 *      (`reversed_at` set, roll-up rebuilt) - the double count a replacement/void would otherwise leave;
 *   3. the platform-ops backfill heals ledger rows written before the fix (claim identity stamped, the roll-up
 *      rebuilt from the ledger), reverses the days of a claim that was paid and later voided, reports a cap year
 *      the tenant never opened instead of dropping it silently, never touches another tenant, and is idempotent.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:gap-038:cap-day-backfill:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capYearForDate, capYearWindow } from "@chartwarden/cap-management";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLineFinalizedBackfill } from "../../../scripts/lib/line-finalized-backfill";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M23_OUTBOX_EVENTS,
  buildClaimStateService,
  buildM23RemittanceConsumer,
} from "../src/modules/23-billing-medicare/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { createCapBackfillPorts } from "../src/modules/26-cap/consumers/backfill-ports";
import { createDrizzleCapConsumerStore } from "../src/modules/26-cap/consumers/drizzle-store";
import { buildM26UpstreamConsumer } from "../src/modules/26-cap/consumers/outbox-binding";
import { M26_OUTBOX_EVENTS } from "../src/modules/26-cap/index";
import { M26_WORKER_SYSTEM_USER_ID } from "../src/modules/26-cap/system-actor";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111138";
const ORG_B = "22222222-2222-2222-2222-222222222238";
const U = "00000000-0000-0000-0000-0000000000a1";
const MEMBER = "00000000-0000-0000-0000-0000000ba0cb";
const ADVICE = "00000000-0000-0000-0000-0000000ad0e1";
const consumerActor = (organizationId: string) => ({
  organizationId,
  userId: "",
  roles: [],
  membershipId: "",
  stepUpRecent: false,
  actorKind: "consumer",
});

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CLAIM = {
  live: id(0x3801),
  healed: id(0x3802),
  voidedLater: id(0x3803),
  unopenedYear: id(0x3804),
  otherTenant: id(0x3805),
} as const;

describe.skipIf(!DB_URL)("GAP-038 cap day ledger - heal, reverse, backfill - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let store: ReturnType<typeof createDrizzleCapConsumerStore>;
  let capYear: string;
  let window: { startsOn: string; endsOn: string };
  let periodId: string;
  let nextMonth = 0;

  const inWindow = (daysAfterStart: number) =>
    new Date(
      Date.parse(`${window.startsOn}T12:00:00Z`) + daysAfterStart * 86_400_000,
    ).toISOString();
  const outsideWindow = () => inWindow(-120); // inside the PREVIOUS cap year

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /** Insert a claim + its lines [revenueCode, levelOfCare, days]. Each claim gets its own service month. */
  async function seedClaim(
    claimId: string,
    org: string,
    state: string,
    lines: ReadonlyArray<[string, string, number]>,
  ): Promise<string[]> {
    nextMonth += 1;
    const mm = String(nextMonth).padStart(2, "0");
    await admin.query(
      `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         claim_control_number, mac_jurisdiction, state, total_charge_cents, sequestration_applied_pct,
         sequestration_policy_id, created_by_membership_id)
       VALUES ($1,$2,$3,$4,$3,$3,$3,$3,'811',$5,$6,$7,'ngs_j6',$8,50000,'2.00',$3,$9)`,
      [
        claimId,
        org,
        U,
        id(0xee000 + nextMonth),
        `2026-${mm}-01`,
        `2026-${mm}-28`,
        `ccn-${claimId}`,
        state,
        MEMBER,
      ],
    );
    const lineIds: string[] = [];
    let n = 0;
    for (const [rev, loc, days] of lines) {
      n += 1;
      const { rows } = await admin.query(
        `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
           service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
         VALUES ($1,$2,$3,$4,'Q5001',$5,$6,$7,$8,20000,$9,$1) RETURNING id`,
        [org, claimId, n, rev, loc, `2026-${mm}-01`, `2026-${mm}-28`, days, days * 20000],
      );
      lineIds.push(rows[0].id as string);
    }
    return lineIds;
  }

  const addHistory = (claimId: string, org: string, from: string | null, to: string, at: string) =>
    admin.query(
      `INSERT INTO claim_state_history (organization_id, claim_id, from_state, to_state, at, actor_kind)
       VALUES ($1,$2,$3,$4,$5,'consumer')`,
      [org, claimId, from, to, at],
    );

  const rollup = async (org = ORG_A) =>
    (
      await admin.query(
        `SELECT gip_days, irc_days, total_patient_days FROM cap_inpatient_accrual
          WHERE organization_id=$1 AND cap_period_id=$2`,
        [org, periodId],
      )
    ).rows[0] ?? null;
  const ledger = async (claimLineId: string) =>
    (
      await admin.query(
        "SELECT claim_id, reversed_at FROM cap_inpatient_day_line WHERE source_id=$1",
        [claimLineId],
      )
    ).rows[0];

  async function drain() {
    // The dispatcher settles a row per tick pass; a few passes drain the chain (claim_paid -> line_finalized).
    for (let i = 0; i < 4; i += 1) await dispatcher.tick();
  }

  async function postPaid(claimId: string, postedAt: string) {
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m25.remittance.claim_paid",
        payload: {
          patientId: null,
          paidAmountCents: 100000,
          serviceFrom: null,
          serviceTo: null,
          claimId,
          remittanceLineId: id(0xf11e1),
          remittanceAdviceId: ADVICE,
          paidAmount: "1000.00",
          postedAt,
        },
        organizationId: ORG_A,
        aggregateKind: "remittance_line",
        aggregateId: id(0xf11e1),
        callerModule: "m25",
      }),
    );
    await drain();
  }

  const backfill = (org: string) =>
    runLineFinalizedBackfill(
      {
        db: handle.db,
        outbox: {
          publish: (tx, event) => publisher.publish(tx as never, { ...event, callerModule: "m23" }),
        },
        store,
        capYears: createCapBackfillPorts(handle.db, M26_WORKER_SYSTEM_USER_ID),
        pageSize: 2, // force the keyset cursor across several pages
      },
      org,
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
    capYear = capYearForDate(new Date().toISOString().slice(0, 10));
    window = capYearWindow(capYear);
    // Org A opened the CURRENT cap year only; org B opened none.
    const { rows } = await admin.query(
      `INSERT INTO cap_period (organization_id, ccn, cap_year, starts_on, ends_on,
         aggregate_cap_amount_cents, inpatient_cap_pct, status, opened_by)
       VALUES ($1,'000000',$2,$3,$4,3446534,0.2000,'open',gen_random_uuid()) RETURNING id`,
      [ORG_A, capYear, window.startsOn, window.endsOn],
    );
    periodId = rows[0].id as string;

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([
      M23_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M26_OUTBOX_EVENTS,
    ]);
    publisher = buildTxOutboxPublisher(catalog);
    const m26Outbox = {
      publish: (tx: unknown, event: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...event, callerModule: "m26" } as never),
    };
    store = createDrizzleCapConsumerStore(handle.db, {
      outbox: m26Outbox as never,
      mbi: { mbiNormalizedForPatient: async () => null },
      firstElection: { firstElectionEffectiveDateInRange: async () => null },
    });
    // Only the claim topics this suite drives (the M26 consumer also binds m5/m6/m36 topics whose catalogs
    // are not loaded here).
    const m26Consumer = buildM26UpstreamConsumer(store);
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
        }),
        {
          ...m26Consumer,
          eventTypes: [
            "m23.claim.line_finalized",
            "m23.claim.replaced",
            "m23.claim.voided",
            "m25.remittance.claim_recouped",
          ],
        } as never,
      ],
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  let liveLines: string[] = [];

  it("an 835 payment makes M26 count the claim's days, numerator and denominator", async () => {
    liveLines = await seedClaim(CLAIM.live, ORG_A, "ACK_ACCEPTED", [
      ["0651", "RHC", 10],
      ["0656", "GIP", 3],
    ]);
    await postPaid(CLAIM.live, inWindow(40));
    expect(
      (await admin.query("SELECT state FROM claim WHERE id=$1", [CLAIM.live])).rows[0].state,
    ).toBe("PAID");
    expect(await rollup()).toEqual({ gip_days: 3, irc_days: 0, total_patient_days: 13 });
    for (const lineId of liveLines) expect((await ledger(lineId)).claim_id).toBe(CLAIM.live);
  });

  it("PAID -> VOIDED through the real claim state machine takes the claim's days back out", async () => {
    const claimState = buildClaimStateService(handle.db, {
      outbox: {
        publish: (tx, input) => publisher.publish(tx as never, { ...input, callerModule: "m23" }),
      },
    });
    const version = Number(
      (await admin.query("SELECT version FROM claim WHERE id=$1", [CLAIM.live])).rows[0].version,
    );
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      claimState.applyInTx(tx as never, consumerActor(ORG_A), {
        claimId: CLAIM.live,
        expectedVersion: version,
        event: "void_accepted",
        extra: { originalClaimId: CLAIM.live, voidClaimId: id(0x3899), reason: "void" },
      }),
    );
    await drain();
    expect(
      (await admin.query("SELECT state FROM claim WHERE id=$1", [CLAIM.live])).rows[0].state,
    ).toBe("VOIDED");
    for (const lineId of liveLines) expect((await ledger(lineId)).reversed_at).not.toBeNull();
    expect(await rollup()).toEqual({ gip_days: 0, irc_days: 0, total_patient_days: 0 });
  });

  describe("platform-ops backfill", () => {
    let healedLines: string[] = [];
    let voidedLines: string[] = [];

    beforeAll(async () => {
      // Claim paid before the fix: ledger rows exist with NO claim identity and the roll-up never got the
      // denominator (gip_days > 0, total_patient_days = 0) - exactly what the old consumer left behind.
      healedLines = await seedClaim(CLAIM.healed, ORG_A, "PAID", [
        ["0651", "RHC", 6],
        ["0656", "GIP", 4],
      ]);
      await addHistory(CLAIM.healed, ORG_A, "ACK_ACCEPTED", "PAID", inWindow(50));
      // A claim paid, then voided, also before the fix: its days are in the ledger and must come out.
      voidedLines = await seedClaim(CLAIM.voidedLater, ORG_A, "VOIDED", [["0656", "GIP", 5]]);
      await addHistory(CLAIM.voidedLater, ORG_A, "ACK_ACCEPTED", "PAID", inWindow(51));
      await addHistory(CLAIM.voidedLater, ORG_A, "PAID", "VOIDED", inWindow(60));
      for (const [lineId, rev, days] of [
        [healedLines[1], "0656", 4],
        [voidedLines[0], "0656", 5],
      ] as const) {
        await admin.query(
          `INSERT INTO cap_inpatient_day_line (organization_id, cap_period_id, patient_id, source_id, rev_code, days,
             service_from, service_to, posted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
          [ORG_A, periodId, id(0xee999), lineId, rev, days, window.startsOn, inWindow(50)],
        );
      }
      await admin.query(
        "UPDATE cap_inpatient_accrual SET gip_days = 9, total_patient_days = 0 WHERE organization_id=$1 AND cap_period_id=$2",
        [ORG_A, periodId],
      );
      // Paid in a cap year org A never opened, and another tenant's paid claim.
      await seedClaim(CLAIM.unopenedYear, ORG_A, "PAID", [["0651", "RHC", 30]]);
      await addHistory(CLAIM.unopenedYear, ORG_A, "ACK_ACCEPTED", "PAID", outsideWindow());
      await seedClaim(CLAIM.otherTenant, ORG_B, "PAID", [["0656", "GIP", 7]]);
      await addHistory(CLAIM.otherTenant, ORG_B, "ACK_ACCEPTED", "PAID", inWindow(52));
    });

    it("heals pre-fix rows, reverses the voided claim, reports the unopened cap year, leaves other tenants alone", async () => {
      const report = await backfill(ORG_A);
      await drain();

      expect(report.claimsReplayed).toBe(1); // only CLAIM.healed is still paid in an opened year
      expect(report.linesEmitted).toBe(2);
      expect(report.claimsReversed).toBe(1); // CLAIM.voidedLater (CLAIM.live was already reversed live)
      expect(report.skippedCapYears).toEqual([
        {
          capYear: capYearForDate(outsideWindow().slice(0, 10)),
          claims: 1,
          reason: "no_cap_period",
        },
      ]);

      // identity stamped on the pre-fix row; the new 0651 day arrived as a fresh line
      expect((await ledger(healedLines[1])).claim_id).toBe(CLAIM.healed);
      expect((await ledger(healedLines[0])).claim_id).toBe(CLAIM.healed);
      // the voided claim's pre-fix line is reversed and carries its identity
      expect((await ledger(voidedLines[0])).reversed_at).not.toBeNull();
      expect((await ledger(voidedLines[0])).claim_id).toBe(CLAIM.voidedLater);
      // roll-up rebuilt from the ledger: CLAIM.healed only (6 RHC + 4 GIP); live + voided claims are out
      expect(await rollup()).toEqual({ gip_days: 4, irc_days: 0, total_patient_days: 10 });
      // the unopened year wrote nothing, and org B (no period) has no roll-up and no ledger
      expect(
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM cap_inpatient_day_line WHERE organization_id=$1",
              [ORG_B],
            )
          ).rows[0].n,
        ),
      ).toBe(0);
      expect(await rollup(ORG_B)).toBeNull();
    });

    it("is idempotent: a second run changes no totals", async () => {
      const before = await rollup();
      const report = await backfill(ORG_A);
      await drain();
      expect(report.claimsReversed).toBe(0);
      expect(await rollup()).toEqual(before);
      expect(
        Number(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM cap_inpatient_day_line WHERE organization_id=$1",
              [ORG_A],
            )
          ).rows[0].n,
        ),
      ).toBe(5); // live (2 lines) + healed (2) + voidedLater (1): a re-run adds no ledger row
    });
  });
});
