/**
 * M8 encounter eraser (§3.6, D7/D8) — the destruction path as a real `chartwarden_destruction` login, on real Postgres.
 *
 * `tombstoneEncounters` used to flip the root to `voided` and null every free-text reason column, which the root's own
 * CHECKs refuse (`encounter_voided_consistency` wants voided_at/voided_by and a 40-character voided_reason; the late-entry,
 * override and EVV-missing reasons carry their own length floors in their tier/state). The unit suite drives an in-memory store
 * that has no CHECKs, so it never saw it: on a real database `eraseEncounterRecord` rolled back and a destruction never
 * completed. This suite runs the whole erase (shred, tombstone, delete) through the Drizzle store over every
 * kind of root the product can hold, and proves what survives: the shell, never the text. The signed, cosign_pending and cosigned roots
 * each carry a Layer-2-involved and a Layer-2-off output. Migrations 1521/1525 freeze a signed note's ciphers: only the shred sentinel the
 * destruction role writes ("" for layer1/final and for a Layer-2-involved layer2, NULL for a Layer-2-off layer2) may pass.
 *
 * The four ADR-0114 visit-note tables (draft confirmations, sealed signed sections incl. amendment rows, amendments, addendum cosignature
 * requests; migrations 1517/1518/1523) are seeded for every party in the order their guards allow (a section or confirmation is written
 * while the note is still `finalized`, amendments while the addendum is a draft) and the full per-table count object is compared. The
 * destruction role's DELETE grants, org-scoped policies and the absence of a BEFORE DELETE trigger on them are asserted from the catalog.
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
  type EncounterEraseCounts,
  createDrizzleEncounterEraseStore,
  eraseEncounterRecord,
} from "../src/modules/08-encounters/erasers/encounter-eraser";
import { LIVE_APP_ROLE_PASSWORD, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SERVICE_DATE = "2026-01-15";
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** The distinctive synthetic string every seeded reason carries; it must not survive an erase. */
const MARKER = "ERASE-MARKER-7Q3X";
const KEPT_MARKER = "KEPT-MARKER-4Z8K";
const SEALED = "v1.dek-1.bm9uY2U.dGFn.U0VZTlRIRVRJQy1DSVBIRVI"; // envelope-shaped, not real ciphertext
const PIN = activeNarrativeVocabRelease(VOCAB_VERSION).id;
/** A sealed section's / confirmation's SHA-256 shape (64 lowercase hex): what their CHECKs require; the value is synthetic. */
const CONTENT_HASH = "ab".repeat(32);
/** `source_refs` carries ids only, never text. */
const SOURCE_REFS = (): string => JSON.stringify([{ kind: "vitals", id: randomUUID() }]);

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

/**
 * Every table the eraser deletes from, keyed as the eraser reports its counts; each is reached from the patient through `encounter`.
 * `satisfies` makes a count key the eraser gains and this suite does not seed a type error, not a silent gap.
 */
const OWNED_TABLES = {
  signatures: "encounter_signature",
  addenda: "encounter_addendum",
  carePlanLinks: "encounter_care_plan_link",
  cosignatureRequests: "cosignature_request",
  vitals: "vitals",
  mileage: "mileage",
  hearthnoteSelections: "hearthnote_selection",
  hearthnoteAssembledOutputs: "hearthnote_assembled_output",
  hearthnoteLlmModifications: "hearthnote_llm_modification",
  draftConfirmations: "encounter_draft_confirmation",
  signedSections: "hearthnote_signed_section",
  amendments: "encounter_amendment",
  addendumCosignatureRequests: "addendum_cosignature_request",
} as const satisfies Record<keyof EncounterEraseCounts, string>;
type OwnedKey = keyof typeof OWNED_TABLES;
const OWNED_KEYS = Object.keys(OWNED_TABLES) as OwnedKey[];
/** The ADR-0114 tables (1517/1518/1523), whose destruction-role grants, policies and delete path this suite proves from the catalog. */
const VISIT_NOTE_KEYS = [
  "draftConfirmations",
  "signedSections",
  "amendments",
  "addendumCosignatureRequests",
] as const satisfies readonly OwnedKey[];

/**
 * What `seedSatellites` plants per root: one of each, plus a second selection (addendum-scoped) and two more outputs (addendum-scoped,
 * Layer-2-involved); two draft confirmations; four sealed sections (two originals under the primary pin, two amendment rows under the
 * addendum's own output); the two sections the addendum names; one cosignature request of the amending addendum.
 */
const PER_ROOT: Record<OwnedKey, number> = {
  signatures: 1,
  addenda: 1,
  carePlanLinks: 1,
  cosignatureRequests: 1,
  vitals: 1,
  mileage: 1,
  hearthnoteSelections: 2,
  hearthnoteAssembledOutputs: 3,
  hearthnoteLlmModifications: 1,
  draftConfirmations: 2,
  signedSections: 4,
  amendments: 2,
  addendumCosignatureRequests: 1,
};

/**
 * Roots seeded `signed`, `cosign_pending` and `cosigned`, each with SIGNED_OUTPUTS_PER_ROOT outputs: one Layer-2-involved, one
 * Layer-2-off. A signed note's ciphers are frozen by the database (migration 1521); only the destruction role's shred sentinel gets through.
 * Each output carries one sealed section and the root one draft confirmation, written while the note was still `finalized` (1525).
 */
const SIGNED_STATUSES = ["signed", "cosign_pending", "cosigned"] as const;
const SIGNED_OUTPUTS_PER_ROOT = 2;
const SIGNED_SECTIONS_PER_ROOT = SIGNED_OUTPUTS_PER_ROOT;
const SIGNED_CONFIRMATIONS_PER_ROOT = 1;
/** What one party (the target, the other patient, the other tenant) holds: its `seedSatellites` rows plus `signedRoots` signed roots' rows. */
const countsWithSignedRoots = (signedRoots: number): Record<OwnedKey, number> => ({
  ...PER_ROOT,
  hearthnoteAssembledOutputs:
    PER_ROOT.hearthnoteAssembledOutputs + signedRoots * SIGNED_OUTPUTS_PER_ROOT,
  signedSections: PER_ROOT.signedSections + signedRoots * SIGNED_SECTIONS_PER_ROOT,
  draftConfirmations: PER_ROOT.draftConfirmations + signedRoots * SIGNED_CONFIRMATIONS_PER_ROOT,
});
/** The target holds all three signed roots; the other patient and the other tenant hold one each. */
const TARGET_COUNTS = countsWithSignedRoots(SIGNED_STATUSES.length);
const OTHER_COUNTS = countsWithSignedRoots(1);
const TARGET_TOTAL = Object.values(TARGET_COUNTS).reduce((a, b) => a + b, 0);

// $1 is always the uuid[] of patient ids. HearthNote rows hang off an encounter OR one of its addenda; modifications off an output.
const ENCOUNTERS_OF = "SELECT id FROM encounter WHERE patient_id = ANY($1::uuid[])";
const ADDENDA_OF = `SELECT id FROM encounter_addendum WHERE encounter_id IN (${ENCOUNTERS_OF})`;
const HEARTHNOTE_SCOPE = `encounter_id IN (${ENCOUNTERS_OF}) OR addendum_id IN (${ADDENDA_OF})`;
const OWNED_SCOPE: Record<OwnedKey, string> = {
  signatures: `encounter_id IN (${ENCOUNTERS_OF})`,
  addenda: `encounter_id IN (${ENCOUNTERS_OF})`,
  carePlanLinks: `encounter_id IN (${ENCOUNTERS_OF})`,
  cosignatureRequests: `encounter_id IN (${ENCOUNTERS_OF})`,
  vitals: `encounter_id IN (${ENCOUNTERS_OF})`,
  mileage: `encounter_id IN (${ENCOUNTERS_OF})`,
  hearthnoteSelections: HEARTHNOTE_SCOPE,
  hearthnoteAssembledOutputs: HEARTHNOTE_SCOPE,
  hearthnoteLlmModifications: `assembled_output_id IN (SELECT id FROM hearthnote_assembled_output WHERE ${HEARTHNOTE_SCOPE})`,
  draftConfirmations: `encounter_id IN (${ENCOUNTERS_OF})`,
  signedSections: `encounter_id IN (${ENCOUNTERS_OF})`,
  amendments: `encounter_id IN (${ENCOUNTERS_OF})`,
  addendumCosignatureRequests: `encounter_id IN (${ENCOUNTERS_OF})`,
};

const countsOf = (rows: Record<OwnedKey, Row[]>): Record<OwnedKey, number> =>
  Object.fromEntries(OWNED_KEYS.map((key) => [key, rows[key].length])) as Record<OwnedKey, number>;

const NO_ROWS = Object.fromEntries(OWNED_KEYS.map((key) => [key, 0])) as Record<OwnedKey, number>;

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

  /** Every row of every owned table that belongs to the given patients (all tenants), whole, as the superuser sees it. */
  async function ownedRows(patientIds: readonly string[]): Promise<Record<OwnedKey, Row[]>> {
    const rows = {} as Record<OwnedKey, Row[]>;
    for (const key of OWNED_KEYS) {
      const result = await admin.query<{ j: Row }>(
        `SELECT to_jsonb(t) AS j FROM ${OWNED_TABLES[key]} t WHERE ${OWNED_SCOPE[key]} ORDER BY t.id`,
        [patientIds],
      );
      rows[key] = result.rows.map((r) => r.j);
    }
    return rows;
  }

  /** Rows in an owned table across every patient and tenant, with no scoping. */
  const tableTotal = async (key: OwnedKey): Promise<number> =>
    one(
      (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${OWNED_TABLES[key]}`))
        .rows,
    ).n;

  const siteOf = (org: "A" | "B"): string[] =>
    org === "A" ? [ORG_A, providerEntityId, locationId] : [ORG_B, providerEntityB, locationB];

  const insertId = async (sqlText: string, values: readonly unknown[]): Promise<string> =>
    one((await admin.query<{ id: string }>(sqlText, [...values])).rows).id;

  /** One assembled output (envelope-shaped ciphers; a Layer-2-involved one also carries a `layer2_cipher`), seeded as the superuser. */
  const seedOutput = (
    org: "A" | "B",
    parentEncounter: string | null,
    parentAddendum: string | null,
    kind: "primary_finalize" | "addendum_finalize",
    layer2: boolean,
  ): Promise<string> =>
    insertId(
      `INSERT INTO hearthnote_assembled_output (organization_id, provider_entity_id, location_id, encounter_id, addendum_id, kind,
         layer1_cipher, layer2_cipher, final_cipher, layer2_eligibility, layer2_involved_at_finalize, assembly_template_key, vocab_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,'routine_visit:rn',$11) RETURNING id`,
      [
        ...siteOf(org),
        parentEncounter,
        parentAddendum,
        kind,
        SEALED,
        layer2 ? SEALED : null,
        layer2 ? "eligible" : "tenant_flag_off",
        layer2,
        PIN,
      ],
    );

  /**
   * A draft confirmation (1517). Its guard refuses an insert once the encounter is signed / cosign_pending / cosigned / voided, so a caller
   * seeds it while the root is draft or finalized. The hash is 64 hex characters, the only shape the CHECK allows.
   */
  const seedConfirmation = (
    org: "A" | "B",
    encounterId: string,
    sectionId: string,
    resolution: "confirmed" | "deselected",
  ): Promise<string> =>
    insertId(
      `INSERT INTO encounter_draft_confirmation (organization_id, provider_entity_id, location_id, encounter_id, section_id, resolution,
         content_hash, corpus_version, edited, part2_derived, source_refs, resolved_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'synthetic-corpus-1',false,false,$8::jsonb,$9) RETURNING id`,
      [
        ...siteOf(org),
        encounterId,
        sectionId,
        resolution,
        CONTENT_HASH,
        SOURCE_REFS(),
        org === "A" ? author : authorB,
      ],
    );

  /**
   * A sealed section row (1518/1523). An ORIGINAL (no `amends`) is written while its encounter is still `finalized` (1525) under the
   * encounter's own output; an AMENDMENT names a finalized addendum, that addendum's own output, and the original it amends (same section
   * id and position).
   */
  const seedSignedSection = (
    org: "A" | "B",
    encounterId: string,
    outputId: string,
    sectionId: string,
    position: number,
    amends?: { addendumId: string; originalId: string },
  ): Promise<string> =>
    insertId(
      `INSERT INTO hearthnote_signed_section (organization_id, provider_entity_id, location_id, encounter_id, assembled_output_id,
         section_id, position, text_cipher, content_hash, part2_derived, source_refs, addendum_id, amends_section_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10::jsonb,$11,$12) RETURNING id`,
      [
        ...siteOf(org),
        encounterId,
        outputId,
        sectionId,
        position,
        SEALED,
        CONTENT_HASH,
        SOURCE_REFS(),
        amends?.addendumId ?? null,
        amends?.originalId ?? null,
      ],
    );

  /**
   * A root that ends `status` (signed, cosign_pending or cosigned) holding one Layer-2-involved and one Layer-2-off output, each with a
   * sealed section, and one draft confirmation. All of it is written while the note is still `finalized` and the status flips after, the order
   * sign itself uses: migration 1525 refuses a new pin, sealed section or confirmation under a signed encounter, and the shred is what has to
   * cope with the frozen ciphers afterwards.
   */
  async function seedSignedRootWithOutputs(
    org: "A" | "B",
    patientId: string,
    status: (typeof SIGNED_STATUSES)[number],
  ): Promise<string> {
    const confirmer = org === "A" ? author : authorB;
    // A signed note whose delivery columns the 1513 freeze trigger guards: the tombstone must not touch them.
    const encounterId = await seedEncounter(org, patientId, {
      status: "finalized",
      vocab_version_id: PIN,
      signed_at: "2026-01-15T18:00:00Z",
      started_at: "2026-01-15T14:00:00Z",
      ended_at: "2026-01-15T15:00:00Z",
      time_source: "clinician",
      visit_modality: "in_person",
      visit_modality_confirmed_at: "2026-01-15T18:00:00Z",
      visit_modality_confirmed_by: confirmer,
    });
    const involvedOutput = await seedOutput(org, encounterId, null, "primary_finalize", true);
    const offOutput = await seedOutput(org, encounterId, null, "primary_finalize", false);
    await seedSignedSection(org, encounterId, involvedOutput, "subjective", 0);
    await seedSignedSection(org, encounterId, offOutput, "subjective", 0);
    await seedConfirmation(org, encounterId, "subjective", "confirmed");
    await admin.query("UPDATE encounter SET status = $2 WHERE id = $1", [encounterId, status]);
    // A cosigned note carries its cosignature time; the tombstone must leave it as it found it.
    if (status === "cosigned")
      await admin.query("UPDATE encounter SET cosigned_at = $2 WHERE id = $1", [
        encounterId,
        "2026-01-16T18:00:00Z",
      ]);
    return encounterId;
  }

  /** The assembled outputs pinned under one encounter root, whole. */
  async function outputsUnder(encounterId: string): Promise<Row[]> {
    const result = await admin.query<{ j: Row }>(
      "SELECT to_jsonb(o) AS j FROM hearthnote_assembled_output o WHERE o.encounter_id = $1 ORDER BY o.id",
      [encounterId],
    );
    return result.rows.map((r) => r.j);
  }

  /**
   * One row in every table the eraser deletes from, under `encounterId` and one addendum of it, seeded as the superuser
   * (the destruction role holds SELECT/UPDATE/DELETE on these tables and no INSERT). The ciphers are envelope-shaped
   * stand-ins; the Layer-2-involved output carries a `layer2_cipher`, so the shred must not null it.
   */
  async function seedSatellites(org: "A" | "B", encounterId: string): Promise<void> {
    const site = siteOf(org);
    const member = org === "A" ? author : authorB;

    const addendumId = await insertId(
      `INSERT INTO encounter_addendum (organization_id, provider_entity_id, location_id, encounter_id, authored_by_membership_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [...site, encounterId, member, "Synthetic addendum reason for the eraser suite."],
    );
    await admin.query(
      `INSERT INTO encounter_signature (organization_id, provider_entity_id, location_id, encounter_id, kind, signed_by_membership_id,
         signed_by_discipline, method, session_id, step_up_auth_at, attestation_text, layer2_involved_at_signing)
       VALUES ($1,$2,$3,$4,'primary',$5,'rn','passkey',$6,now(),$7,false)`,
      [
        ...site,
        encounterId,
        member,
        randomUUID(),
        "Synthetic attestation text for the eraser suite fixture row.",
      ],
    );
    await admin.query(
      `INSERT INTO encounter_care_plan_link (organization_id, provider_entity_id, location_id, encounter_id, problem_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [...site, encounterId, randomUUID()],
    );
    await admin.query(
      `INSERT INTO cosignature_request (organization_id, provider_entity_id, location_id, encounter_id, routed_to_membership_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [...site, encounterId, member],
    );
    await admin.query(
      `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at, heart_rate)
       VALUES ($1,$2,$3,$4,now(),72)`,
      [...site, encounterId],
    );
    await admin.query(
      `INSERT INTO mileage (organization_id, provider_entity_id, location_id, encounter_id, miles_driven, miles_driven_source)
       VALUES ($1,$2,$3,$4,'12.5','route')`,
      [...site, encounterId],
    );
    // HearthNote selections: one under the encounter, one under the addendum (its encounter_id is null: the XOR CHECK).
    for (const [parentEncounter, parentAddendum] of [
      [encounterId, null],
      [null, addendumId],
    ]) {
      await admin.query(
        `INSERT INTO hearthnote_selection (organization_id, provider_entity_id, location_id, encounter_id, addendum_id,
           template_key, template_version, free_text_cipher)
         VALUES ($1,$2,$3,$4,$5,'routine_visit:rn','1',$6)`,
        [...site, parentEncounter, parentAddendum, SEALED],
      );
    }
    // Assembled outputs: Layer 2 off under the encounter, Layer 2 off under the addendum, Layer 2 INVOLVED under the encounter.
    const primaryOutput = await seedOutput(org, encounterId, null, "primary_finalize", false);
    const addendumOutput = await seedOutput(org, null, addendumId, "addendum_finalize", false);
    const layer2Output = await seedOutput(org, encounterId, null, "primary_finalize", true);
    await admin.query(
      `INSERT INTO hearthnote_llm_modification (organization_id, provider_entity_id, location_id, assembled_output_id, prompt_template_key,
         prompt_template_version, model_id, tokens_input, tokens_output, latency_ms, diff_json, called_by_membership_id)
       VALUES ($1,$2,$3,$4,'layer2_polish','1','synthetic-model',10,12,30,'{}'::jsonb,$5)`,
      [...site, layer2Output, member],
    );

    // ADR-0114, in the order the guards allow. The root is `finalized`, so its draft confirmations and its original sealed sections
    // (written by sign, before the status flips) may still be inserted.
    await seedConfirmation(org, encounterId, "subjective", "confirmed");
    await seedConfirmation(org, encounterId, "plan", "deselected");
    const originals = {
      subjective: await seedSignedSection(org, encounterId, primaryOutput, "subjective", 0),
      plan: await seedSignedSection(org, encounterId, primaryOutput, "plan", 1),
    };
    // VN-D30 amendments: the sections an addendum names are inserted while it is a draft; the amendment's sealed rows need it `finalized` and
    // its own output; the author's resolution is written before it is signed (a signed addendum freezes its amendments).
    for (const sectionId of ["subjective", "plan"]) {
      await admin.query(
        `INSERT INTO encounter_amendment (organization_id, provider_entity_id, location_id, encounter_id, addendum_id, section_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [...site, encounterId, addendumId, sectionId],
      );
    }
    await admin.query("UPDATE encounter_addendum SET status = 'finalized' WHERE id = $1", [
      addendumId,
    ]);
    for (const [sectionId, position] of [
      ["subjective", 0],
      ["plan", 1],
    ] as const) {
      await seedSignedSection(org, encounterId, addendumOutput, sectionId, position, {
        addendumId,
        originalId: originals[sectionId],
      });
      await admin.query(
        `UPDATE encounter_amendment SET resolution = $3, content_hash = $4, corpus_version = 'synthetic-corpus-1', edited = false,
           part2_derived = false, resolved_by_membership_id = $5, resolved_at = now() WHERE addendum_id = $1 AND section_id = $2`,
        [
          addendumId,
          sectionId,
          sectionId === "subjective" ? "confirmed" : "deselected",
          CONTENT_HASH,
          member,
        ],
      );
    }
    await admin.query(
      `INSERT INTO addendum_cosignature_request (organization_id, provider_entity_id, location_id, encounter_id, addendum_id, routed_to_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [...site, encounterId, addendumId, member],
    );
    await admin.query(
      "UPDATE encounter_addendum SET status = 'signed', signed_at = now() WHERE id = $1",
      [addendumId],
    );
  }

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
    // Signed, cosign_pending and cosigned notes, each with a Layer-2-involved and a Layer-2-off output (their ciphers are frozen).
    for (const status of SIGNED_STATUSES) {
      targets.set(status, await seedSignedRootWithOutputs("A", targetPatient, status));
    }
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
    // Satellites under the finalized root: one row in every table the eraser deletes from, so every step has work.
    await seedSatellites("A", targets.get("finalized_normal") as string);

    // Other patients: same tenant, and another tenant. Their reasons carry a different marker that must survive,
    // and each root holds the same satellite set, which must survive the target's erase untouched.
    await seedEncounter("A", otherPatient);
    const otherRoot = await seedEncounter("A", otherPatient, {
      ...finalized,
      late_entry_tier: "late_entry",
      late_entry_reason: reason("other patient", 40, KEPT_MARKER),
    });
    const orgBRoot = await seedEncounter("B", orgBPatient, {
      ...finalized,
      late_entry_tier: "late_entry",
      late_entry_reason: reason("other tenant", 40, KEPT_MARKER),
    });
    await seedSatellites("A", otherRoot);
    await seedSatellites("B", orgBRoot);
    await seedSignedRootWithOutputs("A", otherPatient, "signed");
    await seedSignedRootWithOutputs("B", orgBPatient, "signed");

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
    expect(targets.size).toBe(10);
    expect(ENCOUNTER_ERASED_REASON).not.toContain(MARKER);
    // the largest CHECK floor on any reason column is the administrative override's 100 characters
    expect(ENCOUNTER_ERASED_REASON.length).toBeGreaterThanOrEqual(100);
  });

  it("the fixture holds rows in every owned table for every patient, so no delete can pass unseen", async () => {
    const everything = await ownedRows([targetPatient, ...everyoneElse()]);
    for (const key of OWNED_KEYS) {
      // the target's rows plus the other patient's and the other tenant's, each seeded by seedSatellites and the signed roots.
      const expected = TARGET_COUNTS[key] + 2 * OTHER_COUNTS[key];
      expect(everything[key], `${key} reached from every patient`).toHaveLength(expected);
      // The scoped query sees every row the table holds: nothing sits outside the three patients.
      expect(await tableTotal(key), `${key} total`).toBe(expected);
    }
    expect(countsOf(await ownedRows([targetPatient]))).toEqual(TARGET_COUNTS);
    expect(countsOf(await ownedRows([otherPatient]))).toEqual(OTHER_COUNTS);
    expect(countsOf(await ownedRows([orgBPatient]))).toEqual(OTHER_COUNTS);
    // The rows the shred must not null: Layer-2-involved outputs with their layer2_cipher (the finalized root's, and one per signed root).
    const involved = (await ownedRows([targetPatient])).hearthnoteAssembledOutputs.filter(
      (row) => row.layer2_involved_at_finalize === true,
    );
    expect(involved).toHaveLength(1 + SIGNED_STATUSES.length);
    for (const row of involved) expect(row.layer2_cipher).toBe(SEALED);
  });

  it("each signed root carries a Layer-2-involved and a Layer-2-off output, sealed, under a frozen status", async () => {
    for (const status of SIGNED_STATUSES) {
      const encounterId = targets.get(status) as string;
      const root = await admin.query<{ status: string }>(
        "SELECT status::text AS status FROM encounter WHERE id = $1",
        [encounterId],
      );
      expect(one(root.rows).status).toBe(status);
      const outputs = await outputsUnder(encounterId);
      expect(outputs, `${status} outputs`).toHaveLength(SIGNED_OUTPUTS_PER_ROOT);
      const involved = one(outputs.filter((row) => row.layer2_involved_at_finalize === true));
      const off = one(outputs.filter((row) => row.layer2_involved_at_finalize === false));
      expect([involved.layer1_cipher, involved.layer2_cipher, involved.final_cipher]).toEqual([
        SEALED,
        SEALED,
        SEALED,
      ]);
      expect([off.layer1_cipher, off.layer2_cipher, off.final_cipher]).toEqual([
        SEALED,
        null,
        SEALED,
      ]);
    }
  });

  it("the eraser connection is the destruction login, and holds DELETE plus an org-scoped policy on each visit-note table", async () => {
    // The connection the store runs on: a non-superuser, RLS-bound member of chartwarden_destruction.
    const who = await destruction.pool.query<{
      u: string;
      su: boolean;
      bypass: boolean;
      member: boolean;
    }>(
      `SELECT current_user AS u, r.rolsuper AS su, r.rolbypassrls AS bypass,
              pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER') AS member
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(one(who.rows)).toEqual({
      u: "chartwarden_destruction",
      su: false,
      bypass: false,
      member: true,
    });
    for (const key of VISIT_NOTE_KEYS) {
      const table = OWNED_TABLES[key];
      const grants = await admin.query<{ sel: boolean; del: boolean; ins: boolean; upd: boolean }>(
        `SELECT has_table_privilege('chartwarden_destruction', $1::text, 'SELECT') AS sel,
                has_table_privilege('chartwarden_destruction', $1::text, 'DELETE') AS del,
                has_table_privilege('chartwarden_destruction', $1::text, 'INSERT') AS ins,
                has_table_privilege('chartwarden_destruction', $1::text, 'UPDATE') AS upd
           FROM (SELECT 1) one`,
        [table],
      );
      // SELECT (for `returning`) and DELETE, and nothing it does not need: no INSERT, and no table-wide UPDATE.
      expect(one(grants.rows), `${table} grants`).toEqual({
        sel: true,
        del: true,
        ins: false,
        upd: false,
      });
      const rls = await admin.query<{ on: boolean; forced: boolean }>(
        "SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass",
        [table],
      );
      expect(one(rls.rows), `${table} RLS`).toEqual({ on: true, forced: true });
      // One FOR ALL policy naming the destruction role, pinned to the canonical org GUC (a certificate never reaches across tenants).
      const policies = await admin.query<{ cmd: string; qual: string }>(
        "SELECT cmd, qual FROM pg_policies WHERE tablename = $1 AND 'chartwarden_destruction' = ANY(roles)",
        [table],
      );
      const policy = one(policies.rows);
      expect(policy.cmd, `${table} policy command`).toBe("ALL");
      expect(policy.qual, `${table} policy predicate`).toContain("app.org_id");
      // No row trigger that could refuse a DELETE: the only DELETE trigger is the AFTER audit one (BEFORE bit 2, DELETE bit 8).
      const before = await admin.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 2) <> 0 AND (tgtype & 8) <> 0`,
        [table],
      );
      expect(before.rows, `${table} BEFORE DELETE triggers`).toEqual([]);
    }
    // The sealed sections are append-only for everyone but the shred: the destruction role may write `text_cipher` and no other column.
    const writable = await admin.query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_attribute a
        WHERE a.attrelid = 'hearthnote_signed_section'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('chartwarden_destruction', a.attrelid, a.attnum, 'UPDATE')`,
    );
    expect(writable.rows.map((r) => r.column_name)).toEqual(["text_cipher"]);
  });

  it("another tenant's certificate erases nothing, in either direction", async () => {
    const everything = [targetPatient, ...everyoneElse()];
    const rowsBefore = await snapshot(everything);
    const ownedBefore = await ownedRows(everything);

    const wrongTenant = await eraseEncounterRecord(ORG_B, targetPatient, store);
    const wrongTenantOther = await eraseEncounterRecord(ORG_A, orgBPatient, store);

    expect(wrongTenant.erased).toBe(0);
    expect(wrongTenantOther.erased).toBe(0);
    expect(await snapshot(everything)).toEqual(rowsBefore);
    // whole rows in every owned table, ciphers included: nothing was shredded or deleted.
    expect(await ownedRows(everything)).toEqual(ownedBefore);
  });

  it("the shred blanks the target's ciphertext (under signed notes too), keeps the Layer 2 CHECK satisfied, and leaves everyone else's sealed", async () => {
    const othersBefore = await ownedRows(everyoneElse());

    // Before the fix this threw 23514 (hearthnote_output_layer2_consistency): a Layer-2-involved output may not have a NULL layer2_cipher.
    await store.cryptoEraseHearthnote(ORG_A, targetPatient);

    const target = await ownedRows([targetPatient]);
    expect(target.hearthnoteAssembledOutputs).toHaveLength(
      TARGET_COUNTS.hearthnoteAssembledOutputs,
    );
    for (const output of target.hearthnoteAssembledOutputs) {
      expect(output.layer1_cipher).toBe("");
      expect(output.final_cipher).toBe("");
      // the shredded value of a Layer-2-involved output is "" (the CHECK wants it non-null); every other output stays null
      expect(output.layer2_cipher).toBe(output.layer2_involved_at_finalize ? "" : null);
    }
    expect(target.hearthnoteSelections).toHaveLength(PER_ROOT.hearthnoteSelections);
    for (const selection of target.hearthnoteSelections)
      expect(selection.free_text_cipher).toBeNull();
    // ADR-0114: every sealed section (originals and amendment rows, under signed notes too) shreds to the NOT NULL sentinel "".
    expect(target.signedSections).toHaveLength(TARGET_COUNTS.signedSections);
    for (const section of target.signedSections) expect(section.text_cipher).toBe("");
    expect(JSON.stringify(target)).not.toContain(SEALED);
    // the shred deletes nothing, and touches no other patient or tenant
    expect(countsOf(target)).toEqual(TARGET_COUNTS);
    expect(await ownedRows(everyoneElse())).toEqual(othersBefore);

    // Under a signed, cosign_pending and cosigned note a database carrying migrations 1521/1525 freezes the ciphers and lets only the
    // destruction role's sentinel through: "" for layer1/final, NULL or "" for layer2. The roots are still in that status here, so on such
    // a database the guard was in force; on this branch alone the same assertions prove the shred does not depend on the status.
    for (const status of SIGNED_STATUSES) {
      const encounterId = targets.get(status) as string;
      const root = await admin.query<{ status: string }>(
        "SELECT status::text AS status FROM encounter WHERE id = $1",
        [encounterId],
      );
      expect(one(root.rows).status).toBe(status);
      const outputs = await outputsUnder(encounterId);
      expect(outputs, `${status} outputs`).toHaveLength(SIGNED_OUTPUTS_PER_ROOT);
      const involved = one(outputs.filter((row) => row.layer2_involved_at_finalize === true));
      const off = one(outputs.filter((row) => row.layer2_involved_at_finalize === false));
      // Layer 2 involved: "" in all three (the CHECK keeps layer2_cipher non-null); Layer 2 off: layer2_cipher stays NULL
      expect([involved.layer1_cipher, involved.layer2_cipher, involved.final_cipher]).toEqual([
        "",
        "",
        "",
      ]);
      expect([off.layer1_cipher, off.layer2_cipher, off.final_cipher]).toEqual(["", null, ""]);
      expect(JSON.stringify(outputs), `${status} ciphertext`).not.toContain(SEALED);
    }
  });

  describe("destroying the target patient", () => {
    let rowsBefore: Row[];
    let othersBefore: Row[];
    let ownedBefore: Record<OwnedKey, Row[]>;
    let othersOwnedBefore: Record<OwnedKey, Row[]>;
    let startedAt: number;
    let result: Awaited<ReturnType<typeof eraseEncounterRecord>>;

    beforeAll(async () => {
      rowsBefore = await snapshot([targetPatient]);
      othersBefore = await snapshot(everyoneElse());
      ownedBefore = await ownedRows([targetPatient]);
      othersOwnedBefore = await ownedRows(everyoneElse());
      // The database's clock, not the host's: `voided_at` is stamped by `now()` in the destruction transaction.
      startedAt = Number(
        (
          await admin.query<{ ms: string }>(
            "SELECT extract(epoch FROM clock_timestamp()) * 1000 AS ms",
          )
        ).rows[0]?.ms,
      );
      result = await eraseEncounterRecord(ORG_A, targetPatient, store);
    });

    it("completes and reports what it removed, table by table", () => {
      expect(countsOf(ownedBefore)).toEqual(TARGET_COUNTS);
      // the whole count object: a table the eraser reports but this suite does not seed, or the reverse, fails here
      expect(result.counts).toEqual(TARGET_COUNTS);
      expect(result.erased).toBe(TARGET_TOTAL);
    });

    it("leaves every root in place, voided, with its structural shell untouched", async () => {
      const after = await snapshot([targetPatient]);
      expect(after).toHaveLength(10);
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
          expect(Date.parse(row.voided_at as string)).toBeGreaterThanOrEqual(startedAt);
        }
        expect(row.vocab_version_id).toBe(was.vocab_version_id ?? PIN);
      }
      const draft = after.find((row) => row.id === targets.get("draft")) as Row;
      expect(draft.vocab_version_id).toBe(PIN);
    });

    it("deletes every satellite the patient owns, in every table", async () => {
      expect(countsOf(await ownedRows([targetPatient]))).toEqual(NO_ROWS);
      // and removed exactly those rows: each table now holds only the other patient's and the other tenant's
      for (const key of OWNED_KEYS) {
        expect(await tableTotal(key), `${key} total`).toBe(2 * OTHER_COUNTS[key]);
      }
    });

    it("leaves the other patient and the other tenant exactly as they were, satellites included", async () => {
      expect(await ownedRows(everyoneElse())).toEqual(othersOwnedBefore);
      expect(countsOf(await ownedRows(everyoneElse()))).toEqual(
        Object.fromEntries(OWNED_KEYS.map((key) => [key, 2 * OTHER_COUNTS[key]])),
      );
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
      const settledOwned = await ownedRows(everything);
      const again = await eraseEncounterRecord(ORG_A, targetPatient, store);
      expect(again.erased).toBe(0);
      expect(again.counts).toEqual(NO_ROWS);
      expect(await snapshot(everything)).toEqual(settled);
      expect(await ownedRows(everything)).toEqual(settledOwned);
    });
  });
});
