/**
 * ChartWarden — bring the transfer-in demo patient (Rosa Delgado) to `admission.active` (local dev). NOT for production.
 *
 * Root cause this script works around no longer: activation of a transfer-in admission was a real M6 bug
 * (fixed in `admission-route-service-db.ts`, D9). `gateFacts` looked for `election_period.sequence_number = 1`,
 * but a transfer-in has no period 1 — `transferIn` inserts the INHERITED period (carried sequence, already
 * `active`) plus the NEXT pending one — so the gate found no period, could never see the election statement, and
 * demanded a CTI that D9 says the receiving hospice does not owe on the inherited period. Activation now gates on
 * the inherited period: election statement + NOR + admission details, no CTI/F2F on it. This script therefore only
 * needs the ordinary ceremony steps `seed-scenario-admission-outcomes.ts`'s Delgado block stops short of:
 * sign the election statement on the inherited period, then activate.
 *
 * ADDITIVE and idempotent — never wipes anything, drives the real REST API, and every step is skipped when its
 * effect is already present (already-active admission ⇒ nothing to do). Steps:
 *   1. NOR (only if the admission has none) and admission details (`admissionAt`, only if unset).
 *   2. Election statement on the inherited period: draft (if none) then patient-sign.
 *   3. Activate, sited at the Inpatient Unit — where Whitfield/Nakamura are sited and where the M14 IDG packet
 *      scenario schedules its meetings (packet inclusion is keyed on the ADMISSION's location). An admission already
 *      sited elsewhere (e.g. Main Office) is re-sited to the Inpatient Unit through `PATCH /admissions/{id}`.
 *   4. Book the period-3 face-to-face inside its open window (if none), as the outcomes script intends.
 *   5. `patient.status = 'active'` — the SAME direct-SQL stand-in for the missing M5 consumer that
 *      `seed-scenario-admission-outcomes.ts` `syncPatientStatus()` documents (no M5 consumer of
 *      `m6.admission.activated` exists yet); a no-op if already active.
 *   6. One-off REPAIR for a row written before `transferIn` dated the inherited period from
 *      `priorElectionStartDate`: if the inherited period has no `effective_at`, stamp it
 *      `[today-80, +89]` (the same 90-day window `transferIn` now writes). A no-op on any admission created by
 *      the current code. This is the one hand-written SQL beyond the step-up/patient-status precedent, and it
 *      exists only for pre-fix dev rows — re-running `db:seed:scenario-admissions` (which wipes + re-drives
 *      all 6 demo patients) makes it unnecessary.
 *
 * Prereqs: db:seed:scenario-admissions has run (Delgado has a transfer-in admission); backend running with the
 * D9 fix; DATABASE_ADMIN_URL set (admin DB URL: status stand-in + repair + one version read).
 * Run: DATABASE_ADMIN_URL=... BETTER_AUTH_URL=http://localhost:3000 bun run db:seed:scenario-delgado-active
 */
import { Client } from "pg";
import { ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const ATTENDING = "11111111-0000-4000-8000-000000000002"; // Marcus Tillman DO (db:seed:mdm)
const NOR_FORM_VERSION_ID = "00000000-0000-4000-8000-000000000001";
const PATIENT_NAME = "Rosa Delgado";

const daysFromToday = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function sql<T extends Record<string, unknown>>(
  q: string,
  args: unknown[] = [],
): Promise<T[]> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("SET session_replication_role = replica");
    return (await db.query(q, args)).rows as T[];
  } finally {
    await db.end();
  }
}

interface CertPeriod {
  id: string;
  sequenceNumber: number;
  status: string;
  effectiveAt: string | null;
  electionStatement?: { id: string; status: string } | null;
  faceToFace?: unknown;
}
interface CertView {
  admission?: { id: string; state: string; version: number; admissionAt: string | null };
  periods?: CertPeriod[];
}

async function main(): Promise<void> {
  const log = new ScenarioLog("Delgado transfer-in → active");
  const session = await signIn("admin@chartwarden.local");
  const physician = await signIn("drharris@chartwarden.local");
  const patientId = await findPatientIdByLastName(session, "Delgado");

  const readCert = async (): Promise<CertView> => {
    const r = await session.client.GET("/api/v1/patients/{patientId}/election-certification", {
      params: { path: { patientId } },
    });
    return (r.data ?? {}) as unknown as CertView;
  };

  const ipuLocationId = async (): Promise<string> => {
    const locations = await session.client.GET("/api/v1/locations", {
      params: { query: { providerEntityId: PROVIDER_ENTITY_ID, status: "active" } },
    });
    const id = (
      locations.data as { items?: Array<{ id: string; name: string }> } | undefined
    )?.items?.find((l) => l.name.includes("Inpatient"))?.id;
    if (!id) throw new Error("no active Inpatient Unit location — run db:seed:org-structure");
    return id;
  };

  let cert = await readCert();
  const admissionId = cert.admission?.id;
  if (!admissionId)
    throw new Error("Delgado has no admission — run db:seed:scenario-admissions first");
  const inherited = [...(cert.periods ?? [])].sort(
    (a, b) => a.sequenceNumber - b.sequenceNumber,
  )[0];
  const next = (cert.periods ?? []).find((p) => p.status === "pending");
  if (!inherited)
    throw new Error("Delgado's admission has no election periods (not a transfer-in?)");

  if (cert.admission?.state !== "active") {
    // 1. NOR + admission details.
    const nor = await sql<{ n: string }>(
      "SELECT count(*)::text n FROM notice_of_rights_acknowledgment WHERE admission_id = $1",
      [admissionId],
    );
    if (nor[0]?.n === "0") {
      const r = await session.client.POST("/api/v1/admissions/{id}/nor", {
        params: { path: { id: admissionId } },
        body: {
          formVersionId: NOR_FORM_VERSION_ID,
          deliveryMethod: "verbal_with_witness",
          acknowledgedAt: new Date().toISOString(),
          acknowledgedByName: PATIENT_NAME,
          acknowledgedByRole: "patient",
        },
      });
      if (r.error) throw new Error(`NOR failed: ${JSON.stringify(r.error)}`);
    }
    cert = await readCert();
    if (!cert.admission?.admissionAt) {
      const r = await session.client.PATCH("/api/v1/admissions/{id}", {
        params: { path: { id: admissionId } },
        body: {
          admissionAt: `${daysFromToday(-1)}T12:00:00.000Z`,
          ifVersion: cert.admission?.version ?? 1,
        },
      });
      if (r.error) throw new Error(`admission details failed: ${JSON.stringify(r.error)}`);
      cert = await readCert();
    }

    // 2. Election statement on the INHERITED period: draft if absent, then patient-sign.
    let esId = cert.periods?.find((p) => p.id === inherited.id)?.electionStatement?.id;
    let esStatus = cert.periods?.find((p) => p.id === inherited.id)?.electionStatement?.status;
    if (!esId) {
      const es = await session.client.POST("/api/v1/admissions/{id}/election-statements", {
        params: { path: { id: admissionId } },
        body: {
          electionPeriodId: inherited.id,
          effectiveDate: daysFromToday(-1),
          primaryDiagnosisIcd10: "C34.90",
          electedProviderEntityId: PROVIDER_ENTITY_ID,
          electedAttendingPhysicianId: ATTENDING,
          waiverAcknowledged: true,
        },
      });
      const d = es.data as unknown as { id: string } | undefined;
      if (es.error || !d)
        throw new Error(`election statement create failed: ${JSON.stringify(es.error)}`);
      esId = d.id;
      esStatus = "drafted";
    }
    if (esStatus !== "signed") {
      const v = await sql<{ version: string }>(
        "SELECT version::text FROM election_statement WHERE id = $1",
        [esId],
      );
      const sign = await session.client.POST("/api/v1/election-statements/{id}/sign", {
        params: { path: { id: esId } },
        body: {
          signingPatientName: PATIENT_NAME,
          signingRole: "patient",
          ifVersion: Number(v[0]?.version ?? 0),
        },
      });
      if (sign.error)
        throw new Error(`election statement sign failed: ${JSON.stringify(sign.error)}`);
    }

    // 3. Activate, sited at the Inpatient Unit (resolved through the real M1 directory route).
    cert = await readCert();
    const locationId = await ipuLocationId();
    const act = await session.client.POST("/api/v1/admissions/{id}/activate", {
      params: { path: { id: admissionId } },
      body: { ifVersion: cert.admission?.version ?? 1, locationId },
    });
    if (act.error) throw new Error(`activate failed: ${JSON.stringify(act.error)}`);
    log.ok("Delgado: transfer-in admission activated (inherited period, no CTI/F2F owed on it)");
  } else {
    log.ok("Delgado: admission already active — activation skipped");
  }

  // 3b. Ensure the (now active) admission is sited at the Inpatient Unit — no-op when it already is.
  const ipu = await ipuLocationId();
  const sited = await sql<{ location_id: string | null }>(
    "SELECT location_id FROM admission WHERE id = $1",
    [admissionId],
  );
  if (sited[0]?.location_id !== ipu) {
    cert = await readCert();
    const r = await session.client.PATCH("/api/v1/admissions/{id}", {
      params: { path: { id: admissionId } },
      body: { locationId: ipu, ifVersion: cert.admission?.version ?? 1 },
    });
    if (r.error) throw new Error(`re-siting failed: ${JSON.stringify(r.error)}`);
    log.ok("Delgado: admission sited at the Inpatient Unit");
  }

  // 4. Period-3 face-to-face inside its open window (if none booked).
  if (next && !cert.periods?.find((p) => p.id === next.id)?.faceToFace) {
    const existing = await sql<{ n: string }>(
      "SELECT count(*)::text n FROM face_to_face_encounter WHERE election_period_id = $1",
      [next.id],
    );
    if (existing[0]?.n === "0") {
      const f2f = await session.client.POST("/api/v1/admissions/{id}/face-to-face", {
        params: { path: { id: admissionId } },
        body: {
          electionPeriodId: next.id,
          scheduledDate: daysFromToday(3),
          windowStart: daysFromToday(-20),
          windowEnd: daysFromToday(9),
          clinicianRole: "hospice_md",
          scheduledClinicianId: physician.userId,
        },
      });
      if (f2f.error) log.fail(`Delgado: F2F booking failed: ${JSON.stringify(f2f.error)}`);
      else log.ok("Delgado: period-3 face-to-face booked inside its open window");
    }
  }

  // 5. patient.status stand-in for the (unimplemented) M5 consumer of m6.admission.activated.
  await sql(
    "UPDATE patient SET status = 'active', updated_at = now() WHERE id = $1 AND status <> 'active'",
    [patientId],
  );

  // 6. Repair a pre-fix undated inherited period (no-op on rows the current transferIn wrote).
  const repaired = await sql<{ id: string }>(
    `UPDATE election_period
        SET effective_at = $2::date, scheduled_end_at = ($2::date + 89), updated_at = now()
      WHERE id = $1 AND effective_at IS NULL AND status = 'active'
      RETURNING id`,
    [inherited.id, daysFromToday(-80)],
  );
  if (repaired.length)
    log.ok("Delgado: dated the undated inherited period [today-80, +89] (pre-fix row repair)");

  log.summary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
