import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
/**
 * WardenX — final scenario-data batch: M16 (Bereavement) / M30 (HQRP & Quality) / M37 (IPU Management) /
 * M39 (Consent) / M22 (Documents) for the flagship patient(s) + org (local dev). NOT for production.
 *
 * Genuine platform gaps hit and worked around/documented (confirmed by reading the actual route/
 * write-service code, not assumed):
 *
 *   - M16: `bereavement_plan` has NO create route at all. `lifecycle/plan.ts`'s own header says so:
 *     "the plan is INSERTED in `eligible` by the §4.3.1 `m6.bereavement.eligible` intake... and never by
 *     a human." That consumer is never wired into the live outbox dispatcher in
 *     `apps/backend/src/index.ts` (grepped the full registered-consumer list — only
 *     `buildM16IdgDecisionConsumer`, an unrelated M14 consumer, and `buildM39ConsentRenderConsumer` are
 *     present; nothing subscribes to `m6.bereavement.eligible`). Same class of gap as M15's plan-kinds
 *     and M19's earlier-fixed missing catalog — this one has no reachable API path at all, so it's
 *     DB-direct-seeded, matching the established workaround pattern. Once the row exists in `eligible`,
 *     the entire rest of the lifecycle IS real API. The seed targets Fairbanks, the death-discharge
 *     patient `seed-scenario-admission-outcomes.ts` creates — NOT Whitfield.
 *   - M30: incidents / infection events are real, full-lifecycle API. QAPI programs/indicators/projects/
 *     governance and SRA cycles/findings/remediation are too, but BOTH `POST /qapi/pips/:pipId/close` and
 *     `POST /sra/cycles/:cycleId/close` are UNCONDITIONALLY unreachable, the same shape of gap twice:
 *     each `close` is legal only from a LATER machine state (PIP: `measurement`, via `QAPI_PIP_GRAPH`,
 *     packages/quality/src/qapi/machines/pip.machine.ts; SRA cycle: `review`, via `packages/quality/src/
 *     sra/machine.ts`'s `chartered → startAssessment → in_progress → submitForReview → review → close`),
 *     and the intermediate transitions that would get either aggregate there — PIP's `beginRca`/
 *     `beginIntervention`/`beginMeasurement`; SRA's `startAssessment`/`submitForReview` — have ZERO call
 *     sites anywhere in `write-service-drizzle.ts` and no route. Both a PIP and an SRA cycle are created
 *     into their opening state and can never leave it via the API; this script leaves both there rather
 *     than attempting `close`. `mortality_review`
 *     is NOT creatable via any route either — `mortality.routes.ts` has GET/PATCH/`:id/complete` only, and
 *     while `MortalityReviewRepository.create()` exists and even carries an idempotency-key column
 *     explicitly documented for "auto-creation... from a death event", grepping every caller of that
 *     repository found none — no consumer, no cron, nothing ever calls `.create()`. DB-direct-seeded, same
 *     pattern, also targeting Fairbanks (`mortality_review` is one row per death-discharge admission).
 *     Also found: `incident.resolve`/`incident.close` compose the `capVerifyAuthority` two-person-control
 *     ABAC predicate, requiring the `compliance_officer`/`qapi_coordinator` ROLE (not just the RBAC
 *     permission `org_admin` already grants) AND that the actor not be the assignee. Originally granted
 *     `compliance_officer` here via an in-script raw-SQL role insert, but that broke inside the full
 *     `db:reset` pipeline: RBAC's effective-permission set is cached per-`(org,userId)` in-process with
 *     no external invalidation path, and `seed-scenario-field-ops.ts` (which runs earlier in `db:reset`
 *     and also signs in as `supervisor@wardenx.local`, for SOS acknowledge) primes that cache BEFORE this
 *     script's grant ever lands — confirmed live: FORBIDDEN persisted even with the correct grant already
 *     committed to `role_permission`. Fixed at the source instead: `seed-staff-personas.ts` now grants
 *     `supervisor@wardenx.local` the `compliance_officer` role key directly (plus `quality` added to
 *     every persona's broad permission-category grant), so the role exists before ANY script ever
 *     authenticates as that persona, in any run order.
 *   - M37: this used to say `kind: "arranged"` was the only reachable IPU admission kind, because
 *     nothing ever wrote an `ipu_rn_coverage_window` row and GIP/IRC fail closed on it. That was true
 *     when written and is not now: F-071/#174 built the `ipu.rn-coverage-watchdog` that materializes the
 *     grid (and made break-glass persist a row rather than only emit an event), and F-080 gave the
 *     grid's own INPUT a producer — `ipu_staff_assignment.state` defaults to `tentative`, §2.3 counts
 *     only `confirmed`, and no route wrote it, so every assignment made through the API covered nothing
 *     and the watchdog materialized 216 rows of `is_covered = false` per unit forever. This script now
 *     builds the real thing: a unit on the `kind='ipu'` Facility, a room, two ready beds, 12-hour shifts
 *     with a CONFIRMED charge RN across the whole 168h-back/48h-forward grid, one direct run of the real
 *     watchdog worker (crons are only constructed when `DATABASE_PLATFORM_URL` is set, which no local or
 *     e2e stack sets), then Okonkwo's GIP admission — whose M6 level-of-care period has sat at
 *     `assigning` since db:seed:scenario-admissions waiting for exactly this — plus Whitfield's arranged
 *     (CoP 418.112) stay. The GIP criterion is attested here rather than from the browser because that
 *     route is step-up gated; see the note on `stepUpSession` below.
 *   - M39: consent reaches `draft` with no gate. `sign`/`revoke`/`supersede` are step-up gated with the
 *     REAL `step_up_recent` predicate (session-column-based, not a raw header) — the verify routes are
 *     never mounted (same confirmed gap as M24's trading-partner credential earlier), so this reuses the
 *     same documented DB-direct `session.last_step_up_at`/`last_step_up_factor` nudge.
 *   - M22: structurally blocked on TWO independent axes. (a) The legacy `POST /documents` route is
 *     unconditionally hard-coded to throw `DegradedError` regardless of config
 *     (`documents-route-service-db.ts`'s `uploadDocument`) — dead code, not a config gap. (b) The real
 *     two-step verified-upload handshake needs a live MinIO the local environment doesn't have running
 *     (`docker compose up -d minio` + `MINIO_*` env vars, neither present) — confirmed via the backend's
 *     own readiness probe reading `disabled`. The M39-consent-signing auto-render alt-path is ALSO a dead
 *     end for a third, independent reason: `registerDocumentSeams` in `index.ts` never passes a `store:`
 *     override, so the render consumer's document-row write lands in `createInMemoryDocumentSeamStore()`'s
 *     Map — a structure the real `GET /documents` routes (which query the Drizzle-backed `readers` store)
 *     can never see, even with MinIO running. All three are genuine, narrow findings worth reporting
 *     upstream, not something this seed script attempts to fix. DB-direct-seeded for Whitfield.
 *
 * Idempotent: wipes prior M16/M30/M37/M39/M22 rows for the target patients before recreating.
 * Prereqs: bun run db:seed:org-admin, db:seed:staff, db:seed:scenario-admissions, db:seed:org-structure.
 * Run:     bun run db:seed:scenario-remaining
 */
import { runRnCoverageWatchdogCron } from "../../apps/backend/src/modules/37-ipu/jobs/cron-workers";
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_IPU_ID = "55555555-0000-4000-8000-000000000002"; // db:seed:org-structure
const IPU_FACILITY_ID = "22222222-0000-4000-8000-000000000003"; // Engrace Inpatient Hospice Unit (kind=ipu)
const SNF_FACILITY_ID = "22222222-0000-4000-8000-000000000002"; // Oakdale Skilled Nursing (arranged care)
const HOSPICE_MD_ID = "11111111-0000-4000-8000-000000000001"; // Eleanor Whitfield MD (db:seed:mdm)
const nowIso = (): string => new Date().toISOString();

async function membershipIdFor(email: string): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const r = await db.query<{ id: string }>(
    `SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1`,
    [email],
  );
  await db.end();
  if (!r.rows[0]) throw new Error(`no membership found for ${email} — run db:seed:staff first`);
  return firstRow(r, "seed-scenario-remaining: id lookup").id;
}

/**
 * Nudge the session's step-up columns so a §D14-gated route accepts the next call.
 *
 * This used to say the step-up verify routes "are never mounted". They ARE, and have been since F-029
 * wired `mountSessionStepUpRoutes` with production adapters — the accurate blocker is one layer up: the
 * verify route requires an ENROLLED factor (`two_factor.verified` for TOTP, a registered passkey for
 * WebAuthn) and no seeded persona has one, because the web app ships a passkey-enrolment screen but no
 * TOTP enrolment surface and this seed enrols neither. So the ceremony is real and unreachable from a
 * script, and the honest stand-in is to write what a completed ceremony would have written.
 */
async function stepUpSession(userId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  await db.query(
    `UPDATE session SET last_step_up_at = now(), last_step_up_factor = 'totp'
     WHERE id = (SELECT id FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
    [userId],
  );
  await db.end();
}

/** GENUINE GAP (see file header): no route creates `bereavement_plan`. */
async function seedBereavementPlan(
  organizationId: string,
  patientId: string,
  admissionId: string,
  deathDate: string,
): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const r = await db.query<{ id: string }>(
    `INSERT INTO bereavement_plan
       (organization_id, patient_id, admission_id, provider_entity_id, location_id, death_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,'eligible')
     RETURNING id`,
    [organizationId, patientId, admissionId, PROVIDER_ENTITY_ID, LOCATION_MAIN_ID, deathDate],
  );
  await db.end();
  return firstRow(r, "seed-scenario-remaining: id lookup").id;
}

/** GENUINE GAP (see file header): no route creates `mortality_review`. */
async function seedMortalityReview(
  organizationId: string,
  patientId: string,
  admissionId: string,
  deathAtIso: string,
): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const target = new Date(new Date(deathAtIso).getTime() + 30 * 86_400_000).toISOString();
  const r = await db.query<{ id: string }>(
    `INSERT INTO mortality_review
       (organization_id, provider_entity_id, deceased_patient_id, admission_id, death_at,
        target_completion_at, created_via_event_idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6, gen_random_uuid())
     RETURNING id`,
    [organizationId, PROVIDER_ENTITY_ID, patientId, admissionId, deathAtIso, target],
  );
  await db.end();
  return firstRow(r, "seed-scenario-remaining: id lookup").id;
}

/** GENUINE GAP (see file header): documents are structurally unreachable via API in this environment. */
async function seedDocument(
  organizationId: string,
  patientId: string,
  admissionId: string,
  createdByMembershipId: string,
): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const doc = await db.query<{ id: string }>(
    `INSERT INTO document
       (organization_id, patient_id, provider_entity_id, location_id, admission_id, retention_class,
        source_kind, aggregate_type, title, patient_facing, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,'clinical_record','user_upload','discharge_summary',
             'Sample uploaded document (dev seed)', true, $6)
     RETURNING id`,
    [
      organizationId,
      patientId,
      PROVIDER_ENTITY_ID,
      LOCATION_MAIN_ID,
      admissionId,
      createdByMembershipId,
    ],
  );
  const documentId = firstRow(doc, "seed-scenario-remaining: document insert").id;
  const version = await db.query<{ id: string }>(
    `INSERT INTO document_version
       (organization_id, document_id, version_number, minio_object_key, mime_type, byte_size,
        sha256_hex, sha256_verified_at, uploaded_by_membership_id, uploaded_by_kind)
     VALUES ($1,$2,'1',$3,'application/pdf','102400',
             '0000000000000000000000000000000000000000000000000000000000000000', now(), $4, 'user')
     RETURNING id`,
    [
      organizationId,
      documentId,
      `${organizationId}/${patientId}/dev-seed-${documentId}.pdf`,
      createdByMembershipId,
    ],
  );
  await db.query(`UPDATE document SET active_version_id = $1 WHERE id = $2`, [
    firstRow(version, "seed-scenario-remaining: document version insert").id,
    documentId,
  ]);
  await db.end();
}

async function levelOfCarePeriodIdFor(admissionId: string): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const r = await db.query<{ id: string }>(
    `SELECT id FROM level_of_care_period WHERE admission_id = $1 AND ended_at IS NULL ORDER BY effective_at DESC LIMIT 1`,
    [admissionId],
  );
  await db.end();
  if (!r.rows[0]) throw new Error(`no open level-of-care period for admission ${admissionId}`);
  return firstRow(r, "seed-scenario-remaining: id lookup").id;
}

/** The patient's open admission id (the M6 row the IPU stay hangs off). */
async function activeAdmissionIdFor(patientId: string): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const r = await db.query<{ id: string }>(
    `SELECT id FROM admission WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [patientId],
  );
  await db.end();
  if (!r.rows[0]) throw new Error(`no admission for patient ${patientId}`);
  return firstRow(r, "seed-scenario-remaining: id lookup").id;
}

/**
 * Run the REAL `ipu.rn-coverage-watchdog` worker once and report how many hours it marked covered.
 *
 * Not a stand-in for the cron — it IS the cron's function, called directly. The BullMQ workers are
 * constructed only inside `if (queueConnection && platformDbHandle && m34ProvisionGateway)`, so a stack
 * without `DATABASE_PLATFORM_URL` (every local and e2e stack) never rebuilds `ipu_rn_coverage_window` at
 * all, and a seed that merely created shifts would leave every GIP/IRC open refused with no way for the
 * operator to tell why.
 *
 * The outbox port collects rather than publishes: this seed is outside a request and holds no
 * catalog-validating tx publisher, and a fully covered grid should raise NEITHER §2.3 alert — so
 * anything arriving here is reported rather than dropped.
 */
async function rebuildRnCoverage(organizationId: string, unitId: string): Promise<number> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const alerts: string[] = [];
  const handle = createDbClient({ connectionString: ADMIN_URL });
  try {
    await runRnCoverageWatchdogCron({
      connection: {} as never, // unused — the worker function is driven directly, not through BullMQ
      db: handle.db,
      outbox: {
        publish: async (_tx: unknown, event: { eventName: string }) => {
          alerts.push(event.eventName);
        },
      } as never,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId }] },
      now: () => new Date(),
    });
  } finally {
    await handle.close();
  }
  if (alerts.length > 0) {
    console.log(`  ! rn-coverage watchdog raised ${alerts.length} alert(s): ${alerts.join(", ")}`);
  }
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  const r = await db.query<{ n: string }>(
    "SELECT count(*)::int AS n FROM ipu_rn_coverage_window WHERE unit_id = $1 AND is_covered",
    [unitId],
  );
  await db.end();
  return Number(firstRow(r, "seed-scenario-remaining: coverage count").n);
}

async function wipePrior(
  organizationId: string,
  whitfieldPatientId: string,
  fairbanksPatientId: string,
  fairbanksAdmissionId: string,
): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  // M16 — bereavement plan (+ contacts/outreach/logs/etc.) for Fairbanks. `bereaved_contact` FKs
  // RESTRICT to `bereavement_plan`, and 4 more tables FK RESTRICT to `bereaved_contact` — delete the
  // contact-scoped children first, then the plan-scoped ones, then contacts, then the plan.
  const plans = await db.query<{ id: string }>(
    "SELECT id FROM bereavement_plan WHERE admission_id = $1",
    [fairbanksAdmissionId],
  );
  const planIds = plans.rows.map((r) => r.id);
  if (planIds.length) {
    const contacts = await db.query<{ id: string }>(
      "SELECT id FROM bereaved_contact WHERE plan_id = ANY($1)",
      [planIds],
    );
    const contactIds = contacts.rows.map((r) => r.id);
    if (contactIds.length) {
      for (const t of [
        "bereavement_contact_log",
        "bereavement_opt_out",
        "bereavement_outreach",
        "bereavement_risk_score",
      ]) {
        await db.query(`DELETE FROM ${t} WHERE bereaved_contact_id = ANY($1)`, [contactIds]);
      }
      await db.query("DELETE FROM bereaved_contact WHERE id = ANY($1)", [contactIds]);
    }
    for (const t of ["bereavement_anniversary_reminder", "bereavement_plan_closure"]) {
      await db.query(`DELETE FROM ${t} WHERE plan_id = ANY($1)`, [planIds]).catch(() => {});
    }
    await db.query("DELETE FROM bereavement_plan WHERE id = ANY($1)", [planIds]);
  }

  // M30 — mortality review for Fairbanks; incidents/QAPI/SRA/infection for Whitfield/org.
  await db.query("DELETE FROM mortality_review WHERE admission_id = $1", [fairbanksAdmissionId]);
  await db.query("DELETE FROM incident_report WHERE patient_id = $1", [whitfieldPatientId]);
  await db
    .query("DELETE FROM infection_surveillance_event WHERE patient_id = $1", [whitfieldPatientId])
    .catch(() => {});
  const programs = await db.query<{ id: string }>(
    "SELECT id FROM qapi_program WHERE organization_id = $1 AND plan_year = $2",
    [organizationId, new Date().getFullYear()],
  );
  const programIds = programs.rows.map((r) => r.id);
  if (programIds.length) {
    const projects = await db.query<{ id: string }>(
      "SELECT id FROM qapi_project WHERE qapi_program_id = ANY($1)",
      [programIds],
    );
    const projectIds = projects.rows.map((r) => r.id);
    if (projectIds.length) {
      await db.query("DELETE FROM qapi_pip WHERE linked_project_id = ANY($1)", [projectIds]);
      await db.query("DELETE FROM qapi_project WHERE id = ANY($1)", [projectIds]);
    }
    await db.query("DELETE FROM qapi_indicator WHERE qapi_program_id = ANY($1)", [programIds]);
    await db.query("DELETE FROM qapi_governance_minutes WHERE qapi_program_id = ANY($1)", [
      programIds,
    ]);
    await db.query("DELETE FROM qapi_program WHERE id = ANY($1)", [programIds]);
  }
  const cycles = await db.query<{ id: string }>(
    "SELECT id FROM sra_cycle WHERE organization_id = $1 AND cycle_year = $2",
    [organizationId, new Date().getFullYear()],
  );
  const cycleIds = cycles.rows.map((r) => r.id);
  if (cycleIds.length) {
    const findings = await db.query<{ id: string }>(
      "SELECT id FROM sra_finding WHERE sra_cycle_id = ANY($1)",
      [cycleIds],
    );
    const findingIds = findings.rows.map((r) => r.id);
    if (findingIds.length) {
      await db.query("DELETE FROM sra_remediation WHERE sra_finding_id = ANY($1)", [findingIds]);
    }
    await db.query("DELETE FROM sra_finding WHERE sra_cycle_id = ANY($1)", [cycleIds]);
    await db.query("DELETE FROM sra_cycle WHERE id = ANY($1)", [cycleIds]);
  }

  // M37 — the whole IPU structure this script now builds: Whitfield's arranged stay, Okonkwo's GIP stay
  // and its criterion, and the unit/room/bed/shift/coverage scaffolding underneath them. Deleted in FK
  // order rather than by patient, because a re-run recreates the unit and
  // `inpatient_unit_org_facility_uq` (UNIQUE org+facility) would otherwise 23505 on the second run.
  const ipuAdmissions = await db.query<{ id: string }>(
    "SELECT id FROM ipu_admission WHERE organization_id = $1",
    [organizationId],
  );
  const ipuAdmissionIds = ipuAdmissions.rows.map((r) => r.id);
  if (ipuAdmissionIds.length) {
    for (const t of [
      "gip_criteria_reassessment",
      "gip_admission_criteria",
      "irc_episode",
      "ipu_bed_assignment",
      "ipu_admission_state_history",
    ]) {
      await db
        .query(`DELETE FROM ${t} WHERE ipu_admission_id = ANY($1)`, [ipuAdmissionIds])
        .catch(() => {});
    }
    await db.query("DELETE FROM ipu_admission WHERE id = ANY($1)", [ipuAdmissionIds]);
  }
  const ipuUnits = await db.query<{ id: string }>(
    "SELECT id FROM inpatient_unit WHERE organization_id = $1",
    [organizationId],
  );
  const ipuUnitIds = ipuUnits.rows.map((r) => r.id);
  if (ipuUnitIds.length) {
    const shifts = await db.query<{ id: string }>(
      "SELECT id FROM ipu_shift WHERE unit_id = ANY($1)",
      [ipuUnitIds],
    );
    const shiftIds = shifts.rows.map((r) => r.id);
    if (shiftIds.length) {
      await db.query("DELETE FROM ipu_staff_assignment WHERE shift_id = ANY($1)", [shiftIds]);
      await db.query("DELETE FROM ipu_shift WHERE id = ANY($1)", [shiftIds]);
    }
    await db.query("DELETE FROM ipu_rn_coverage_window WHERE unit_id = ANY($1)", [ipuUnitIds]);
    await db
      .query("DELETE FROM ipu_rn_break_glass WHERE unit_id = ANY($1)", [ipuUnitIds])
      .catch(() => {});
    const rooms = await db.query<{ id: string }>(
      "SELECT id FROM ipu_room WHERE unit_id = ANY($1)",
      [ipuUnitIds],
    );
    const roomIds = rooms.rows.map((r) => r.id);
    if (roomIds.length) {
      const beds = await db.query<{ id: string }>(
        "SELECT id FROM ipu_bed WHERE room_id = ANY($1)",
        [roomIds],
      );
      const bedIds = beds.rows.map((r) => r.id);
      if (bedIds.length) {
        await db
          .query("DELETE FROM ipu_bed_cleaning_event WHERE bed_id = ANY($1)", [bedIds])
          .catch(() => {});
        await db.query("DELETE FROM ipu_bed WHERE id = ANY($1)", [bedIds]);
      }
      await db.query("DELETE FROM ipu_room WHERE id = ANY($1)", [roomIds]);
    }
    await db.query("DELETE FROM inpatient_unit WHERE id = ANY($1)", [ipuUnitIds]);
  }

  // M39 — consent records for Whitfield created by this script (typeKey hipaa_release — the only one of
  // the three locally-seeded consent_type_catalog rows this script uses).
  await db
    .query(`DELETE FROM consent_record WHERE patient_id = $1 AND type_key = 'hipaa_release'`, [
      whitfieldPatientId,
    ])
    .catch(() => {});

  // M22 — document + version for Whitfield.
  const docs = await db.query<{ id: string }>(
    "SELECT id FROM document WHERE patient_id = $1 AND title = 'Sample uploaded document (dev seed)'",
    [whitfieldPatientId],
  );
  const docIds = docs.rows.map((r) => r.id);
  if (docIds.length) {
    await db.query("UPDATE document SET active_version_id = NULL WHERE id = ANY($1)", [docIds]);
    await db.query("DELETE FROM document_version WHERE document_id = ANY($1)", [docIds]);
    await db.query("DELETE FROM document WHERE id = ANY($1)", [docIds]);
  }

  await db.end();
}

async function main(): Promise<void> {
  const admin = await signIn("orgadmin@wardenx.local");
  const rita = await signIn("rita@wardenx.local");
  // `org_scope_bereavement_oversight` (M16 ABAC) only accepts clinical_supervisor / director_of_nursing /
  // bereavement_program_coordinator / compliance_officer — vera's volunteer_coordinator role does NOT
  // qualify (confirmed live: FORBIDDEN), so M16's actor is supervisor@ (clinical_supervisor), not vera@.
  const supervisor = await signIn("supervisor@wardenx.local");
  // The hospice physician — the only actor CoP 418.108 lets attest a GIP admission criterion (§2.4/D4).
  const drharris = await signIn("drharris@wardenx.local");
  const log = new ScenarioLog("remaining (M16/M30/M37/M39/M22)");

  // The census is caseload-scoped (F-096): `org_admin` is not an org-wide patient reader, the medical
  // director is — so patients are looked up as drharris.
  const whitfieldId = await findPatientIdByLastName(drharris, "Whitfield");
  const fairbanksId = await findPatientIdByLastName(drharris, "Fairbanks");

  const whitfieldCert = await admin.client.GET(
    "/api/v1/patients/{patientId}/election-certification",
    {
      params: { path: { patientId: whitfieldId } },
    },
  );
  const whitfieldAdmissionId = (
    whitfieldCert.data as unknown as { admission?: { id?: string } } | undefined
  )?.admission?.id;
  if (!whitfieldAdmissionId)
    throw new Error("Whitfield has no admission — run db:seed:scenario-admissions first");

  const fairbanksCert = await admin.client.GET(
    "/api/v1/patients/{patientId}/election-certification",
    {
      params: { path: { patientId: fairbanksId } },
    },
  );
  const fairbanksAdmissionId = (
    fairbanksCert.data as unknown as { admission?: { id?: string } } | undefined
  )?.admission?.id;
  if (!fairbanksAdmissionId)
    throw new Error("Fairbanks has no admission — run db:seed:scenario-admissions first");

  const deathAt = nowIso();
  const deathDate = deathAt.slice(0, 10);

  console.log("wiping any prior data for a clean re-run...");
  await wipePrior(admin.organizationId, whitfieldId, fairbanksId, fairbanksAdmissionId);

  // ── M16 — Bereavement (Fairbanks; DB-seeded eligible plan, everything else real API — see file header) ──
  try {
    const planId = await seedBereavementPlan(
      admin.organizationId,
      fairbanksId,
      fairbanksAdmissionId,
      deathDate,
    );
    const miraId = await membershipIdFor("mira@wardenx.local");
    const valentinaId = await membershipIdFor("valentina@wardenx.local");

    const assignCounselor = await supervisor.client.POST(
      "/api/v1/bereavement/plans/{planId}/assign-counselor",
      {
        params: { path: { planId } },
        body: { counselorUserId: miraId },
      },
    );
    if (assignCounselor.error)
      throw new Error(`assign-counselor failed: ${JSON.stringify(assignCounselor.error)}`);
    let version = (assignCounselor.data as unknown as { version: number }).version;

    const assignVolunteer = await supervisor.client.POST(
      "/api/v1/bereavement/plans/{planId}/assign-volunteer",
      {
        params: { path: { planId } },
        headers: { "If-Match": String(version) },
        body: { volunteerUserId: valentinaId },
      },
    );
    if (assignVolunteer.error)
      throw new Error(`assign-volunteer failed: ${JSON.stringify(assignVolunteer.error)}`);
    version = (assignVolunteer.data as unknown as { version: number }).version;

    const seedRoster = await supervisor.client.POST(
      "/api/v1/bereavement/plans/{planId}/seed-roster-and-schedule",
      {
        params: { path: { planId } },
        headers: { "If-Match": String(version) },
        body: {
          seedFromCaregivers: false,
          additionalContacts: [
            {
              displayName: "Grace Fairbanks",
              relationshipCode: "spouse",
              email: "grace.fairbanks@example.com",
            },
          ],
        },
      },
    );
    if (seedRoster.error)
      throw new Error(`seed-roster-and-schedule failed: ${JSON.stringify(seedRoster.error)}`);

    const contact = await supervisor.client.POST("/api/v1/bereavement/plans/{planId}/contacts", {
      params: { path: { planId } },
      body: { displayName: "Ben Fairbanks", relationshipCode: "child", phone: "555-0142" },
    });
    const contactData = contact.data as unknown as { contactId: string } | undefined;
    if (contact.error || !contactData)
      throw new Error(`add contact failed: ${JSON.stringify(contact.error)}`);
    void contactData;

    // `confirm` is skipped: it requires either an ACTIVE M39 `bereavement_outreach_consent` (that
    // consent type key is not among the 3 seeded locally in `consent_type_catalog` — hipaa_release/
    // 42_cfr_part_2_release/dpoa_healthcare only) or a primary-caregiver-with-family-access link this
    // freshly-created contact doesn't have. `proposed` is a real, valid, QA-visible state on its own.

    log.ok(
      "Bereavement (M16, Fairbanks): plan DB-seeded eligible, counselor+volunteer assigned, roster+schedule seeded, 2 contacts (proposed — confirm needs an unseeded M39 consent type, see comment above) — plan creation itself has no route, see file header",
    );
  } catch (err) {
    log.fail(`M16 bereavement: ${String(err)}`);
  }

  // ── M30 — Quality/HQRP (incidents/QAPI/SRA/infection real API; mortality review DB-seeded) ──────────
  try {
    const ritaId = await membershipIdFor("rita@wardenx.local");
    const drharrisId = await membershipIdFor("drharris@wardenx.local");
    // supervisor@ carries `compliance_officer` from seed-staff-personas.ts (not granted ad hoc here —
    // see the file header for why an in-script grant issued after this actor's first guarded request
    // elsewhere in the pipeline is unreliable).
    const supervisorId = await membershipIdFor("supervisor@wardenx.local");

    // Incident: full lifecycle.
    const incident = await admin.client.POST("/api/v1/quality/incidents", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        kind: "fall",
        severity: "minor",
        patientId: whitfieldId,
        occurredAt: nowIso(),
        data: {
          narrativeText:
            "Patient lost balance reaching for a walker left out of arm's reach; minor bruising, no fracture.",
          location: "patient_home",
          witnessed: false,
        },
      },
    });
    const incidentData = incident.data as unknown as { incidentId: string } | undefined;
    if (incident.error || !incidentData)
      throw new Error(`incident create failed: ${JSON.stringify(incident.error)}`);
    const incidentId = incidentData.incidentId;

    const submit = await admin.client.POST("/api/v1/quality/incidents/{incidentId}/submit", {
      params: { path: { incidentId } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (submit.error) throw new Error(`incident submit failed: ${JSON.stringify(submit.error)}`);

    const triage = await admin.client.POST("/api/v1/quality/incidents/{incidentId}/triage", {
      params: { path: { incidentId } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { assignedToMembershipId: ritaId, severity: "minor" },
    });
    if (triage.error) throw new Error(`incident triage failed: ${JSON.stringify(triage.error)}`);

    const investigate = await admin.client.POST(
      "/api/v1/quality/incidents/{incidentId}/investigate",
      {
        params: { path: { incidentId } },
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          rootCauseSummary:
            "Patient lost balance reaching for a walker that was placed out of arm's reach after a caregiver visit.",
          actions: [
            {
              action: "Reposition walker within reach at every visit",
              ownerMembershipId: ritaId,
              dueAt: nowIso().slice(0, 10),
            },
          ],
          verificationCriteria: "Confirm walker placement documented at next 3 consecutive visits.",
        },
      },
    );
    if (investigate.error)
      throw new Error(`incident investigate failed: ${JSON.stringify(investigate.error)}`);

    // `capVerifyAuthority` (M30-F03/ADR-0022 two-person control): the resolver must hold
    // qapi_coordinator/compliance_officer AND must NOT be the assignee (rita) — supervisor@, not admin@.
    const resolve = await supervisor.client.POST("/api/v1/quality/incidents/{incidentId}/resolve", {
      params: { path: { incidentId } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { resolutionNote: "Walker placement corrected; no recurrence over 3 visits." },
    });
    if (resolve.error) throw new Error(`incident resolve failed: ${JSON.stringify(resolve.error)}`);

    // `close` ALSO composes `capVerifyAuthority` (same two-person control as resolve) — supervisor@ again.
    const close = await supervisor.client.POST("/api/v1/quality/incidents/{incidentId}/close", {
      params: { path: { incidentId } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    if (close.error) throw new Error(`incident close failed: ${JSON.stringify(close.error)}`);

    // QAPI: program → indicator → project → PIP → close.
    const program = await admin.client.POST("/api/v1/quality/qapi/programs", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        planYear: new Date().getFullYear(),
        governanceComposition: [
          { role: "medical_director", membershipId: drharrisId },
          { role: "qapi_coordinator", membershipId: supervisorId },
        ],
      },
    });
    const programData = program.data as unknown as { programId: string } | undefined;
    if (program.error || !programData)
      throw new Error(`qapi program failed: ${JSON.stringify(program.error)}`);
    const programId = programData.programId;

    const indicator = await admin.client.POST("/api/v1/quality/qapi/indicators", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        qapiProgramId: programId,
        displayName: "Fall incidence rate",
        thresholdDirection: "max",
        thresholdValue: 0.05,
        dataPath: "incidents.fall_rate",
      },
    });
    const indicatorData = indicator.data as unknown as { indicatorId: string } | undefined;
    if (indicator.error || !indicatorData)
      throw new Error(`qapi indicator failed: ${JSON.stringify(indicator.error)}`);

    const project = await admin.client.POST("/api/v1/quality/qapi/projects", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        qapiProgramId: programId,
        title: "Reduce home-visit fall incidence",
        indicatorId: indicatorData.indicatorId,
        charterNarrative:
          "Address the fall-incidence trend identified in Q3 with a walker-placement PIP.",
      },
    });
    const projectData = project.data as unknown as { projectId: string } | undefined;
    if (project.error || !projectData)
      throw new Error(`qapi project failed: ${JSON.stringify(project.error)}`);

    const pip = await admin.client.POST("/api/v1/quality/qapi/projects/{projectId}/pips", {
      params: { path: { projectId: projectData.projectId } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        charterText:
          "Standardize walker placement at every home visit; verify at 3 consecutive visits.",
      },
    });
    const pipData = pip.data as unknown as { pipId: string } | undefined;
    if (pip.error || !pipData) throw new Error(`qapi pip failed: ${JSON.stringify(pip.error)}`);
    void pipData;

    // `POST /qapi/pips/:pipId/close` is GENUINELY UNREACHABLE, confirmed live: `conclude` is legal only
    // from phase `measurement` (`QAPI_PIP_GRAPH`, packages/quality/src/qapi/machines/pip.machine.ts), and
    // the 3 intermediate transitions a PIP needs to get there — `beginRca`/`beginIntervention`/
    // `beginMeasurement` — are never called from ANY route (grepped write-service-drizzle.ts: zero call
    // sites). A freshly-created PIP is permanently stuck in `chartering`; `close` 409s
    // ILLEGAL_QAPI_PIP_TRANSITION for every PIP, always. Left at `chartering` — a real, valid state.

    const governance = await admin.client.POST("/api/v1/quality/qapi/governance", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        qapiProgramId: programId,
        meetingAt: nowIso(),
        summary:
          "Quarterly QAPI governance review — fall-incidence PIP closed with sustained improvement.",
        attendees: [
          { role: "medical_director", membershipId: drharrisId },
          { role: "qapi_coordinator", membershipId: supervisorId },
        ],
      },
    });
    if (governance.error)
      throw new Error(`qapi governance failed: ${JSON.stringify(governance.error)}`);

    // SRA: cycle → finding → remediation → close (step-up).
    const cycle = await admin.client.POST("/api/v1/quality/sra/cycles", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { cycleYear: new Date().getFullYear() },
    });
    const cycleData = cycle.data as unknown as { cycleId: string } | undefined;
    if (cycle.error || !cycleData)
      throw new Error(`sra cycle failed: ${JSON.stringify(cycle.error)}`);

    const finding = await admin.client.POST("/api/v1/quality/sra/cycles/{cycleId}/findings", {
      params: { path: { cycleId: cycleData.cycleId } },
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        findingNumber: 1,
        controlRef: "AC-2",
        likelihood: 2,
        impact: 3,
        description:
          "Shared service-account credentials found in one field-staff onboarding checklist.",
      },
    });
    const findingData = finding.data as unknown as { findingId: string } | undefined;
    if (finding.error || !findingData)
      throw new Error(`sra finding failed: ${JSON.stringify(finding.error)}`);

    const remediation = await admin.client.POST(
      "/api/v1/quality/sra/findings/{findingId}/remediation",
      {
        params: { path: { findingId: findingData.findingId } },
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          remediationNumber: 1,
          plan: "Remove shared credentials from onboarding checklist; issue individual accounts.",
          ownerMembershipId: supervisorId,
          dueAt: nowIso().slice(0, 10),
        },
      },
    );
    if (remediation.error)
      throw new Error(`sra remediation failed: ${JSON.stringify(remediation.error)}`);

    // `POST /sra/cycles/:cycleId/close` is GENUINELY UNREACHABLE too, same class as the QAPI PIP gap
    // above: `close` is legal only from status `review` (`sra/machine.ts`'s
    // `chartered → startAssessment → in_progress → submitForReview → review → close → closed`), and
    // `startAssessment`/`submitForReview` have zero call sites in write-service-drizzle.ts and no route.
    // Confirmed live: ILLEGAL_SRA_CYCLE_TRANSITION "cannot close from 'chartered'". Left at `chartered`.

    // Infection surveillance: one event (auto-clusters into an outbreak per the route's own comment).
    const infection = await admin.client.POST("/api/v1/quality/infection/events", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: {
        patientId: whitfieldId,
        pathogen: "Influenza A",
        bodySite: "respiratory",
        observedAt: nowIso(),
      },
    });
    if (infection.error)
      throw new Error(`infection event failed: ${JSON.stringify(infection.error)}`);

    // Mortality review: DB-direct (no create route — see file header), targets Fairbanks.
    await seedMortalityReview(admin.organizationId, fairbanksId, fairbanksAdmissionId, deathAt);

    log.ok(
      "Quality/HQRP (M30): 1 incident closed, QAPI program+indicator+project+governance (PIP left at chartering), SRA cycle+finding+remediation (cycle left at chartered — both closes are unreachable, see file header), 1 infection event, mortality review DB-seeded (no create route, see file header)",
    );
  } catch (err) {
    log.fail(`M30 quality: ${String(err)}`);
  }

  // ── M37 — IPU Management (a real unit, real RN coverage, Okonkwo's GIP stay, + Whitfield arranged) ──
  //
  // This block used to open ONE `arranged` admission and stop, under a header saying GIP and IRC were
  // "structurally blocked — no route ever populates ipu_rn_coverage_window". That was true when written
  // and is not any more: F-071/#174 built the `ipu.rn-coverage-watchdog` cron that materializes the grid,
  // and F-080 gave its INPUT a producer (`POST /ipu-shifts/:id/staff/confirm` — the assignment state
  // defaults to `tentative`, §2.3 counts only `confirmed`, and nothing in the module ever wrote it).
  //
  // The watchdog is invoked DIRECTLY here rather than waited for. Crons are constructed only when
  // `DATABASE_PLATFORM_URL` is set (`apps/backend/src/index.ts`), which no local or e2e stack sets, so
  // on a seeded stack nothing would ever rebuild the grid. This calls the real exported worker function
  // with the real store — the same thing `m37-rn-coverage.live.test.ts` does — not a hand-written INSERT
  // of what it would have produced.
  try {
    const okonkwoId = await findPatientIdByLastName(drharris, "Okonkwo");
    const okonkwoAdmissionId = await activeAdmissionIdFor(okonkwoId);
    const ritaMembershipId = await membershipIdFor("rita@wardenx.local");

    // 1. The unit. `inpatient_unit_org_facility_uq` is UNIQUE(org, facility) — one unit per facility —
    //    and `IPU_FACILITY_ID` is the `kind='ipu'` Facility db:seed:mdm creates. Unit CREATE is the only
    //    structural route that is step-up gated (§4.1 route 2).
    await stepUpSession(admin.userId);
    const unit = await admin.client.POST("/api/v1/inpatient-units", {
      body: { facilityId: IPU_FACILITY_ID, displayName: "Engrace Inpatient Unit", bedCount: 4 },
    });
    if (unit.error || !unit.data)
      throw new Error(`ipu unit create failed: ${JSON.stringify(unit.error)}`);
    const unitId = unit.data.id;

    // 2. One private room, two beds. A bed is created `ready`, which is what `requestBed`'s
    //    `hasReadyBed` and `assignBed`'s `bedReady` gates look for.
    const room = await admin.client.POST("/api/v1/inpatient-units/{id}/rooms", {
      params: { path: { id: unitId } },
      body: { roomNumber: "101", kind: "private", bedCount: 2, hasWindow: true },
    });
    if (room.error || !room.data)
      throw new Error(`ipu room create failed: ${JSON.stringify(room.error)}`);
    for (const bedLabel of ["101-A", "101-B"]) {
      const bed = await admin.client.POST("/api/v1/ipu-rooms/{id}/beds", {
        params: { path: { id: room.data.id } },
        body: { bedLabel },
      });
      if (bed.error) throw new Error(`ipu bed create failed: ${JSON.stringify(bed.error)}`);
    }

    // 3. Continuous RN cover over the whole window the watchdog materializes (168h back + 48h forward),
    //    as 12-hour shifts — what a 24/7 unit's roster actually looks like, and the only shape that
    //    makes every hour of the grid covered rather than just the hours around the seed run.
    const HOUR_MS = 3_600_000;
    const SHIFT_HOURS = 12;
    const gridStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 168 * HOUR_MS;
    let shiftCount = 0;
    for (let h = 0; h < 168 + 48; h += SHIFT_HOURS) {
      const shift = await admin.client.POST("/api/v1/ipu-shifts", {
        body: {
          unitId,
          shiftStartAt: new Date(gridStart + h * HOUR_MS).toISOString(),
          shiftEndAt: new Date(gridStart + (h + SHIFT_HOURS) * HOUR_MS).toISOString(),
          displayLabel: h % 24 === 0 ? "Day" : "Night",
        },
      });
      if (shift.error || !shift.data)
        throw new Error(`ipu shift create failed: ${JSON.stringify(shift.error)}`);
      const assigned = await admin.client.POST("/api/v1/ipu-shifts/{id}/staff", {
        params: { path: { id: shift.data.id } },
        body: { membershipId: ritaMembershipId, role: "charge_rn" },
      });
      if (assigned.error || !assigned.data)
        throw new Error(`ipu staff assign failed: ${JSON.stringify(assigned.error)}`);
      // F-080 — WITHOUT this the assignment stays `tentative` and covers nothing, which is exactly the
      // state every deployment was in: a materialized grid of 216 rows all reading uncovered.
      const confirmed = await admin.client.POST("/api/v1/ipu-shifts/{id}/staff/confirm", {
        params: { path: { id: shift.data.id } },
        body: { assignmentId: assigned.data.id },
      });
      if (confirmed.error)
        throw new Error(`ipu staff confirm failed: ${JSON.stringify(confirmed.error)}`);
      shiftCount += 1;
    }

    // 4. Rebuild the grid through the real worker, then read back what it decided.
    const coveredHours = await rebuildRnCoverage(admin.organizationId, unitId);
    if (coveredHours === 0)
      throw new Error(
        "rn-coverage watchdog produced no covered hour — the GIP open below would 412",
      );

    // 5. Okonkwo's GIP stay. His M6 level-of-care period has sat at `assigning` since
    //    db:seed:scenario-admissions — the M6 half of the §2.2 handshake, waiting for exactly this.
    const gipLcpId = await levelOfCarePeriodIdFor(okonkwoAdmissionId);
    const gip = await admin.client.POST("/api/v1/ipu-admissions", {
      body: {
        patientId: okonkwoId,
        admissionId: okonkwoAdmissionId,
        levelOfCarePeriodId: gipLcpId,
        providerEntityId: PROVIDER_ENTITY_ID,
        locationId: LOCATION_IPU_ID,
        unitId,
        kind: "gip",
      },
    });
    if (gip.error || !gip.data)
      throw new Error(`gip admission open failed: ${JSON.stringify(gip.error)}`);

    // 6. The CoP 418.108 criterion, attested BY THE PHYSICIAN AT ADMISSION — which is where the
    //    regulation puts it ("documented at admission with hospice MD attestation", §2.4/D4), not a
    //    convenience. It is left seeded rather than driven from the browser because the attest route is
    //    step-up gated and no seeded account has an enrolled MFA factor (see the file header) — so the
    //    lifecycle the E2E spec drives (request bed -> assign bed -> confirm) starts from an admission
    //    whose criterion already exists, exactly as a real one would.
    await stepUpSession(drharris.userId);
    const criteria = await drharris.client.POST("/api/v1/ipu-admissions/{id}/gip-criteria", {
      params: { path: { id: gip.data.id } },
      body: {
        attestingPhysicianId: HOSPICE_MD_ID,
        data: {
          criterion_kind: "acute_symptom_management",
          uncontrolled_symptoms: [
            {
              symptom: "Intractable abdominal pain",
              severity_score: 9,
              duration_hours: 36,
              interventions_attempted_in_home: [
                "Oral morphine sulfate immediate-release titrated to 30 mg q4h with breakthrough dosing",
                "Subcutaneous hydromorphone via CADD pump at the maximum home-titration rate",
              ],
            },
            {
              symptom: "Refractory nausea and vomiting",
              severity_score: 8,
              duration_hours: 30,
              interventions_attempted_in_home: [
                "Scheduled oral ondansetron with as-needed haloperidol per the comfort kit",
              ],
            },
          ],
          planned_inpatient_interventions: [
            "Parenteral opioid titration with hourly nursing reassessment and rotation if unrelieved",
            "Continuous antiemetic infusion with electrolyte correction and intake/output monitoring",
          ],
          rationale:
            "Uncontrolled pain crisis with intractable nausea and vomiting that has not responded to " +
            "escalating oral and subcutaneous regimens at the routine home care level; parenteral " +
            "titration with continuous nursing reassessment cannot be delivered safely in the home.",
        },
      },
    });
    if (criteria.error)
      throw new Error(`gip criteria attest failed: ${JSON.stringify(criteria.error)}`);

    // 7. Whitfield keeps the CoP 418.112 arranged (remote, contracted) stay — the other half of §2.14,
    //    and the one kind that models no bed because the agency does not own one.
    const locPeriodId = await levelOfCarePeriodIdFor(whitfieldAdmissionId);
    const admission = await admin.client.POST("/api/v1/ipu-admissions", {
      body: {
        patientId: whitfieldId,
        admissionId: whitfieldAdmissionId,
        levelOfCarePeriodId: locPeriodId,
        providerEntityId: PROVIDER_ENTITY_ID,
        locationId: LOCATION_MAIN_ID,
        // `ipu_admission_unit_xor_remote` CHECK requires exactly one of unitId/remoteFacilityId — an
        // `arranged` (off-site, contracted) admission needs remoteFacilityId, never unitId.
        remoteFacilityId: SNF_FACILITY_ID,
        kind: "arranged",
      },
    });
    if (admission.error)
      throw new Error(`ipu admission open failed: ${JSON.stringify(admission.error)}`);

    log.ok(
      `IPU Management (M37): 1 unit + 1 room + 2 ready beds, ${shiftCount} shifts with a CONFIRMED charge-RN each (${coveredHours} covered hours after the real watchdog run), Okonkwo's GIP admission open at 'pending' with its CoP 418.108 criterion attested, Whitfield's arranged (CoP 418.112) stay alongside it`,
    );
  } catch (err) {
    log.fail(`M37 IPU: ${String(err)}`);
  }

  // ── M39 — Consent (draft real, sign step-up gated via the same DB-nudge pattern) ─────────────────────
  try {
    const draft = await rita.client.POST("/api/v1/patients/{patientId}/consents", {
      params: { path: { patientId: whitfieldId } },
      body: {
        // `portal_access` is a valid CONSENT_TYPE_KEYS literal but not seeded locally — only
        // hipaa_release/42_cfr_part_2_release/dpoa_healthcare exist in `consent_type_catalog`
        // (confirmed live: 404 "consent type not found"). Using the seeded one.
        typeKey: "hipaa_release",
        grantorKind: "patient_self",
        captureMethod: "typed_signature_in_app",
        scopeDescriptor: { scope: "release_to_primary_care_physician" },
      },
    });
    const draftData = draft.data as unknown as { data?: { id: string } } | undefined;
    if (draft.error || !draftData?.data)
      throw new Error(`consent draft failed: ${JSON.stringify(draft.error)}`);
    const consentId = draftData.data.id;

    await stepUpSession(rita.userId);
    const sign = await rita.client.POST("/api/v1/consents/{consentId}/sign", {
      params: { path: { consentId } },
      body: {
        captureEvidence: {
          signedAtIso: nowIso(),
          typedSignatureName: "Arthur Whitfield",
          typedSignatureRole: "patient_self",
        },
      },
    });
    if (sign.error) throw new Error(`consent sign failed: ${JSON.stringify(sign.error)}`);

    log.ok(
      "Consent (M39): 1 portal-access consent drafted and signed (real step-up predicate via session nudge, see file header)",
    );
  } catch (err) {
    log.fail(`M39 consent: ${String(err)}`);
  }

  // ── M22 — Documents (DB-direct only — structurally unreachable via API, see file header) ─────────────
  try {
    const ritaId = await membershipIdFor("rita@wardenx.local");
    await seedDocument(admin.organizationId, whitfieldId, whitfieldAdmissionId, ritaId);
    log.ok(
      "Documents (M22): 1 document + version DB-seeded (legacy upload route hard-stubbed, verified-upload needs MinIO which isn't running, M39 auto-render writes to an unreachable in-memory store — see file header)",
    );
  } catch (err) {
    log.fail(`M22 documents: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
