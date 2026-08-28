/**
 * WardenX — field-ops scenario data: M15 (volunteer plan) / M17 (scheduling) / M18 (EVV) /
 * M19 (on-call triage) / M20 (field safety) / M21 (supplies) for the flagship patient (local dev).
 * NOT for production.
 *
 * M15 scope note: only the `volunteer_plan` path is exercised here, and even that needed a small
 * DB-direct seed. ALL FOUR plan kinds (`aide_poc`/`msw_plan`/`spiritual_plan`/`volunteer_plan`) are
 * supposed to auto-bootstrap in `draft` when M6 fires `admission.activated` — confirmed this never
 * happens (checked live: `SELECT count(*) FROM discipline_care_plan` is 0 even for Whitfield's
 * genuinely-activated admission), the same unwired-dispatcher gap `seed-scenario-admission-
 * outcomes.ts` documents for `patient.status`. `volunteer_plan` was assumed to be a lazy-create
 * exception (a prior research pass claimed `POST .../volunteer-assignments` creates the plan on
 * first use) — reading the actual DB-backed service disproved that: `createVolunteerAssignment`
 * calls `planOr404(tx, planId)` first and 404s if no plan exists, same as every other kind. So this
 * DB-seeds one `draft` `volunteer_plan` row (see `seedDraftVolunteerPlan` below, same documented
 * workaround pattern as M14's meeting seed), then drives the compliance gates + assignment through
 * the real API from there. The other three kinds are left unseeded — out of scope for this pass.
 *
 * Idempotent: wipes prior field-ops rows for Whitfield (+ the org-wide on-call shift/triage-protocol
 * rows this script owns) before recreating.
 * Prereqs: bun run db:seed:staff, db:seed:scenario-admissions, db:seed:org-structure.
 * Run:     bun run db:seed:scenario-field-ops
 */
import { Client } from "pg";
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001";
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001";
const nowIso = (): string => new Date().toISOString();
const addHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

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
  return firstRow(r, "seed-scenario-field-ops: id lookup").id;
}

/**
 * GENUINE GAP, confirmed by reading the code (not the earlier research pass's claim): `discipline_
 * care_plan` rows are supposed to auto-bootstrap in `draft` when M6 fires `admission.activated`
 * (same unwired-dispatcher class of gap as `patient.status`/`seed-scenario-admission-outcomes.ts`).
 * The prior assumption that `volunteer_plan` is the one exception, lazily created by
 * `POST .../volunteer-assignments`, does NOT hold — `write-service-drizzle.ts`'s
 * `createVolunteerAssignment` calls `planOr404(tx, planId)` first: the plan must already exist or
 * the route 404s. So this seeds one `draft` `volunteer_plan` row directly, the same documented
 * DB-direct workaround `seed-scenario-orders-meds-idg.ts` uses for the M14 meeting-creation gap.
 */
async function seedDraftVolunteerPlan(
  organizationId: string,
  patientId: string,
  admissionId: string,
): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const r = await db.query<{ id: string }>(
    `INSERT INTO discipline_care_plan
       (organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status)
     VALUES ($1,$2,$3,$4,$5,'volunteer_plan','draft')
     RETURNING id`,
    [organizationId, patientId, admissionId, PROVIDER_ENTITY_ID, LOCATION_MAIN_ID],
  );
  await db.end();
  return firstRow(r, "seed-scenario-field-ops: id lookup").id;
}

/**
 * GENUINE GAP: no API route ever sets `admission.provider_entity_id`/`location_id`. The M6 schema
 * comment (`packages/db/src/schema/admission/admissions.ts`) says both are "nullable at draft... until
 * the §7.2 admission wizard runs, before activation" — but `PATCH /api/v1/admissions/:id`
 * (`AdmissionUpdateSchema`) only accepts `intakeMethod`/`attendingPhysicianId`/`ifVersion`; the
 * admission-siting wizard was never built. Confirmed via `seed-scenario-admission-outcomes.ts`: every
 * seeded admission has both columns NULL even after activation. M21's supply-request route needs a
 * resolvable provider entity (`M21_SERVING_LOCATION_UNRESOLVED` otherwise), so this patches the column
 * directly — the same documented DB-direct-workaround pattern used elsewhere in this script for other
 * unwired paths.
 */
async function ensureAdmissionSited(admissionId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  await db.query(
    `UPDATE admission SET provider_entity_id = $2, location_id = $3
     WHERE id = $1 AND (provider_entity_id IS NULL OR location_id IS NULL)`,
    [admissionId, PROVIDER_ENTITY_ID, LOCATION_MAIN_ID],
  );
  await db.end();
}

/**
 * GENUINE GAP, confirmed by reading the code, not assumed: `POST /api/v1/visits` is unconditionally
 * unreachable in production. `scheduling-route-service-db.ts`'s `SchedulingAbacResolver` implementation
 * hard-codes `credentialsActiveForPurpose`→`false`, `resolveDiscipline`→`null`, `isInCaseload`→`false`,
 * `allowsUnassignedPool`→`false` ("cross-module facts fail closed (compromise #3)") — there is no live
 * input that can ever satisfy `clinician_credentials_active` / `discipline_matches_visit` /
 * `within_caseload_or_unassigned_pool`, so every visit-create call gets FORBIDDEN regardless of caller or
 * data. This is the SAME class of deliberate Phase-1 stub as M20's unbound DEK (not a bug to route
 * around quietly) — DB-seeds the row directly instead, matching this file's other documented workarounds.
 */
async function seedPublishedVisit(
  organizationId: string,
  patientId: string,
  admissionId: string,
  assignedMembershipId: string,
  startsAt: string,
  endsAt: string,
): Promise<string> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  const serviceDate = startsAt.slice(0, 10);
  const r = await db.query<{ id: string }>(
    `INSERT INTO visit
       (organization_id, provider_entity_id, location_id, patient_id, admission_id,
        assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
        scheduled_started_at, scheduled_ended_at, service_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',$7,$8,$9,'published')
     RETURNING id`,
    [
      organizationId,
      PROVIDER_ENTITY_ID,
      LOCATION_MAIN_ID,
      patientId,
      admissionId,
      assignedMembershipId,
      startsAt,
      endsAt,
      serviceDate,
    ],
  );
  await db.end();
  return firstRow(r, "seed-scenario-field-ops: id lookup").id;
}

/**
 * GENUINE GAP: `tenant_oncall_policy` has no create route at all — `PATCH /api/v1/oncall/policy` 404s
 * with `ONCALL_POLICY_NOT_FOUND` if the row doesn't already exist (`write-service-drizzle.ts`'s
 * `patchPolicy` selects-then-requires, never upserts), and the module header on the GET route explains
 * why on purpose: "NOT auto-created on read... a default invented at read time would be pinned as though
 * the tenant had chosen it." A shift cannot open without this row (`policy_snapshot` is NOT NULL, D7), so
 * this DB-seeds the org's one direct-model policy directly.
 */
async function seedOncallPolicy(organizationId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");
  await db.query(
    `INSERT INTO tenant_oncall_policy
       (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
     VALUES ($1, $2, 'direct', $3, $4)
     ON CONFLICT (organization_id, provider_entity_id) DO NOTHING`,
    [
      organizationId,
      PROVIDER_ENTITY_ID,
      JSON.stringify({
        tier_1_rn_supervisor: { role: "rn_case_manager" },
        tier_2_clinical_manager: { role: "clinical_supervisor" },
        tier_3_medical_director: { role: "medical_director" },
      }),
      JSON.stringify({ emergent: 5, urgent: 15, routine: 60 }),
    ],
  );
  await db.end();
}

async function wipePriorFieldOps(patientId: string, organizationId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  // M15 volunteer plan
  const plans = await db.query<{ id: string }>(
    "SELECT id FROM discipline_care_plan WHERE patient_id = $1",
    [patientId],
  );
  const planIds = plans.rows.map((r) => r.id);
  if (planIds.length) {
    const versions = await db.query<{ id: string }>(
      "SELECT id FROM discipline_care_plan_version WHERE plan_id = ANY($1)",
      [planIds],
    );
    const versionIds = versions.rows.map((r) => r.id);
    if (versionIds.length) {
      await db.query("DELETE FROM discipline_care_plan_signature WHERE version_id = ANY($1)", [
        versionIds,
      ]);
    }
    await db.query("DELETE FROM discipline_intervention WHERE plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM discipline_goal WHERE plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM discipline_care_plan_version WHERE plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM volunteer_assignment WHERE plan_id = ANY($1)", [planIds]);
    await db.query("DELETE FROM discipline_care_plan WHERE id = ANY($1)", [planIds]);
  }
  await db.query(
    `DELETE FROM volunteer_compliance_gate WHERE volunteer_membership_id = (
       SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id WHERE u.email = 'valentina@wardenx.local'
     )`,
  );

  // M17 scheduling
  const visits = await db.query<{ id: string }>("SELECT id FROM visit WHERE patient_id = $1", [
    patientId,
  ]);
  const visitIds = visits.rows.map((r) => r.id);
  if (visitIds.length) {
    await db.query("DELETE FROM evv_visit_registration WHERE visit_id = ANY($1)", [visitIds]);
    await db.query("DELETE FROM visit_state_history WHERE visit_id = ANY($1)", [visitIds]);
    await db.query("DELETE FROM visit WHERE id = ANY($1)", [visitIds]);
  }

  // M18 EVV device (org-scoped by membership, not patient — clear this script's rita device)
  const ritaId = await membershipIdFor("rita@wardenx.local");
  await db.query("DELETE FROM evv_event WHERE posting_membership_id = $1", [ritaId]);
  await db.query("DELETE FROM evv_device WHERE membership_id = $1", [ritaId]);

  // M19 on-call — this script's own shift + any triage call tied to this patient
  const calls = await db.query<{ id: string }>("SELECT id FROM triage_call WHERE patient_id = $1", [
    patientId,
  ]);
  const callIds = calls.rows.map((r) => r.id);
  if (callIds.length) {
    await db.query("DELETE FROM triage_call_answer WHERE triage_call_id = ANY($1)", [callIds]);
    await db.query("DELETE FROM triage_escalation WHERE triage_call_id = ANY($1)", [callIds]);
    await db.query("DELETE FROM triage_call_state_history WHERE triage_call_id = ANY($1)", [
      callIds,
    ]);
    await db.query("DELETE FROM triage_call WHERE id = ANY($1)", [callIds]);
  }
  await db.query(
    `DELETE FROM on_call_shift WHERE organization_id = $1 AND primary_on_call_membership_id = $2`,
    [organizationId, ritaId],
  );

  // M20 field safety
  await db.query("DELETE FROM safety_incident WHERE patient_id = $1", [patientId]);
  await db.query(`DELETE FROM safety_sos_alert WHERE posted_by_membership_id = $1`, [ritaId]);
  await db.query(`DELETE FROM safety_check_in WHERE posted_by_membership_id = $1`, [ritaId]);

  // M21 supplies
  const reqs = await db.query<{ id: string }>(
    "SELECT id FROM supply_request WHERE patient_id = $1",
    [patientId],
  );
  const reqIds = reqs.rows.map((r) => r.id);
  if (reqIds.length) {
    const dispatches = await db.query<{ id: string }>(
      "SELECT id FROM comfort_kit_dispatch WHERE supply_request_id = ANY($1)",
      [reqIds],
    );
    const dispatchIds = dispatches.rows.map((r) => r.id);
    if (dispatchIds.length) {
      await db.query("DELETE FROM comfort_kit_dispatched_content WHERE dispatch_id = ANY($1)", [
        dispatchIds,
      ]);
      await db.query("DELETE FROM comfort_kit_dispatch WHERE id = ANY($1)", [dispatchIds]);
    }
    await db.query("DELETE FROM supply_request WHERE id = ANY($1)", [reqIds]);
  }

  await db.end();
}

async function main(): Promise<void> {
  const rn = await signIn("rita@wardenx.local");
  const vol = await signIn("valentina@wardenx.local");
  const coord = await signIn("vera@wardenx.local");
  const supervisor = await signIn("supervisor@wardenx.local");
  const log = new ScenarioLog("field-ops (Whitfield)");

  const patientId = await findPatientIdByLastName(rn, "Whitfield");
  const cert = await rn.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const admissionId = (cert.data as unknown as { admission?: { id?: string } } | undefined)
    ?.admission?.id;
  if (!admissionId)
    throw new Error("Whitfield has no admission — run db:seed:scenario-admissions first");

  console.log("wiping any prior field-ops data for a clean re-run...");
  await wipePriorFieldOps(patientId, rn.organizationId);
  await ensureAdmissionSited(admissionId);

  // ── M15 — volunteer plan (draft plan DB-seeded, everything else real API — see file header) ──
  try {
    const volunteerId = await membershipIdFor("valentina@wardenx.local");
    const planId = await seedDraftVolunteerPlan(rn.organizationId, patientId, admissionId);

    // BLOCKING_VOLUNTEER_GATE_KINDS (packages/discipline-plans/src/policy.ts) — ALL SIX must clear before
    // `volunteer_assignment` insert passes the `volunteer_compliance_active` ABAC predicate, not just one.
    const BLOCKING_GATE_KINDS = [
      "background_check",
      "tb_screening",
      "confidentiality_agreement",
      "initial_training",
      "annual_ce",
      "assignment_specific_training",
    ] as const;
    // LIFETIME_VOLUNTEER_GATE_KINDS (same policy.ts): `initial_training` is one-time and must be
    // recorded WITHOUT `validUntil` — the write path 422s (`INITIAL_TRAINING_LIFETIME`) otherwise.
    for (const gateKind of BLOCKING_GATE_KINDS) {
      const gate = await coord.client.POST("/api/v1/volunteer-compliance-gates", {
        body: {
          volunteerMembershipId: volunteerId,
          gateKind,
          validFrom: "2024-01-01",
          // `validUntil` is a REQUIRED, nullable field (`InstantN`) — omitting it 422s; `null` is the
          // one-time-credential value.
          validUntil: gateKind === "initial_training" ? null : "2027-01-01",
        },
      });
      if (gate.error)
        throw new Error(`compliance gate '${gateKind}' failed: ${JSON.stringify(gate.error)}`);
    }

    const assign = await coord.client.POST(
      "/api/v1/discipline-plans/{planId}/volunteer-assignments",
      {
        params: { path: { planId } },
        body: {
          volunteerMembershipId: volunteerId,
          activities: ["Companionship visits", "Light errands"],
          startsAt: nowIso(),
        },
      },
    );
    if (assign.error)
      throw new Error(`volunteer assignment failed: ${JSON.stringify(assign.error)}`);
    log.ok(
      "Volunteer plan: draft plan seeded, 2 compliance gates + volunteer assignment via real API",
    );
  } catch (err) {
    log.fail(`M15 volunteer plan: ${String(err)}`);
  }

  // ── M17 — Scheduling ───────────────────────────────────────────────────────────────────────────
  let visitId: string | null = null;
  try {
    const ritaId = await membershipIdFor("rita@wardenx.local");
    visitId = await seedPublishedVisit(
      rn.organizationId,
      patientId,
      admissionId,
      ritaId,
      addHours(24),
      addHours(25),
    );
    log.ok(
      "Scheduling: 1 visit published (tomorrow, Rita RN) — DB-seeded, POST /visits is unreachable in prod (see file header)",
    );
  } catch (err) {
    log.fail(`M17 scheduling: ${String(err)}`);
  }

  // ── M18 — EVV ──────────────────────────────────────────────────────────────────────────────────
  try {
    const dev = await rn.client.POST("/api/v1/evv/devices/self-register", {
      // The `attestationId` this used to pass was `crypto.randomUUID()` — the only caller in the
      // codebase, satisfying a REQUIRED uuid by inventing one, because no route mints a device
      // attestation id a client can hold (F-068 §3). The field is gone from the contract.
      body: { platform: "ios", modelDescription: "Demo iPhone" },
    });
    const devData = dev.data as unknown as { id: string } | undefined;
    if (dev.error || !devData)
      throw new Error(`device register failed: ${JSON.stringify(dev.error)}`);

    const approve = await supervisor.client.POST("/api/v1/evv/devices/{id}/approve", {
      params: { path: { id: devData.id } },
    });
    if (approve.error) throw new Error(`device approve failed: ${JSON.stringify(approve.error)}`);

    // A SECOND handset, deliberately left PENDING. The approve/reject ceremony is the only M18 write a
    // browser can drive at all — check-in/check-out is the Capacitor mobile flow (§5.2), because a
    // browser has no attested device and no §12.4 posture to report — and with the first device driven
    // straight to `approved` the supervisor roster had nothing to act on, so `/evv/devices/pending` was
    // permanently empty on a seeded stack and the action could not be exercised. Same shape as M11's
    // signature inbox (#91) and the billing spec #106/F-046 names: a queue whose only row is already
    // terminal, and a spec written against it that would assert the empty state forever.
    const pending = await rn.client.POST("/api/v1/evv/devices/self-register", {
      body: { platform: "android", modelDescription: "Demo Pixel — awaiting approval" },
    });
    if (pending.error)
      throw new Error(`second device register failed: ${JSON.stringify(pending.error)}`);

    log.ok(
      "EVV: device self-registered + approved, and a second left PENDING for the supervisor roster " +
        "(no completed visit yet to check in/out against — scheduled for tomorrow)",
    );
  } catch (err) {
    log.fail(`M18 EVV: ${String(err)}`);
  }
  void visitId;

  // ── M19 — On-Call Triage ───────────────────────────────────────────────────────────────────────
  try {
    await seedOncallPolicy(rn.organizationId);
    const providerEntityId = PROVIDER_ENTITY_ID;
    const ritaId = await membershipIdFor("rita@wardenx.local");
    const shift = await rn.client.POST("/api/v1/oncall/shifts", {
      body: {
        providerEntityId,
        shiftStartsAt: addHours(-1),
        shiftEndsAt: addHours(11),
        discipline: "clinical_rn",
        primaryOnCallMembershipId: ritaId,
        // The SOS `active_sos_responder` predicate's on-call arm needs the acknowledging/resolving
        // membership on this same shift's roster (`onCallForProviderEntity`) — supervisor@ backs it up.
        backupMembershipId: await membershipIdFor("supervisor@wardenx.local"),
      },
    });
    const shiftData = shift.data as unknown as { id: string; version: number } | undefined;
    if (shift.error || !shiftData)
      throw new Error(`on-call shift create failed: ${JSON.stringify(shift.error)}`);

    // A shift is created `scheduled`, not `active` — `oncall_eligible`'s shift path (and `m19.oncall_shift.
    // activated`, which M20's SOS coverage-lookup subscribes to) both require the explicit open transition.
    const open = await rn.client.POST("/api/v1/oncall/shifts/{shiftId}/open", {
      params: { path: { shiftId: shiftData.id } },
      headers: { "If-Match": String(shiftData.version) },
      body: {},
    });
    if (open.error) throw new Error(`on-call shift open failed: ${JSON.stringify(open.error)}`);

    const call = await rn.client.POST("/api/v1/triage-calls", {
      body: {
        providerEntityId,
        inboundChannel: "phone",
        callerKind: "caregiver",
        callerDisplayName: "Thomas Brandt-style caregiver — Arthur Whitfield",
        chiefComplaintText: "Caregiver reports increased shortness of breath overnight.",
      },
    });
    const callData = call.data as unknown as { triageCallId: string; version: number } | undefined;
    if (call.error || !callData)
      throw new Error(`triage call create failed: ${JSON.stringify(call.error)}`);

    const identify = await rn.client.POST("/api/v1/triage-calls/{triageCallId}/identify-patient", {
      params: { path: { triageCallId: callData.triageCallId } },
      headers: { "If-Match": String(callData.version) },
      body: { patientId, admissionId },
    });
    const identifyData = identify.data as unknown as { version: number } | undefined;
    if (identify.error || !identifyData)
      throw new Error(`identify-patient failed: ${JSON.stringify(identify.error)}`);

    // `selectDisposition` is only legal from `disposition_pending` (TRIAGE_CALL_EDGES,
    // `lifecycle/triage-call.ts`) — a call must walk a protocol first. "Other clinical concern"
    // (00000000-0019-0000-0000-000000000028) is the shortest platform-floor protocol (3 questions, no
    // mandatory escalation); its one red-flag question ("is anything time-critical?") is answered `false`
    // to avoid opening an unresolved escalation that would block `completeProtocol`.
    const OTHER_CLINICAL_CONCERN_PROTOCOL_ID = "00000000-0019-0000-0000-000000000028";
    const apply = await rn.client.POST("/api/v1/triage-calls/{triageCallId}/apply-protocol", {
      params: { path: { triageCallId: callData.triageCallId } },
      headers: { "If-Match": String(identifyData.version) },
      body: { triageProtocolId: OTHER_CLINICAL_CONCERN_PROTOCOL_ID },
    });
    const applyData = apply.data as unknown as { version: number } | undefined;
    if (apply.error || !applyData)
      throw new Error(`apply-protocol failed: ${JSON.stringify(apply.error)}`);

    // A DISCRIMINATED union, matching the route's own contract. The previous annotation was
    // `{ kind: "text" | "bool"; value: string | boolean }`, which is a wider type that admits the
    // invalid pairings (`kind: "text"` with a boolean) the contract rejects — so the seed could not
    // be checked against the endpoint it drives.
    const QUESTIONS: ReadonlyArray<{
      id: string;
      value: { kind: "text"; value: string } | { kind: "bool"; value: boolean };
    }> = [
      {
        id: "00000000-0019-0001-2801-000000000000",
        value: {
          kind: "text",
          value: "Caregiver reports increased shortness of breath overnight.",
        },
      },
      { id: "00000000-0019-0001-2802-000000000000", value: { kind: "bool", value: false } },
      { id: "00000000-0019-0001-2803-000000000000", value: { kind: "bool", value: true } },
    ];
    let answerVersion = applyData.version;
    for (const q of QUESTIONS) {
      const answer = await rn.client.POST("/api/v1/triage-calls/{triageCallId}/answers", {
        params: { path: { triageCallId: callData.triageCallId } },
        headers: { "If-Match": String(answerVersion) },
        body: { triageProtocolQuestionId: q.id, value: q.value },
      });
      const answerData = answer.data as unknown as { version: number } | undefined;
      if (answer.error || !answerData)
        throw new Error(`answer for question ${q.id} failed: ${JSON.stringify(answer.error)}`);
      answerVersion = answerData.version;
    }

    const complete = await rn.client.POST("/api/v1/triage-calls/{triageCallId}/complete-protocol", {
      params: { path: { triageCallId: callData.triageCallId } },
      headers: { "If-Match": String(answerVersion) },
    });
    const completeData = complete.data as unknown as { version: number } | undefined;
    if (complete.error || !completeData)
      throw new Error(`complete-protocol failed: ${JSON.stringify(complete.error)}`);

    const disposition = await rn.client.POST("/api/v1/triage-calls/{triageCallId}/disposition", {
      params: { path: { triageCallId: callData.triageCallId } },
      headers: { "If-Match": String(completeData.version) },
      body: {
        dispositionData: {
          disposition: "caregiver_education_only",
          educationSummary:
            "Reviewed positioning and breathing techniques with caregiver; advised to call back if worsening.",
          followUpCallAt: null,
        },
      },
    });
    if (disposition.error)
      throw new Error(`disposition failed: ${JSON.stringify(disposition.error)}`);

    log.ok(
      "On-call: shift opened, 1 triage call identified to Whitfield, dispositioned (education only)",
    );
  } catch (err) {
    log.fail(`M19 on-call: ${String(err)}`);
  }

  // ── M20 — Field Safety ─────────────────────────────────────────────────────────────────────────
  // `POST /api/v1/safety/incidents` is skipped on purpose, not a bug workaround: `write-service-drizzle.ts`'s
  // own header documents "Phase 1 has none [DEK] for M20" as a DELIBERATE, permanent-for-this-phase design
  // decision (`SAFETY_CIPHER_UNBOUND`, 503) — writing the narrative in the clear to fake it would make the
  // §3.7 erasure a lie, so unlike this file's other DB-direct workarounds, no seed shortcut is taken here.
  // The SOS press is the one path M20-F16/S13 guarantees NEVER refuses for a missing cipher (property 2 in
  // the same file header), so that alone carries this section.
  try {
    const sos = await rn.client.POST("/api/v1/safety/sos", {
      body: { capturedAt: nowIso() },
    });
    const sosData = sos.data as unknown as { id: string } | undefined;
    if (sos.error || !sosData) throw new Error(`SOS raise failed: ${JSON.stringify(sos.error)}`);

    // GENUINE GAP: a press lands `cancel_window_open`, and the SAFE_SOS_EDGES table (`lifecycle/sos-alert.
    // ts`) only reaches `acknowledging` — the one state `active_sos_responder` accepts — via the
    // `expireCancelWindow` command, which `m20.sos-sla-watchdog.cron` fires 5 seconds after the press
    // (§7.4). That cron is never registered anywhere under `apps/backend/src/bootstrap/` (confirmed by
    // grep), so in this environment no alert EVER leaves `cancel_window_open` on its own. This nudges the
    // one column the watchdog's own `expireCancelWindow` transition would flip — no cipher, no history
    // row invented, nothing this session's other DB-direct workarounds don't already do elsewhere.
    await (async () => {
      if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
      const dbc = new Client({ connectionString: ADMIN_URL });
      await dbc.connect();
      await dbc.query("SET session_replication_role = replica");
      await dbc.query(
        `UPDATE safety_sos_alert SET lifecycle_state = 'acknowledging' WHERE id = $1 AND lifecycle_state = 'cancel_window_open'`,
        [sosData.id],
      );
      await dbc.end();
    })();

    const ack = await supervisor.client.POST("/api/v1/safety/sos/{sosAlertId}/acknowledge", {
      params: { path: { sosAlertId: sosData.id } },
      body: {
        actionTaken:
          "Called clinician directly; confirmed a false alarm from an accidental button press.",
      },
    });
    if (ack.error) throw new Error(`SOS acknowledge failed: ${JSON.stringify(ack.error)}`);

    // `resolve` is skipped too, for the SAME reason incident-create is: `write-service-drizzle.ts`'s
    // ordinary (non-incident) resolve path ALSO unconditionally `seal()`s `resolutionNarrative` — "the
    // narrative column is nullable... but the WRITE PATH requires it... With no cipher bound the resolve
    // REFUSES rather than dropping the narrative." Confirmed live: SAFETY_CIPHER_UNBOUND, not a script bug.

    log.ok(
      "Field safety: 1 SOS alert raised + acknowledged (resolve + incident-create both skipped — SAFETY_CIPHER_UNBOUND is a permanent Phase-1 gap, see comments above)",
    );
  } catch (err) {
    log.fail(`M20 field safety: ${String(err)}`);
  }

  // ── M21 — Supplies / DME ───────────────────────────────────────────────────────────────────────
  try {
    const supplyReq = await rn.client.POST("/api/v1/supplies/supply-requests", {
      body: {
        patientId,
        admissionId,
        locationId: LOCATION_MAIN_ID,
        deliveryAddress: {
          line1: "42 Camellia Ln",
          city: "Asheville",
          state: "NC",
          postalCode: "28801",
        },
        kindPayload: {
          kind: "dme",
          skuId: crypto.randomUUID(),
          hcpcs: "E0250",
          hcpcsModifiers: [],
          quantity: 1,
          rentalCadence: "one_time_purchase",
          needsInstallation: true,
          needsPatientEducation: true,
        },
      },
    });
    if (supplyReq.error)
      throw new Error(`supply request failed: ${JSON.stringify(supplyReq.error)}`);

    const template = await rn.client.POST("/api/v1/supplies/comfort-kit-templates", {
      body: {
        name: "Standard D3 comfort kit",
        medications: [
          {
            rxnorm: "894801",
            drugName: "Morphine sulfate",
            strength: "20 mg/mL",
            dosageForm: "oral_solution",
            routeOfAdministration: "PO",
            isControlledSubstance: true,
            controlledSubstanceSchedule: "CII",
            expectedQuantity: "30",
            expectedUnit: "mL",
            replenishmentThresholdPct: "0.25",
          },
          {
            rxnorm: "801957",
            drugName: "Lorazepam",
            strength: "2 mg/mL",
            dosageForm: "oral_solution",
            routeOfAdministration: "PO",
            isControlledSubstance: true,
            controlledSubstanceSchedule: "CIV",
            expectedQuantity: "15",
            expectedUnit: "mL",
            replenishmentThresholdPct: "0.25",
          },
          {
            rxnorm: "197632",
            drugName: "Haloperidol",
            strength: "5 mg/mL",
            dosageForm: "oral_solution",
            routeOfAdministration: "PO",
            isControlledSubstance: false,
            expectedQuantity: "10",
            expectedUnit: "mL",
            replenishmentThresholdPct: "0.25",
          },
          {
            rxnorm: "197379",
            drugName: "Atropine sulfate",
            strength: "1%",
            dosageForm: "ophthalmic_solution",
            routeOfAdministration: "ophthalmic",
            isControlledSubstance: false,
            expectedQuantity: "5",
            expectedUnit: "mL",
            replenishmentThresholdPct: "0.25",
          },
        ],
      },
    });
    if (template.error)
      throw new Error(`comfort-kit template failed: ${JSON.stringify(template.error)}`);

    log.ok("Supplies: 1 DME request (hospital bed) + D3 comfort-kit template created");
  } catch (err) {
    log.fail(`M21 supplies: ${String(err)}`);
  }

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
