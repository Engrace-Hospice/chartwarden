#!/usr/bin/env bun
/**
 * Restore-drill freshness (CW-CP-01): `bun run backup:drill-overdue`.
 *
 * DR/BCP 8.2 asks for a monthly restore of PRODUCTION data from the off-site copy, witnessed and recorded. Nothing in the
 * repository can perform it (it needs the production off-site key and the escrowed secrets), so this is the alarm for
 * the day nobody did: it reads the evidence records under audit/restore-drill/ and fails when the newest passing
 * production drill is older than DEFAULT_MAX_AGE_DAYS (monthly plus a grace period) or when there is none.
 *
 * A record counts only when it is a complete, honest record of a drill that passed (see judgeRecord): witnessed by a second
 * person, a verifier exit code of 0, the restored PHI copy destroyed. The synthetic drills (coordinated, replication,
 * M36) never count: they prove the tooling, not that production can be restored. audit/restore-drill/TEMPLATE-* are ignored.
 *
 *   bun run backup:drill-overdue [--dir=audit/restore-drill] [--max-age-days=35] [--today=YYYY-MM-DD]
 *
 * Exit 0 fresh, 1 overdue, 2 unreadable directory. When overdue and OPS_ALERT_WEBHOOK_URL is an https URL it posts
 * `backup.restore_drill_overdue` in the same payload shape the backup sidecar uses. The monthly/weekly workflow is
 * .github/workflows/restore-drill.yml. The record's template and meaning: audit/restore-drill/TEMPLATE-production-restore.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DRILL_KIND = "production-restore-drill";
/** The files an operator writes from audit/restore-drill/TEMPLATE-production-restore.json: <date>-production-restore.json. */
const PRODUCTION_RECORD_NAME = /production-restore.*\.json$/;
export const DEFAULT_MAX_AGE_DAYS = 35;
const DAY_MS = 86_400_000;
const ALERT_TIMEOUT_MS = 10_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_ID = /^\d{8}T\d{6}Z$/;
const SECONDS_FIELDS = [
  "restoreWallSeconds",
  "rtoTargetSeconds",
  "snapshotAgeSeconds",
  "rpoTargetSeconds",
] as const;

export interface Judgement {
  readonly counts: boolean;
  /** "pass" or "fail" as recorded (null when the record does not say), whether or not the rest is valid. */
  readonly result: "pass" | "fail" | null;
  readonly drilledOn: string | null;
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

export interface Verdict {
  readonly overdue: boolean;
  readonly summary: string;
  readonly lastPassOn: string | null;
  readonly ageDays: number | null;
  readonly warnings: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
// Greater than zero: the template's placeholders are 0, so a record that only filled in the dates cannot pass.
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

/** Whether a record of this kind is a complete record of a passing drill, and what is wrong with it when it is not. */
export function judgeRecord(raw: unknown, today: Date): Judgement | null {
  if (!isObject(raw) || raw.kind !== DRILL_KIND) return null;
  const problems: string[] = [];
  const notes: string[] = [];
  const drilled = parseDay(raw.drilledOn);
  if (!drilled) problems.push("drilledOn is not a YYYY-MM-DD date");
  else if (drilled.getTime() > today.getTime()) problems.push("drilledOn is in the future");
  if (raw.result !== "pass" && raw.result !== "fail")
    problems.push('result must be "pass" or "fail"');
  const by = text(raw.conductedBy);
  const witness = text(raw.witness);
  if (!by) problems.push("conductedBy is empty");
  if (!witness) problems.push("witness is empty");
  else if (witness.toLowerCase() === by.toLowerCase())
    problems.push("the witness must be a second person");
  if (typeof raw.snapshotId !== "string" || !SNAPSHOT_ID.test(raw.snapshotId)) {
    problems.push("snapshotId is not a snapshot id (YYYYMMDDTHHMMSSZ)");
  }
  for (const field of SECONDS_FIELDS) {
    if (!isSeconds(raw[field])) problems.push(`${field} is not a positive number of seconds`);
  }
  if (!Number.isInteger(raw.verifierExitCode)) problems.push("verifierExitCode is not an integer");
  const destroyed = parseDay(raw.phiCopyDestroyedOn);
  if (!destroyed) {
    problems.push(
      "phiCopyDestroyedOn is not a YYYY-MM-DD date (the restored PHI copy must be destroyed and recorded)",
    );
  } else if (drilled && destroyed.getTime() < drilled.getTime()) {
    problems.push("phiCopyDestroyedOn is before drilledOn");
  } else if (destroyed.getTime() > today.getTime()) {
    // A destruction date still to come is a promise, not a fact: the restored PHI copy still exists.
    problems.push("phiCopyDestroyedOn is in the future");
  }
  if (raw.result === "pass" && raw.verifierExitCode !== 0) {
    problems.push("result is pass but the verifier did not exit 0");
  }
  const { restoreWallSeconds, rtoTargetSeconds, snapshotAgeSeconds, rpoTargetSeconds } = raw;
  if (
    isSeconds(restoreWallSeconds) &&
    isSeconds(rtoTargetSeconds) &&
    restoreWallSeconds > rtoTargetSeconds
  ) {
    notes.push(
      `the restore took ${restoreWallSeconds} s against an RTO target of ${rtoTargetSeconds} s`,
    );
  }
  if (
    isSeconds(snapshotAgeSeconds) &&
    isSeconds(rpoTargetSeconds) &&
    snapshotAgeSeconds > rpoTargetSeconds
  ) {
    notes.push(
      `the restored snapshot was ${snapshotAgeSeconds} s old against an RPO target of ${rpoTargetSeconds} s`,
    );
  }
  return {
    counts: problems.length === 0 && raw.result === "pass",
    result: raw.result === "pass" || raw.result === "fail" ? raw.result : null,
    // A date in the future is not a date a drill happened on: it neither passes nor fails anything.
    drilledOn: drilled && drilled.getTime() <= today.getTime() ? (raw.drilledOn as string) : null,
    problems,
    notes,
  };
}

export function evaluateDrills(
  records: ReadonlyArray<{ readonly file: string; readonly raw: unknown }>,
  today: Date,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): Verdict {
  const warnings: string[] = [];
  const malformed: string[] = [];
  let lastPassOn: string | null = null;
  let lastFailOn: string | null = null;
  for (const { file, raw } of records) {
    const verdict = judgeRecord(raw, today);
    if (!verdict) {
      // A file NAMED like a production restore record that is not one (unparseable, or the wrong kind) could be a FAILED
      // drill's record, damaged or mislabelled: fail closed rather than let an older pass keep the alarm silent. An
      // unparseable file (the loader hands over `null`) is held to the same rule under ANY name: a damaged record
      // cannot be told from a damaged failure record. A parseable file of another kind (the synthetic drills) is not ours.
      if (PRODUCTION_RECORD_NAME.test(file) || raw === null) malformed.push(file);
      continue;
    }
    for (const problem of verdict.problems) warnings.push(`${file}: ${problem}`);
    for (const note of verdict.notes) warnings.push(`${file}: ${note}`);
    if (!verdict.drilledOn) continue;
    if (verdict.counts && (lastPassOn === null || verdict.drilledOn > lastPassOn)) {
      lastPassOn = verdict.drilledOn;
    }
    // Completeness is demanded of a PASS only. A failed drill that never got as far as a witness, a snapshot or a
    // destroyed copy is still a failed drill, and the one record most worth alarming on. A dated record of this kind
    // whose result is neither "pass" nor "fail" ("failed", "FAIL", the template's placeholder left in) cannot show
    // production restorable, so it is read as a failure rather than ignored.
    if (verdict.result !== "pass" && (lastFailOn === null || verdict.drilledOn > lastFailOn)) {
      lastFailOn = verdict.drilledOn;
    }
  }
  if (malformed.length > 0) {
    return {
      overdue: true,
      summary: `not a valid production restore record (unparseable, or not kind "${DRILL_KIND}"): ${malformed.join(", ")}; fix or remove it`,
      lastPassOn,
      ageDays: null,
      warnings,
    };
  }
  // A drill that FAILED is the most important record there is: a failure on or after the last pass means production
  // cannot currently be shown restorable, however recent the older pass is.
  if (lastFailOn && (lastPassOn === null || lastFailOn >= lastPassOn)) {
    return {
      overdue: true,
      summary: `the latest production restore drill (${lastFailOn}) FAILED (or its result is neither "pass" nor "fail") and no passing drill has been recorded since`,
      lastPassOn,
      ageDays: null,
      warnings,
    };
  }
  const last = parseDay(lastPassOn);
  if (!lastPassOn || !last) {
    return {
      overdue: true,
      summary: "no witnessed production restore drill is recorded under audit/restore-drill/",
      lastPassOn: null,
      ageDays: null,
      warnings,
    };
  }
  const ageDays = Math.floor((today.getTime() - last.getTime()) / DAY_MS);
  return {
    overdue: ageDays > maxAgeDays,
    summary: `the last passing production restore drill was ${ageDays} days ago (${lastPassOn}); the limit is ${maxAgeDays}`,
    lastPassOn,
    ageDays,
    warnings,
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Post an ops notice (the payload shape cw-backup.sh uses) when OPS_ALERT_WEBHOOK_URL is an https URL; never throws. */
async function alertIfConfigured(
  kind: string,
  summary: string,
  details: Readonly<Record<string, unknown>>,
  today: string,
): Promise<void> {
  const url = process.env.OPS_ALERT_WEBHOOK_URL ?? "";
  if (!url.startsWith("https://")) {
    console.error(
      "OPS_ALERT_WEBHOOK_URL is not an https URL: no alert was posted (the exit code is the alarm)",
    );
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind,
        summary,
        details,
        correlationId: `${kind}-${today}`,
        occurredAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      redirect: "error", // an https URL must not hand the body on to an http one
    });
    if (!res.ok) throw new Error(`alert webhook answered ${res.status}`);
  } catch (error) {
    console.error(`alert webhook delivery failed: ${messageOf(error)}`);
  }
}

function option(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dir = option("dir") ?? join(repo, "audit", "restore-drill");
  const maxAge = Number(option("max-age-days") ?? DEFAULT_MAX_AGE_DAYS);
  const todayArg = option("today") ?? new Date().toISOString().slice(0, 10);
  const today = parseDay(todayArg);
  if (!today || !Number.isFinite(maxAge) || maxAge < 0) {
    console.error("backup:drill-overdue: --today must be YYYY-MM-DD and --max-age-days a number");
    return 2;
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("TEMPLATE"));
  } catch (error) {
    // The check itself is broken: that must page too, or a missing evidence directory silences the alarm.
    const summary = `backup:drill-overdue cannot read its evidence directory: ${messageOf(error)}`;
    console.error(summary);
    await alertIfConfigured("backup.restore_drill_check_failed", summary, { dir }, todayArg);
    return 2;
  }
  const unreadable: string[] = [];
  const records = names.map((file) => {
    try {
      return { file, raw: JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown };
    } catch {
      unreadable.push(`${file}: not valid JSON`);
      return { file, raw: null };
    }
  });
  const verdict = evaluateDrills(records, today, maxAge);
  for (const warning of [...unreadable, ...verdict.warnings]) console.warn(`warning: ${warning}`);
  if (!verdict.overdue) {
    console.log(`backup:drill-overdue OK: ${verdict.summary}`);
    return 0;
  }
  console.error(`backup:drill-overdue OVERDUE: ${verdict.summary}`);
  await alertIfConfigured(
    "backup.restore_drill_overdue",
    verdict.summary,
    { lastPassOn: verdict.lastPassOn, ageDays: verdict.ageDays, warnings: verdict.warnings },
    todayArg,
  );
  return 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(2);
    });
}
