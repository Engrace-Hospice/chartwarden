/**
 * ChartWarden — DocLens chart-writeback scenario seed (local dev only; F-235, #248). NOT for production.
 *
 * Seeds what `POST /api/v1/intake/reviews/:id/complete` needs to be driven over real HTTP on the local
 * stack:
 *
 *   1. A signed-in-able REVIEWER, `doclens.reviewer@chartwarden.local`, created through the real Better Auth
 *      sign-up (password written to the gitignored CREDENTIALS.local.md, so `scripts/db/lib/api-session.ts`
 *      `signIn()` can use it). The membership gets a `doclens_intake_reviewer` role holding the `intake.*` /
 *      `documents.*` keys, and an ACTIVE RN `membership_credential`, which `extraction_reviewer_eligible`
 *      requires for a high-risk field decision.
 *   2. A dedicated demo patient (`DOCLENS-DEMO-0001`, so no other scenario's patient is edited).
 *   3. One DocLens intake batch resolved to that patient: a filed source document + active version, a
 *      `classified_page`, an `extraction_job`, and eleven `extraction_candidate` rows covering every
 *      branch of the writeback planner (allowlisted contacts, a medication, a SUD-flagged value, an
 *      identity field, one to reject, one to edit).
 *
 * WHY ROWS AND NOT THE PIPELINE. In production those candidate rows are written by the DocLens pipeline,
 * whose M32 classifier/extractor is still a deny-stub at `DESIGN_REVIEW`. They are seeded here in exactly
 * the shape that pipeline must write — values ONLY in `value_cipher`, encrypted with the org's REAL tenant
 * DEK through the same M34 key provider the API uses, so the API decrypts them on the real path.
 *
 * Idempotent: removes this script's prior reviewer, role, batches and the demo patient's contact rows,
 * then re-creates them. Never touches any other account, patient or batch.
 *
 * Prereqs: the stack is up and seeded (`db:seed`, `db:seed:org-structure`), the backend answers on
 *   BETTER_AUTH_URL, and these are set (the compose dev values work against the local stack):
 *     DATABASE_ADMIN_URL      postgres://postgres:postgres@localhost:5432/chartwarden
 *     DATABASE_PLATFORM_URL   the platform login (it alone may read `tenant_key_ring`)
 *     M34_TENANT_KEK          the KEK the API runs with (`docker compose config | grep M34_TENANT_KEK`)
 * Run:     bun run db:seed:scenario-doclens
 * Prints:  the batch id and the candidate ids by field path, for driving the review routes.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { allPermissionMirrorRows } from "@chartwarden/auth";
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
import { fetchAuthWithRateLimitRetry } from "./lib/auth-rate-limit";
import { SEED_CREDENTIALS_PATH, writeSeedCredentials } from "./lib/credentials";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL;
const PLATFORM_URL = process.env.DATABASE_PLATFORM_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const ORG_SLUG = "chartwarden-demo";
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001"; // db:seed:org-structure
const REVIEWER_EMAIL = "doclens.reviewer@chartwarden.local";
const REVIEWER_NAME = "Dee Lens, RN (DocLens reviewer)";
const ROLE_KEY = "doclens_intake_reviewer";
const PATIENT_MRN = "DOCLENS-DEMO-0001";
const CREDS_MARKER = "\n## DocLens reviewer (bun run db:seed:scenario-doclens)\n";

/** Every candidate the batch carries; the comment is what the writeback planner does with it once approved. */
const CANDIDATES: ReadonlyArray<{
  fieldPath: string;
  value: string;
  riskLevel: "low" | "medium" | "high";
  sudDetected?: boolean;
}> = [
  { fieldPath: "patient.phoneHome", value: "(503) 555-0142", riskLevel: "low" }, // commits
  { fieldPath: "patient.email", value: "Mae.Doclens@Example.org", riskLevel: "low" }, // commits (lower-cased)
  { fieldPath: "patient.address.line1", value: "48 Willow Ln", riskLevel: "low" }, // commits
  { fieldPath: "patient.address.city", value: "Salem", riskLevel: "low" }, // commits
  { fieldPath: "patient.address.state", value: "or", riskLevel: "low" }, // commits (→ OR)
  { fieldPath: "patient.address.postalCode", value: "97302", riskLevel: "low" }, // commits
  { fieldPath: "patient.preferredName", value: "Mea", riskLevel: "low" }, // approve_with_edit → "Mae"
  { fieldPath: "medications[0].name", value: "Morphine sulfate 5 mg", riskLevel: "high" }, // A1: never
  { fieldPath: "patient.phoneMobile", value: "503-555-0177", riskLevel: "low", sudDetected: true }, // Part 2
  { fieldPath: "patient.legalLastName", value: "Doclensky", riskLevel: "low" }, // B: identity, never
  { fieldPath: "patient.phoneMobile", value: "503-555-0188", riskLevel: "low" }, // to be rejected
];

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetchAuthWithRateLimitRetry(
    `${AUTH_URL}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    },
    `sign-up for ${email}`,
  );
  if (!res.ok)
    throw new Error(`sign-up failed for ${email}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error(`sign-up for ${email} returned no user id`);
  return body.user.id;
}

function writeCredentials(password: string): void {
  const existing = existsSync(SEED_CREDENTIALS_PATH)
    ? readFileSync(SEED_CREDENTIALS_PATH, "utf8")
    : "";
  const [before, after = ""] = existing.split(CREDS_MARKER);
  // Keep any section a later seed appended after ours; drop only our own previous table.
  const rest = after.includes("\n## ") ? after.slice(after.indexOf("\n## ")) : "";
  const section = [
    CREDS_MARKER.trimStart(),
    "| Persona | Email | Password | Role key(s) |",
    "|---|---|---|---|",
    `| DocLens reviewer (RN) | \`${REVIEWER_EMAIL}\` | \`${password}\` | ${ROLE_KEY} |`,
    "",
  ].join("\n");
  writeSeedCredentials(`${(before ?? "").replace(/\n+$/, "\n")}\n${section}${rest}`);
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required (the superuser seed connection)");
  if (!PLATFORM_URL) {
    throw new Error(
      "DATABASE_PLATFORM_URL is required — only the platform login can read tenant_key_ring",
    );
  }
  const kekRing = loadPlatformKekRing(process.env);
  if (!kekRing)
    throw new Error("M34_TENANT_KEK is required — the candidate values are DEK-encrypted");

  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const org = (
    await db.query<{ id: string }>("SELECT id FROM organization WHERE slug=$1", [ORG_SLUG])
  ).rows[0];
  if (!org) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);
  const orgId = org.id;

  // The real M34 key provider, exactly as the API composes it (platform pool for the key-ring read).
  const platform = createDbClient({ connectionString: PLATFORM_URL });
  registerLiveM34Seams({
    db: platform.db,
    auditBypass: {} as never, // dekForOrg never takes the cross-tenant platform path
    kekUnwrap: createPlatformKekAdapter(kekRing),
    keyRingDb: platform.db,
  });
  const cipher = createCandidateValueCipher(getTenantKeyProvider());

  // ── idempotent cleanup (this script's own rows only) ──────────────────────────────────────────────
  await db.query("BEGIN");
  await db.query("SET LOCAL session_replication_role = replica"); // bypass append-only triggers for cleanup
  const prior = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
    REVIEWER_EMAIL,
  ]);
  const priorUserIds = prior.rows.map((r) => r.id);
  const priorPatient = (
    await db.query<{ id: string }>("SELECT id FROM patient WHERE organization_id=$1 AND mrn=$2", [
      orgId,
      PATIENT_MRN,
    ])
  ).rows[0];
  if (priorPatient) {
    const batches = (
      await db.query<{ id: string }>("SELECT id FROM intake_upload_batch WHERE patient_id=$1", [
        priorPatient.id,
      ])
    ).rows.map((r) => r.id);
    if (batches.length) {
      await db.query(
        `DELETE FROM extraction_provenance WHERE extraction_decision_id IN (SELECT d.id FROM extraction_decision d
           JOIN extraction_review r ON r.id = d.extraction_review_id WHERE r.intake_upload_batch_id = ANY($1))`,
        [batches],
      );
      await db.query(
        `DELETE FROM extraction_decision WHERE extraction_review_id IN
           (SELECT id FROM extraction_review WHERE intake_upload_batch_id = ANY($1))`,
        [batches],
      );
      await db.query("DELETE FROM extraction_review WHERE intake_upload_batch_id = ANY($1)", [
        batches,
      ]);
      await db.query(
        `DELETE FROM extraction_candidate WHERE extraction_job_id IN (SELECT j.id FROM extraction_job j
           JOIN classified_page c ON c.id = j.classified_page_id WHERE c.intake_upload_batch_id = ANY($1))`,
        [batches],
      );
      await db.query(
        `DELETE FROM extraction_job WHERE classified_page_id IN
           (SELECT id FROM classified_page WHERE intake_upload_batch_id = ANY($1))`,
        [batches],
      );
      await db.query("DELETE FROM classified_page WHERE intake_upload_batch_id = ANY($1)", [
        batches,
      ]);
      await db.query("DELETE FROM intake_upload_batch WHERE id = ANY($1)", [batches]);
    }
    for (const t of ["patient_phone", "patient_email", "patient_address", "patient_name_alias"]) {
      await db.query(`DELETE FROM ${t} WHERE patient_id=$1`, [priorPatient.id]);
    }
  }
  if (priorUserIds.length) {
    const ms = (
      await db.query<{ id: string }>("SELECT id FROM membership WHERE user_id = ANY($1)", [
        priorUserIds,
      ])
    ).rows.map((r) => r.id);
    if (ms.length) {
      await db.query("DELETE FROM membership_credential WHERE membership_id = ANY($1)", [ms]);
      await db.query("DELETE FROM membership_role WHERE membership_id = ANY($1)", [ms]);
      await db.query(
        "DELETE FROM document WHERE created_by_membership_id = ANY($1) AND title LIKE 'DocLens demo%'",
        [ms],
      );
      await db.query("DELETE FROM membership WHERE id = ANY($1)", [ms]);
    }
    for (const t of ["session", "account", "two_factor", "passkey"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [priorUserIds]).catch(() => {});
    }
    await db.query('DELETE FROM "user" WHERE id = ANY($1)', [priorUserIds]);
  }
  const priorRole = (
    await db.query<{ id: string }>("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [
      orgId,
      ROLE_KEY,
    ])
  ).rows[0];
  if (priorRole) {
    await db.query("DELETE FROM role_permission WHERE role_id=$1", [priorRole.id]);
    await db.query("DELETE FROM role WHERE id=$1", [priorRole.id]);
  }
  await db.query("COMMIT");

  // ── 1. the reviewer ───────────────────────────────────────────────────────────────────────────────
  const password = `Wx-${randomBytes(9).toString("base64url")}-Zq9!`;
  const userId = await signUp(REVIEWER_EMAIL, password, REVIEWER_NAME);
  const membershipId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO membership (user_id, organization_id, status, accepted_at, default_provider_entity_id,
         default_location_ids)
       VALUES ($1,$2,'active',now(),$3,$4::jsonb) RETURNING id`,
      [userId, orgId, PROVIDER_ENTITY_ID, JSON.stringify([LOCATION_MAIN_ID])],
    ),
    "doclens reviewer membership",
  ).id;
  const roleId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES ($1,$2,'DocLens intake reviewer','clinical_staff'::role_category,'organization',true,
               'DocLens intake reviewer (dev seed, F-235)') RETURNING id`,
      [orgId, ROLE_KEY],
    ),
    "doclens reviewer role",
  ).id;
  const keys = allPermissionMirrorRows()
    .map((r) => r.key)
    .filter(
      (k) => k.startsWith("intake.") || k.startsWith("documents.read") || k === "documents.upload",
    );
  for (const k of keys) {
    await db.query(
      "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
      [orgId, roleId, k],
    );
  }
  await db.query(
    "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
    [orgId, membershipId, roleId],
  );
  await db.query(
    `INSERT INTO membership_credential (organization_id, membership_id, credential_type, status, effective_at,
       issuing_body, granted_by_membership_id)
     VALUES ($1,$2,'rn','active',now() - interval '1 year','Oregon State Board of Nursing',$2)`,
    [orgId, membershipId],
  );
  writeCredentials(password);

  // ── 2. the demo patient ───────────────────────────────────────────────────────────────────────────
  const patientId =
    priorPatient?.id ??
    firstRow(
      await db.query<{ id: string }>(
        `INSERT INTO patient (organization_id, provider_entity_id, location_id, mrn, legal_first_name,
           legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,'Mae','Doclens','1938-04-12','F','active') RETURNING id`,
        [orgId, PROVIDER_ENTITY_ID, LOCATION_MAIN_ID, PATIENT_MRN],
      ),
      "doclens demo patient",
    ).id;

  // ── 3. the intake batch, as the DocLens pipeline must persist it ─────────────────────────────────
  const documentId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
         created_by_membership_id)
       VALUES ($1,$2,'intake_artifact','fax_ingest','other','DocLens demo referral fax',$3) RETURNING id`,
      [orgId, patientId, membershipId],
    ),
    "doclens source document",
  ).id;
  const versionId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key, mime_type,
         byte_size, sha256_hex, uploaded_by_kind)
       VALUES ($1,$2,'1',$3,'application/pdf','48213',$4,'fax') RETURNING id`,
      [orgId, documentId, `intake/${orgId}/${documentId}/v1.pdf`, randomBytes(32).toString("hex")],
    ),
    "doclens source version",
  ).id;
  await db.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [versionId, documentId]);
  const batchId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO intake_upload_batch (organization_id, patient_id, provider_entity_id, location_id,
         initial_document_id, source_channel, uploaded_by_membership_id, correlation_id, status)
       VALUES ($1,$2,$3,$4,$5,'fax',$6,gen_random_uuid(),'extraction_complete') RETURNING id`,
      [orgId, patientId, PROVIDER_ENTITY_ID, LOCATION_MAIN_ID, documentId, membershipId],
    ),
    "doclens batch",
  ).id;
  const pageId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO classified_page (organization_id, intake_upload_batch_id, source_document_id, page_range_start,
         page_range_end, document_type, confidence, classifier_model_version_ref)
       VALUES ($1,$2,$3,1,3,'discharge_summary',0.962,'doclens-classifier@dev-seed') RETURNING id`,
      [orgId, batchId, documentId],
    ),
    "doclens classified page",
  ).id;
  const jobId = firstRow(
    await db.query<{ id: string }>(
      `INSERT INTO extraction_job (organization_id, classified_page_id, document_type, status,
         extractor_model_version_ref, vision_verifier_model_version_ref, aggregate_confidence, correlation_id)
       VALUES ($1,$2,'discharge_summary','ready_for_review','doclens-extractor@dev-seed',
               'doclens-vision@dev-seed',0.931,'doclens-dev-seed') RETURNING id`,
      [orgId, pageId],
    ),
    "doclens extraction job",
  ).id;
  const candidateIds: Array<{ fieldPath: string; value: string; id: string; riskLevel: string }> =
    [];
  for (const [i, c] of CANDIDATES.entries()) {
    const id = firstRow(
      await db.query<{ id: string }>(
        `INSERT INTO extraction_candidate (organization_id, extraction_job_id, field_path, field_kind, risk_level,
           value_cipher, confidence, source_page, source_bounding_box, vision_verified, sud_detected)
         VALUES ($1,$2,$3,'text',$4,$5,0.94,1,$6::jsonb,$7,$8) RETURNING id`,
        [
          orgId,
          jobId,
          c.fieldPath,
          c.riskLevel,
          await cipher.encrypt(orgId, c.value),
          JSON.stringify({ x1: 40, y1: 80 + i * 22, x2: 420, y2: 98 + i * 22 }),
          c.riskLevel === "high",
          c.sudDetected ?? false,
        ],
      ),
      `doclens candidate ${c.fieldPath}`,
    ).id;
    candidateIds.push({ fieldPath: c.fieldPath, value: c.value, id, riskLevel: c.riskLevel });
  }

  await platform.close();
  await db.end();
  console.log(
    JSON.stringify(
      {
        reviewer: REVIEWER_EMAIL,
        organizationId: orgId,
        patientId,
        batchId,
        documentId,
        candidates: candidateIds,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
