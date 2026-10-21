/**
 * ChartWarden — scope-demo scenario seed (local dev only).
 *
 * GAP-053 (M17 visit/proposal reads) and GAP-059 (M19 triage-call list) narrow reads to a clinician's caseload
 * (+ own-assigned visits / handled calls). A freshly seeded stack has ZERO visits and ZERO triage calls, so
 * neither can be proven live. This adds a small, tagged, ADDITIVE fixture set spread over in- and
 * out-of-caseload patients:
 *   - 4 visits (2 in caseload, 1 out, 1 out-of-caseload but assigned DIRECTLY to the demo clinician)
 *   - 2 visit proposals (1 in caseload, 1 out)
 *   - 5 triage calls (2 in caseload, 1 out, 1 unidentified caller with no patient, 1 out-of-caseload but
 *     HANDLED by the demo clinician via state history)
 *   plus one on-call shift they hang off (triage_call.on_call_shift_id is NOT NULL).
 *
 * SQL, like the other fixture seeds that need rows no route can create (a visit must pass the real ABAC /
 * credential gates; a triage call needs an open shift) — the point here is READ scoping, not write paths.
 * Idempotent: every row is keyed by a fixed UUID and `ON CONFLICT DO NOTHING`; re-runs insert nothing.
 * Never deletes. Does NOT grant permissions: the demo clinician still needs visit.read / triage.read.
 *
 * Usage: DATABASE_ADMIN_URL=<superuser url> bun run db:seed:scope-demo
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_ID = "b991d9e6-c459-4831-9543-cc00fb4cf6e2";
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001";
const ADMIN_EMAIL = "admin@chartwarden.local";
const CLINICIAN_EMAIL = "chrome-demo-1791166404690@chartwarden.local";
const TAG = "[scope-demo]";

/** Caseload of the demo clinician (open patient_assignment rows) / a patient outside it. */
const IN_A = "d37f5249-215c-41f9-8ae1-20116096a386";
const IN_B = "66c274b0-38ee-4368-bf76-49a1ccab481f";
const OUT = "0c8844c5-54c5-401b-9835-b3dc45441613";

const id = (n: number): string => `5c09e000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHIFT_ID = id(1);

interface VisitSpec {
  n: number;
  patientId: string;
  own: boolean;
  date: string;
  hour: number;
}
const VISITS: readonly VisitSpec[] = [
  { n: 10, patientId: IN_A, own: false, date: "2026-10-06", hour: 9 },
  { n: 11, patientId: IN_B, own: false, date: "2026-10-06", hour: 11 },
  { n: 12, patientId: OUT, own: false, date: "2026-10-06", hour: 13 },
  { n: 13, patientId: OUT, own: true, date: "2026-10-06", hour: 15 },
];
const PROPOSALS: readonly { n: number; patientId: string }[] = [
  { n: 20, patientId: IN_A },
  { n: 21, patientId: OUT },
];
interface CallSpec {
  n: number;
  patientId: string | null;
  handled: boolean;
  who: string;
}
const CALLS: readonly CallSpec[] = [
  { n: 30, patientId: IN_A, handled: false, who: "in-caseload caller A" },
  { n: 31, patientId: IN_B, handled: false, who: "in-caseload caller B" },
  { n: 32, patientId: OUT, handled: false, who: "out-of-caseload caller" },
  { n: 33, patientId: null, handled: false, who: "unidentified caller" },
  { n: 34, patientId: OUT, handled: true, who: "out-of-caseload, handled by demo clinician" },
];

async function one<T>(db: Client, sql: string, params: unknown[]): Promise<T> {
  const r = await db.query(sql, params);
  if (r.rows.length !== 1) throw new Error(`expected 1 row: ${sql} ${JSON.stringify(params)}`);
  return r.rows[0] as T;
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL session_replication_role = replica");
    const mem = async (email: string): Promise<string> =>
      (
        await one<{ id: string }>(
          db,
          `SELECT m.id FROM membership m JOIN "user" u ON u.id = m.user_id
          WHERE u.email = $1 AND m.organization_id = $2`,
          [email, ORG_ID],
        )
      ).id;
    const adminM = await mem(ADMIN_EMAIL);
    const clinM = await mem(CLINICIAN_EMAIL);
    let inserted = 0;

    const adm = async (patientId: string) =>
      one<{ id: string; location_id: string }>(
        db,
        `SELECT id, location_id FROM admission
        WHERE patient_id = $1 AND organization_id = $2 AND location_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
        [patientId, ORG_ID],
      );

    for (const v of VISITS) {
      const a = await adm(v.patientId);
      const start = `${v.date}T${String(v.hour).padStart(2, "0")}:00:00Z`;
      const end = `${v.date}T${String(v.hour + 1).padStart(2, "0")}:00:00Z`;
      const r = await db.query(
        `INSERT INTO visit (id, organization_id, provider_entity_id, location_id, patient_id, admission_id,
           assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
           scheduled_started_at, scheduled_ended_at, service_date, status, scheduler_internal_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'clinical_rn','routine_visit','telephonic',$8,$9,$10,'published',$11)
         ON CONFLICT DO NOTHING`,
        [
          id(v.n),
          ORG_ID,
          PROVIDER_ENTITY_ID,
          a.location_id,
          v.patientId,
          a.id,
          v.own ? clinM : adminM,
          start,
          end,
          v.date,
          TAG,
        ],
      );
      inserted += r.rowCount ?? 0;
    }
    for (const p of PROPOSALS) {
      const a = await adm(p.patientId);
      const r = await db.query(
        `INSERT INTO visit_proposal (id, organization_id, provider_entity_id, location_id, patient_id,
           admission_id, source, source_payload, source_idempotency_key, proposed_for_date,
           proposed_visit_purpose, proposed_discipline, proposed_duration_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,'frequency_driven_m7','{}'::jsonb,$7,'2026-10-07','routine_visit','clinical_rn',60)
         ON CONFLICT DO NOTHING`,
        [id(p.n), ORG_ID, PROVIDER_ENTITY_ID, a.location_id, p.patientId, a.id, `${TAG}-${p.n}`],
      );
      inserted += r.rowCount ?? 0;
    }

    inserted +=
      (
        await db.query(
          `INSERT INTO on_call_shift (id, organization_id, provider_entity_id, shift_starts_at, shift_ends_at,
         discipline, primary_on_call_membership_id, policy_snapshot, status, opened_at)
       VALUES ($1,$2,$3, now() - interval '1 hour', now() + interval '11 hours','clinical_rn',$4,
         '{"model":"direct"}'::jsonb,'active', now() - interval '1 hour')
       ON CONFLICT DO NOTHING`,
          [SHIFT_ID, ORG_ID, PROVIDER_ENTITY_ID, adminM],
        )
      ).rowCount ?? 0;

    for (const c of CALLS) {
      const a = c.patientId ? await adm(c.patientId) : null;
      const r = await db.query(
        `INSERT INTO triage_call (id, organization_id, provider_entity_id, on_call_shift_id, patient_id,
           admission_id, caller_kind, caller_display_name, inbound_channel, chief_complaint_text)
         VALUES ($1,$2,$3,$4,$5,$6,'caregiver',$7,'phone',$8) ON CONFLICT DO NOTHING`,
        [
          id(c.n),
          ORG_ID,
          PROVIDER_ENTITY_ID,
          SHIFT_ID,
          c.patientId,
          a?.id ?? null,
          `${TAG} ${c.who}`,
          `${TAG} ${c.who}`,
        ],
      );
      if ((r.rowCount ?? 0) === 0) continue;
      inserted += 1;
      // The state-history actor is what GAP-059's "handled by" arm keys on.
      await db.query(
        `INSERT INTO triage_call_state_history (organization_id, provider_entity_id, triage_call_id,
           from_state, to_state, actor_membership_id) VALUES ($1,$2,$3,NULL,'open',$4)`,
        [ORG_ID, PROVIDER_ENTITY_ID, id(c.n), c.handled ? clinM : adminM],
      );
    }
    await db.query("COMMIT");
    console.log(`scope-demo: inserted ${inserted} new row(s) (0 on a re-run)`);
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
