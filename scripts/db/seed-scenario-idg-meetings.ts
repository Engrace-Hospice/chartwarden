/**
 * WardenX — M14 IDG meeting scenario data (local dev). NOT for production.
 *
 * Builds real IDG meetings — one UPCOMING (`scheduled`, a few days out), one with packets BUILT
 * (`packets_ready`, tomorrow) and one LIVE (started, quorate) — at each demo location, entirely through the
 * REAL REST API as signed-in personas, so RLS / ABAC / the meeting state machine are exercised honestly:
 *
 *   0. ADMIN LOCATION SCOPE. `admin@` / `orgadmin@` are created before any location exists, so their
 *      membership carried `default_location_ids = []` and `idg_meeting_scope` (which requires the meeting's
 *      location in the caller's session location set) 403'd every meeting read. This script assigns them the
 *      two demo locations through `PATCH /api/v1/orgs/:id/members/:mId` (the real M2 member-scope route;
 *      union-only, never removes an assignment). `db:seed:org-structure` now does the same for a fresh seed.
 *   1. Per location: schedule (`POST /idg/meetings`), agenda (patient_review x3 + administrative_note +
 *      carry_forward), `POST .../packets/build`, then start / attendance / decisions / action items.
 *
 * Location choice. Packet inclusion (M6 `idgPacketInclusionForOrg`) is keyed on the ADMISSION's location, and
 * the demo admissions (Whitfield, Nakamura) are sited at the Inpatient Unit, not the Main Office. So the
 * Main Office meetings carry the full agenda/attendance/decision/action-item flow but their packet build is
 * legitimately empty (0 included patients); the Inpatient Unit meetings can build REAL packets once the
 * admitted patients have a SIGNED care-plan version (M14 packet-build refuses to fabricate one). Coordinator
 * at both = Ada (admin), the persona operating the UI.
 *
 * Packet build. `POST .../packets/build` flips the meeting to `packets_building` and enqueues an `on-demand`
 * job on `idg.packets-cron` (only when a worker + Redis are running; the seed's API stack may have neither); the
 * packets themselves are inserted by that job or by the hourly `idg.packets-cron` handler (`jobs/packet-build.ts`,
 * only for meetings starting within T-24h). The deployed worker's active-org enumerator is now bound to the platform pool (index.ts
 * `m14ActiveOrgs`), but a local seed stack may run no worker at all, so this script still runs that same handler
 * once via `db:idg:packet-build`, then polls (the older "cron is a no-op" note in `run-idg-packet-build.ts` is stale).
 *
 * Gaps deliberately NOT faked:
 *   - Adjourn needs FRESH STEP-UP (a passkey/TOTP ceremony); there is no dev bypass, so no meeting is
 *     adjourned and no minutes are finalised. The LIVE meetings are left in session for the D13 ceremony.
 *   - A decision recorded while NON-quorate is refused by the real `quorate_decision` ABAC (403); the script
 *     attempts one and logs the refusal — it cannot be seeded through the API.
 *
 * Idempotent per rolling window: a "slot" is identified by (location, duration) among non-cancelled meetings
 * starting within [now-36h, now+9d]; existing slots are resumed, never duplicated. Every write step is
 * guarded by a read of what already exists. Non-destructive: never deletes.
 * Prereqs: db:seed, db:seed:org-admin, db:seed:staff, db:seed:org-structure, db:seed:scenario-admissions (+
 * clinical, for packet care-plan data). Backend + worker + redis running.
 * Run:     BETTER_AUTH_URL=http://localhost:3000 bun run db:seed:scenario-idg-meetings
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { ScenarioLog, type WxSession, findPatientIdByLastName, signIn } from "./lib/api-session";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const LOC_MAIN = "55555555-0000-4000-8000-000000000001";
const LOC_IPU = "55555555-0000-4000-8000-000000000002";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Slot = "live" | "tomorrow" | "upcoming";
/** Slot key = meeting duration in minutes (the only field the API lets us pick that survives a re-read). */
const SLOT_MINUTES: Record<Slot, number> = { live: 90, tomorrow: 60, upcoming: 75 };

interface MeetingRow {
  id: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
}

const log = new ScenarioLog("IDG meetings (M14)");

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function membershipIds(): Promise<Map<string, { id: string; locations: string[] }>> {
  return withDb(async (db) => {
    const r = await db.query<{ email: string; id: string; loc: string[] }>(
      `SELECT u.email, m.id, m.default_location_ids AS loc FROM membership m JOIN "user" u ON u.id = m.user_id`,
    );
    return new Map(r.rows.map((x) => [x.email, { id: x.id, locations: x.loc }]));
  });
}

/** Unwrap an openapi-fetch result or throw with the server's error body. */
async function must<T>(
  what: string,
  p: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) {
    throw new Error(`${what}: HTTP ${r.response.status} ${JSON.stringify(r.error)}`);
  }
  return r.data as T;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

// ── 0. admin location scope (real M2 API) ──────────────────────────────────────────────────────────────────
async function ensureAdminLocationScope(admin: WxSession): Promise<void> {
  const members = await membershipIds();
  for (const email of ["admin@wardenx.local", "orgadmin@wardenx.local"]) {
    const m = members.get(email);
    if (!m) {
      log.fail(`${email}: no membership`);
      continue;
    }
    const want = [...new Set([...m.locations, LOC_MAIN, LOC_IPU])];
    if (want.length === m.locations.length) {
      log.dup(`${email} already assigned to both demo locations`);
      continue;
    }
    await must(
      `assign locations to ${email}`,
      admin.client.PATCH("/api/v1/orgs/{id}/members/{mId}", {
        params: { path: { id: admin.organizationId, mId: m.id } },
        body: { defaultLocationIds: want } as never,
      }),
    );
    log.ok(`${email}: default_location_ids -> Main Office + Inpatient Unit (via PATCH members)`);
  }
}

// ── slots ──────────────────────────────────────────────────────────────────────────────────────────────────
async function scheduleFor(actor: WxSession, loc: string): Promise<MeetingRow[]> {
  const now = Date.now();
  const rows = await must<MeetingRow[]>(
    `schedule ${loc}`,
    actor.client.GET("/api/v1/idg/schedule", {
      params: {
        query: {
          location: loc,
          from: new Date(now - 36 * HOUR).toISOString(),
          to: new Date(now + 9 * DAY).toISOString(),
        },
      },
    }),
  );
  return rows.filter((m) => m.status !== "cancelled" && m.status !== "rescheduled");
}

const minutesOf = (m: MeetingRow): number =>
  Math.round((Date.parse(m.scheduledEnd) - Date.parse(m.scheduledStart)) / MIN);

async function ensureMeeting(actor: WxSession, loc: string, slot: Slot): Promise<string> {
  const existing = (await scheduleFor(actor, loc)).find((m) => minutesOf(m) === SLOT_MINUTES[slot]);
  if (existing) {
    log.dup(
      `${slot} meeting at ${loc.slice(-1)} already exists (${existing.id}, ${existing.status})`,
    );
    return existing.id;
  }
  const start =
    slot === "live"
      ? new Date(Date.now() + 2 * MIN)
      : slot === "tomorrow"
        ? new Date(Date.now() + 20 * HOUR) // inside the worker's T-24h lookahead
        : new Date(Date.now() + 3 * DAY); // outside it: stays `scheduled`
  const end = new Date(start.getTime() + SLOT_MINUTES[slot] * MIN);
  const created = await must<{ id: string }>(
    `schedule ${slot} meeting`,
    actor.client.POST("/api/v1/idg/meetings", {
      params: { header: { "Idempotency-Key": crypto.randomUUID() } },
      body: {
        locationId: loc,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      },
    }),
  );
  log.ok(`${slot} meeting scheduled at ${loc.slice(-1)} (${created.id}, ${start.toISOString()})`);
  return created.id;
}

interface AgendaRow {
  kind: string;
  patientId: string | null;
}

async function ensureAgenda(
  actor: WxSession,
  meetingId: string,
  patients: Array<{ name: string; id: string }>,
): Promise<void> {
  const have = await must<AgendaRow[]>(
    "agenda list",
    actor.client.GET("/api/v1/idg/meetings/{id}/agenda", { params: { path: { id: meetingId } } }),
  );
  const wanted: Array<{ kind: string; patientId?: string; label: string }> = [
    ...patients.map((p) => ({
      kind: "patient_review",
      patientId: p.id,
      label: `patient_review ${p.name}`,
    })),
    { kind: "administrative_note", label: "administrative_note" },
    // carry_forward: an open item from the prior IDG about the first patient (the §2.7 carry-forward row).
    ...(patients[0]
      ? [
          {
            kind: "carry_forward",
            patientId: patients[0].id,
            label: `carry_forward ${patients[0].name}`,
          },
        ]
      : []),
  ];
  for (const w of wanted) {
    if (have.some((h) => h.kind === w.kind && (h.patientId ?? null) === (w.patientId ?? null))) {
      log.dup(`agenda: ${w.label} present`);
      continue;
    }
    try {
      await must(
        `agenda ${w.label}`,
        actor.client.POST("/api/v1/idg/meetings/{id}/agenda", {
          params: { path: { id: meetingId } },
          body: { kind: w.kind, patientId: w.patientId } as never,
        }),
      );
      log.ok(`agenda: ${w.label}`);
    } catch (err) {
      log.fail(String(err));
    }
  }
}

async function statusOf(actor: WxSession, meetingId: string): Promise<string> {
  const m = await must<{ status: string }>(
    "meeting read",
    actor.client.GET("/api/v1/idg/meetings/{id}", { params: { path: { id: meetingId } } }),
  );
  return m.status;
}

async function requestBuild(actor: WxSession, meetingId: string): Promise<void> {
  if ((await statusOf(actor, meetingId)) !== "scheduled") return;
  await must(
    "build packets",
    actor.client.POST("/api/v1/idg/meetings/{id}/packets/build", {
      params: { path: { id: meetingId } },
    }),
  );
  log.ok(`packets/build requested (${meetingId}) -> packets_building`);
}

/**
 * Run the real `idg.packets-cron` handler once (see `run-idg-packet-build.ts` for why the deployed cron
 * cannot do this itself). Needs the app-role URL the Docker stack uses; taken from `IDG_APP_DATABASE_URL`, or
 * read from the running `worker` container. Returns false (logged as blocked) when neither is available.
 */
async function runPacketBuild(): Promise<boolean> {
  let url = process.env.IDG_APP_DATABASE_URL;
  if (!url) {
    const p = spawnSync("docker", ["compose", "exec", "-T", "worker", "printenv", "DATABASE_URL"], {
      encoding: "utf8",
    });
    const out = (p.stdout ?? "").trim();
    if (p.status === 0 && out) url = out.replace("@postgres:", "@localhost:");
  }
  if (!url) return false;
  const proc = spawnSync("bun", ["run", "scripts/db/run-idg-packet-build.ts"], {
    env: { ...process.env, DATABASE_URL: url, REDIS_URL: "redis://localhost:6379" },
    stdio: "inherit",
  });
  return proc.status === 0;
}

async function waitReady(actor: WxSession, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < 40; i++) {
    let pending = 0;
    for (const id of ids) {
      const s = await statusOf(actor, id);
      out.set(id, s);
      if (s === "packets_building" || s === "scheduled") pending++;
    }
    if (pending === 0) break;
    await sleep(3000);
  }
  return out;
}

// ── live-meeting conduct ───────────────────────────────────────────────────────────────────────────────────
interface Persona {
  email: string;
  discipline: string;
}
const ATTENDEES: Persona[] = [
  { email: "admin@wardenx.local", discipline: "administrator" },
  { email: "orgadmin@wardenx.local", discipline: "administrator" },
  { email: "rita@wardenx.local", discipline: "rn_case_manager" },
  { email: "drharris@wardenx.local", discipline: "hospice_physician" },
  { email: "cole@wardenx.local", discipline: "chaplain" },
  { email: "mira@wardenx.local", discipline: "msw" },
];

async function conductLive(
  meetingId: string,
  coord: WxSession,
  patients: Array<{ name: string; id: string }>,
  mem: Map<string, { id: string }>,
): Promise<void> {
  const status = await statusOf(coord, meetingId);
  if (status === "packets_ready") {
    await must(
      "start meeting",
      coord.client.POST("/api/v1/idg/meetings/{id}/start", { params: { path: { id: meetingId } } }),
    );
    log.ok("meeting started -> live");
  } else if (status !== "live") {
    log.fail(`live meeting ${meetingId} is '${status}', cannot start (expected packets_ready)`);
    return;
  } else log.dup("meeting already live");

  // Attendance: RN + MD + chaplain first (NOT quorate — MSW seat empty), so the refusal below is real.
  const attendance = await must<Array<{ membershipId: string }>>(
    "attendance list",
    coord.client.GET("/api/v1/idg/meetings/{id}/attendance", {
      params: { path: { id: meetingId } },
    }),
  );
  const record = async (p: Persona, st: "present" | "tardy"): Promise<void> => {
    const m = mem.get(p.email);
    if (!m) throw new Error(`no membership for ${p.email}`);
    if (attendance.some((a) => a.membershipId === m.id)) {
      log.dup(`attendance: ${p.email} present`);
      return;
    }
    await must(
      `attendance ${p.email}`,
      coord.client.POST("/api/v1/idg/meetings/{id}/attendance", {
        params: { path: { id: meetingId } },
        body: { membershipId: m.id, discipline: p.discipline, status: st },
      }),
    );
    log.ok(`attendance: ${p.email} (${p.discipline}) ${st}`);
  };
  const decisions0 = await must<
    Array<{ id: string; patientId: string | null; decisionKind: string }>
  >(
    "decision list",
    coord.client.GET("/api/v1/idg/meetings/{id}/decisions", {
      params: { path: { id: meetingId } },
    }),
  );
  for (const p of ATTENDEES.filter((a) => a.email !== "mira@wardenx.local"))
    await record(p, "present");

  if (decisions0.length === 0) {
    // Non-quorate attempt: the real `quorate_decision` ABAC must refuse it. Logged, never faked.
    const attempt = await coord.client.POST("/api/v1/idg/meetings/{id}/decisions", {
      params: { path: { id: meetingId } },
      body: {
        patientId: patients[0]?.id ?? null,
        payload: { kind: "team_note", noteText: "Recorded before the MSW joined (non-quorate)." },
      },
    });
    if (attempt.response.status === 403)
      log.blocked(
        "non-quorate decision: refused 403 by quorate_decision ABAC (correct) — cannot be seeded via the API",
      );
    else log.ok(`non-quorate decision unexpectedly accepted (HTTP ${attempt.response.status})`);
  }
  // MSW joins late -> tardy still counts toward quorum.
  await record({ email: "mira@wardenx.local", discipline: "msw" }, "tardy");

  const decide = async (
    patientId: string | null,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<string | undefined> => {
    const dup = decisions0.find(
      (d) => d.patientId === patientId && d.decisionKind === (payload.kind as string),
    );
    if (dup) {
      log.dup(`decision: ${label} present`);
      return dup.id;
    }
    try {
      const d = await must<{ id: string }>(
        `decision ${label}`,
        coord.client.POST("/api/v1/idg/meetings/{id}/decisions", {
          params: { path: { id: meetingId } },
          body: { patientId, payload } as never,
        }),
      );
      log.ok(`decision: ${label}`);
      return d.id;
    } catch (err) {
      log.fail(String(err));
      return undefined;
    }
  };
  const [pw, pn, pd] = patients;
  const dTeam = pw
    ? await decide(
        pw.id,
        {
          kind: "team_note",
          noteText:
            "Pain controlled on current regimen; family coping well. Continue routine home care.",
        },
        "team_note Whitfield",
      )
    : undefined;
  if (pw)
    await decide(
      pw.id,
      {
        kind: "level_of_care_consideration",
        consideredLevel: "routine",
        rationaleText:
          "Symptom burden stable; no indication for a higher level of care this cycle.",
      },
      "level_of_care_consideration Whitfield",
    );
  const dMed = pn
    ? await decide(
        pn.id,
        {
          kind: "medication_recommendation",
          recommendations: [
            {
              recommendationKind: "change_dose",
              drugLabel: "Lorazepam",
              proposedStrength: "0.5 mg",
              proposedRoute: "sublingual",
              proposedFrequency: "every 6 hours as needed",
              triggeringProblemId: null,
              rationaleText: "Breakthrough anxiety overnight per RN report.",
            },
          ],
        },
        "medication_recommendation Nakamura",
      )
    : undefined;
  const dRecert = pd
    ? await decide(
        pd.id,
        {
          kind: "recertification_consideration",
          periodIndex: 2,
          rationaleText: "Continued decline supports recertification for the next benefit period.",
        },
        "recertification_consideration Delgado",
      )
    : undefined;

  // Action items — a mix of overdue / due-soon / later, assigned across the personas.
  const existingItems = await must<Array<{ meetingId: string }>>(
    "action-item list",
    coord.client.GET("/api/v1/idg/action-items", { params: { query: {} } }),
  );
  if (existingItems.some((a) => a.meetingId === meetingId)) {
    log.dup("action items already present for this meeting");
    return;
  }
  const due = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
  const items: Array<{
    who: string;
    days: number;
    patientId: string | null;
    decisionId?: string;
    label: string;
  }> = [
    {
      who: "rita@wardenx.local",
      days: -6,
      patientId: pw?.id ?? null,
      decisionId: dTeam,
      label: "RN follow-up visit (overdue 6d)",
    },
    {
      who: "mira@wardenx.local",
      days: -2,
      patientId: pd?.id ?? null,
      decisionId: dRecert,
      label: "MSW caregiver assessment (overdue 2d)",
    },
    {
      who: "cole@wardenx.local",
      days: -1,
      patientId: pw?.id ?? null,
      label: "Chaplain spiritual-care visit (overdue 1d)",
    },
    {
      who: "drharris@wardenx.local",
      days: 2,
      patientId: pn?.id ?? null,
      decisionId: dMed,
      label: "MD to sign comfort-med change (due 2d)",
    },
    {
      who: "admin@wardenx.local",
      days: -3,
      patientId: pw?.id ?? null,
      label: "Administrator: confirm Whitfield IDG documentation (overdue 3d)",
    },
    {
      who: "orgadmin@wardenx.local",
      days: 4,
      patientId: null,
      label: "Org admin: review IDG cadence policy (due 4d)",
    },
    {
      who: "rita@wardenx.local",
      days: 6,
      patientId: null,
      label: "Team-level action, no patient (due 6d)",
    },
  ];
  for (const it of items) {
    const m = mem.get(it.who);
    if (!m) continue;
    try {
      await must(
        `action item ${it.label}`,
        coord.client.POST("/api/v1/idg/meetings/{id}/action-items", {
          params: { path: { id: meetingId } },
          body: {
            patientId: it.patientId,
            assignedToMembershipId: m.id,
            dueDate: due(it.days),
            ...(it.decisionId ? { decisionId: it.decisionId } : {}),
          },
        }),
      );
      log.ok(`action item: ${it.label} -> ${it.who}`);
    } catch (err) {
      log.fail(String(err));
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const admin = await signIn("admin@wardenx.local");
  await ensureAdminLocationScope(admin);
  const mem = await membershipIds();

  const patients: Array<{ name: string; id: string }> = [];
  for (const name of ["Whitfield", "Nakamura", "Delgado"]) {
    patients.push({ name, id: await findPatientIdByLastName(admin, name) });
  }

  // Ada (admin) coordinates and records everything at both locations — she is the persona operating the UI,
  // and the IDG permissions/location scope she needs are what this scenario proves. Clinicians fill the
  // quorum seats (recorded on their behalf: attendance takes a membershipId).
  const targets: Array<{ loc: string; name: string; coord: WxSession }> = [
    { loc: LOC_MAIN, name: "Main Office", coord: admin },
    { loc: LOC_IPU, name: "Inpatient Unit", coord: admin },
  ];

  const ids = new Map<string, { live: string; tomorrow: string; upcoming: string }>();
  for (const t of targets) {
    console.log(`\n── ${t.name} (${t.loc}) ──`);
    const live = await ensureMeeting(t.coord, t.loc, "live");
    const tomorrow = await ensureMeeting(t.coord, t.loc, "tomorrow");
    const upcoming = await ensureMeeting(t.coord, t.loc, "upcoming");
    ids.set(t.loc, { live, tomorrow, upcoming });
    for (const id of [live, tomorrow, upcoming]) await ensureAgenda(t.coord, id, patients);
    await requestBuild(t.coord, live);
    await requestBuild(t.coord, tomorrow);
  }

  // One cron run builds every due meeting (live + tomorrow slots, both locations). Admin can read both.
  const pending: string[] = [];
  for (const t of targets) {
    const v = ids.get(t.loc);
    if (!v) continue;
    for (const id of [v.live, v.tomorrow]) {
      if ((await statusOf(admin, id)) === "packets_building") pending.push(id);
    }
  }
  if (pending.length > 0) {
    if (await runPacketBuild()) log.ok("ran the real packets-cron handler for the demo org");
    else
      log.blocked(
        "could not run the packet-build handler (no app-role DB URL): set IDG_APP_DATABASE_URL or run `bun run db:idg:packet-build`",
      );
    for (const [id, s] of await waitReady(admin, pending)) {
      if (s === "packets_ready" || s === "live") log.ok(`packets built: ${id} -> ${s}`);
      else
        log.blocked(
          `packets not built for ${id} (status '${s}') — the packets-cron worker did not complete; rerun after it does`,
        );
    }
  }

  for (const t of targets) {
    const v = ids.get(t.loc);
    if (!v) continue;
    console.log(`\n── conduct live meeting: ${t.name} ──`);
    await conductLive(v.live, t.coord, patients, mem);
  }

  console.log("\nMeeting ids:");
  for (const t of targets) {
    const v = ids.get(t.loc);
    if (v) console.log(`  ${t.name}: live=${v.live} tomorrow=${v.tomorrow} upcoming=${v.upcoming}`);
  }
  log.blocked(
    "adjourn / final minutes: needs FRESH STEP-UP (passkey/TOTP ceremony); no dev bypass exists and the seed will not fake it",
  );
  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
