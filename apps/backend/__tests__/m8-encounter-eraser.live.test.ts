/**
 * M8 encounter eraser (§3.6, D7/D8) — the destruction path as a real `chartwarden_destruction` login, on real Postgres.
 *
 * `tombstoneEncounters` used to flip the root to `voided` and null every free-text reason column, which the root's own
 * CHECKs refuse (`encounter_voided_consistency` wants voided_at/voided_by and a 40-character voided_reason; the late-entry,
 * override and EVV-missing reasons carry their own length floors in their tier/state). The unit suite drives an in-memory store
 * that has no CHECKs, so it never saw it: on a real database `eraseEncounterRecord` rolled back and a destruction never
 * completed. This suite runs the whole erase (crypto-erase, delete subtree, tombstone) through the Drizzle store over every
 * kind of root the product can hold, and proves what survives: the shell, never the text.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m8:eraser:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { VOCAB_VERSION, activeNarrativeVocabRelease } from "@chartwarden/narrative-vocab";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENCOUNTER_ERASED_REASON,
  createDrizzleEncounterEraseStore,
  eraseEncounterRecord,
} from "../src/modules/08-encounters/erasers/encounter-eraser";
import { LIVE_APP_ROLE_PASSWORD, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SERVICE_DATE = "2026-01-15"; // `encounter_service_date_not_future` forbids the future
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** The distinctive synthetic string every seeded reason carries; it must not survive an erase. */
const MARKER = "ERASE-MARKER-7Q3X";
const KEPT_MARKER = "KEPT-MARKER-4Z8K";
const SEALED = "v1.dek-1.bm9uY2U.dGFn.U0VZTlRIRVRJQy1DSVBIRVI"; // envelope-shaped, not real ciphertext
const PIN = activeNarrativeVocabRelease(VOCAB_VERSION).id;

/** The five free-text columns the eraser must scrub, and every column it is allowed to change. */
const REASON_COLUMNS = [
  "evv_missing_reason",
  "late_entry_reason",
  "significant_late_override_reason",
  "administrative_override_reason",
  "voided_reason",
] as const;
const CHANGED_COLUMNS = [
  ...REASON_COLUMNS,
  "status",
  "voided_at",
  "voided_by",
  "vocab_version_id",
] as const;

type Row = Record<string, unknown>;

/** A synthetic reason of at least `min` characters (the CHECK floors) that carries the marker. */
const reason = (label: string, min: number, marker = MARKER): string =>
  `${label} ${marker} `.padEnd(min, ".");

const omit = (row: Row, keys: readonly string[]): Row =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return first;
}

describe.skipIf(!DB_URL)("M8 encounter eraser — LIVE Postgres, destruction role", () => {
  let admin: Client;
  let destruction: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleEncounterEraseStore>;
  let providerEntityId: string;
  let locationId: string;
  let providerEntityB: string;
  let locationB: string;
  let author: string;
  let approver: string;
  let voider: string;
  let authorB: string;

  const targetPatient = randomUUID();
  const otherPatient = randomUUID();
  const orgBPatient = randomUUID();
  /** label → encounter id, for the target patient's roots. */
  const targets = new Map<string, string>();

  async function seedMembership(orgId: string, label: string): Promise<string> {
    const user = await admin.query<{ id: string }>(
      `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
      [`${label}-${randomUUID().slice(0, 8)}@eraser.test`],
    );
    const membership = await admin.query<{ id: string }>(
      "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
      [one(user.rows).id, orgId],
    );
    return one(membership.rows).id;
  }

  async function seedSite(orgId: string, slug: string): Promise<{ pe: string; loc: string }> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [orgId, `m8-eraser-${slug}`],
    );
    const pe = await admin.query<{ id: string }>(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
      [orgId, `ER-${slug}`, `PE ${slug}`, slug === "a" ? "1500000001" : "1500000002"],
    );
    const loc = await admin.query<{ id: string }>(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,'Site one','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
      [one(pe.rows).id],
    );
    return { pe: one(pe.rows).id, loc: one(loc.rows).id };
  }

  /** Insert one encounter root as the superuser; `columns` overrides the draft defaults. */
  async function seedEncounter(
    org: "A" | "B",
    patientId: string,
    columns: Row = {},
  ): Promise<string> {
    const base: Row = {
      organization_id: org === "A" ? ORG_A : ORG_B,
      provider_entity_id: org === "A" ? providerEntityId : providerEntityB,
      location_id: org === "A" ? locationId : locationB,
      patient_id: patientId,
      admission_id: randomUUID(),
      encounter_type: "routine_visit",
      discipline: "rn",
      authored_by_membership_id: org === "A" ? author : authorB,
      service_date: SERVICE_DATE,
      status: "draft",
    };
    const merged = { ...base, ...columns };
    const names = Object.keys(merged);
    const result = await admin.query<{ id: string }>(
      `INSERT INTO encounter (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(merged),
    );
    return one(result.rows).id;
  }

  /** Every encounter row of the given patients (all tenants), as the superuser sees it. */
  async function snapshot(patientIds: readonly string[]): Promise<Row[]> {
    const result = await admin.query<{ id: string; j: Row }>(
      "SELECT id, to_jsonb(e) AS j FROM encounter e WHERE patient_id = ANY($1::uuid[]) ORDER BY id",
      [patientIds],
    );
    return result.rows.map((r) => r.j);
  }

  const outputCiphers = async (): Promise<Row[]> =>
    (
      await admin.query<Row>(
        "SELECT id, layer1_cipher, final_cipher FROM hearthnote_assembled_output ORDER BY id",
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }

    const siteA = await seedSite(ORG_A, "a");
    providerEntityId = siteA.pe;
    locationId = siteA.loc;
    const siteB = await seedSite(ORG_B, "b");
    providerEntityB = siteB.pe;
    locationB = siteB.loc;
    author = await seedMembership(ORG_A, "author");
    approver = await seedMembership(ORG_A, "approver");
    voider = await seedMembership(ORG_A, "voider");
    authorB = await seedMembership(ORG_B, "author-b");

    // One root of every kind the product can hold, for the patient to be destroyed.
    const finalized = { status: "finalized", vocab_version_id: PIN };
    targets.set("draft", await seedEncounter("A", targetPatient));
    targets.set("finalized_normal", await seedEncounter("A", targetPatient, finalized));
    targets.set(
      "late_entry",
      await seedEncounter("A", targetPatient, {
        ...finalized,
        late_entry_tier: "late_entry",
        late_entry_reason: reason("late entry", 40),
      }),
    );
    targets.set(
      "significant_late_entry",
      await seedEncounter("A", targetPatient, {
        ...finalized,
        late_entry_tier: "significant_late_entry",
        late_entry_reason: reason("significant late entry", 40),
        significant_late_override_by: approver,
        significant_late_override_reason: reason("supervisor override", 40),
      }),
    );
    targets.set(
      "administrative_override",
      await seedEncounter("A", targetPatient, {
        ...finalized,
        late_entry_tier: "administrative_override",
        late_entry_reason: reason("administrative late entry", 40),
        administrative_override_by: approver,
        administrative_override_reason: reason("administrative override", 100),
      }),
    );
    targets.set(
      "evv_missing_documented",
      await seedEncounter("A", targetPatient, {
        ...finalized,
        evv_bracket_state: "evv_missing_documented",
        evv_missing_reason: reason("no EVV bracket", 20),
      }),
    );
    // A signed note whose delivery columns the 1513 freeze trigger guards: the tombstone must not touch them.
    targets.set(
      "signed",
      await seedEncounter("A", targetPatient, {
        status: "signed",
        vocab_version_id: PIN,
        signed_at: "2026-01-15T18:00:00Z",
        started_at: "2026-01-15T14:00:00Z",
        ended_at: "2026-01-15T15:00:00Z",
        time_source: "clinician",
        visit_modality: "in_person",
        visit_modality_confirmed_at: "2026-01-15T18:00:00Z",
        visit_modality_confirmed_by: author,
      }),
    );
    // Already voided by a human, with free text that must be scrubbed too; the human's attribution stays.
    targets.set(
      "voided_by_human",
      await seedEncounter("A", targetPatient, {
        status: "voided",
        vocab_version_id: PIN,
        voided_at: "2026-01-16T09:00:00Z",
        voided_by: voider,
        voided_reason: reason("entered on the wrong chart", 40),
      }),
    );
    // A satellite under the finalized root, so the whole erase (shred, delete, tombstone) has work in every step.
    await admin.query(
      `INSERT INTO hearthnote_assembled_output (organization_id, provider_entity_id, location_id, encounter_id, kind,
       layer1_cipher, final_cipher, layer2_eligibility, assembly_template_key, vocab_version_id)
       VALUES ($1,$2,$3,$4,'primary_finalize',$5,$5,'tenant_flag_off','routine_visit:rn',$6)`,
      [ORG_A, providerEntityId, locationId, targets.get("finalized_normal"), SEALED, PIN],
    );

    // Other patients: same tenant, and another tenant. Their reasons carry a different marker that must survive.
    await seedEncounter("A", otherPatient);
    await seedEncounter("A", otherPatient, {
      ...finalized,
      late_entry_tier: "late_entry",
      late_entry_reason: reason("other patient", 40, KEPT_MARKER),
    });
    await seedEncounter("B", orgBPatient, {
      ...finalized,
      late_entry_tier: "late_entry",
      late_entry_reason: reason("other tenant", 40, KEPT_MARKER),
    });

    await admin.query(
      `ALTER ROLE chartwarden_destruction LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`,
    );
    const url = new URL(DB_URL as string);
    url.username = "chartwarden_destruction";
    url.password = LIVE_APP_ROLE_PASSWORD;
    destruction = createDbClient({ connectionString: url.toString() });
    store = createDrizzleEncounterEraseStore(destruction.db);
  }, 600_000);

  afterAll(async () => {
    await destruction?.close();
    if (admin) await admin.end();
  });

  const everyoneElse = (): readonly string[] => [otherPatient, orgBPatient];

  it("the fixture is not vacuous: five roots carry the marker, and the placeholder cannot", async () => {
    const carrying = await admin.query(
      "SELECT 1 FROM encounter e WHERE patient_id=$1 AND to_jsonb(e)::text LIKE $2",
      [targetPatient, `%${MARKER}%`],
    );
    expect(carrying.rowCount).toBe(5);
    expect(targets.size).toBe(8);
    expect(ENCOUNTER_ERASED_REASON).not.toContain(MARKER);
    // the largest CHECK floor on any reason column is the administrative override's 100 characters
    expect(ENCOUNTER_ERASED_REASON.length).toBeGreaterThanOrEqual(100);
  });

  it("another tenant's certificate erases nothing, in either direction", async () => {
    const everything = [targetPatient, ...everyoneElse()];
    const rowsBefore = await snapshot(everything);
    const ciphersBefore = await outputCiphers();

    const wrongTenant = await eraseEncounterRecord(ORG_B, targetPatient, store);
    const wrongTenantOther = await eraseEncounterRecord(ORG_A, orgBPatient, store);

    expect(wrongTenant.erased).toBe(0);
    expect(wrongTenantOther.erased).toBe(0);
    expect(await snapshot(everything)).toEqual(rowsBefore);
    expect(await outputCiphers()).toEqual(ciphersBefore);
  });

  describe("destroying the target patient", () => {
    let rowsBefore: Row[];
    let othersBefore: Row[];
    let startedAt: number;
    let result: Awaited<ReturnType<typeof eraseEncounterRecord>>;

    beforeAll(async () => {
      rowsBefore = await snapshot([targetPatient]);
      othersBefore = await snapshot(everyoneElse());
      startedAt = Date.now();
      result = await eraseEncounterRecord(ORG_A, targetPatient, store);
    });

    it("completes and reports what it removed", () => {
      expect(result.erased).toBe(1);
      expect(result.counts.hearthnoteAssembledOutputs).toBe(1);
    });

    it("leaves every root in place, voided, with its structural shell untouched", async () => {
      const after = await snapshot([targetPatient]);
      expect(after).toHaveLength(8);
      for (const row of after) expect(row.status).toBe("voided");
      const byId = new Map(rowsBefore.map((row) => [row.id, row]));
      for (const row of after) {
        expect(omit(row, CHANGED_COLUMNS)).toEqual(omit(byId.get(row.id) as Row, CHANGED_COLUMNS));
      }
    });

    it("scrubs every reason column to the one placeholder, and keeps a null column null", async () => {
      const after = await snapshot([targetPatient]);
      const byId = new Map(rowsBefore.map((row) => [row.id, row]));
      for (const row of after) {
        const was = byId.get(row.id) as Row;
        for (const column of REASON_COLUMNS) {
          // voided_reason cannot stay null on a voided root; every other column is null iff it was.
          const expected =
            column === "voided_reason" || was[column] !== null ? ENCOUNTER_ERASED_REASON : null;
          expect(row[column], `${column} of ${row.id}`).toBe(expected);
        }
      }
      const leaked = await admin.query(
        "SELECT 1 FROM encounter e WHERE patient_id=$1 AND to_jsonb(e)::text LIKE $2",
        [targetPatient, `%${MARKER}%`],
      );
      expect(leaked.rowCount).toBe(0);
    });

    it("keeps a human's void attribution, attributes the rest to the author, and pins a draft to a real corpus release", async () => {
      const after = await snapshot([targetPatient]);
      const byId = new Map(rowsBefore.map((row) => [row.id, row]));
      for (const row of after) {
        const was = byId.get(row.id) as Row;
        if (was.status === "voided") {
          expect(row.voided_at).toBe(was.voided_at);
          expect(row.voided_by).toBe(voider);
        } else {
          expect(row.voided_by).toBe(was.authored_by_membership_id);
          expect(Date.parse(row.voided_at as string)).toBeGreaterThanOrEqual(startedAt - 1000);
        }
        expect(row.vocab_version_id).toBe(was.vocab_version_id ?? PIN);
      }
      const draft = after.find((row) => row.id === targets.get("draft")) as Row;
      expect(draft.vocab_version_id).toBe(PIN);
    });

    it("deletes the satellites it owns", async () => {
      const left = await admin.query(
        "SELECT 1 FROM hearthnote_assembled_output WHERE organization_id=$1",
        [ORG_A],
      );
      expect(left.rowCount).toBe(0);
    });

    it("leaves the other patient and the other tenant exactly as they were", async () => {
      expect(await snapshot(everyoneElse())).toEqual(othersBefore);
      const kept = await admin.query(
        "SELECT 1 FROM encounter e WHERE patient_id = ANY($1::uuid[]) AND to_jsonb(e)::text LIKE $2",
        [everyoneElse(), `%${KEPT_MARKER}%`],
      );
      expect(kept.rowCount).toBe(2);
    });

    it("a second run changes nothing", async () => {
      const everything = [targetPatient, ...everyoneElse()];
      const settled = await snapshot(everything);
      const again = await eraseEncounterRecord(ORG_A, targetPatient, store);
      expect(again.erased).toBe(0);
      expect(await snapshot(everything)).toEqual(settled);
    });
  });
});
