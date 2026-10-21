/**
 * M14L — the Drizzle `createDbIdgBackend` READ paths, proven against real Postgres.
 *
 * M14's pure suites exercise the meeting/decision/minutes machines over in-memory Maps; the RLS suite proves
 * the policies but never drives the SERVICE. This applies the real migrations to a real Postgres, seeds one
 * full IDG chain per tenant as superuser, then drives the PRODUCTION read service (the one the composition
 * root mounts) over the M14-owned tables as the unprivileged `wardenx_app` role — proving the schedule /
 * meeting / action-item / minutes reads return the seeded rows, that RLS scopes every read by tenant (org B
 * cannot see org A's meeting through the service), and that every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m14-idg-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { membershipDisplayForOrg } from "../src/modules/02-identity/index";
import { createDbIdgBackend } from "../src/modules/14-idg/idg-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** membership_id / patient_id / admission_id are NOT NULL but carry NO SQL FK (§3.3) — literals are fine. */
const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
/** Real `membership` rows (the signer-name seam JOINs `user`); org B's is a DIFFERENT membership of another user. */
const USER_B = "66666666-6666-6666-6666-666666666666";
const MEMBER_A = "77777777-7777-7777-7777-777777777777";
const MEMBER_B = "88888888-8888-8888-8888-888888888888";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = { location: string; meeting: string; actionItem: string; minutes: string };

describe.skipIf(!DB_URL)("M14 Drizzle read service — LIVE Postgres (M14L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbIdgBackend>;
  const seeded: Record<string, SeedIds> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one full M14 IDG chain for `org` as superuser (RLS + grants bypassed), in FK order. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M14R${n}`, `M14R ${n}`, `NPI-M14R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M14R${n}`],
      )
    ).rows[0].id as string;
    const recurringPolicy = (
      await admin.query(
        `INSERT INTO idg_recurring_policy (organization_id, location_id, day_of_week_anchor,
           default_coordinator_membership_id)
         VALUES ($1,$2,'monday',$3) RETURNING id`,
        [org, location, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const meeting = (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, recurring_policy_id, scheduled_start,
           scheduled_end, status, coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2,$3, now(), now() + interval '2 hours', 'scheduled', $4, '{}'::jsonb) RETURNING id`,
        [org, location, recurringPolicy, MEMBERSHIP],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO idg_attendance (organization_id, idg_meeting_id, membership_id, discipline, status)
       VALUES ($1,$2,$3,'rn','present')`,
      [org, meeting, MEMBERSHIP],
    );
    const agendaItem = (
      await admin.query(
        `INSERT INTO idg_agenda_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, title, kind, added_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'Review','patient_review',$6) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const decision = (
      await admin.query(
        `INSERT INTO idg_decision (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, agenda_item_id, decision_kind, payload, was_quorate, quorum_snapshot,
           recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'care_plan_update','{}'::jsonb, true, '{}'::jsonb, $7) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, agendaItem, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const actionItem = (
      await admin.query(
        `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
           idg_decision_id, patient_id, assigned_to_membership_id, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Follow up') RETURNING id`,
        [org, providerEntity, location, meeting, decision, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const minutes = (
      await admin.query(
        `INSERT INTO idg_minutes (organization_id, idg_meeting_id, status)
         VALUES ($1,$2,'in_progress') RETURNING id`,
        [org, meeting],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO idg_patient_packet (organization_id, provider_entity_id, location_id, idg_meeting_id,
         patient_id, admission_id, since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01T00:00:00Z','{}'::jsonb,'{}'::jsonb,'summary')`,
      [org, providerEntity, location, meeting, PATIENT, ADMISSION],
    );
    return { location, meeting, actionItem, minutes };
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
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'m14r@x.test','  Dana Coordinator ')`,
      [USER],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'m14b@x.test','Org B Person')`,
      [USER_B],
    );
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active'),($4,$5,$6,'revoked')",
      [MEMBER_A, USER, ORG_A, MEMBER_B, USER_B, ORG_B],
    );
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `wardenx_app` role; `withOrgContext` does NOT SET ROLE. To exercise
    // RLS faithfully, connect the client AS wardenx_app — NOLOGIN in the migrations, so grant LOGIN here.
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbIdgBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("getMeeting returns the seeded meeting (RLS-scoped)", async () => {
    const m = await service.getMeeting(ORG_A, seeded[ORG_A].meeting);
    expect(m.id).toBe(seeded[ORG_A].meeting);
    expect(m.organizationId).toBe(ORG_A);
    expect(m.status).toBe("scheduled");
    expect(m.locationId).toBe(seeded[ORG_A].location);
  });

  it("listSchedule returns the org's meeting within the window, empty for the other tenant's location", async () => {
    const rows = await service.listSchedule(ORG_A, {
      location: seeded[ORG_A].location,
      from: "2020-01-01T00:00:00Z",
      to: "2035-01-01T00:00:00Z",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(seeded[ORG_A].meeting);
    expect(rows[0].status).toBe("scheduled");
  });

  it("listActionItems + getMinutes return org A's rows", async () => {
    const items = await service.listActionItems(
      ORG_A,
      {},
      { assigneeMembershipId: USER, locationIds: null, patientIds: null },
    );
    expect(items.some((i) => i.id === seeded[ORG_A].actionItem)).toBe(true);
    const minutes = await service.getMinutes(ORG_A, seeded[ORG_A].meeting);
    expect(minutes.id).toBe(seeded[ORG_A].minutes);
    expect(minutes.status).toBe("in_progress");
  });

  it("applies assignee, location and patient scope in the action-item SQL query", async () => {
    await expect(
      service.listActionItems(
        ORG_A,
        {},
        { assigneeMembershipId: USER, locationIds: [], patientIds: null },
      ),
    ).resolves.toEqual([]);
    await expect(
      service.listActionItems(
        ORG_A,
        {},
        { assigneeMembershipId: USER, locationIds: [seeded[ORG_A].location], patientIds: [] },
      ),
    ).resolves.toEqual([]);
    await expect(
      service.listActionItems(
        ORG_A,
        {},
        { assigneeMembershipId: MEMBER_A, locationIds: null, patientIds: null },
      ),
    ).resolves.toEqual([]);
  });

  it("resolves child parent scope under RLS and hides a cross-tenant child", async () => {
    await expect(
      service.scopedChildFacts(ORG_A, "action_item", seeded[ORG_A].actionItem),
    ).resolves.toMatchObject({
      meetingId: seeded[ORG_A].meeting,
      locationId: seeded[ORG_A].location,
      patientId: PATIENT,
    });
    await expect(
      service.scopedChildFacts(ORG_B, "action_item", seeded[ORG_A].actionItem),
    ).resolves.toBeNull();
  });

  it("RLS: org B cannot see org A's meeting through the read service", async () => {
    // getMeeting fail-closes 404 (RLS-hidden rows share NOT_FOUND — no existence oracle, §4.3).
    await expect(service.getMeeting(ORG_B, seeded[ORG_A].meeting)).rejects.toMatchObject({
      statusCode: 404,
    });
    // And nothing of org A's leaks through the schedule read scoped by org A's location.
    const rows = await service.listSchedule(ORG_B, {
      location: seeded[ORG_A].location,
      from: "2020-01-01T00:00:00Z",
      to: "2035-01-01T00:00:00Z",
    });
    expect(rows.every((r) => r.id !== seeded[ORG_A].meeting)).toBe(true);
  });

  it("writes are live (M14L): createRecurringPolicy persists + updateRecurringPolicy round-trips", async () => {
    const created = await service.createRecurringPolicy(ORG_A, MEMBERSHIP, {
      locationId: seeded[ORG_A].location,
      cadenceDays: 14,
    });
    expect(created.cadenceDays).toBe(14);
    expect(created.active).toBe(true);
    const updated = await service.updateRecurringPolicy(ORG_A, MEMBERSHIP, created.id, {
      locationId: seeded[ORG_A].location,
      cadenceDays: 7,
      active: false,
    });
    expect(updated.cadenceDays).toBe(7);
    expect(updated.active).toBe(false);
  });

  it("getPatientIdgHistory assembles the patient's reviewed meetings + decisions + action items", async () => {
    const history = await service.getPatientIdgHistory(ORG_A, PATIENT);
    expect(history.meetings.length).toBe(1);
    const m = history.meetings[0];
    expect(m.meetingId).toBe(seeded[ORG_A].meeting);
    // The seeded chain gives this patient one decision + one action item in the meeting.
    expect(m.decisions.length).toBeGreaterThanOrEqual(1);
    expect(m.actionItems.some((a) => a.id === seeded[ORG_A].actionItem)).toBe(true);
  });

  it("getPatientIdgHistory is a truthful empty for a patient never on an agenda", async () => {
    const history = await service.getPatientIdgHistory(
      ORG_A,
      "99999999-9999-9999-9999-999999999999",
    );
    expect(history.meetings).toEqual([]);
  });

  it("RLS: getPatientIdgHistory scopes to the caller's org for a cross-tenant patient literal", async () => {
    // Both orgs seeded a packet for the SAME patient id; each caller resolves ONLY its own meeting.
    const a = await service.getPatientIdgHistory(ORG_A, PATIENT);
    const b = await service.getPatientIdgHistory(ORG_B, PATIENT);
    expect(a.meetings[0]?.meetingId).toBe(seeded[ORG_A].meeting);
    expect(b.meetings[0]?.meetingId).toBe(seeded[ORG_B].meeting);
    expect(b.meetings.every((m) => m.meetingId !== seeded[ORG_A].meeting)).toBe(true);
  });

  // ── signer name + render status on the minutes read (the identity-owned `membershipDisplayForOrg` seam) ──
  it("membershipDisplayForOrg (as wardenx_app): name ONLY, trimmed; unknown ids absent; a revoked member still resolves", async () => {
    const got = await membershipDisplayForOrg(handle.db, ORG_A, [
      MEMBER_A,
      "99999999-9999-9999-9999-999999999999",
    ]);
    expect([...got.keys()]).toEqual([MEMBER_A]);
    // Minimum necessary: the projection is exactly {membershipId, displayName} — no email, no user id.
    expect(got.get(MEMBER_A)).toEqual({ membershipId: MEMBER_A, displayName: "Dana Coordinator" });
    const revoked = await membershipDisplayForOrg(handle.db, ORG_B, [MEMBER_B]);
    expect(revoked.get(MEMBER_B)?.displayName).toBe("Org B Person");
    expect((await membershipDisplayForOrg(handle.db, ORG_A, [])).size).toBe(0);
  });

  it("RLS: membershipDisplayForOrg never resolves another tenant's membership, in either direction", async () => {
    expect((await membershipDisplayForOrg(handle.db, ORG_A, [MEMBER_B])).size).toBe(0);
    expect((await membershipDisplayForOrg(handle.db, ORG_B, [MEMBER_A])).size).toBe(0);
  });

  it("getMinutes derives renderStatus from real data (not_rendered -> pending -> rendered) + the finalizer's discipline", async () => {
    const meetingId = seeded[ORG_A].meeting;
    const before = await service.getMinutes(ORG_A, meetingId);
    expect(before.renderStatus).toBe("not_rendered");
    expect(before.finalizedByDiscipline).toBeNull();

    await admin.query(
      `UPDATE idg_minutes SET status='final', finalized_at=now(), finalized_by_membership_id=$2,
         attendance_snapshot=$3::jsonb, decision_list_snapshot='[]'::jsonb, action_item_list_snapshot='[]'::jsonb
       WHERE idg_meeting_id=$1`,
      [
        meetingId,
        MEMBER_A,
        JSON.stringify([
          { attendanceId: "a", membershipId: MEMBER_A, discipline: "rn_case_manager" },
        ]),
      ],
    );
    const pending = await service.getMinutes(ORG_A, meetingId);
    expect(pending.status).toBe("final");
    expect(pending.renderStatus).toBe("pending");
    expect(pending.minutesDocumentId).toBeNull();
    expect(pending.finalizedByMembershipId).toBe(MEMBER_A);
    expect(pending.finalizedByDiscipline).toBe("rn_case_manager");

    const documentId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    await admin.query("UPDATE idg_minutes SET minutes_document_id=$2 WHERE idg_meeting_id=$1", [
      meetingId,
      documentId,
    ]);
    const rendered = await service.getMinutes(ORG_A, meetingId);
    expect(rendered.renderStatus).toBe("rendered");
    expect(rendered.minutesDocumentId).toBe(documentId);
  });

  // ── packet CONTENT read (GET /meetings/:id/packets/:patientId) — as wardenx_app over a real jsonb row ─────────
  const PKT_PATIENT_SUD = "99999999-9999-4999-8999-999999999999";
  const snapshotFor = (patientId: string, meetingId: string, sud: boolean) => ({
    schemaVersion: "2026-01-v1",
    meta: {
      meetingId,
      patientId,
      admissionId: ADMISSION,
      locationId: seeded[ORG_A].location,
      builtAt: "2026-06-16T09:00:00.000Z",
      sinceCursorIso: "2026-06-02T15:00:00.000Z",
      sinceContext: "prior_idg",
      builderJobId: "job-live",
      appliedSudRedaction: false,
    },
    patientCover: {
      fullNameRedacted: "Ada L.",
      age: 81,
      primaryDiagnosisIcd10: "C34.90",
      primaryDiagnosisLabel: "Malignant neoplasm of lung",
      daysOnService: 100,
      levelOfCare: "routine",
      nextRecertDueAt: "2026-07-01T00:00:00.000Z",
      f2fWindowState: "not_due",
      activeDpoa: null,
      activeSudFlag: sud,
    },
    sinceLastIdg: {
      encounters: [
        {
          encounterId: "enc-live-1",
          encounterType: "rn_visit",
          signedAt: "2026-06-10T10:00:00.000Z",
          authorDiscipline: "rn",
        },
      ],
      significantAssessmentChanges: [],
      j2051Triggers: [],
      ordersChanged: [
        {
          orderId: "ord-live-1",
          orderKind: "lab",
          changeKind: "signed",
          changedAt: "2026-06-12T00:00:00.000Z",
        },
      ],
      medicationsChanged: [],
      flaggedEvents: [],
    },
    carePlanSummary: {
      activeProblemCount: 1,
      activeGoalCount: 1,
      activeInterventionCount: 1,
      lastSignedVersionId: "cpv-live",
      lastSignedAt: "2026-06-01T00:00:00.000Z",
      nextReviewDueAt: "2026-06-30T00:00:00.000Z",
      isReviewOverdue: false,
    },
    hopeContext: null,
    capProjection: null,
    carryForwardActionItems: [],
    flagsForDiscussion: [],
  });
  const viewsFor = () => ({
    rn: {
      oneLineSummary: "2 highlighted item(s) for rn since the last IDG",
      highlightedEntries: [
        {
          sourceKind: "encounter",
          sourceId: "enc-live-1",
          label: "rn_visit",
          summary: "rn encounter signed",
          severity: "info",
        },
        {
          sourceKind: "order",
          sourceId: "ord-live-1",
          label: "lab",
          summary: "signed (lab)",
          severity: "info",
        },
      ],
      openQuestions: [],
      layer2Polished: null,
    },
  });

  it("getPacket returns the stored snapshot's content as wardenx_app; a non-SUD read never consults consent", async () => {
    const meetingId = seeded[ORG_A].meeting;
    const pe = (
      await admin.query(
        "SELECT provider_entity_id FROM idg_meeting m JOIN location l ON l.id=m.location_id WHERE m.id=$1",
        [meetingId],
      )
    ).rows[0].provider_entity_id as string;
    await admin.query(
      `INSERT INTO idg_patient_packet (organization_id, provider_entity_id, location_id, idg_meeting_id,
         patient_id, admission_id, since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-06-02T15:00:00.000Z',$7::jsonb,$8::jsonb,'s'),
              ($1,$2,$3,$4,$9,$6,'2026-06-02T15:00:00.000Z',$10::jsonb,$8::jsonb,'s')`,
      [
        ORG_A,
        pe,
        seeded[ORG_A].location,
        meetingId,
        "88888888-8888-4888-8888-888888888880",
        ADMISSION,
        JSON.stringify(snapshotFor("88888888-8888-4888-8888-888888888880", meetingId, false)),
        JSON.stringify(viewsFor()),
        PKT_PATIENT_SUD,
        JSON.stringify(snapshotFor(PKT_PATIENT_SUD, meetingId, true)),
      ],
    );
    let consentCalls = 0;
    const packet = await service.getPacket(
      ORG_A,
      meetingId,
      "88888888-8888-4888-8888-888888888880",
      {
        sudDisclosureAllowed: async () => {
          consentCalls++;
          return false;
        },
      },
    );
    expect(packet.content?.signedEncounters.map((e) => e.encounterId)).toEqual(["enc-live-1"]);
    expect(packet.content?.orderChanges.map((o) => o.orderId)).toEqual(["ord-live-1"]);
    expect(packet.content?.hopeTimepoints.captured).toBe(false);
    expect(packet.appliedSudRedaction).toBe(false);
    expect(consentCalls).toBe(0);
    expect(packet.content?.disciplines.find((d) => d.discipline === "rn")?.items).toHaveLength(2);
  });

  it("W-SUD-01: a SUD-flagged packet is redacted for a caller WITHOUT the release, complete WITH it, and redacted with no viewer (fail-closed)", async () => {
    const meetingId = seeded[ORG_A].meeting;
    const denied = await service.getPacket(ORG_A, meetingId, PKT_PATIENT_SUD, {
      sudDisclosureAllowed: async () => false,
    });
    expect(denied.appliedSudRedaction).toBe(true);
    expect(denied.redactionNotice).toBe("Some content filtered per 42 CFR Part 2");
    expect(denied.content?.signedEncounters).toEqual([]);
    expect(denied.content?.orderChanges).toEqual([]);
    expect(JSON.stringify(denied)).not.toMatch(/enc-live-1|ord-live-1/);

    const allowed = await service.getPacket(ORG_A, meetingId, PKT_PATIENT_SUD, {
      sudDisclosureAllowed: async () => true,
    });
    expect(allowed.appliedSudRedaction).toBe(false);
    expect(allowed.content?.signedEncounters).toHaveLength(1);

    const noViewer = await service.getPacket(ORG_A, meetingId, PKT_PATIENT_SUD);
    expect(noViewer.appliedSudRedaction).toBe(true);
  });

  it("getPacket: an empty-jsonb stored packet is content:null (not fabricated); RLS hides org A's packet from org B", async () => {
    const seededEmpty = await service.getPacket(ORG_A, seeded[ORG_A].meeting, PATIENT);
    expect(seededEmpty.content).toBeNull();
    await expect(service.getPacket(ORG_B, seeded[ORG_A].meeting, PATIENT)).rejects.toThrow();
  });
});
