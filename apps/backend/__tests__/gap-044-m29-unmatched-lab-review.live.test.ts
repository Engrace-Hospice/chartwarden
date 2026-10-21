/**
 * GAP-044 — the M29 §4.2 unmatched-lab review queue, LIVE Postgres.
 *
 * `POST …/attach-patient` and `POST …/discard` were permanent 501s whose message deferred to T-29.13 —
 * which is the FRONTEND task. No backend task ever owned the write paths, and the audit's "the review
 * queue has no exit" understates it: the queue had no ENTRANCE either. `planLabAttach`'s unmatched branch
 * returned an outbox descriptor and nothing else — no `lab_observation_inbound_link` row — while
 * `listUnmatchedObservations` reads exactly that table. The queue was structurally guaranteed to be empty,
 * and the OBX values a reviewer needs to identify the patient were discarded at the wire boundary.
 *
 * THE SHAPE THIS SUITE PROVES. An unmatched lab RESERVES an observation id, writes its
 * `lab_observation_value` rows under it and one link row — but no `lab_observation` parent, because
 * `patient_id` and (via ARCH-011) `provider_entity_id` are both NOT NULL and neither is known. The manual
 * bind materializes that parent under the reserved id; the discard tombstones the link and creates no
 * observation at all.
 *
 * Everything runs as the NOBYPASSRLS `chartwarden_app` role over the production Drizzle store, so a missing
 * RLS policy, a CHECK the code disagrees with, or a partition-key mismatch between parent and children
 * fails it.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m29:unmatched-lab-review:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M29_OUTBOX_EVENTS,
  createDrizzleM29Store,
} from "../src/modules/29-external-interfaces/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG = "11111111-1111-1111-1111-111111111129";
const OTHER_ORG = "11111111-1111-1111-1111-111111111130";
const PE = "00000000-0000-0000-0000-000000000a29";
const USER = "00000000-0000-0000-0000-0000000ba029";
const REVIEWER = "00000000-0000-0000-0000-0000000cb029";
const PATIENT = "00000000-0000-0000-0000-0000000ee029";
const PATIENT_NO_AGENCY = "00000000-0000-0000-0000-0000000ee030";
const FEED = "00000000-0000-0000-0000-0000000fe029";
const INGEST_AT = new Date("2026-08-02T06:30:00.000Z");

/** Reserved observation ids — no `lab_observation` row bears one until a bind. */
const OBS = (n: number) => `00000000-0000-0000-0000-0000ab0000${String(n).padStart(2, "0")}`;
const LINK = (n: number) => `00000000-0000-0000-0000-0000cd0000${String(n).padStart(2, "0")}`;
const MSG = (n: number) => `00000000-0000-0000-0000-0000ef0000${String(n).padStart(2, "0")}`;

describe.skipIf(!DB_URL)("GAP-044 M29 unmatched-lab review — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleM29Store>;
  /** The same store with the M5 reader UNBOUND — the fail-closed posture check. */
  let storeUnbound: ReturnType<typeof createDrizzleM29Store>;

  const catalog = buildBootOutboxCatalog([M29_OUTBOX_EVENTS]);

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

  /** Seed one unmatched queue item exactly as the (future) ORU worker's `planLabAttach` result would. */
  async function seedUnmatched(
    n: number,
    opts: { organizationId?: string; values?: number; matchMethod?: string } = {},
  ) {
    const orgId = opts.organizationId ?? ORG;
    await admin.query(
      `INSERT INTO hl7_message_inbound
         (id, organization_id, feed_id, message_type, message_control_id, payload_sha256,
          payload_cipher, segments_summary, sending_facility_raw_id, idempotency_key, received_at,
          match_outcome, parse_status)
       VALUES ($1,$2,$3,'ORU^R01',$4,'sha','cipher','{}'::jsonb,'QUEST',$5,$6,'no_match','parsed')`,
      [MSG(n), orgId, FEED, `mcid-${n}`, `idem-${n}`, INGEST_AT],
    );
    const count = opts.values ?? 1;
    for (let i = 1; i <= count; i++) {
      await admin.query(
        `INSERT INTO lab_observation_value
           (organization_id, observation_id, obx_set_id, loinc_code, loinc_display_text,
            terminology_validation, value_type, numeric_value, units, reference_range, abnormal_flag,
            received_at)
         VALUES ($1,$2,$3,'718-7','Hemoglobin','valid','NM',$4,'g/dL','12-16',$5,$6)`,
        [orgId, OBS(n), i, `${7 + i}.2`, i === 1 ? "LL" : "N", INGEST_AT],
      );
    }
    await admin.query(
      `INSERT INTO lab_observation_inbound_link
         (id, organization_id, observation_id, source_message_id, obr_placer_order_number,
          match_method, match_confidence, candidate_patient_id, candidate_match_level, created_at)
       VALUES ($1,$2,$3,$4,NULL,$5,0.920,$6,'L4_DEMOGRAPHIC_BRIDGE_CANDIDATE',$7)`,
      [
        LINK(n),
        orgId,
        OBS(n),
        MSG(n),
        opts.matchMethod ?? "unmatched",
        orgId === ORG ? PATIENT : null,
        INGEST_AT,
      ],
    );
  }

  const linkRow = async (n: number) =>
    (await admin.query("SELECT * FROM lab_observation_inbound_link WHERE id=$1", [LINK(n)]))
      .rows[0];
  const observationRow = async (n: number) =>
    (await admin.query("SELECT * FROM lab_observation WHERE id=$1", [OBS(n)])).rows[0];
  const events = async (eventType: string) =>
    (
      await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type=$1 ORDER BY created_at",
        [eventType],
      )
    ).rows;

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
    for (const [id, slug] of [
      [ORG, "org-a"],
      [OTHER_ORG, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m29-gap044@x.test')`, [USER]);
    // The write-audit trigger stamps `app.user_id` as the actor and audit_event FKs it to `user` — the
    // reviewer's membership id is what the store puts there, so it needs a row (GAP-079's actor-vs-
    // membership id split bites here every time).
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m29-reviewer@x.test')`, [
      REVIEWER,
    ]);
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
       VALUES ($1,$2,'PE','123456','1234567893','enc','12-31')`,
      [PE, ORG],
    );
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, status, protocol, port, proposed_by_membership_id)
       VALUES ($1,$2,'lab_inbound','Quest','active','mllp_tls',6100,$3)`,
      [FEED, ORG, USER],
    );

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The M5 PatientReader slice the bind resolves through — the composition root passes the real seam.
    const patients = {
      async findById({ organizationId, id }: { organizationId: string; id: string }) {
        if (organizationId !== ORG) return null;
        if (id === PATIENT) return { id, providerEntityId: PE };
        if (id === PATIENT_NO_AGENCY) return { id, providerEntityId: null };
        return null;
      },
    };
    const outbox = buildTxOutboxPublisher(catalog);
    const m29Outbox = {
      publish: (tx: Parameters<typeof outbox.publish>[0], input: Record<string, unknown>) =>
        outbox.publish(tx, {
          ...(input as unknown as Parameters<typeof outbox.publish>[1]),
          callerModule: "m29",
        }),
    };
    store = createDrizzleM29Store(handle.db, { outbox: m29Outbox, patients });
    storeUnbound = createDrizzleM29Store(handle.db, { outbox: m29Outbox });

    for (let n = 1; n <= 8; n++) await seedUnmatched(n, { values: n === 6 ? 2 : 1 });
    // n=9: a link row recording an AUTO-attached lab — provenance, not a queue item.
    await seedUnmatched(9, { matchMethod: "obr_placer_id" });
    // n=10: another tenant's unmatched result — the RLS check.
    await seedUnmatched(10, { organizationId: OTHER_ORG });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("the queue surfaces unresolved items WITH their result values — and never another tenant's", async () => {
    const page = await store.listUnmatchedObservations(ORG, { limit: 50 });
    const ids = page.items.map((i) => i.observationId);
    expect(ids).toContain(OBS(1));
    // An auto-attached lab's provenance row is not a review item.
    expect(ids).not.toContain(OBS(9));
    // Cross-tenant: RLS + the org predicate both exclude it.
    expect(ids).not.toContain(OBS(10));

    const item = page.items.find((i) => i.observationId === OBS(6));
    expect(item?.values).toHaveLength(2);
    expect(item?.values[0]).toMatchObject({ obxSetId: 1, loincCode: "718-7", abnormalFlag: "LL" });
    // §5.2.4's detail panel needs the actual numbers, not just a flag.
    expect(item?.values[0]?.numericValue).toBe(8.2);
  });

  it("no `lab_observation` PARENT exists for an unmatched result — the values stand alone", async () => {
    expect(await observationRow(1)).toBeUndefined();
    const values = await admin.query(
      "SELECT count(*)::int AS n FROM lab_observation_value WHERE observation_id=$1",
      [OBS(1)],
    );
    expect(values.rows[0].n).toBe(1);
  });

  it("the bind materializes the parent under the RESERVED id, co-partitioned with its values", async () => {
    const result = await store.bindUnmatchedObservation(ORG, REVIEWER, OBS(1), {
      patientId: PATIENT,
      note: "confirmed with the sending lab",
    });
    expect(result).toMatchObject({
      observationId: OBS(1),
      resolution: "manually_matched",
      patientId: PATIENT,
    });

    const obs = await observationRow(1);
    expect(obs.patient_id).toBe(PATIENT);
    expect(obs.provider_entity_id).toBe(PE);
    expect(obs.loinc_code).toBe("718-7");
    expect(obs.abnormal_summary).toBe("any_critical");
    expect(obs.source_message_id).toBe(MSG(1));
    // The parent MUST reuse its children's `received_at`: both tables are monthly-partitioned on it, and
    // stamping the bind instant would land parent and values in different partitions.
    expect(new Date(obs.received_at).toISOString()).toBe(INGEST_AT.toISOString());

    const link = await linkRow(1);
    expect(link.match_method).toBe("manual");
    expect(link.resolution).toBe("manually_matched");
    expect(link.resolved_by_membership_id).toBe(REVIEWER);
    expect(link.resolution_reason).toBe("confirmed with the sending lab");
    expect(link.candidate_patient_id).toBe(PATIENT);
  });

  it("a bound item leaves the queue and the observation is readable as an ordinary result", async () => {
    const ids = (await store.listUnmatchedObservations(ORG, { limit: 50 })).items.map(
      (i) => i.observationId,
    );
    expect(ids).not.toContain(OBS(1));

    const detail = await store.getObservation(ORG, OBS(1));
    expect(detail?.patientId).toBe(PATIENT);
    expect(detail?.values).toHaveLength(1);
  });

  it("the bind emits `manually_matched` in the SAME transaction as the write", async () => {
    const rows = await events("m29.lab_observation.manually_matched");
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(ORG);
    expect(rows[0].payload).toMatchObject({
      observationId: OBS(1),
      patientId: PATIENT,
      sourceMessageId: MSG(1),
      decidedByMembershipId: REVIEWER,
    });
  });

  it("a second bind of the same item is a 409 — decided is decided", async () => {
    await expect(
      store.bindUnmatchedObservation(ORG, REVIEWER, OBS(1), { patientId: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // And no duplicate observation was written.
    const n = await admin.query("SELECT count(*)::int AS n FROM lab_observation WHERE id=$1", [
      OBS(1),
    ]);
    expect(n.rows[0].n).toBe(1);
  });

  it("the discard tombstones the link, emits `discarded`, and creates NO observation", async () => {
    const result = await store.discardUnmatchedObservation(ORG, REVIEWER, OBS(2), {
      reason: "sending lab typo'd the MRN; belongs to another agency",
    });
    expect(result.resolution).toBe("discarded");

    const link = await linkRow(2);
    expect(link.resolution).toBe("discarded");
    expect(link.match_method).toBe("unmatched"); // never flipped to `manual`
    expect(link.resolved_by_membership_id).toBe(REVIEWER);
    // §8 — the receipt is RETAINED (180 days for unmatched-then-discarded); only the queue stops showing it.
    const values = await admin.query(
      "SELECT count(*)::int AS n FROM lab_observation_value WHERE observation_id=$1",
      [OBS(2)],
    );
    expect(values.rows[0].n).toBe(1);
    expect(await observationRow(2)).toBeUndefined();

    const rows = await events("m29.lab_observation.discarded");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.reason).toMatch(/typo/);

    const ids = (await store.listUnmatchedObservations(ORG, { limit: 50 })).items.map(
      (i) => i.observationId,
    );
    expect(ids).not.toContain(OBS(2));
  });

  it("a discarded item cannot then be bound", async () => {
    await expect(
      store.bindUnmatchedObservation(ORG, REVIEWER, OBS(2), { patientId: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a patient with no agency is refused (ARCH-011) and the item stays in the queue", async () => {
    await expect(
      store.bindUnmatchedObservation(ORG, REVIEWER, OBS(3), { patientId: PATIENT_NO_AGENCY }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await linkRow(3)).resolved_at).toBeNull();
    expect(await observationRow(3)).toBeUndefined();
  });

  it("a patient that does not resolve in this tenant is refused before any write", async () => {
    await expect(
      store.bindUnmatchedObservation(ORG, REVIEWER, OBS(4), {
        patientId: "00000000-0000-0000-0000-0000000000ff",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await linkRow(4)).resolved_at).toBeNull();
  });

  it("a sub-10-character discard reason is refused by the DOMAIN, and by the DB CHECK behind it", async () => {
    await expect(
      store.discardUnmatchedObservation(ORG, REVIEWER, OBS(5), { reason: "dupe" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await linkRow(5)).resolved_at).toBeNull();
    // Defence in depth: even a caller that bypassed the domain core cannot write a bare reason.
    await expect(
      admin.query(
        `UPDATE lab_observation_inbound_link
           SET resolution='discarded', resolved_at=now(), resolved_by_membership_id=$2, resolution_reason='dupe'
         WHERE id=$1`,
        [LINK(5), REVIEWER],
      ),
    ).rejects.toThrow(/lol_discard_reason_required/);
  });

  it("a half-written resolution is impossible — the all-or-nothing CHECK holds", async () => {
    await expect(
      admin.query(
        // `manually_matched` deliberately, not `discarded` — a bare `discarded` would trip the REASON
        // check first and prove nothing about the all-or-nothing one.
        "UPDATE lab_observation_inbound_link SET resolution='manually_matched' WHERE id=$1",
        [LINK(5)],
      ),
    ).rejects.toThrow(/lol_resolution_consistent/);
  });

  it("an auto-attached lab's provenance row is not a queue item and cannot be bound", async () => {
    await expect(
      store.bindUnmatchedObservation(ORG, REVIEWER, OBS(9), { patientId: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("another tenant's queue item is a 404 from this org, not a cross-tenant write", async () => {
    await expect(
      store.bindUnmatchedObservation(ORG, REVIEWER, OBS(10), { patientId: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await linkRow(10)).resolved_at).toBeNull();
  });

  it("with the M5 reader UNBOUND the bind degrades to 503 — it never invents an agency", async () => {
    await expect(
      storeUnbound.bindUnmatchedObservation(ORG, REVIEWER, OBS(7), { patientId: PATIENT }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect((await linkRow(7)).resolved_at).toBeNull();
    // The discard needs no patient at all, so it still works with the reader unbound.
    await storeUnbound.discardUnmatchedObservation(ORG, REVIEWER, OBS(8), {
      reason: "no matching patient in this tenant, confirmed",
    });
    expect((await linkRow(8)).resolution).toBe("discarded");
  });
});
