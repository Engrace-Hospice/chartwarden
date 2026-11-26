/**
 * ChartWarden — ESAS-r series for the visit-note composer prompts (local dev). NOT for production.
 *
 * The composer's symptom prompts and the M9 severe-item alert read ESAS-r captures. `seed-scenario-clinical-core.ts`
 * records ONE capture whose items all sit at 6 or below, so neither the alert nor a rising series is ever visible. This
 * adds four profiles over the real REST API as `rita@chartwarden.local` (rn), one per behaviour a reviewer wants to see:
 *
 *   - Whitfield  → three captures, rising: pain and tiredness reach 7 (severe, M9 `esas_symptom_ge_7`), and the total
 *                  grows by well over 20% (`esas_total_increase_20_in_7d`). The flagship composer demo.
 *   - Okonkwo    → one capture with five items at 7 or more (pain 8, tiredness 9, lack of appetite 7, shortness of
 *                  breath 8, wellbeing 8): several severe items on one record.
 *   - Delgado    → one capture with items at 4 to 5 and none at 7: the composer's advisory prompt (benchmark 4) with NO
 *                  M9 alert, so the two thresholds can be told apart.
 *   - Yarbrough  → one capture with every item at 3 or below: no prompt, no alert (the negative control).
 *
 * All values are invented. Each capture carries `otherSymptomText = MARKER`; a patient that already has a capture with
 * that text is skipped, so a re-run adds nothing. `capturedAt` is spread over past days but never earlier than the
 * admission's activation (M9 refuses a capture that precedes it) and never in the future.
 *
 * Local dev only: refuses a non-local database or NODE_ENV (`assertLocalDevSeed`) and is NOT in `db:seed:all`, which production's
 * reseed workflow expands and runs.
 *
 * Prereqs: bun run db:seed:staff, db:seed:scenario-admissions (+ db:seed:scenario-delgado-active); DATABASE_ADMIN_URL.
 * Run:     bun run db:seed:scenario-composer-esas
 */
import { Client } from "pg";
import { API, ScenarioLog, findPatientIdByLastName, signIn } from "./lib/api-session";
import type { WxSession } from "./lib/api-session";
import { assertLocalDevSeed } from "./lib/local-seed-guard";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const MARKER = "demo series: composer ESAS-r";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SPACING_DAYS = 2;

interface EsasItems {
  readonly pain: number;
  readonly tiredness: number;
  readonly drowsiness: number;
  readonly nausea: number;
  readonly lackOfAppetite: number;
  readonly shortnessOfBreath: number;
  readonly depression: number;
  readonly anxiety: number;
  readonly wellbeing: number;
}

interface Profile {
  readonly lastName: string;
  readonly summary: string;
  /** Oldest first. */
  readonly captures: readonly EsasItems[];
}

export const PROFILES: readonly Profile[] = [
  {
    lastName: "Whitfield",
    summary: "rising series, pain and tiredness reach 7",
    captures: [
      {
        pain: 3,
        tiredness: 5,
        drowsiness: 3,
        nausea: 1,
        lackOfAppetite: 4,
        shortnessOfBreath: 3,
        depression: 2,
        anxiety: 2,
        wellbeing: 4,
      },
      {
        pain: 5,
        tiredness: 6,
        drowsiness: 4,
        nausea: 2,
        lackOfAppetite: 5,
        shortnessOfBreath: 5,
        depression: 3,
        anxiety: 3,
        wellbeing: 5,
      },
      {
        pain: 7,
        tiredness: 7,
        drowsiness: 5,
        nausea: 2,
        lackOfAppetite: 6,
        shortnessOfBreath: 6,
        depression: 3,
        anxiety: 4,
        wellbeing: 6,
      },
    ],
  },
  {
    lastName: "Okonkwo",
    summary: "five items at 7 or more",
    captures: [
      {
        pain: 8,
        tiredness: 9,
        drowsiness: 6,
        nausea: 4,
        lackOfAppetite: 7,
        shortnessOfBreath: 8,
        depression: 4,
        anxiety: 6,
        wellbeing: 8,
      },
    ],
  },
  {
    lastName: "Delgado",
    summary: "items at 4 to 5, none at 7 (prompt, no alert)",
    captures: [
      {
        pain: 4,
        tiredness: 5,
        drowsiness: 3,
        nausea: 4,
        lackOfAppetite: 5,
        shortnessOfBreath: 5,
        depression: 3,
        anxiety: 4,
        wellbeing: 4,
      },
    ],
  },
  {
    lastName: "Yarbrough",
    summary: "every item at 3 or below (no prompt, no alert)",
    captures: [
      {
        pain: 2,
        tiredness: 3,
        drowsiness: 1,
        nausea: 0,
        lackOfAppetite: 2,
        shortnessOfBreath: 1,
        depression: 1,
        anxiety: 2,
        wellbeing: 2,
      },
    ],
  },
];

/** Capture times, oldest first: `SPACING_DAYS` apart ending an hour ago, floored at the activation and strictly increasing. */
export function captureTimes(count: number, nowMs: number, activatedAtMs: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const intended = nowMs - (count - 1 - i) * SPACING_DAYS * DAY_MS - 60 * MINUTE_MS;
    const floor = i === 0 ? activatedAtMs + MINUTE_MS : (times[i - 1] ?? 0) + MINUTE_MS;
    times.push(Math.max(intended, floor));
  }
  return times;
}

async function admissionOf(
  rn: WxSession,
  patientId: string,
): Promise<{ id: string; activatedAtMs: number } | null> {
  const cert = await rn.client.GET("/api/v1/patients/{patientId}/election-certification", {
    params: { path: { patientId } },
  });
  const id = (cert.data as unknown as { admission?: { id?: string } } | undefined)?.admission?.id;
  if (!id) return null;
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ activated_at: Date | null }>(
      "SELECT activated_at FROM admission WHERE id = $1",
      [id],
    );
    const activatedAt = rows[0]?.activated_at;
    return activatedAt ? { id, activatedAtMs: activatedAt.getTime() } : null;
  } finally {
    await db.end();
  }
}

async function alreadySeeded(rn: WxSession, patientId: string): Promise<boolean> {
  const list = await rn.client.GET("/api/v1/patients/{patientId}/assessments", {
    params: { path: { patientId } },
  });
  const assessments =
    (
      list.data as unknown as
        | { assessments?: Array<{ scaleType: string; data: Record<string, unknown> }> }
        | undefined
    )?.assessments ?? [];
  return assessments.some((a) => a.scaleType === "esas_r" && a.data.otherSymptomText === MARKER);
}

async function seedProfile(rn: WxSession, profile: Profile, log: ScenarioLog): Promise<void> {
  const patientId = await findPatientIdByLastName(rn, profile.lastName);
  const admission = await admissionOf(rn, patientId);
  if (!admission) {
    log.fail(`${profile.lastName}: no active admission — run the admission scenarios first`);
    return;
  }
  if (await alreadySeeded(rn, patientId)) {
    log.dup(`${profile.lastName}: ESAS-r series already seeded`);
    return;
  }
  const times = captureTimes(profile.captures.length, Date.now(), admission.activatedAtMs);
  for (const [i, items] of profile.captures.entries()) {
    const res = await rn.client.POST("/api/v1/patients/{patientId}/assessments", {
      params: { path: { patientId } },
      body: {
        admissionId: admission.id,
        scaleType: "esas_r",
        capturedAt: new Date(times[i] ?? Date.now()).toISOString(),
        data: { ...items, reportedBy: "patient", otherSymptomText: MARKER },
      },
    });
    if (res.error) {
      log.fail(`${profile.lastName} capture ${i + 1}: ${JSON.stringify(res.error)}`);
      return;
    }
  }
  log.ok(`${profile.lastName}: ${profile.captures.length} ESAS-r capture(s) — ${profile.summary}`);
}

async function main(): Promise<void> {
  assertLocalDevSeed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: ADMIN_URL,
    productionSeedAck: process.env.CHARTWARDEN_SEED_ALLOW_PRODUCTION,
    authUrl: API,
  });
  if (!ADMIN_URL)
    throw new Error("DATABASE_ADMIN_URL is required (reads the admission activation time)");
  const rn = await signIn("rita@chartwarden.local");
  const log = new ScenarioLog("composer ESAS-r series");
  for (const profile of PROFILES) {
    try {
      await seedProfile(rn, profile, log);
    } catch (err) {
      log.fail(`${profile.lastName}: ${String(err)}`);
    }
  }
  log.summary();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
