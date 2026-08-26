import { randomUUID } from "node:crypto";
/**
 * M8L-T02 — the Drizzle encounter WRITE lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: draft creation, vitals/mileage authoring,
 * finalize (pins the vocab version), the §2.3 sign machine (RN direct-sign, the §7.4 D1 F2F dual-write,
 * and the LPN cosignature routing), the §2.4 D3 cosignature chain (acknowledge → sign), void, and the
 * addendum aggregate (draft → finalize → sign). Like the M7 write suite (and unlike the M6 outbox slices,
 * which ran against a NOOP) it binds the REAL catalog-validating transactional publisher
 * (buildBootOutboxCatalog([M8_OUTBOX_EVENTS]) → the caller's tx) and asserts the `m8.*` rows land in
 * `outbox_event` — so the boot-catalog wiring + the LOCKED `m8.encounter.signed` payload are proven, not
 * assumed. RLS + §7.7 optimistic concurrency + §2.7 immutability-after-sign are exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m8:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInMemorySessionContextStore, createSessionContextResolver } from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import {
  type EncounterWriteOutboxPort,
  M8_OUTBOX_EVENTS,
  createDbEncounterRouteService,
} from "../src/modules/08-encounters/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id are NOT NULL but carry NO FK — literals are fine (as the RLS/read suites do). */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
/** A recent-but-past service date (the encounter_service_date_not_future CHECK forbids the future). */
const SERVICE_DATE = "2026-01-15";
// `encounter_signature.session_id` is a uuid column — session ids in this system are uuids.
const SESSION_A = "66666666-6666-6666-6666-666666666666";
/** A session id the store never seeds — `resolveStepUpState` resolves it to `null` (never fresh). */
const STALE_SESSION = "77777777-7777-7777-7777-777777777777";

/** §2.6 selection trees (#114). Real template sections + real `@wardenx/narrative-vocab` codes. */
const EMPTY_TREE = { sections: [] };
const TREE = {
  sections: [
    {
      sectionId: "assessment",
      entries: [{ code: "nv.cv.stable" }, { code: "nv.cv.edema", params: { edema_grade: "2+" } }],
    },
  ],
};
/** A deterministic stand-in for the tenant-DEK envelope: reversible, and never the plaintext. */
const FAKE_CIPHER = {
  async seal(_org: string, plaintext: string) {
    return `sealed:${Buffer.from(plaintext, "utf8").toString("base64url")}`;
  },
  async open(_org: string, envelope: string) {
    return Buffer.from(envelope.replace(/^sealed:/, ""), "base64url").toString("utf8");
  },
};

describe.skipIf(!DB_URL)("M8 encounter write lifecycle — LIVE Postgres (M8L-T02)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEncounterRouteService>;
  const membershipOf: Record<string, string> = {};
  /** The real caller signing (§3.3/D13) — `resolveSignatureProvenance` resolves SESSION_A's step-up
   *  through the SessionContextResolver seam registered in beforeAll (fresh, webauthn). */
  let ACTOR_A: { membershipId: string; sessionId: string };
  /** PARAM-004/CoP-418.104(c) follow-up — signing now writes an `encounter_signature` row, which has
   *  NOT NULL provider_entity_id/location_id. `createDraft` never sets an encounter's siting (a
   *  pre-existing gap this write-lifecycle slice doesn't backfill from the admission/visit yet — see
   *  the file header's "siting backfills... when present" note), so the test seeds real FK-valid
   *  siting and `draft()` stamps it onto every created encounter directly. */
  let SITING_A: { providerEntityId: string; locationId: string };

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped)");
      }
      await admin.query(sql);
    }
  }

  /** The `m8.*` events persisted for an aggregate, event-type only (asserts the catalog wiring). */
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  async function seedOrg(org: string, slug: string) {
    membershipOf[org] = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m8w@x.test')`, [USER]);
    await seedOrg(ORG_A, "org-a");
    await seedOrg(ORG_B, "org-b");
    const pe = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1, '01-1234', 'M8 Test PE', '1234567890', 'enc', '12-31') RETURNING id`,
      [ORG_A],
    );
    const loc = await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1, 'M8 Test Loc', '1 Main St', 'Town', 'NY', '10001', 'America/New_York') RETURNING id`,
      [pe.rows[0].id],
    );
    SITING_A = { providerEntityId: pe.rows[0].id as string, locationId: loc.rows[0].id as string };
    ACTOR_A = { membershipId: membershipOf[ORG_A], sessionId: SESSION_A };
    const sessions = createInMemorySessionContextStore([
      {
        sessionId: SESSION_A,
        userId: USER,
        membershipId: membershipOf[ORG_A],
        organizationId: ORG_A,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "webauthn",
      },
    ]);
    registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M8_OUTBOX_EVENTS]));
    const outbox: EncounterWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m8" }),
    };
    svc = createDbEncounterRouteService(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  /** Create an org-A draft with the given type/discipline; returns the created id. */
  async function draft(
    encounterType: string,
    discipline: string,
    extra: { faceToFaceEncounterId?: string } = {},
  ): Promise<string> {
    const d = await svc.createDraft(ORG_A, membershipOf[ORG_A], {
      patientId: PATIENT,
      admissionId: ADMISSION,
      encounterType: encounterType as never,
      discipline: discipline as never,
      serviceDate: SERVICE_DATE as never,
      ...extra,
    });
    await admin.query("UPDATE encounter SET provider_entity_id=$1, location_id=$2 WHERE id=$3", [
      SITING_A.providerEntityId,
      SITING_A.locationId,
      d.id,
    ]);
    return d.id;
  }

  it("createDraft persists a draft and emits m8.encounter.created", async () => {
    const d = await svc.createDraft(ORG_A, membershipOf[ORG_A], {
      patientId: PATIENT,
      admissionId: ADMISSION,
      encounterType: "routine_visit" as never,
      discipline: "rn" as never,
      serviceDate: SERVICE_DATE as never,
    });
    expect(d.status).toBe("draft");
    expect(d.version).toBe(0);
    const detail = await svc.getEncounter(ORG_A, d.id);
    expect(detail.discipline).toBe("rn");
    expect(await eventsFor(d.id)).toContain("m8.encounter.created");
  });

  it("captureVitals computes BMI, derives abnormal flags, and emits m8.vitals.captured", async () => {
    const id = await draft("routine_visit", "rn");
    const r = await svc.captureVitals(ORG_A, id, {
      bpSystolic: 150,
      bpDiastolic: 95,
      weight: "80",
      weightUnit: "kg",
      height: "180",
      heightUnit: "cm",
    });
    expect(r.bmi).toBe("24.7");
    expect(r.abnormalFlags).toContain("bp_systolic");
    expect(await eventsFor(r.vitalsId)).toContain("m8.vitals.captured");
    // An out-of-envelope reading is a precise 422 (defence-in-depth before the DB CHECK).
    await expect(svc.captureVitals(ORG_A, id, { spo2: 20 })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("captureMileage stores the authoritative miles (D10) and emits m8.mileage.captured", async () => {
    const id = await draft("routine_visit", "rn");
    const r = await svc.captureMileage(ORG_A, id, {
      odometerStart: 1000,
      odometerEnd: 1012,
      source: "odometer",
    });
    expect(r.milesDriven).toBe("12");
    expect(await eventsFor(r.mileageId)).toContain("m8.mileage.captured");
  });

  it("finalize → sign (RN, no cosign) → signed; emits finalized + the LOCKED m8.encounter.signed", async () => {
    const id = await draft("routine_visit", "rn");
    const fin = await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    expect(fin.status).toBe("finalized");
    expect(fin.version).toBe(1);
    const [row] = (await admin.query("SELECT vocab_version_id FROM encounter WHERE id=$1", [id]))
      .rows;
    expect(row.vocab_version_id).not.toBeNull(); // D11 pinned at finalize
    const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
    expect(signed.cosignatureRequestId).toBeNull();
    const events = await eventsFor(id);
    expect(events).toContain("m8.encounter.finalized");
    expect(events).toContain("m8.encounter.signed");
  });

  it("sign requires a fresh step-up (D13) — a stale step-up is 412", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await expect(
      svc.sign(
        ORG_A,
        id,
        { membershipId: membershipOf[ORG_A], sessionId: STALE_SESSION },
        { at: SERVICE_DATE as never },
      ),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  it("LPN sign routes to cosign_pending; acknowledge → cosign signs the encounter (§2.4/§7.2)", async () => {
    const id = await draft("routine_visit", "lpn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    const signed = await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("cosign_pending");
    expect(signed.cosignatureRequestId).not.toBeNull();
    expect(await eventsFor(id)).toContain("m8.encounter.signed");
    const cr = signed.cosignatureRequestId as string;
    expect(await eventsFor(cr)).toContain("m8.encounter.cosignature_routed");
    // The cosignature queue surfaces it; the RN acknowledges then cosigns.
    const queue = await svc.cosignatureQueue(ORG_A);
    expect(queue.encounters.some((e) => e.id === id)).toBe(true);
    const ack = await svc.cosignAcknowledge(ORG_A, id, SERVICE_DATE as never);
    expect(ack.status).toBe("acknowledged");
    const done = await svc.cosignSign(ORG_A, id, ACTOR_A, {
      isQualifiedRn: true,
      at: SERVICE_DATE as never,
    });
    expect(done.status).toBe("cosigned");
    expect(done.cosignedAt).toBeTruthy();
    expect(await eventsFor(id)).toContain("m8.encounter.cosigned");
  });

  it("§7.4 D1 — an F2F encounter signs as one atomic unit (no cosign); a missing M6 id is 412", async () => {
    // Without the M6 face_to_face_encounter_id the dual-write guard fires (F2F_DUAL_WRITE_REQUIRED → 412).
    const bare = await draft("face_to_face", "md");
    await svc.finalize(ORG_A, bare, SERVICE_DATE as never);
    await expect(
      svc.sign(ORG_A, bare, ACTOR_A, { at: SERVICE_DATE as never }),
    ).rejects.toMatchObject({ statusCode: 412 });
    // With it present, the sign completes as `signed` (MD/NP never route to cosignature).
    const f2f = await draft("face_to_face", "md", { faceToFaceEncounterId: randomUUID() });
    await svc.finalize(ORG_A, f2f, SERVICE_DATE as never);
    const signed = await svc.sign(ORG_A, f2f, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
    expect(await eventsFor(f2f)).toContain("m8.encounter.signed");
  });

  it("void from draft is a terminal admin action; emits m8.encounter.voided", async () => {
    const id = await draft("routine_visit", "rn");
    const reason = "documented void reason meeting the 40-character minimum length rule";
    const v = await svc.voidEncounter(ORG_A, id, {
      isAdmin: true,
      reason,
      at: SERVICE_DATE as never,
    });
    expect(v.status).toBe("voided");
    expect(await eventsFor(id)).toContain("m8.encounter.voided");
    // A non-admin void is refused (403) before any write.
    const id2 = await draft("routine_visit", "rn");
    await expect(
      svc.voidEncounter(ORG_A, id2, { isAdmin: false, reason, at: SERVICE_DATE as never }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("addendum on a signed encounter: draft → finalize → sign; emits m8.encounter.addendum_signed", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    const a = await svc.createAddendum(ORG_A, id);
    expect(a.status).toBe("draft");
    const addendumNote = await svc.updateAddendumSelections(ORG_A, id, a.id, TREE);
    expect(addendumNote.layer1Preview).toContain("cardiovascularly stable");
    // The addendum's note is its OWN hearthnote_selection row, keyed by addendum_id (#114).
    const addendumRows = await admin.query(
      "SELECT template_key FROM hearthnote_selection WHERE addendum_id=$1",
      [a.id],
    );
    expect(addendumRows.rowCount).toBe(1);
    expect(addendumRows.rows[0].template_key).toBe("routine_visit:rn");
    const fin = await svc.finalizeAddendum(ORG_A, id, a.id);
    expect(fin.status).toBe("finalized");
    const signed = await svc.signAddendum(ORG_A, id, a.id, ACTOR_A, { at: SERVICE_DATE as never });
    expect(signed.status).toBe("signed");
    expect(await eventsFor(id)).toContain("m8.encounter.addendum_signed");
  });

  it("§7.7 optimistic concurrency — a stale updateSelections is 412, a fresh one bumps the version", async () => {
    const id = await draft("routine_visit", "rn");
    await expect(svc.updateSelections(ORG_A, id, 99, EMPTY_TREE)).rejects.toMatchObject({
      statusCode: 412,
    });
    const bumped = await svc.updateSelections(ORG_A, id, 0, EMPTY_TREE);
    expect(bumped.version).toBe(1);
  });

  it("§2.7 immutability — editing a signed encounter is refused (IMMUTABLE_AFTER_SIGN → 409)", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    await expect(svc.captureVitals(ORG_A, id, { heartRate: 72 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  // #92 — the vitals read-back, against real rows under the NOBYPASSRLS `wardenx_app` role. The pure
  // suite proves the projection over in-memory Maps; only this proves the SELECT returns the columns
  // the write actually persisted, that `captured_at` orders them, and that RLS scopes them by tenant.
  it("#92 listVitals round-trips the persisted measurements, newest capture first", async () => {
    const id = await draft("routine_visit", "rn");
    const first = await svc.captureVitals(ORG_A, id, {
      heartRate: 60,
      temperature: "37.1",
      temperatureUnit: "c",
    });
    // A distinct `captured_at` — the ordering claim is about the real clock, not an id tiebreak.
    await new Promise((r) => setTimeout(r, 25));
    const second = await svc.captureVitals(ORG_A, id, {
      bpSystolic: 150,
      bpDiastolic: 95,
      spo2: 97,
      painScore: 4,
      painScale: "nrs_0_10",
      weight: "80",
      weightUnit: "kg",
      height: "180",
      heightUnit: "cm",
      bloodGlucose: 110,
      bloodGlucoseUnit: "mg_dl",
    });

    const read = await svc.listVitals(ORG_A, id);
    expect(read.encounterId).toBe(id);
    expect(read.vitals.map((v) => v.id)).toEqual([second.vitalsId, first.vitalsId]);

    const [newest, oldest] = read.vitals;
    if (!newest || !oldest) throw new Error("expected two vitals sets");
    expect(newest.bpSystolic).toBe(150);
    expect(newest.bpDiastolic).toBe(95);
    expect(newest.spo2).toBe(97);
    expect(newest.painScore).toBe(4);
    expect(newest.painScale).toBe("nrs_0_10");
    expect(newest.weight).toBe("80");
    expect(newest.height).toBe("180");
    expect(newest.bloodGlucose).toBe(110);
    expect(newest.bloodGlucoseUnit).toBe("mg_dl");
    // Stored BMI comes back as stored; flags re-derive to the same answer the write returned.
    expect(newest.bmi).toBe(second.bmi);
    expect(newest.abnormalFlags).toEqual(second.abnormalFlags);
    // A measurement nobody took reads as null on a row that exists — not as a missing key.
    expect(oldest.heartRate).toBe(60);
    expect(oldest.temperature).toBe("37.1");
    expect(oldest.spo2).toBeNull();
    expect(oldest.bmi).toBeNull();
  });

  it("#92 listVitals survives the encounter being signed (the record stays retrievable)", async () => {
    const id = await draft("routine_visit", "rn");
    const written = await svc.captureVitals(ORG_A, id, { heartRate: 72 });
    await svc.finalize(ORG_A, id, SERVICE_DATE as never);
    await svc.sign(ORG_A, id, ACTOR_A, { at: SERVICE_DATE as never });
    // Writing is refused after signing (§2.7); READING must not be — 42 CFR 418.104 requires the
    // signed record be retrievable, and it is the signed state the record exists in.
    const read = await svc.listVitals(ORG_A, id);
    expect(read.vitals.map((v) => v.id)).toEqual([written.vitalsId]);
    expect(read.vitals[0]?.heartRate).toBe(72);
  });

  it("#92 RLS — org B cannot read org A's vitals, and gets a non-leaking 404 not an empty list", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.captureVitals(ORG_A, id, { heartRate: 72 });
    await expect(svc.listVitals(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── §2.6 HearthNote selections (#114) ─────────────────────────────────────────────────────────────
  //
  // The two selections PATCHes published a required body, parsed none of it, bumped `version` and
  // returned 200. Nothing had ever written a `hearthnote_selection` row — the only code that touched the
  // three hearthnote tables was the ERASER. These cases drive the real Drizzle path as the NOBYPASSRLS
  // role and read the row back out of Postgres.

  it("§2.6 — the tree is PERSISTED to hearthnote_selection and reads back assembled", async () => {
    const id = await draft("routine_visit", "rn");
    const written = await svc.updateSelections(ORG_A, id, 0, TREE);
    expect(written.version).toBe(1);
    expect(written.layer1Preview).toContain("2+ dependent edema");

    // The row exists. Asserted against the TABLE, not the service, because "nothing writes this table"
    // is the finding — a service that returns the right shape from memory would satisfy a weaker test.
    const rows = await admin.query(
      "SELECT template_key, template_version, selections, free_text_cipher, provider_entity_id FROM hearthnote_selection WHERE encounter_id=$1",
      [id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].template_key).toBe("routine_visit:rn");
    expect(rows.rows[0].selections.sections).toHaveLength(1);
    // No cipher is bound in this suite, so the tree carries no free text and the column stays NULL —
    // never plaintext prose in a column named `_cipher`.
    expect(rows.rows[0].free_text_cipher).toBeNull();

    const read = await svc.getSelections(ORG_A, id);
    expect(read.sections).toEqual(TREE.sections);
    expect(read.layer1Preview).toBe(written.layer1Preview);
  });

  it("§2.6 — a second PATCH UPDATES the one row rather than adding a second (mig 0225)", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.updateSelections(ORG_A, id, 0, TREE);
    await svc.updateSelections(ORG_A, id, 1, {
      sections: [{ sectionId: "assessment", entries: [{ code: "nv.neuro.alert" }] }],
    });
    const rows = await admin.query(
      "SELECT version, selections FROM hearthnote_selection WHERE encounter_id=$1",
      [id],
    );
    // Before 0225 the "unique" indexes were plain indexes, so this would have been two rows and every
    // reader afterwards would have had to guess which one was the note.
    expect(rows.rowCount).toBe(1);
    expect(Number(rows.rows[0].version)).toBe(1);
    const read = await svc.getSelections(ORG_A, id);
    expect(read.sections[0]?.entries[0]?.code).toBe("nv.neuro.alert");
  });

  it("§3.6 — free text is REFUSED with no cipher bound, and nothing is written", async () => {
    const id = await draft("routine_visit", "rn");
    await expect(
      svc.updateSelections(ORG_A, id, 0, {
        sections: [{ sectionId: "plan", entries: [], freeText: "Family to call overnight." }],
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "HEARTHNOTE_CIPHER_UNBOUND" });
    const rows = await admin.query("SELECT 1 FROM hearthnote_selection WHERE encounter_id=$1", [
      id,
    ]);
    expect(rows.rowCount).toBe(0);
    // The refusal is a refusal, not a partial write: the encounter's own version did not move either.
    expect((await svc.getEncounter(ORG_A, id)).version).toBe(0);
  });

  it("§3.6 — with a cipher bound, the prose round-trips and is NEVER stored in the clear", async () => {
    const cipherSvc = createDbEncounterRouteService(handle.db, undefined, FAKE_CIPHER);
    const id = await draft("routine_visit", "rn");
    const prose = "Family to call if pain escalates overnight.";
    const written = await cipherSvc.updateSelections(ORG_A, id, 0, {
      sections: [{ sectionId: "plan", entries: [], freeText: prose }],
    });
    expect(written.layer1Preview).toContain(prose);

    const rows = await admin.query(
      "SELECT selections, free_text_cipher FROM hearthnote_selection WHERE encounter_id=$1",
      [id],
    );
    expect(rows.rows[0].free_text_cipher).not.toBeNull();
    expect(rows.rows[0].free_text_cipher).not.toContain(prose);
    // And it is not hiding in the structured column either — the split is the §3.6 minimization rule.
    expect(JSON.stringify(rows.rows[0].selections)).not.toContain(prose);

    const read = await cipherSvc.getSelections(ORG_A, id);
    expect(read.sections[0]?.freeText).toBe(prose);
  });

  it("the M22 render seam 404s with no note, and serves the assembled one after a PATCH", async () => {
    const id = await draft("routine_visit", "rn");
    // Was a 200 with `final: ""` — an empty note reported as a successful render.
    await expect(svc.renderPayload(ORG_A, id)).rejects.toMatchObject({ statusCode: 404 });
    await svc.updateSelections(ORG_A, id, 0, TREE);
    const rendered = await svc.renderPayload(ORG_A, id);
    expect(rendered.final).toContain("Assessment");
    expect(rendered.final).toContain("cardiovascularly stable");
  });

  it("RLS — org B cannot read or write org A's hearthnote_selection (non-leaking 404)", async () => {
    const id = await draft("routine_visit", "rn");
    await svc.updateSelections(ORG_A, id, 0, TREE);
    await expect(svc.getSelections(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.updateSelections(ORG_B, id, 1, TREE)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.renderPayload(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
    // Org A's note is untouched by org B's attempt.
    expect((await svc.getSelections(ORG_A, id)).sections).toEqual(TREE.sections);
  });

  it("RLS — org B cannot read or write org A's encounter (non-leaking 404)", async () => {
    const id = await draft("routine_visit", "rn");
    await expect(svc.getEncounter(ORG_B, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.finalize(ORG_B, id, SERVICE_DATE as never)).rejects.toMatchObject({
      statusCode: 404,
    });
    const { encounters } = await svc.listEncounters(ORG_B);
    expect(encounters.every((e) => e.id !== id)).toBe(true);
  });
});
