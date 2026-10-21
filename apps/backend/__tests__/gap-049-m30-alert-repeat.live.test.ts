/**
 * GAP-049 - the M30 §4.9 REPEAT cadences against a real database, as the NOBYPASSRLS `chartwarden_app` role, on the real
 * M36 emitter and the real platform-default `alert_rule` seed:
 *
 *   incident_sentinel (4h until triaged) - incident_abuse_allegation (6h until triaged)
 *   outbreak_detected (12h until reviewed) - measure_threshold_breached (7d until a project is chartered)
 *
 * The first page is raised by the REAL `buildM36QualityAlertConsumer` (bucket 0); the sweep (`runAlertRepeatSweeps` over
 * the real SQL scans) raises `:rN` on an injected clock. Also proves the zero-recipient fallback, tenant isolation, and
 * runs the two review-overdue SQL scans (`scanOrgForOverdueMortalityReviews` / `scanOrgForOverdueCopReviews`) that had
 * never been executed against a real database.
 *
 * NOT covered here: the M30 command route and the outbox relay in front of the consumer (the consumer is invoked with the
 * event it would receive). Those are covered by their own suites; this one owns the repeat half.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:gap049:alert-repeat:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite DROPs the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runAlertRepeatSweeps,
  scanOrgForOpenAlertItems,
} from "../src/modules/30-quality/jobs/alert-repeat-sweeps";
import {
  scanOrgForOverdueCopReviews,
  scanOrgForOverdueMortalityReviews,
} from "../src/modules/30-quality/jobs/review-overdue-sweeps";
import { emitWithRecipientFallback } from "../src/modules/36-messaging/alert-recipient-fallback";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { buildM36QualityAlertConsumer } from "../src/modules/36-messaging/outbox-consumers/quality-alerts";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "aaaaaaaa-0049-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0049-4000-8000-00000000000b";
const ORG_C = "cccccccc-0049-4000-8000-00000000000c";
const PE = "dddddddd-0049-4000-8000-0000000000d1";
const MEMBER = "eeeeeeee-0049-4000-8000-0000000000e1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe.skipIf(!DB_URL)("GAP-049 M30 alert repeat cadences - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let emitter: ReturnType<typeof createDrizzleAlertEmitter>;
  let consumer: ReturnType<typeof buildM36QualityAlertConsumer>;
  const user: Record<string, string> = {};

  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (process.env.CHARTWARDEN_TEST_NO_PGVECTOR) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function addMember(orgId: string, tag: string, roleKey: string): Promise<string> {
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') RETURNING id",
        [orgId, roleKey],
      )
    ).rows[0].id as string;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@g049.test`])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, orgId],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [orgId, membershipId, roleId],
    );
    return userId;
  }

  /** The sweep over the real SQL scans and the real emitter (with the production fallback), on an injected clock. */
  const sweep = (now: Date, orgs: string[] = [ORG_A, ORG_B, ORG_C]) =>
    runAlertRepeatSweeps({
      listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
      scanOpenItems: (organizationId) => scanOrgForOpenAlertItems(handle.db, organizationId),
      emit: (organizationId, input) => emitWithRecipientFallback(emitter, organizationId, input),
      now: () => now,
    });

  const alertsFor = async (orgId: string, like: string) =>
    (
      await admin.query(
        "SELECT correlation_id FROM alert WHERE organization_id = $1 AND correlation_id LIKE $2 ORDER BY correlation_id",
        [orgId, like],
      )
    ).rows.map((r) => r.correlation_id as string);
  const deliveriesOf = async (orgId: string, correlationId: string) =>
    (
      await admin.query(
        `SELECT DISTINCT nd.recipient_user_id FROM notification_delivery nd
           JOIN alert a ON a.id = nd.alert_id
          WHERE a.organization_id = $1 AND a.correlation_id = $2`,
        [orgId, correlationId],
      )
    ).rows
      .map((r) => r.recipient_user_id as string)
      .sort();

  async function insertIncident(
    orgId: string,
    over: { kind: string; severity: string; lifecycle?: string; reportedAt: Date },
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO incident_report
         (id, organization_id, provider_entity_id, kind, kind_data, occurred_at, reported_at,
          reported_by_membership_id, severity, lifecycle)
       VALUES ($1,$2,$3,$4::m30_incident_kind,'{}'::jsonb,$5,$5,$6,$7::m30_incident_severity,$8::m30_incident_lifecycle)`,
      [
        id,
        orgId,
        PE,
        over.kind,
        over.reportedAt,
        MEMBER,
        over.severity,
        over.lifecycle ?? "submitted",
      ],
    );
    return id;
  }
  /** The first page, raised by the REAL consumer from the event the relay would hand it. */
  const firstPage = (
    orgId: string,
    incidentId: string,
    kind: string,
    severity: string,
    reportedAt: Date,
  ) =>
    consumer.handle({
      eventType: "m30.incident.submitted",
      organizationId: orgId,
      payload: { incidentId, kind, severity, reportedAt: reportedAt.toISOString() },
    } as never);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "g049-a"],
      [ORG_B, "g049-b"],
      [ORG_C, "g049-c"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    // ORG_A has the quality roles the seeded rules name; ORG_B too (isolation); ORG_C has ONLY an org_admin.
    user.aQapi = await addMember(ORG_A, "a-qapi", "qapi_coordinator");
    user.aMedical = await addMember(ORG_A, "a-md", "medical_director");
    user.aAdmin = await addMember(ORG_A, "a-administrator", "administrator");
    user.aCompliance = await addMember(ORG_A, "a-co", "compliance_officer");
    user.aInfection = await addMember(ORG_A, "a-ic", "infection_control_lead");
    user.bAdmin = await addMember(ORG_B, "b-administrator", "administrator");
    user.cOrgAdmin = await addMember(ORG_C, "c-org-admin", "org_admin");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    emitter = createDrizzleAlertEmitter(handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(handle.db);
    consumer = buildM36QualityAlertConsumer(emitter);
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("sentinel incident (every 4h until triaged)", () => {
    let incident: string;
    it("the consumer raises bucket 0; the sweep raises :r1 after 4h and is idempotent inside the bucket", async () => {
      incident = await insertIncident(ORG_A, {
        kind: "fall",
        severity: "critical",
        reportedAt: T0,
      });
      await firstPage(ORG_A, incident, "fall", "critical", T0);
      const base = `outbox:m30.alerts.incident_sentinel:${incident}`;
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base]);

      expect((await sweep(at(4 * HOUR - 1))).repeatsRaised).toBe(0);
      expect((await sweep(at(4 * HOUR + 60_000), [ORG_A])).repeatsRaised).toBeGreaterThanOrEqual(1);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`]);

      // run again inside the same bucket: the alert UNIQUE key absorbs it - no third alert
      await sweep(at(4 * HOUR + 120_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`]);
      // and the repeat reaches the seeded recipients, not nobody
      expect((await deliveriesOf(ORG_A, `${base}:r1`)).length).toBeGreaterThanOrEqual(3);
    });

    it("a missed run catches up to the CURRENT bucket only", async () => {
      const base = `outbox:m30.alerts.incident_sentinel:${incident}`;
      await sweep(at(4 * HOUR * 4 + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`, `${base}:r4`]);
    });

    it("triage ends the series: the next bucket creates nothing", async () => {
      const base = `outbox:m30.alerts.incident_sentinel:${incident}`;
      await admin.query(
        "UPDATE incident_report SET lifecycle = 'triaged', triaged_at = $2 WHERE id = $1",
        [incident, at(4 * HOUR * 4 + 90_000)],
      );
      await sweep(at(4 * HOUR * 6 + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`, `${base}:r4`]);
    });

    it("a reopened incident does not restart the cadence", async () => {
      const reopened = await insertIncident(ORG_A, {
        kind: "fall",
        severity: "critical",
        lifecycle: "reopened",
        reportedAt: T0,
      });
      await sweep(at(30 * DAY), [ORG_A]);
      expect(await alertsFor(ORG_A, `%${reopened}%`)).toEqual([]);
    });

    it("a non-critical, non-abuse incident never repeats", async () => {
      const minor = await insertIncident(ORG_A, {
        kind: "fall",
        severity: "minor",
        reportedAt: T0,
      });
      await sweep(at(30 * DAY), [ORG_A]);
      expect(await alertsFor(ORG_A, `%${minor}%`)).toEqual([]);
    });
  });

  describe("abuse allegation (every 6h) alongside the sentinel (every 4h)", () => {
    it("one critical abuse incident carries two independent cadences", async () => {
      const incident = await insertIncident(ORG_A, {
        kind: "allegation_of_abuse",
        severity: "critical",
        reportedAt: at(10 * DAY),
      });
      await firstPage(ORG_A, incident, "allegation_of_abuse", "critical", at(10 * DAY));
      const sentinel = `outbox:m30.alerts.incident_sentinel:${incident}`;
      const abuse = `outbox:m30.alerts.incident_abuse_allegation:${incident}`;
      await sweep(at(10 * DAY + 4 * HOUR + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `%${incident}%`)).toEqual(
        [abuse, sentinel, `${sentinel}:r1`].sort(),
      );
      await sweep(at(10 * DAY + 6 * HOUR + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `%${incident}%`)).toEqual(
        [abuse, `${abuse}:r1`, sentinel, `${sentinel}:r1`].sort(),
      );
    });
  });

  describe("outbreak (every 12h until IDG reviewed)", () => {
    it("repeats until the IDG review, then stops", async () => {
      const caseId = randomUUID();
      await admin.query(
        `INSERT INTO infection_outbreak_case
           (id, organization_id, provider_entity_id, pathogen, body_site, window_start, window_end,
            triggering_event_count, created_at)
         VALUES ($1,$2,$3,'mrsa','skin',$4,$5,3,$5)`,
        [caseId, ORG_A, PE, at(20 * DAY - 14 * DAY), at(20 * DAY)],
      );
      await consumer.handle({
        eventType: "m30.infection.outbreak_opened",
        organizationId: ORG_A,
        payload: { caseId, pathogen: "mrsa", bodySite: "skin", eventCount: 3 },
      } as never);
      const base = `outbox:m30.alerts.outbreak_detected:${caseId}`;
      await sweep(at(20 * DAY + 12 * HOUR + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`]);
      await admin.query(
        "UPDATE infection_outbreak_case SET status = 'idg_reviewed', idg_reviewed_at = $2 WHERE id = $1",
        [caseId, at(20 * DAY + 13 * HOUR)],
      );
      await sweep(at(20 * DAY + 24 * HOUR + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`]);
    });
  });

  describe("threshold breach (every 7d until a project is chartered, 90d ceiling)", () => {
    const MEASURE = "hci_composite";
    const PERIOD_START = new Date("2026-07-01T00:00:00Z");
    const PERIOD_END = new Date("2026-09-30T00:00:00Z");
    const insertValue = (band: string | null, computedAt: Date, over: { periodEnd?: Date } = {}) =>
      admin.query(
        `INSERT INTO quality_measure_value
           (measure_code, provider_entity_id, organization_id, period_kind, period_start, period_end,
            numerator, denominator, ratio, threshold_met, band_color, computation_snapshot,
            snapshot_content_hash, calculator_version, computed_at)
         VALUES ($1,$2,$3,'calendar_quarter',$4,$5,2,10,0.2,false,$6,'{}'::jsonb,$7,'1.0.0',$8)`,
        [
          MEASURE,
          PE,
          ORG_A,
          PERIOD_START,
          over.periodEnd ?? PERIOD_END,
          band,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          computedAt,
        ],
      );
    const key = `${MEASURE}:${PERIOD_END.toISOString()}`;
    const base = `outbox:m30.alerts.measure_threshold_breached:${key}`;
    const breachAt = at(40 * DAY);

    it("a YELLOW latest value is not a breach and never repeats", async () => {
      await insertValue("yellow", breachAt);
      await sweep(at(80 * DAY), [ORG_A]);
      expect(await alertsFor(ORG_A, `outbox:m30.alerts.measure_threshold_breached:%`)).toEqual([]);
      await admin.query("DELETE FROM quality_measure_value WHERE organization_id = $1", [ORG_A]);
    });

    it("a red value repeats every 7d from the first red computation, and a project ends it", async () => {
      await insertValue("red", breachAt);
      await consumer.handle({
        eventType: "m30.measure.threshold_breached",
        organizationId: ORG_A,
        payload: {
          indicatorId: MEASURE,
          measureId: MEASURE,
          periodEnd: PERIOD_END.toISOString(),
          rate: 0.2,
          threshold: 0.8,
          severityBand: "red",
        },
      } as never);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base]);
      await sweep(at(40 * DAY + 7 * DAY - 1), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base]);
      await sweep(at(40 * DAY + 7 * DAY + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`]);

      // charter a project against the measure-sourced indicator
      const program = randomUUID();
      const indicator = randomUUID();
      await admin.query(
        `INSERT INTO qapi_program (id, organization_id, provider_entity_id, plan_year, program_description, governing_body_roster)
         VALUES ($1,$2,$3,2026,'p','[]'::jsonb)`,
        [program, ORG_A, PE],
      );
      await admin.query(
        `INSERT INTO qapi_indicator (id, qapi_program_id, organization_id, indicator_name, data_path)
         VALUES ($1,$2,$3,'HCI','measure:${MEASURE}')`,
        [indicator, program, ORG_A],
      );
      const project = randomUUID();
      await admin.query(
        `INSERT INTO qapi_project (id, qapi_program_id, organization_id, title, goal_text, owner_membership_id, linked_indicator_id, status)
         VALUES ($1,$2,$3,'Improve','goal',$4,$5,'abandoned')`,
        [project, program, ORG_A, MEMBER, indicator],
      );
      // an ABANDONED project does not count as chartered: the series continues
      await sweep(at(40 * DAY + 14 * DAY + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`, `${base}:r2`]);
      await admin.query("UPDATE qapi_project SET status = 'active' WHERE id = $1", [project]);
      await sweep(at(40 * DAY + 21 * DAY + 60_000), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}%`)).toEqual([base, `${base}:r1`, `${base}:r2`]);
    });

    it("stops after the 90-day ceiling even with no project", async () => {
      await admin.query("UPDATE qapi_project SET status = 'abandoned'");
      await sweep(at(40 * DAY + 91 * DAY), [ORG_A]);
      expect(await alertsFor(ORG_A, `${base}:r13`)).toEqual([]);
    });
  });

  describe("zero recipients: the page is routed to the tenant admins, never dropped", () => {
    it("ORG_C has no quality roles; the first page AND its repeat reach the org_admin via the fallback", async () => {
      const incident = await insertIncident(ORG_C, {
        kind: "fall",
        severity: "critical",
        reportedAt: T0,
      });
      const warnings: string[] = [];
      const withWarn = buildM36QualityAlertConsumer(emitter, (message) => warnings.push(message));
      await withWarn.handle({
        eventType: "m30.incident.submitted",
        organizationId: ORG_C,
        payload: {
          incidentId: incident,
          kind: "fall",
          severity: "critical",
          reportedAt: T0.toISOString(),
        },
      } as never);
      const base = `outbox:m30.alerts.incident_sentinel:${incident}`;
      expect(warnings).toEqual(["quality alert resolved no recipients; paging tenant admins"]);
      expect(await deliveriesOf(ORG_C, base)).toEqual([]);
      expect(await deliveriesOf(ORG_C, `${base}:fb`)).toEqual([user.cOrgAdmin]);

      await sweep(at(4 * HOUR + 60_000), [ORG_C]);
      expect(await deliveriesOf(ORG_C, `${base}:r1`)).toEqual([]);
      expect(await deliveriesOf(ORG_C, `${base}:r1:fb`)).toEqual([user.cOrgAdmin]);
    });
  });

  describe("tenant isolation", () => {
    it("org B's open incident never produces an org A alert, and the sweep as org A reads only org A's rows", async () => {
      const bIncident = await insertIncident(ORG_B, {
        kind: "fall",
        severity: "critical",
        reportedAt: at(50 * DAY),
      });
      await firstPage(ORG_B, bIncident, "fall", "critical", at(50 * DAY));
      await sweep(at(50 * DAY + 4 * HOUR + 60_000), [ORG_A, ORG_B]);
      expect(await alertsFor(ORG_A, `%${bIncident}%`)).toEqual([]);
      const b = await alertsFor(ORG_B, `%${bIncident}%`);
      expect(b.length).toBe(2);
      expect(
        await deliveriesOf(ORG_B, `outbox:m30.alerts.incident_sentinel:${bIncident}:r1`),
      ).toEqual([user.bAdmin].sort());
      const aItems = await scanOrgForOpenAlertItems(handle.db, ORG_A);
      expect(aItems.every((i) => i.key !== bIncident)).toBe(true);
    });
  });

  describe("the review-overdue SQL (never executed against a real database before)", () => {
    it("scanOrgForOverdueMortalityReviews returns an overdue, uncompleted review and nothing else", async () => {
      await admin.query(
        `INSERT INTO mortality_review
           (organization_id, provider_entity_id, deceased_patient_id, admission_id, death_at, target_completion_at,
            created_via_event_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7), ($1,$2,$10,$11,$5,$8,$9)`,
        [
          ORG_A,
          PE,
          randomUUID(),
          randomUUID(),
          at(0),
          at(5 * DAY),
          randomUUID(),
          at(400 * DAY),
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ],
      );
      const overdue = await scanOrgForOverdueMortalityReviews(handle.db, ORG_A, at(10 * DAY));
      expect(overdue).toHaveLength(1);
      expect(overdue[0]?.targetCompletionAt).toBe(at(5 * DAY).toISOString());
      expect(await scanOrgForOverdueMortalityReviews(handle.db, ORG_B, at(10 * DAY))).toEqual([]);
    });

    it("scanOrgForOverdueCopReviews returns a past-due citation and nothing else", async () => {
      await admin.query(
        `INSERT INTO cop_compliance_status
           (organization_id, provider_entity_id, cop_citation, status, last_reviewed_at,
            last_reviewed_by_membership_id, next_review_due_at)
         VALUES ($1,$2,'418.58','compliant',$3,$4,$5), ($1,$2,'418.60','compliant',$3,$4,$6)`,
        [ORG_A, PE, at(0), MEMBER, at(5 * DAY), at(900 * DAY)],
      );
      const overdue = await scanOrgForOverdueCopReviews(handle.db, ORG_A, at(10 * DAY));
      expect(overdue.map((c) => c.copCitation)).toEqual(["418.58"]);
      expect(await scanOrgForOverdueCopReviews(handle.db, ORG_B, at(10 * DAY))).toEqual([]);
    });
  });
});
