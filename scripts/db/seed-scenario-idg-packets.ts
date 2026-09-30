/**
 * WardenX — M14 IDG packets + FINAL minutes scenario data (local dev). NOT for production.
 *
 * Follows `seed-scenario-idg-meetings.ts`, whose meetings all ended up with 0 packets and no adjourned minutes.
 * ADDITIVE and idempotent — never wipes a care plan, encounter, assessment or admission, never deletes a row.
 *
 *   1. SIGNED CARE PLANS. M14's packet builder (`jobs/packet-build.ts`) refuses to fabricate a care-plan context:
 *      a patient with no `signed` care_plan_version is skipped (`no_signed_care_plan_version`). Whitfield and
 *      Nakamura had only an empty DRAFT v1. For each demo patient whose ADMISSION IS ACTIVE (Whitfield,
 *      Nakamura, Delgado) and whose plan has no signed version, this drives the real M7 API exactly as
 *      `seed-scenario-clinical-core.ts` does — add a problem/goal/interventions if the plan is empty, finalize,
 *      then RN (rita, rn_case_manager) and MD (drharris, hospice_physician) sign — using the repo's established
 *      step-up stand-in (`lib/step-up.ts`, which writes the same `session.last_step_up_*` fields a completed
 *      ceremony writes) immediately before each gated signature. Plans that already have a signed version are left
 *      alone.
 *      Delgado (transfer-in) is included once `db:seed:scenario-delgado-active` has activated her admission (the M6
 *      D9 fix); until then `ensureSignedCarePlan` skips her as "admission is not active".
 *   2. STALE MEETINGS. The Inpatient Unit `packets_ready` meeting the previous script produced has 0 packets and
 *      can no longer be rebuilt (the machine has no packets_ready -> packets_building edge), so it is CANCELLED
 *      (real cancel route, with a reason) if it still has no packets. The old empty LIVE meeting cannot be
 *      cancelled (live -> only ADJOURN) and is left as-is.
 *   3. NEW IPU MEETINGS (slots keyed by duration among non-cancelled meetings in [now-36h, now+9d], so existing
 *      ones are resumed): READY (63 min, +20h, agenda + packets_ready), LIVE (93 min, started + quorum +
 *      decisions, packets present and unfrozen), FINAL (48 min, started, quorate, decisions + an action item,
 *      then ADJOURNED with a step-up so a FINAL `idg_minutes` row + snapshot and FROZEN packets exist — through
 *      the real adjourn route, nothing hand-written).
 *      The packet handler is run once via `run-idg-packet-build.ts` (the deployed cron's org enumerator is bound to
 *      the tenant pool — see that script's header — so it builds nothing on the Docker stack).
 *
 * `--plans-only` runs just step 1 (care plans, level of care, terminal ICD-10) and exits; `--recert-only` runs step 1
 * then only a dedicated `recert` meeting (3-patient agenda, packets built, not started).
 *
 * Prereqs: db:seed, db:seed:org-admin, db:seed:staff, db:seed:org-structure, db:seed:scenario-admissions,
 * db:seed:scenario-idg-meetings; backend + redis running; DATABASE_ADMIN_URL set (admin DB URL, for the step-up
 * nudge). The app-role URL for the packet handler is read from the `worker` container (or IDG_APP_DATABASE_URL).
 * Run: DATABASE_ADMIN_URL=... BETTER_AUTH_URL=http://localhost:3000 bun run db:seed:scenario-idg-packets
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { ScenarioLog, type WxSession, findPatientIdByLastName, signIn } from "./lib/api-session";
import { stepUpSession } from "./lib/step-up";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const LOC_IPU = "55555555-0000-4000-8000-000000000002";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const log = new ScenarioLog("IDG packets + final minutes (M14)");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function must<T>(
  what: string,
  p: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok)
    throw new Error(`${what}: HTTP ${r.response.status} ${JSON.stringify(r.error)}`);
  return r.data as T;
}

async function sql<T extends Record<string, unknown>>(
  q: string,
  args: unknown[] = [],
): Promise<T[]> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    return (await db.query(q, args)).rows as T[];
  } finally {
    await db.end();
  }
}

const TERMINAL_ICD10: Record<string, string> = {
  Whitfield: "C34.90",
  Nakamura: "C25.9",
  Delgado: "I50.9",
};

/** M14's packet builder also requires a terminal diagnosis (ICD-10 + label) on the plan: the `terminal` problem's
 * `icd10_code`. Set it through the real PATCH problem route (If-Match = the problem's own row version); a no-op
 * once present. Works on an already-signed/active plan (no new version is drafted). */
async function ensureTerminalIcd10(rn: WxSession, name: string): Promise<void> {
  const rows = await sql<{ id: string; plan: string; v: number; code: string | null }>(
    `SELECT pr.id, pr.care_plan_id plan, pr.version v, pr.icd10_code code
       FROM problem pr JOIN care_plan cp ON cp.id = pr.care_plan_id JOIN patient pa ON pa.id = cp.patient_id
      WHERE pa.legal_last_name = $1 AND pr.kind = 'terminal' AND pr.status = 'active' LIMIT 1`,
    [name],
  );
  const r = rows[0];
  if (!r) return;
  if (r.code) {
    log.dup(`${name}: terminal problem already has ICD-10 ${r.code}`);
    return;
  }
  const res = (await rn.client.PATCH(
    "/api/v1/care-plans/{planId}/problems/{elementId}" as never,
    {
      params: {
        path: { planId: r.plan, elementId: r.id },
        header: { "If-Match": `"${r.v}"`, "Idempotency-Key": crypto.randomUUID() },
      },
      body: { icd10Code: TERMINAL_ICD10[name] ?? "C80.1" },
    } as never,
  )) as { response: Response; error?: unknown };
  if (res.error !== undefined || !res.response.ok)
    throw new Error(
      `${name} icd10 patch: HTTP ${res.response.status} ${JSON.stringify(res.error)}`,
    );
  log.ok(`${name}: terminal problem ICD-10 ${TERMINAL_ICD10[name] ?? "C80.1"} set (PATCH problem)`);
}

/** The packet's level-of-care cover field comes from M6's `level_of_care_period`; activation alone writes none
 * (`seed-scenario-admission-outcomes.ts` posts the initial period but never checks the result, and it was missing
 * for the active demo admissions -> `no_level_of_care`). Post the initial routine-home-care period through the
 * real M6 route, only for an active admission that has no period yet. */
async function ensureLevelOfCare(admin: WxSession, name: string): Promise<void> {
  const rows = await sql<{ id: string; n: string }>(
    `SELECT a.id, (SELECT count(*)::text FROM level_of_care_period l WHERE l.admission_id = a.id) n
       FROM admission a JOIN patient p ON p.id = a.patient_id
      WHERE p.legal_last_name = $1 AND a.status = 'active' LIMIT 1`,
    [name],
  );
  const a = rows[0];
  if (!a) return;
  if (a.n !== "0") {
    log.dup(`${name}: level-of-care period already present`);
    return;
  }
  await must(
    `${name} level of care`,
    admin.client.POST("/api/v1/admissions/{id}/level-of-care", {
      params: { path: { id: a.id } },
      body: {
        newLevel: "routine_home_care",
        effectiveStart: new Date().toISOString().slice(0, 10),
        reason: "Initial routine home care level at admission.",
      },
    }),
  );
  log.ok(`${name}: routine_home_care level-of-care period recorded (M6 route)`);
}

// ── 1. signed care plans ───────────────────────────────────────────────────────────────────────────────────
async function ensureSignedCarePlan(
  admin0: WxSession,
  rn: WxSession,
  md: WxSession,
  name: string,
): Promise<void> {
  const patientId = await findPatientIdByLastName(admin0, name);
  const adm = await sql<{ id: string; status: string }>(
    "SELECT id, status FROM admission WHERE patient_id = $1 AND status = 'active' LIMIT 1",
    [patientId],
  );
  const admissionId = adm[0]?.id;
  if (!admissionId) {
    log.blocked(`${name}: admission is not active — no additive precedent to activate it; skipped`);
    return;
  }
  // Plan + versions read straight from the tables (read-only): the GET response shape is not needed for that.
  type PlanRead = {
    id?: string;
    versions?: Array<{ id: string; status: string; version: number }>;
  };
  const read = async (): Promise<PlanRead | undefined> => {
    const cp = await sql<{ id: string }>("SELECT id FROM care_plan WHERE patient_id = $1 LIMIT 1", [
      patientId,
    ]);
    const id = cp[0]?.id;
    if (!id) return undefined;
    const versions = await sql<{ id: string; status: string; version: number }>(
      "SELECT id, status, version FROM care_plan_version WHERE care_plan_id = $1 ORDER BY sequence",
      [id],
    );
    return { id, versions };
  };
  let plan = await read();
  if (plan?.versions?.some((v) => v.status === "signed")) {
    log.dup(`${name}: care plan already has a signed version`);
    await ensureTerminalIcd10(rn, name);
    return;
  }
  if (!plan?.id) {
    const boot = await must<{ id: string }>(
      `${name} care-plan bootstrap`,
      rn.client.POST("/api/v1/patients/{patientId}/care-plan", {
        params: { path: { patientId } },
        body: { admissionId },
      }),
    );
    plan = { id: boot.id };
  }
  const planId = plan.id as string;
  const counts = await sql<{ p: string }>(
    "SELECT count(*)::text p FROM problem WHERE care_plan_id = $1",
    [planId],
  );
  if (counts[0]?.p === "0") {
    const problem = await must<{ id: string }>(
      `${name} problem`,
      rn.client.POST("/api/v1/care-plans/{planId}/problems", {
        params: { path: { planId } },
        body: {
          description: "Advanced illness with progressive functional decline and symptom burden.",
          kind: "terminal",
          source: "clinical",
        },
      }),
    );
    await rn.client.POST("/api/v1/care-plans/{planId}/goals", {
      params: { path: { planId } },
      body: {
        problemId: problem.id,
        originalText: "Patient will report comfort at or below 3/10 on a 0-10 scale.",
        source: "clinical",
        measurableOutcome: "Symptom score <=3/10 on routine assessment.",
      },
    });
    await rn.client.POST("/api/v1/care-plans/{planId}/interventions", {
      params: { path: { planId } },
      body: {
        problemId: problem.id,
        scopeText:
          "RN case management visits to assess symptoms and coordinate the IDG plan of care.",
        frequencyText: "Twice weekly",
        frequencyValue: "2x/week",
        discipline: "rn",
      },
    });
    log.ok(`${name}: care plan content added (1 problem, 1 goal, 1 intervention)`);
  }
  const draft = async (): Promise<{ id: string; version: number; status: string }> => {
    const v = (await read())?.versions?.find(
      (x) => x.status === "draft" || x.status === "in_review",
    );
    if (!v) throw new Error(`${name}: no draft/in_review care-plan version`);
    return v;
  };
  const v1 = await draft();
  if (v1.status === "draft") {
    await must(
      `${name} finalize`,
      rn.client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/finalize", {
        params: { path: { planId, versionId: v1.id } },
        body: {
          ifVersion: v1.version,
          requiredSignerSet: [
            { role: "rn_case_manager", count: 1 },
            { role: "hospice_physician", count: 1 },
          ],
        },
      }),
    );
  }
  const signAs = async (who: WxSession, role: string): Promise<void> => {
    const v = await draft();
    await stepUpSession(who.userId);
    await must(
      `${name} sign ${role}`,
      who.client.POST("/api/v1/care-plans/{planId}/versions/{versionId}/signatures", {
        params: { path: { planId, versionId: v.id } },
        body: { ifVersion: v.version, signerRole: role } as never,
      }),
    );
  };
  await signAs(rn, "rn_case_manager");
  await signAs(md, "hospice_physician");
  log.ok(`${name}: care plan finalized + signed (RN + MD; step-up via lib/step-up.ts)`);
  await ensureTerminalIcd10(rn, name);
}

// ── meetings ───────────────────────────────────────────────────────────────────────────────────────────────
interface MeetingRow {
  id: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}
const minutesOf = (m: MeetingRow): number =>
  Math.round((Date.parse(m.scheduledEnd) - Date.parse(m.scheduledStart)) / MIN);
const statusOf = async (a: WxSession, id: string): Promise<string> =>
  (
    await must<{ status: string }>(
      "meeting",
      a.client.GET("/api/v1/idg/meetings/{id}", { params: { path: { id } } }),
    )
  ).status;

async function schedule(a: WxSession): Promise<MeetingRow[]> {
  const now = Date.now();
  return must<MeetingRow[]>(
    "schedule",
    a.client.GET("/api/v1/idg/schedule", {
      params: {
        query: {
          location: LOC_IPU,
          from: new Date(now - 36 * HOUR).toISOString(),
          to: new Date(now + 9 * DAY).toISOString(),
        },
      },
    }),
  );
}

type Slot = "ready" | "live" | "final" | "recert";
const SLOT: Record<Slot, { minutes: number; startInMs: number }> = {
  ready: { minutes: 63, startInMs: 20 * HOUR },
  live: { minutes: 93, startInMs: 3 * MIN },
  final: { minutes: 48, startInMs: 3 * MIN },
  // Recert-window meeting: due inside the T-24h lookahead so the packet handler builds it, and left `packets_ready`
  // (never started) so it carries Whitfield + Nakamura + Delgado packets and shows the 3-patient recert pane.
  recert: { minutes: 57, startInMs: 21 * HOUR },
};

async function ensureMeeting(a: WxSession, slot: Slot): Promise<string> {
  const all = (await schedule(a)).filter(
    (m) => m.status !== "cancelled" && m.status !== "rescheduled",
  );
  const ex = all.find((m) => minutesOf(m) === SLOT[slot].minutes);
  if (ex) {
    log.dup(`${slot} meeting exists (${ex.id}, ${ex.status})`);
    return ex.id;
  }
  // The API refuses overlapping meetings at a location, so bump the start past any window it would collide with
  // (a meeting can be STARTED before its scheduled time, so a later window is fine for the live/final flows).
  let startMs = Date.now() + SLOT[slot].startInMs;
  const len = SLOT[slot].minutes * MIN;
  for (const m of [...all].sort(
    (x, y) => Date.parse(x.scheduledStart) - Date.parse(y.scheduledStart),
  )) {
    if (
      startMs < Date.parse(m.scheduledEnd) + MIN &&
      startMs + len + MIN > Date.parse(m.scheduledStart)
    )
      startMs = Date.parse(m.scheduledEnd) + 2 * MIN;
  }
  const start = new Date(startMs);
  const end = new Date(start.getTime() + SLOT[slot].minutes * MIN);
  const c = await must<{ id: string }>(
    `create ${slot}`,
    a.client.POST("/api/v1/idg/meetings", {
      params: { header: { "Idempotency-Key": crypto.randomUUID() } },
      body: {
        locationId: LOC_IPU,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      },
    }),
  );
  log.ok(`${slot} meeting scheduled (${c.id}, ${start.toISOString()})`);
  return c.id;
}

async function ensureAgenda(
  a: WxSession,
  id: string,
  pts: Array<{ name: string; id: string }>,
): Promise<void> {
  const have = await must<Array<{ kind: string; patientId: string | null }>>(
    "agenda",
    a.client.GET("/api/v1/idg/meetings/{id}/agenda", { params: { path: { id } } }),
  );
  const wanted: Array<{ kind: string; patientId?: string }> = [
    ...pts.map((p) => ({ kind: "patient_review", patientId: p.id })),
    { kind: "administrative_note" },
  ];
  for (const w of wanted) {
    if (have.some((h) => h.kind === w.kind && (h.patientId ?? null) === (w.patientId ?? null)))
      continue;
    await must(
      "agenda add",
      a.client.POST("/api/v1/idg/meetings/{id}/agenda", {
        params: { path: { id } },
        body: w as never,
      }),
    );
  }
  log.ok(`agenda ensured for ${id}`);
}

async function requestBuild(a: WxSession, id: string): Promise<void> {
  if ((await statusOf(a, id)) !== "scheduled") return;
  await must(
    "build",
    a.client.POST("/api/v1/idg/meetings/{id}/packets/build", { params: { path: { id } } }),
  );
  log.ok(`packets/build requested (${id})`);
}

function runPacketBuild(): boolean {
  let url = process.env.IDG_APP_DATABASE_URL;
  if (!url) {
    const p = spawnSync("docker", ["compose", "exec", "-T", "worker", "printenv", "DATABASE_URL"], {
      encoding: "utf8",
    });
    const out = (p.stdout ?? "").trim();
    if (p.status === 0 && out) url = out.replace("@postgres:", "@localhost:");
  }
  if (!url) return false;
  return (
    spawnSync("bun", ["run", "scripts/db/run-idg-packet-build.ts"], {
      env: { ...process.env, DATABASE_URL: url, REDIS_URL: "redis://localhost:6379" },
      stdio: "inherit",
    }).status === 0
  );
}

const packetCount = async (id: string): Promise<number> =>
  Number(
    (
      await sql<{ n: string }>(
        "SELECT count(*)::text n FROM idg_patient_packet WHERE idg_meeting_id = $1",
        [id],
      )
    )[0]?.n,
  );

const ATTENDEES = [
  { email: "admin@wardenx.local", discipline: "administrator" },
  { email: "orgadmin@wardenx.local", discipline: "administrator" },
  { email: "rita@wardenx.local", discipline: "rn_case_manager" },
  { email: "drharris@wardenx.local", discipline: "hospice_physician" },
  { email: "cole@wardenx.local", discipline: "chaplain" },
  { email: "mira@wardenx.local", discipline: "msw" },
];

/** start (if packets_ready) -> quorate attendance -> decisions -> one action item. Returns the live status. */
async function conduct(
  a: WxSession,
  id: string,
  pts: Array<{ name: string; id: string }>,
  mem: Map<string, string>,
): Promise<void> {
  const st = await statusOf(a, id);
  if (st === "adjourned") {
    log.dup(`${id} already adjourned`);
    return;
  }
  if (st === "packets_ready") {
    await must(
      "start",
      a.client.POST("/api/v1/idg/meetings/{id}/start", { params: { path: { id } } }),
    );
    log.ok(`meeting started (${id})`);
  } else if (st !== "live") throw new Error(`${id} is '${st}', expected packets_ready/live`);
  const att = await must<Array<{ membershipId: string }>>(
    "attendance",
    a.client.GET("/api/v1/idg/meetings/{id}/attendance", { params: { path: { id } } }),
  );
  for (const p of ATTENDEES) {
    const m = mem.get(p.email);
    if (!m || att.some((x) => x.membershipId === m)) continue;
    await must(
      `attend ${p.email}`,
      a.client.POST("/api/v1/idg/meetings/{id}/attendance", {
        params: { path: { id } },
        body: { membershipId: m, discipline: p.discipline, status: "present" },
      }),
    );
  }
  const dec = await must<Array<{ patientId: string | null; decisionKind: string }>>(
    "decisions",
    a.client.GET("/api/v1/idg/meetings/{id}/decisions", { params: { path: { id } } }),
  );
  const decide = async (
    patientId: string,
    payload: Record<string, unknown>,
  ): Promise<string | undefined> => {
    if (dec.some((d) => d.patientId === patientId && d.decisionKind === payload.kind))
      return undefined;
    const r = await must<{ id: string }>(
      `decision ${String(payload.kind)}`,
      a.client.POST("/api/v1/idg/meetings/{id}/decisions", {
        params: { path: { id } },
        body: { patientId, payload } as never,
      }),
    );
    return r.id;
  };
  const [pw, pn] = pts;
  let firstDecision: string | undefined;
  if (pw)
    firstDecision = await decide(pw.id, {
      kind: "team_note",
      noteText: "Pain controlled on current regimen; family coping well. Continue routine care.",
    });
  if (pn)
    await decide(pn.id, {
      kind: "level_of_care_consideration",
      consideredLevel: "routine",
      rationaleText: "Symptom burden stable; no indication for a higher level of care this cycle.",
    });
  const items = await must<Array<{ meetingId: string }>>(
    "items",
    a.client.GET("/api/v1/idg/action-items", { params: { query: {} } }),
  );
  const rita = mem.get("rita@wardenx.local");
  if (rita && pw && !items.some((x) => x.meetingId === id)) {
    await must(
      "action item",
      a.client.POST("/api/v1/idg/meetings/{id}/action-items", {
        params: { path: { id } },
        body: {
          patientId: pw.id,
          assignedToMembershipId: rita,
          dueDate: new Date(Date.now() + 3 * DAY).toISOString(),
          ...(firstDecision ? { decisionId: firstDecision } : {}),
        },
      }),
    );
  }
  log.ok(`conducted ${id}: attendance (quorate) + decisions + action item`);
}

/** rita / drharris were scoped to the Main Office only, but the demo admissions (and so their care plans) sit at
 * the Inpatient Unit, so M7 404s their care-plan writes. Union the IPU into their `default_location_ids` via the
 * real M2 member-scope route (union-only, never removes an assignment) — same precedent as
 * `seed-scenario-idg-meetings.ts` step 0 for the admin personas. */
async function ensureClinicianIpuScope(admin: WxSession): Promise<void> {
  const rows = await sql<{ email: string; id: string; loc: string[] }>(
    `SELECT u.email, m.id, m.default_location_ids AS loc FROM membership m JOIN "user" u ON u.id = m.user_id
     WHERE u.email = ANY($1)`,
    [["rita@wardenx.local", "drharris@wardenx.local"]],
  );
  for (const r of rows) {
    if (r.loc.includes(LOC_IPU)) {
      log.dup(`${r.email} already scoped to the Inpatient Unit`);
      continue;
    }
    await must(
      `scope ${r.email}`,
      admin.client.PATCH("/api/v1/orgs/{id}/members/{mId}", {
        params: { path: { id: admin.organizationId, mId: r.id } },
        body: { defaultLocationIds: [...new Set([...r.loc, LOC_IPU])] } as never,
      }),
    );
    log.ok(`${r.email}: default_location_ids += Inpatient Unit (via PATCH members)`);
  }
}

/** `caseload_or_scope` (M7 care-plan routes, `notFoundOnDeny`) is satisfied by an OPEN `patient_assignment` row for
 * the calling user. The demo patients currently have none, so rita/drharris get a 404 on the care plan. Same
 * SQL anchor `seed-staff-personas.ts#anchorDemoCaseload` / `seed-clinical.ts` write (primary_rn = rita,
 * attending_clinician = the MD); ADDITIVE: only inserted where the patient has no open row for that role. */
async function ensureCaseload(names: string[]): Promise<void> {
  const users = await sql<{ email: string; id: string }>(
    `SELECT email, id FROM "user" WHERE email IN ('rita@wardenx.local','drharris@wardenx.local')`,
  );
  const uid = (e: string): string | undefined => users.find((u) => u.email === e)?.id;
  for (const name of names) {
    const pat = await sql<{ id: string; organization_id: string }>(
      "SELECT id, organization_id FROM patient WHERE legal_last_name = $1 LIMIT 1",
      [name],
    );
    const p = pat[0];
    if (!p) continue;
    for (const [role, email] of [
      ["primary_rn", "rita@wardenx.local"],
      ["attending_clinician", "drharris@wardenx.local"],
    ] as const) {
      const u = uid(email);
      if (!u) continue;
      const open = await sql(
        "SELECT 1 FROM patient_assignment WHERE patient_id = $1 AND role = $2 AND clinician_user_id = $3 AND unassigned_at IS NULL",
        [p.id, role, u],
      );
      if (open.length > 0) {
        log.dup(`${name}: open ${role} assignment for ${email} exists`);
        continue;
      }
      // A stale open row anchored to a since-deleted user id (the persona seed drops+recreates users) would trip
      // the one-open-primary_rn unique index; CLOSE it (never delete) — only when its clinician no longer exists.
      await sql(
        `UPDATE patient_assignment SET unassigned_at = CURRENT_DATE
          WHERE patient_id = $1 AND role = $2 AND unassigned_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM "user" x WHERE x.id = clinician_user_id)`,
        [p.id, role],
      );
      await sql(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,$4, CURRENT_DATE)`,
        [p.id, p.organization_id, u, role],
      );
      log.ok(`${name}: ${role} -> ${email} (patient_assignment, caseload anchor)`);
    }
  }
}

async function main(): Promise<void> {
  const admin = await signIn("admin@wardenx.local");
  await ensureClinicianIpuScope(admin);
  await ensureCaseload(["Whitfield", "Nakamura", "Delgado"]);
  const rn = await signIn("rita@wardenx.local");
  const md = await signIn("drharris@wardenx.local");
  const pts: Array<{ name: string; id: string }> = [];
  for (const name of ["Whitfield", "Nakamura", "Delgado"])
    pts.push({ name, id: await findPatientIdByLastName(admin, name) });

  // 1
  let plansOk = true;
  for (const n of ["Whitfield", "Nakamura", "Delgado"]) {
    try {
      await ensureLevelOfCare(admin, n);
      await ensureSignedCarePlan(admin, rn, md, n);
    } catch (e) {
      plansOk = false;
      log.fail(`${n} care plan: ${String(e)}`);
    }
  }
  // `--plans-only`: stop after the care-plan/level-of-care/ICD-10 prerequisites (no meeting create/start/adjourn) —
  // used to bring one more patient (e.g. Delgado) to packet-eligible without touching any meeting.
  if (process.argv.includes("--plans-only")) {
    log.summary();
    process.exit(plansOk ? 0 : 1);
  }
  if (!plansOk) {
    // Without signed plans the builder (correctly) produces 0 packets; do not create/start meetings on top of that.
    log.summary();
    process.exit(1);
  }

  // `--recert-only`: after the prerequisites above, ensure ONLY the `recert` meeting (all three patients on the agenda,
  // packets built, not started). Touches no other meeting — used to give Delgado (activated later than the others) a
  // packet without disturbing the ready/live/final meetings.
  if (process.argv.includes("--recert-only")) {
    let id = await ensureMeeting(admin, "recert");
    // A packets_ready meeting cannot be rebuilt (no packets_ready -> packets_building edge). If it was built before every
    // patient was packet-eligible (e.g. before Delgado's care plan was signed), cancel it (real route) and start fresh.
    if ((await statusOf(admin, id)) === "packets_ready" && (await packetCount(id)) < pts.length) {
      await must(
        "cancel incomplete recert meeting",
        admin.client.POST("/api/v1/idg/meetings/{id}/cancel", {
          params: { path: { id } },
          body: {
            proposedTransition: "cancel",
            reason: "Superseded: rebuilt once every demo patient is packet-eligible (dev scenario)",
          } as never,
        }),
      );
      log.ok(`cancelled incomplete recert meeting ${id}`);
      id = await ensureMeeting(admin, "recert");
    }
    if ((await statusOf(admin, id)) === "scheduled") await ensureAgenda(admin, id, pts);
    await requestBuild(admin, id);
    if ((await statusOf(admin, id)) === "packets_building") {
      if (!runPacketBuild()) log.blocked("packet handler could not run (no app-role DB URL)");
      for (let i = 0; i < 20 && (await statusOf(admin, id)) === "packets_building"; i++)
        await sleep(2000);
    }
    const c = await packetCount(id);
    (c > 0 ? log.ok : log.fail).call(
      log,
      `recert ${id}: status=${await statusOf(admin, id)} packets=${c}`,
    );
    console.log(`\nRecert meeting (Inpatient Unit ${LOC_IPU}): ${id}`);
    log.summary();
    return;
  }

  const mem = new Map(
    (
      await sql<{ email: string; id: string }>(
        `SELECT u.email, m.id FROM membership m JOIN "user" u ON u.id = m.user_id`,
      )
    ).map((r) => [r.email, r.id]),
  );

  // 2 stale packets_ready IPU meetings with 0 packets from the previous script (60-min "tomorrow" slot)
  for (const m of await schedule(admin)) {
    if (
      m.status === "packets_ready" &&
      [60, 63, 93, 48].includes(minutesOf(m)) &&
      (await packetCount(m.id)) === 0
    ) {
      try {
        await must(
          "cancel stale",
          admin.client.POST("/api/v1/idg/meetings/{id}/cancel", {
            params: { path: { id: m.id } },
            body: {
              proposedTransition: "cancel",
              reason: "Superseded: rebuilt with signed care plans (dev scenario)",
            } as never,
          }),
        );
        log.ok(`cancelled stale empty packets_ready meeting ${m.id}`);
      } catch (e) {
        log.fail(String(e));
      }
    }
  }

  // 3
  const fin = await ensureMeeting(admin, "final");
  const live = await ensureMeeting(admin, "live");
  const ready = await ensureMeeting(admin, "ready");
  for (const id of [ready, live, fin]) {
    if ((await statusOf(admin, id)) === "scheduled") await ensureAgenda(admin, id, pts);
    await requestBuild(admin, id);
  }
  const pending: string[] = [];
  for (const id of [ready, live, fin])
    if ((await statusOf(admin, id)) === "packets_building") pending.push(id);
  if (pending.length > 0) {
    if (!runPacketBuild()) log.blocked("packet handler could not run (no app-role DB URL)");
    for (let i = 0; i < 20; i++) {
      const s = await Promise.all(pending.map((id) => statusOf(admin, id)));
      if (s.every((x) => x !== "packets_building")) break;
      await sleep(2000);
    }
  }
  for (const [n, id] of [
    ["ready", ready],
    ["live", live],
    ["final", fin],
  ] as const) {
    const c = await packetCount(id);
    (c > 0 ? log.ok : log.fail).call(
      log,
      `${n} ${id}: status=${await statusOf(admin, id)} packets=${c}`,
    );
  }

  // live + final are conducted; only `final` is adjourned. NEVER start a meeting that has no packets: the state
  // machine has no way back from live, and a live/adjourned meeting without packets defeats the scenario.
  for (const id of [live, fin]) {
    if ((await packetCount(id)) === 0 && (await statusOf(admin, id)) === "packets_ready") {
      log.blocked(
        `${id}: 0 packets (care plans unsigned?) — NOT started; fix the cause and re-run`,
      );
      continue;
    }
    try {
      await conduct(admin, id, pts, mem);
    } catch (e) {
      log.fail(String(e));
    }
  }
  if ((await statusOf(admin, fin)) === "live" && (await packetCount(fin)) > 0) {
    try {
      await stepUpSession(admin.userId); // lib/step-up.ts — same stand-in as care-plan signing
      await must(
        "adjourn",
        admin.client.POST("/api/v1/idg/meetings/{id}/adjourn", {
          params: { path: { id: fin } },
          body: {} as never,
        }),
      );
      log.ok(`adjourned ${fin} (step-up stand-in) -> final minutes + frozen packets`);
    } catch (e) {
      log.fail(String(e));
    }
  } else log.dup(`final meeting is '${await statusOf(admin, fin)}' (not adjourned by this run)`);

  console.log(
    `\nMeetings (Inpatient Unit ${LOC_IPU}):\n  ready=${ready}\n  live=${live}\n  final=${fin}`,
  );
  console.log("Patients:", pts.map((p) => `${p.name}=${p.id}`).join(" "));
  log.summary();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
