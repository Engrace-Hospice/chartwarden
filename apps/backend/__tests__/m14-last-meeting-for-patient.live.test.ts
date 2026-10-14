/**
 * M14 `lastMeetingForPatient` / `getLastMeetingForPatient` (WP 3.1) — the Drizzle query proven against real
 * Postgres as the NOBYPASSRLS `wardenx_app` role. Rows are seeded as superuser through the real tables.
 *
 * "Last meeting" = status 'adjourned' AND real actual_start AND a FROZEN packet row for the patient. Each
 * decoy below fails exactly ONE of those conditions, so dropping any single filter surfaces a decoy that is
 * later than the expected row (negative control by construction). Cross-tenant: both orgs hold the SAME
 * patient id and org B's meeting is the latest overall, so an RLS leak returns org B's meeting for org A. This
 * proves RLS; the query's explicit organization_id predicate is a second wall that RLS masks here, so it is
 * not proven separately by this suite.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m14-last-meeting-for-patient.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdgScheduleProvider } from "../src/modules/14-idg/seams/providers";
import { createDrizzleIdgSeamStore } from "../src/modules/14-idg/seams/drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
/** Same patient id in both tenants: only the org walls keep their rows apart. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const OTHER_PATIENT = "99999999-9999-9999-9999-999999999999";
const NEVER_REVIEWED = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type OrgSeed = { providerEntity: string; location: string; policy: string };

describe.skipIf(!DB_URL)("M14 lastMeetingForPatient — LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleIdgSeamStore>;
  const orgs: Record<string, OrgSeed> = {};
  const ids: Record<string, string> = {};

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

  async function seedOrg(org: string, n: number): Promise<OrgSeed> {
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-LM${n}`, `LM ${n}`, `NPI-LM${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-LM${n}`],
      )
    ).rows[0].id as string;
    const policy = (
      await admin.query(
        `INSERT INTO idg_recurring_policy (organization_id, location_id, day_of_week_anchor,
           default_coordinator_membership_id) VALUES ($1,$2,'monday',$3) RETURNING id`,
        [org, location, MEMBERSHIP],
      )
    ).rows[0].id as string;
    return { providerEntity, location, policy };
  }

  /** One meeting plus (optionally) one packet for `patient`; `frozen` stamps frozen_at. Returns the meeting id. */
  async function meeting(
    org: string,
    o: {
      status: string;
      actualStart: string | null;
      packet?: { patient: string; frozen: boolean };
    },
  ): Promise<string> {
    const s = orgs[org];
    const id = (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, recurring_policy_id, scheduled_start,
           scheduled_end, actual_start, status, coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2,$3, now(), now() + interval '2 hours', $4, $5, $6, '{}'::jsonb) RETURNING id`,
        [org, s.location, s.policy, o.actualStart, o.status, MEMBERSHIP],
      )
    ).rows[0].id as string;
    if (o.packet) {
      await admin.query(
        `INSERT INTO idg_patient_packet (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, admission_id, since_cursor_iso, built_snapshot, discipline_views,
           cover_summary_layer1, frozen_at)
         VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01T00:00:00Z','{}'::jsonb,'{}'::jsonb,'summary',
           ${o.packet.frozen ? "now()" : "NULL"})`,
        [org, s.providerEntity, s.location, id, o.packet.patient, ADMISSION],
      );
    }
    return id;
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
    orgs[ORG_A] = await seedOrg(ORG_A, 1);
    orgs[ORG_B] = await seedOrg(ORG_B, 2);
    const frozen = { patient: PATIENT, frozen: true };
    // Org A. Expected winner: `older` (2026-03) is beaten by `latest` (2026-05); every decoy is LATER.
    ids.older = await meeting(ORG_A, {
      status: "adjourned",
      actualStart: "2026-03-01T10:00:00Z",
      packet: frozen,
    });
    ids.latest = await meeting(ORG_A, {
      status: "adjourned",
      actualStart: "2026-05-01T10:00:00Z",
      packet: frozen,
    });
    ids.live = await meeting(ORG_A, {
      status: "live",
      actualStart: "2026-09-01T10:00:00Z",
      packet: frozen,
    });
    ids.scheduled = await meeting(ORG_A, {
      status: "scheduled",
      actualStart: "2026-09-02T10:00:00Z",
      packet: frozen,
    });
    ids.cancelled = await meeting(ORG_A, {
      status: "cancelled",
      actualStart: "2026-09-03T10:00:00Z",
      packet: frozen,
    });
    ids.noStart = await meeting(ORG_A, { status: "adjourned", actualStart: null, packet: frozen });
    ids.unfrozen = await meeting(ORG_A, {
      status: "adjourned",
      actualStart: "2026-09-05T10:00:00Z",
      packet: { patient: PATIENT, frozen: false },
    });
    ids.otherPatient = await meeting(ORG_A, {
      status: "adjourned",
      actualStart: "2026-09-06T10:00:00Z",
      packet: { patient: OTHER_PATIENT, frozen: true },
    });
    // Adjourned + started but no packet at all for anyone.
    ids.noPacket = await meeting(ORG_A, {
      status: "adjourned",
      actualStart: "2026-09-07T10:00:00Z",
    });
    // Org B: same patient id, the latest meeting overall (2026-12) — must never reach org A.
    ids.orgB = await meeting(ORG_B, {
      status: "adjourned",
      actualStart: "2026-12-01T10:00:00Z",
      packet: frozen,
    });
    // Org B patient with data only in B.
    ids.orgBOnly = await meeting(ORG_B, {
      status: "adjourned",
      actualStart: "2026-11-01T10:00:00Z",
      packet: { patient: NEVER_REVIEWED, frozen: true },
    });

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDrizzleIdgSeamStore(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("returns the latest adjourned meeting with a real actual_start and a frozen packet, ignoring every decoy", async () => {
    const last = await store.lastMeetingForPatient(ORG_A, PATIENT);
    expect(last).toEqual({
      meetingId: ids.latest,
      heldAt: new Date("2026-05-01T10:00:00Z").toISOString(),
      status: "adjourned",
    });
  });

  it("picks the latest actual_start among several qualifying meetings (not insertion order)", async () => {
    const last = await store.lastMeetingForPatient(ORG_A, PATIENT);
    expect(last?.meetingId).not.toBe(ids.older);
  });

  it("scopes by patient: the other patient's later frozen packet resolves to its own meeting", async () => {
    const last = await store.lastMeetingForPatient(ORG_A, OTHER_PATIENT);
    expect(last?.meetingId).toBe(ids.otherPatient);
  });

  it("returns null when the patient was never reviewed (and for a patient whose only data is in another tenant)", async () => {
    expect(
      await store.lastMeetingForPatient(ORG_A, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    ).toBeNull();
    expect(await store.lastMeetingForPatient(ORG_A, NEVER_REVIEWED)).toBeNull();
  });

  it("cross-tenant: org B gets its own meeting for the shared patient id, never org A's, and vice versa", async () => {
    expect((await store.lastMeetingForPatient(ORG_B, PATIENT))?.meetingId).toBe(ids.orgB);
    expect((await store.lastMeetingForPatient(ORG_A, PATIENT))?.meetingId).toBe(ids.latest);
    expect((await store.lastMeetingForPatient(ORG_B, NEVER_REVIEWED))?.meetingId).toBe(
      ids.orgBOnly,
    );
    expect(await store.lastMeetingForPatient(ORG_B, OTHER_PATIENT)).toBeNull();
  });

  it("returns null when every candidate fails a filter (only decoys exist)", async () => {
    await admin.query(
      "UPDATE idg_patient_packet SET frozen_at = NULL WHERE idg_meeting_id = ANY($1)",
      [[ids.older, ids.latest]],
    );
    try {
      // Remaining adjourned+started meetings for PATIENT are unfrozen / unstarted / non-adjourned.
      expect(await store.lastMeetingForPatient(ORG_A, PATIENT)).toBeNull();
    } finally {
      await admin.query(
        "UPDATE idg_patient_packet SET frozen_at = now() WHERE idg_meeting_id = ANY($1)",
        [[ids.older, ids.latest]],
      );
    }
  });

  it("getLastMeetingForPatient adds a valid ISO asOf and passes null through", async () => {
    const provider = createIdgScheduleProvider(store);
    const before = Date.now();
    const got = await provider.getLastMeetingForPatient(ORG_A, PATIENT as never);
    expect(got?.meetingId).toBe(ids.latest);
    const asOf = got?.asOf as string;
    expect(new Date(asOf).toISOString()).toBe(asOf);
    expect(Date.parse(asOf)).toBeGreaterThanOrEqual(before);
    expect(
      await provider.getLastMeetingForPatient(
        ORG_A,
        "cccccccc-cccc-cccc-cccc-cccccccccccc" as never,
      ),
    ).toBeNull();
  });

  it("linkSummary: found meeting yields exactly four keys, null patientId, status, scheduled_start", async () => {
    const provider = createIdgScheduleProvider(store);
    const got = await provider.linkSummary(ORG_A, ids.latest);
    expect(got).not.toBeNull();
    expect(Object.keys(got ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
    expect(got?.id).toBe(ids.latest);
    expect(got?.patientId).toBeNull();
    expect(got?.status).toBe("adjourned");
    const { rows } = await admin.query("SELECT scheduled_start FROM idg_meeting WHERE id = $1", [
      ids.latest,
    ]);
    expect(got?.occurredAt).toBe((rows[0].scheduled_start as Date).toISOString());
  });

  it("linkSummary: unknown id is null; a cross-tenant meeting id is null both ways", async () => {
    const provider = createIdgScheduleProvider(store);
    expect(await provider.linkSummary(ORG_A, "dddddddd-dddd-dddd-dddd-dddddddddddd")).toBeNull();
    expect(await provider.linkSummary(ORG_A, ids.orgB)).toBeNull();
    expect(await provider.linkSummary(ORG_B, ids.latest)).toBeNull();
    expect((await provider.linkSummary(ORG_B, ids.orgB))?.id).toBe(ids.orgB);
  });

  it("meetingLocation: returns the meeting's location in its own org only", async () => {
    const provider = createIdgScheduleProvider(store);
    expect(await provider.meetingLocation(ORG_A, ids.latest)).toBe(orgs[ORG_A].location);
    expect(await provider.meetingLocation(ORG_B, ids.orgB)).toBe(orgs[ORG_B].location);
    expect(await provider.meetingLocation(ORG_A, ids.orgB)).toBeNull();
    expect(
      await provider.meetingLocation(ORG_A, "dddddddd-dddd-dddd-dddd-dddddddddddd"),
    ).toBeNull();
  });
});
