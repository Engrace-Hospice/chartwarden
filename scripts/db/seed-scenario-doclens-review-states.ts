/**
 * ChartWarden — one DocLens intake batch per V3.2 review state (local dev only). NOT for production.
 *
 * `seed-scenario-doclens.ts` seeds ONE patient (`DOCLENS-DEMO-0001`) with one clean batch, so the unified review's
 * exception tasks and safeguards (ADR-0115, V3.2 spec) have nothing to show. This adds five more patients, each with the
 * batch that produces one state, so the review queue and the patient census both have real rows:
 *
 *   0002 Ferrin, Walter  → CONFLICT: two pages of one packet disagree on the home phone and the street address.
 *   0003 Quill, Imogen   → WRONG PATIENT: page 2 was resolved `other_patient`; its observations are excluded from the facts.
 *   0004 Raines, Colm    → IDENTITY UNRESOLVED: the date of birth on the page does not match the chart, nobody has resolved it.
 *   0005 Teague, Odalys  → PART 2: the batch is `sud_status = detected`; the reviewer has no need-to-know, so values are withheld.
 *   0006 Vandermeer, Lorna  → VISION / CONFIDENCE: a vision disagreement, a low-confidence value, and a high-risk medication.
 *
 * Rows only, in the shape the DocLens pipeline must write (values and the vision note ONLY as DEK ciphertext, written through
 * the same M34 key provider the API uses). No source image exists for these documents, so the source panel shows its
 * "unavailable" state. All names, dates of birth and values are invented.
 *
 * Local dev only: refuses a non-local database or NODE_ENV (`assertLocalDevSeed`) and is NOT in `db:seed:all`, which production's
 * reseed workflow expands and runs.
 *
 * Idempotent: removes this script's own batches (the five MRNs above) and re-creates them; never touches
 * `DOCLENS-DEMO-0001`, the reviewer, or any other patient.
 *
 * Prereqs: `db:seed`, `db:seed:org-structure` and `db:seed:scenario-doclens` (it creates the reviewer these batches belong
 * to). Env as for `db:seed:scenario-doclens`: DATABASE_ADMIN_URL, DATABASE_PLATFORM_URL, M34_TENANT_KEK.
 * Run:     bun run db:seed:scenario-doclens-review-states
 */
import { randomBytes } from "node:crypto";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import {
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../../apps/backend/src/bootstrap/tenant-kek";
import { createCandidateValueCipher } from "../../apps/backend/src/modules/22-documents/extraction/candidate-value-cipher";
import {
  getTenantKeyProvider,
  registerLiveM34Seams,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/index";
import { assertLocalDevSeed } from "./lib/local-seed-guard";
import { firstRow } from "./lib/query-rows";

const ORG_SLUG = "chartwarden-demo";
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001"; // db:seed:org-structure
const REVIEWER_EMAIL = "doclens.reviewer@chartwarden.local"; // db:seed:scenario-doclens
const TITLE_PREFIX = "DocLens review-state";
const LOW_CONFIDENCE = 0.52;
const NORMAL_CONFIDENCE = 0.94;

type Risk = "low" | "medium" | "high";

interface CandidateSpec {
  readonly fieldPath: string;
  readonly value: string;
  readonly risk?: Risk;
  readonly confidence?: number;
  readonly sud?: boolean;
  /** A vision-check disagreement note; the candidate is then not vision-verified. */
  readonly visionNote?: string;
}

interface PageSpec {
  readonly range: readonly [number, number];
  readonly identity: "match" | "mismatch";
  readonly disagreeing?: readonly string[];
  /** Resolved by the reviewer as a page of ANOTHER patient. */
  readonly otherPatient?: boolean;
  readonly candidates: readonly CandidateSpec[];
}

interface ScenarioSpec {
  readonly mrn: string;
  readonly first: string;
  readonly last: string;
  readonly dob: string;
  readonly sex: "F" | "M";
  readonly state: string;
  readonly batchIdentity: "match" | "mismatch";
  readonly sudDetected?: boolean;
  readonly pages: readonly PageSpec[];
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    mrn: "DOCLENS-DEMO-0002",
    first: "Walter",
    last: "Ferrin",
    dob: "1941-09-03",
    sex: "M",
    state: "conflicting sources",
    batchIdentity: "match",
    pages: [
      {
        range: [1, 2],
        identity: "match",
        candidates: [
          { fieldPath: "patient.phoneHome", value: "(541) 555-0111" },
          { fieldPath: "patient.address.line1", value: "7 Alder Court" },
          { fieldPath: "patient.address.city", value: "Bend" },
          { fieldPath: "patient.preferredName", value: "Walt" },
        ],
      },
      {
        range: [3, 4],
        identity: "match",
        candidates: [
          { fieldPath: "patient.phoneHome", value: "(541) 555-0112" },
          { fieldPath: "patient.address.line1", value: "71 Alder Court" },
          { fieldPath: "patient.address.city", value: "Bend" },
          { fieldPath: "patient.preferredName", value: "Walt" },
        ],
      },
    ],
  },
  {
    mrn: "DOCLENS-DEMO-0003",
    first: "Imogen",
    last: "Quill",
    dob: "1944-02-17",
    sex: "F",
    state: "wrong-patient page",
    batchIdentity: "match",
    pages: [
      {
        range: [1, 2],
        identity: "match",
        candidates: [
          { fieldPath: "patient.phoneHome", value: "(971) 555-0131" },
          { fieldPath: "patient.address.city", value: "Gresham" },
        ],
      },
      {
        range: [3, 3],
        identity: "mismatch",
        disagreeing: ["dateOfBirth", "firstName"],
        otherPatient: true,
        candidates: [
          { fieldPath: "patient.phoneHome", value: "(971) 555-0199" },
          { fieldPath: "medications[0].name", value: "Lisinopril 10 mg", risk: "high" },
        ],
      },
    ],
  },
  {
    mrn: "DOCLENS-DEMO-0004",
    first: "Colm",
    last: "Raines",
    dob: "1936-12-30",
    sex: "M",
    state: "identity unresolved",
    batchIdentity: "mismatch",
    pages: [
      {
        range: [1, 2],
        identity: "mismatch",
        disagreeing: ["dateOfBirth"],
        candidates: [
          { fieldPath: "patient.phoneHome", value: "(503) 555-0144" },
          { fieldPath: "patient.address.city", value: "Hillsboro" },
        ],
      },
    ],
  },
  {
    mrn: "DOCLENS-DEMO-0005",
    first: "Odalys",
    last: "Teague",
    dob: "1949-07-21",
    sex: "F",
    state: "Part 2 withheld",
    batchIdentity: "match",
    sudDetected: true,
    pages: [
      {
        range: [1, 3],
        identity: "match",
        candidates: [
          { fieldPath: "patient.phoneHome", value: "(503) 555-0155" },
          { fieldPath: "patient.phoneMobile", value: "503-555-0166", sud: true },
          {
            fieldPath: "medications[0].name",
            value: "Buprenorphine 8 mg",
            risk: "high",
            sud: true,
          },
          { fieldPath: "patient.address.city", value: "Portland", sud: true },
        ],
      },
    ],
  },
  {
    mrn: "DOCLENS-DEMO-0006",
    first: "Lorna",
    last: "Vandermeer",
    dob: "1940-05-08",
    sex: "F",
    state: "vision disagreement and low confidence",
    batchIdentity: "match",
    pages: [
      {
        range: [1, 2],
        identity: "match",
        candidates: [
          {
            fieldPath: "patient.address.line1",
            value: "310 Larch Way",
            visionNote: "The image reads 318 Larch Way.",
          },
          { fieldPath: "patient.phoneHome", value: "(541) 555-0177", confidence: LOW_CONFIDENCE },
          { fieldPath: "medications[0].name", value: "Furosemide 40 mg", risk: "high" },
        ],
      },
    ],
  },
];

type Cipher = ReturnType<typeof createCandidateValueCipher>;

export async function removePrior(db: Client, orgId: string): Promise<void> {
  const mrns = SCENARIOS.map((s) => s.mrn);
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica"); // bypass append-only triggers for cleanup
  const batches = (
    await db.query<{ id: string }>(
      `SELECT b.id FROM intake_upload_batch b JOIN patient p ON p.id = b.patient_id
         WHERE p.organization_id = $1 AND p.mrn = ANY($2)`,
      [orgId, mrns],
    )
  ).rows.map((r) => r.id);
  if (batches.length) {
    const pagesOf = "SELECT id FROM classified_page WHERE intake_upload_batch_id = ANY($1)";
    const jobsOf = `SELECT id FROM extraction_job WHERE classified_page_id IN (${pagesOf})`;
    const reviewsOf = "SELECT id FROM extraction_review WHERE intake_upload_batch_id = ANY($1)";
    await db.query(
      `DELETE FROM extraction_provenance WHERE extraction_decision_id IN
         (SELECT id FROM extraction_decision WHERE extraction_review_id IN (${reviewsOf}))`,
      [batches],
    );
    await db.query(`DELETE FROM extraction_decision WHERE extraction_review_id IN (${reviewsOf})`, [
      batches,
    ]);
    await db.query("DELETE FROM extraction_review WHERE intake_upload_batch_id = ANY($1)", [
      batches,
    ]);
    await db.query(`DELETE FROM extraction_candidate WHERE extraction_job_id IN (${jobsOf})`, [
      batches,
    ]);
    await db.query(`DELETE FROM extraction_job WHERE id IN (${jobsOf})`, [batches]);
    await db.query(`DELETE FROM classified_page WHERE id IN (${pagesOf})`, [batches]);
    await db.query("DELETE FROM intake_upload_batch WHERE id = ANY($1)", [batches]);
  }
  await db.query("DELETE FROM document WHERE organization_id = $1 AND title LIKE $2", [
    orgId,
    `${TITLE_PREFIX}%`,
  ]);
  await db.query("COMMIT");
}

async function ensurePatient(db: Client, orgId: string, s: ScenarioSpec): Promise<string> {
  const existing = (
    await db.query<{ id: string }>(
      "SELECT id FROM patient WHERE organization_id = $1 AND mrn = $2",
      [orgId, s.mrn],
    )
  ).rows[0];
  if (existing) return existing.id;
  return firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO patient (organization_id, provider_entity_id, location_id, mrn, legal_first_name,
         legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING id`,
      [orgId, PROVIDER_ENTITY_ID, LOCATION_MAIN_ID, s.mrn, s.first, s.last, s.dob, s.sex],
    ),
    `patient ${s.mrn}`,
  ).id;
}

async function insertDocument(
  db: Client,
  orgId: string,
  patientId: string,
  membershipId: string,
  s: ScenarioSpec,
): Promise<string> {
  const documentId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
         created_by_membership_id)
       VALUES ($1,$2,'intake_artifact','fax_ingest','other',$3,$4) RETURNING id`,
      [orgId, patientId, `${TITLE_PREFIX}: ${s.state}`, membershipId],
    ),
    "review-state document",
  ).id;
  const versionId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO document_version (organization_id, document_id, version_number, object_key, mime_type,
         byte_size, sha256_hex, uploaded_by_kind)
       VALUES ($1,$2,'1',$3,'application/pdf','48213',$4,'fax') RETURNING id`,
      [orgId, documentId, `intake/${orgId}/${documentId}/v1.pdf`, randomBytes(32).toString("hex")],
    ),
    "review-state version",
  ).id;
  await db.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [versionId, documentId]);
  return documentId;
}

async function insertBatch(
  db: Client,
  cipher: Cipher,
  ids: { orgId: string; patientId: string; membershipId: string; documentId: string },
  s: ScenarioSpec,
): Promise<string> {
  const sudEvidence = s.sudDetected
    ? await cipher.encrypt(
        ids.orgId,
        "Letterhead of a substance use disorder treatment program on page 1.",
      )
    : null;
  return firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO intake_upload_batch (organization_id, patient_id, provider_entity_id, location_id,
         initial_document_id, source_channel, uploaded_by_membership_id, correlation_id, status, identity_status,
         sud_status, sud_evidence_cipher, sud_detector_ref)
       VALUES ($1,$2,$3,$4,$5,'fax',$6,gen_random_uuid(),'extraction_complete',$7,$8,$9,$10) RETURNING id`,
      [
        ids.orgId,
        ids.patientId,
        PROVIDER_ENTITY_ID,
        LOCATION_MAIN_ID,
        ids.documentId,
        ids.membershipId,
        s.batchIdentity,
        s.sudDetected ? "detected" : "not_detected",
        sudEvidence,
        s.sudDetected ? "doclens-sud@dev-seed" : null,
      ],
    ),
    "review-state batch",
  ).id;
}

async function insertPage(
  db: Client,
  ids: { orgId: string; batchId: string; documentId: string; membershipId: string },
  page: PageSpec,
): Promise<string> {
  const [start, end] = page.range;
  const resolved = page.otherPatient === true;
  return firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO classified_page (organization_id, intake_upload_batch_id, source_document_id, page_range_start,
         page_range_end, document_type, confidence, classifier_model_version_ref, identity_status,
         identity_disagreeing, identity_resolution, identity_resolved_by_membership_id, identity_resolved_at,
         identity_resolution_reason)
       VALUES ($1,$2,$3,$4,$5,'discharge_summary',0.962,'doclens-classifier@dev-seed',$6,$7::jsonb,$8,$9,$10,$11)
       RETURNING id`,
      [
        ids.orgId,
        ids.batchId,
        ids.documentId,
        start,
        end,
        page.identity,
        page.disagreeing ? JSON.stringify(page.disagreeing) : null,
        resolved ? "other_patient" : null,
        resolved ? ids.membershipId : null,
        resolved ? new Date() : null,
        resolved ? "Date of birth and first name belong to a different patient (demo seed)." : null,
      ],
    ),
    "review-state page",
  ).id;
}

async function insertCandidates(
  db: Client,
  cipher: Cipher,
  orgId: string,
  pageId: string,
  page: PageSpec,
): Promise<void> {
  const jobId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO extraction_job (organization_id, classified_page_id, document_type, status,
         extractor_model_version_ref, vision_verifier_model_version_ref, aggregate_confidence, correlation_id)
       VALUES ($1,$2,'discharge_summary','ready_for_review','doclens-extractor@dev-seed',
               'doclens-vision@dev-seed',0.931,'doclens-review-states-seed') RETURNING id`,
      [orgId, pageId],
    ),
    "review-state job",
  ).id;
  for (const [i, c] of page.candidates.entries()) {
    const risk = c.risk ?? "low";
    const note = c.visionNote ? await cipher.encrypt(orgId, c.visionNote) : null;
    await db.query(
      `INSERT INTO extraction_candidate (organization_id, extraction_job_id, field_path, field_kind, risk_level,
         value_cipher, confidence, source_page, source_bounding_box, vision_verified, vision_disagreement,
         sud_detected)
       VALUES ($1,$2,$3,'text',$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [
        orgId,
        jobId,
        c.fieldPath,
        risk,
        await cipher.encrypt(orgId, c.value),
        c.confidence ?? NORMAL_CONFIDENCE,
        page.range[0],
        JSON.stringify({ x1: 40, y1: 80 + i * 22, x2: 420, y2: 98 + i * 22 }),
        risk === "high" && note === null,
        note,
        c.sud ?? false,
      ],
    );
  }
}

export async function seedScenario(
  db: Client,
  cipher: Cipher,
  orgId: string,
  membershipId: string,
  s: ScenarioSpec,
): Promise<void> {
  const patientId = await ensurePatient(db, orgId, s);
  const documentId = await insertDocument(db, orgId, patientId, membershipId, s);
  const batchId = await insertBatch(db, cipher, { orgId, patientId, membershipId, documentId }, s);
  for (const page of s.pages) {
    const pageId = await insertPage(db, { orgId, batchId, documentId, membershipId }, page);
    await insertCandidates(db, cipher, orgId, pageId, page);
  }
  console.log(`  ✓ ${s.mrn} ${s.last}, ${s.first} — ${s.state} (batch ${batchId})`);
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const platformUrl = process.env.DATABASE_PLATFORM_URL;
  assertLocalDevSeed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: adminUrl,
    productionSeedAck: process.env.CHARTWARDEN_SEED_ALLOW_PRODUCTION,
    authUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  });
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required (the superuser seed connection)");
  if (!platformUrl) {
    throw new Error(
      "DATABASE_PLATFORM_URL is required — only the platform login can read tenant_key_ring",
    );
  }
  const kekRing = loadPlatformKekRing(process.env);
  if (!kekRing)
    throw new Error("M34_TENANT_KEK is required — the candidate values are DEK-encrypted");

  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  const platform = createDbClient({ connectionString: platformUrl });
  try {
    const org = (
      await db.query<{ id: string }>("SELECT id FROM organization WHERE slug=$1", [ORG_SLUG])
    ).rows[0];
    if (!org) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);
    const reviewer = (
      await db.query<{ id: string }>(
        `SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id
           WHERE u.email = $1 AND m.organization_id = $2`,
        [REVIEWER_EMAIL, org.id],
      )
    ).rows[0];
    if (!reviewer)
      throw new Error("DocLens reviewer not found — run db:seed:scenario-doclens first");

    registerLiveM34Seams({
      db: platform.db,
      auditBypass: {} as never, // dekForOrg never takes the cross-tenant platform path
      kekUnwrap: createPlatformKekAdapter(kekRing),
      keyRingDb: platform.db,
    });
    const cipher = createCandidateValueCipher(getTenantKeyProvider());

    await removePrior(db, org.id);
    for (const s of SCENARIOS) await seedScenario(db, cipher, org.id, reviewer.id, s);
  } finally {
    await platform.close();
    await db.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
