/**
 * F-166 (#248) — LIVE Postgres proof that M17's two newest bindings actually write real rows under RLS:
 *   - `buildM17VolunteerAssignmentInactivatedConsumer` (`m15.volunteer.assignment_inactivated` →
 *     `m17.reassignment_needed` warnings for every non-terminal visit still assigned to the volunteer)
 *   - `buildM17TriageVisitNeededConsumer` (`m19.triage_call.visit_needed` → a real `visit_proposal` row,
 *     via M6's new org-explicit `activeAdmissionSitingForPatientForOrg` seam, exercised for real here —
 *     not a stub — so the whole cross-module chain is proven end to end)
 *
 * M15's own catalog entry says "so M17 must drop the volunteer from the schedule (§7.5)" — the literal
 * reading is not buildable (`visit.assigned_membership_id` is NOT NULL, checked directly), so what's
 * proven here is the real, designed alternative: the catalogued `m17.reassignment_needed` alert-wired
 * event, published for the first time by this consumer. M19's own worked example names `visit_needed` as
 * the D5 proposal-worker trigger — three previously-named infrastructure gaps (the `visit_proposal_source`
 * enum member, the admission-siting seam, the `visitKind` discriminator) are all proven closed here.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m17:volunteer-triage-consumers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeAdmissionSitingForPatientForOrg } from "../src/modules/06-admission/seams/drizzle-store";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/events-by-m17";
import { buildM17VolunteerAssignmentInactivatedConsumer } from "../src/modules/17-scheduling/outbox-consumers/m15-volunteer-assignment-inactivated";
import { buildM17TriageVisitNeededConsumer } from "../src/modules/17-scheduling/outbox-consumers/m19-triage-visit-needed";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-166 — M17's volunteer-inactivated + triage-visit-needed consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let peA: string;
    let locA: string;
    let memA: string;
    let peB: string;
    let locB: string;
    let memB: string;
    let visitSeedCounter = 0;
    let volunteerConsumer: ReturnType<typeof buildM17VolunteerAssignmentInactivatedConsumer>;
    let triageConsumer: ReturnType<typeof buildM17TriageVisitNeededConsumer>;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedOrgFixture(orgId: string, slug: string) {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
        [orgId, slug, slug],
      );
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [orgId, `M17T-${slug}`, `Provider ${slug}`, slug === "a" ? "1300000001" : "1300000002"],
        )
      ).rows[0].id as string;
      const loc = (
        await admin.query(
          `INSERT INTO location
             (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Main','1 Main St','Portland','OR','97201','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17-vol-triage-${slug}@x.test`,
        ])
      ).rows[0].id as string;
      const mem = (
        await admin.query(
          `INSERT INTO membership
             (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, orgId, pe, JSON.stringify([loc])],
        )
      ).rows[0].id as string;
      return { pe, loc, mem };
    }

    async function seedVisit(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      assignedMembershipId: string;
      status: "published" | "en_route" | "in_visit" | "completed" | "cancelled";
    }): Promise<string> {
      const patientId = crypto.randomUUID();
      const admissionId = crypto.randomUUID();
      const offsetHours = visitSeedCounter++;
      const row = await admin.query(
        `INSERT INTO visit
           (organization_id, provider_entity_id, location_id, patient_id, admission_id,
            assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
            scheduled_started_at, scheduled_ended_at, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
                 now() + ($8 || ' hours')::interval, now() + ($8 || ' hours')::interval + interval '1 hour',
                 CURRENT_DATE, $7)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          patientId,
          admissionId,
          opts.assignedMembershipId,
          opts.status,
          String(offsetHours * 2),
        ],
      );
      return row.rows[0].id as string;
    }

    async function seedActiveAdmission(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
    }): Promise<{ admissionId: string; patientId: string }> {
      const patientId = crypto.randomUUID();
      const row = await admin.query(
        `INSERT INTO admission
           (organization_id, provider_entity_id, location_id, patient_id, status, admission_at, activated_at)
         VALUES ($1,$2,$3,$4,'active', now(), now())
         RETURNING id`,
        [opts.organizationId, opts.providerEntityId, opts.locationId, patientId],
      );
      return { admissionId: row.rows[0].id as string, patientId };
    }

    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT aggregate_id, payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2 ORDER BY created_at`,
        [organizationId, eventType],
      );
      return rows;
    }

    async function visitProposalRows(organizationId: string, patientId: string) {
      const { rows } = await admin.query(
        `SELECT id, organization_id, provider_entity_id, location_id, admission_id, patient_id, source,
                source_idempotency_key, proposed_for_date::text AS proposed_for_date,
                proposed_visit_purpose, proposed_discipline, proposed_duration_minutes, status
         FROM visit_proposal WHERE organization_id = $1 AND patient_id = $2 ORDER BY created_at`,
        [organizationId, patientId],
      );
      return rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      const a = await seedOrgFixture(ORG_A, "a");
      peA = a.pe;
      locA = a.loc;
      memA = a.mem;
      const b = await seedOrgFixture(ORG_B, "b");
      peB = b.pe;
      locB = b.loc;
      memB = b.mem;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M17_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      const outbox = {
        async publish(
          tx: unknown,
          input: {
            eventName: string;
            payload: Record<string, unknown>;
            organizationId: string;
            aggregateKind: string;
            aggregateId: string;
          },
        ) {
          if (!catalog.has(input.eventName)) {
            throw new Error(`m17 test publisher: undeclared event ${input.eventName}`);
          }
          await (tx as typeof handle.db).execute(sql`
            INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
            VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                    ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
          `);
        },
      };

      volunteerConsumer = buildM17VolunteerAssignmentInactivatedConsumer({ db: handle.db, outbox });
      triageConsumer = buildM17TriageVisitNeededConsumer({
        db: handle.db,
        outbox,
        admissionSitingForPatient: activeAdmissionSitingForPatientForOrg,
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("warns on every non-terminal visit assigned to the inactivated volunteer, skips terminal ones", async () => {
      const published = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "published",
      });
      const enRoute = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "en_route",
      });
      const completed = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "completed",
      });

      const inactivation = {
        organizationId: ORG_A,
        payload: {
          volunteerMembershipId: memA,
          affectedPlanIds: [],
          reason: "gate_expired",
        },
      };
      const firstEventId = crypto.randomUUID();
      await volunteerConsumer.handle({ id: firstEventId, ...inactivation });

      const events = await outboxRows(ORG_A, "m17.reassignment_needed");
      const visitIds = events.map((e) => e.aggregate_id).sort();
      expect(visitIds).toEqual([published, enRoute].sort());
      expect(events.every((e) => e.payload.reason === "volunteer_gate_expired")).toBe(true);
      expect(events.every((e) => e.payload.affectedMembershipId === memA)).toBe(true);
      // The terminal visit never got one.
      expect(visitIds).not.toContain(completed);

      // b11: a REPLAY of the same delivered event emits nothing more...
      await volunteerConsumer.handle({ id: firstEventId, ...inactivation });
      expect(await outboxRows(ORG_A, "m17.reassignment_needed")).toHaveLength(2);
      // ...while a genuinely new inactivation (new event id) flags the still-assigned visits again.
      await volunteerConsumer.handle({ id: crypto.randomUUID(), ...inactivation });
      expect(await outboxRows(ORG_A, "m17.reassignment_needed")).toHaveLength(4);
    });

    it("is org-scoped — org A's inactivation cannot see org B's volunteer's visits", async () => {
      await seedVisit({
        organizationId: ORG_B,
        providerEntityId: peB,
        locationId: locB,
        assignedMembershipId: memB,
        status: "published",
      });

      await volunteerConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: { volunteerMembershipId: memB, affectedPlanIds: [], reason: "gate_expired" },
      });

      // memB's own org-B visit must not have been reached from an ORG_A-scoped call.
      const { rows } = await admin.query(
        `SELECT count(*)::int AS c FROM outbox_event
         WHERE organization_id = $1 AND event_type = 'm17.reassignment_needed'
           AND payload->>'affectedMembershipId' = $2`,
        [ORG_A, memB],
      );
      expect(rows[0].c).toBe(0);
    });

    it("dispatch_now creates a real visit_proposal (source=triage_dispatch_m19, purpose=prn) and publishes m17.visit.proposed", async () => {
      const { admissionId, patientId } = await seedActiveAdmission({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
      });
      const triageCallId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const requestedArrivalBy = "2026-10-01T05:30:00.000Z"; // a UTC-late instant to prove org-tz dating

      await triageConsumer.handle({
        id: eventId,
        organizationId: ORG_A,
        payload: {
          triageCallId,
          patientId,
          requestedDiscipline: "rn",
          requestedArrivalBy,
          proposedForDate: null,
          reason: "unmanaged pain overnight",
          visitKind: "dispatch_now",
        },
      });

      const rows = await visitProposalRows(ORG_A, patientId);
      expect(rows).toHaveLength(1);
      const p = rows[0];
      expect(p.admission_id).toBe(admissionId);
      expect(p.provider_entity_id).toBe(peA);
      expect(p.location_id).toBe(locA);
      expect(p.source).toBe("triage_dispatch_m19");
      expect(p.source_idempotency_key).toBe(eventId);
      expect(p.proposed_visit_purpose).toBe("prn");
      expect(p.proposed_discipline).toBe("rn");
      expect(p.proposed_duration_minutes).toBe(60);
      expect(p.status).toBe("pending");
      // Dated by ORGANIZATION timezone (`organizationTimezone`'s own `org_timezone` setting), not the
      // visit's location: this fixture's org sets no override, so it falls to the platform default
      // (`DEFAULT_ORGANIZATION_TIMEZONE`, America/New_York) — 2026-10-01T05:30Z is 01:30 EDT, still Oct 1.
      expect(p.proposed_for_date).toBe("2026-10-01");

      const proposed = await outboxRows(ORG_A, "m17.visit.proposed");
      const mine = proposed.find((r) => r.aggregate_id === p.id);
      expect(mine).toBeDefined();
      expect(mine?.payload).toMatchObject({
        proposalId: p.id,
        patientId,
        admissionId,
        source: "triage_dispatch_m19",
        proposedVisitPurpose: "prn",
        proposedDiscipline: "rn",
      });

      // Redelivery of the SAME event id must not create a second row or a second m17.visit.proposed.
      await triageConsumer.handle({
        id: eventId,
        organizationId: ORG_A,
        payload: {
          triageCallId,
          patientId,
          requestedDiscipline: "rn",
          requestedArrivalBy,
          proposedForDate: null,
          reason: "unmanaged pain overnight",
          visitKind: "dispatch_now",
        },
      });
      expect(await visitProposalRows(ORG_A, patientId)).toHaveLength(1);
      expect(
        (await outboxRows(ORG_A, "m17.visit.proposed")).filter((r) => r.aggregate_id === p.id),
      ).toHaveLength(1);
    });

    it("pronouncement maps to visit_purpose=pronouncement, distinct from dispatch_now despite the identical non-null field shape", async () => {
      const { admissionId, patientId } = await seedActiveAdmission({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
      });

      await triageConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: {
          triageCallId: crypto.randomUUID(),
          patientId,
          requestedDiscipline: "rn",
          requestedArrivalBy: new Date().toISOString(),
          proposedForDate: null,
          reason: "death pronouncement requested during after-hours triage call",
          visitKind: "pronouncement",
        },
      });

      const rows = await visitProposalRows(ORG_A, patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0].admission_id).toBe(admissionId);
      expect(rows[0].proposed_visit_purpose).toBe("pronouncement");
    });

    it("first_light uses the payload's own proposedForDate verbatim", async () => {
      const { patientId } = await seedActiveAdmission({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
      });

      await triageConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: {
          triageCallId: crypto.randomUUID(),
          patientId,
          requestedDiscipline: "msw",
          requestedArrivalBy: null,
          proposedForDate: "2026-11-15",
          reason: "family requests a visit at first light",
          visitKind: "first_light",
        },
      });

      const rows = await visitProposalRows(ORG_A, patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0].proposed_visit_purpose).toBe("prn");
      expect(rows[0].proposed_discipline).toBe("msw");
      expect(rows[0].proposed_for_date).toBe("2026-11-15");
    });

    it("is a true no-op when the call carries no patient or no active admission exists", async () => {
      // No patient at all.
      await triageConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: {
          triageCallId: crypto.randomUUID(),
          patientId: null,
          requestedDiscipline: "rn",
          requestedArrivalBy: new Date().toISOString(),
          proposedForDate: null,
          reason: "no patient linked",
          visitKind: "dispatch_now",
        },
      });

      // A patient with no admission at all in this org.
      const strandedPatientId = crypto.randomUUID();
      await triageConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: {
          triageCallId: crypto.randomUUID(),
          patientId: strandedPatientId,
          requestedDiscipline: "rn",
          requestedArrivalBy: new Date().toISOString(),
          proposedForDate: null,
          reason: "no admission",
          visitKind: "dispatch_now",
        },
      });
      expect(await visitProposalRows(ORG_A, strandedPatientId)).toHaveLength(0);
    });
  },
);
