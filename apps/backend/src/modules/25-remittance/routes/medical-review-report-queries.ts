// apps/backend/src/modules/25-remittance/routes/medical-review-report-queries.ts - M25 milestone 9a-2: the SQL behind the
// leadership medical-review report. Every query is a GROUP BY / aggregate over M25's own tables, run inside the caller's
// `withOrgContext` (FORCE RLS) and narrowed by the actor's provider-entity scope, so no row is ever loaded into memory
// (unlike `denialMetrics`). Nothing here selects a patient, claim, person or free-text column: the output is counts,
// dollars and day counts. Deadline-based figures compare against the due date STORED ON THE CASE; whether that date came
// from a verified rule is returned beside it, never assumed. Dates are UTC days; "median days" counts UTC calendar days.
import { schema } from "@chartwarden/db";
import type { DbClient } from "@chartwarden/db";
import { type SQL, sql } from "drizzle-orm";
import { providerEntityScopeCondition } from "./scope";

export type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface DayRange {
  readonly from: string;
  readonly to: string;
}
export interface InstantRange {
  readonly startsAt: string;
  readonly endsBefore: string;
}
export interface ScopeArgs {
  readonly scope: readonly string[] | undefined;
  readonly providerEntityId?: string;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function rowsOf<T>(tx: Tx, query: SQL): Promise<T[]> {
  const res = (await tx.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(res) ? res : (res.rows ?? []);
}

/** `AND <scope>` or nothing. The column is a drizzle column so it renders table-qualified. */
const scoped = (column: Parameters<typeof providerEntityScopeCondition>[0], s: ScopeArgs): SQL => {
  const cond = providerEntityScopeCondition(column, s.scope, s.providerEntityId);
  return cond ? sql`AND ${cond}` : sql``;
};

export interface AdrFigures {
  readonly received: number;
  readonly filed: number;
  readonly filedOnOrBeforeDue: number;
  readonly filedAfterDue: number;
  readonly deniedNoResponse: number;
  readonly withRecordedProof: number;
  readonly dueDatesFromUnverifiedWindows: number;
  readonly medianDaysToFile: number | null;
}

/** ADRs logged (requested_on) in the day range. "Filed" is the filing time the user recorded (filed_at). */
export async function adrFigures(tx: Tx, days: DayRange, s: ScopeArgs): Promise<AdrFigures> {
  const A = schema.adrCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT count(*)::int AS received,
        count(*) FILTER (WHERE filed_at IS NOT NULL)::int AS filed,
        count(*) FILTER (WHERE filed_at IS NOT NULL AND filed_at <= response_due_at)::int AS on_time,
        count(*) FILTER (WHERE filed_at IS NOT NULL AND filed_at > response_due_at)::int AS late,
        count(*) FILTER (WHERE state = 'denied_no_response')::int AS no_response,
        count(*) FILTER (WHERE window_verified = false)::int AS unverified,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM submission_attempt sa
          WHERE sa.adr_case_id = adr_case.id AND sa.receipt_at IS NOT NULL))::int AS with_proof,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY (filed_at AT TIME ZONE 'UTC')::date - requested_on)
          FILTER (WHERE filed_at IS NOT NULL))::float8 AS median_days
      FROM adr_case
     WHERE requested_on >= ${days.from}::date AND requested_on <= ${days.to}::date ${scoped(A.providerEntityId, s)}`,
  );
  const row = r[0] ?? {};
  return {
    received: num(row.received),
    filed: num(row.filed),
    filedOnOrBeforeDue: num(row.on_time),
    filedAfterDue: num(row.late),
    deniedNoResponse: num(row.no_response),
    withRecordedProof: num(row.with_proof),
    dueDatesFromUnverifiedWindows: num(row.unverified),
    medianDaysToFile: numOrNull(row.median_days),
  };
}

export interface AdrByMac {
  readonly macName: string;
  readonly received: number;
  readonly filed: number;
  readonly filedOnOrBeforeDue: number;
  readonly deniedNoResponse: number;
}

export async function adrByMac(tx: Tx, days: DayRange, s: ScopeArgs): Promise<AdrByMac[]> {
  const A = schema.adrCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT mac_name,
        count(*)::int AS received,
        count(*) FILTER (WHERE filed_at IS NOT NULL)::int AS filed,
        count(*) FILTER (WHERE filed_at IS NOT NULL AND filed_at <= response_due_at)::int AS on_time,
        count(*) FILTER (WHERE state = 'denied_no_response')::int AS no_response
      FROM adr_case
     WHERE requested_on >= ${days.from}::date AND requested_on <= ${days.to}::date ${scoped(A.providerEntityId, s)}
     GROUP BY mac_name ORDER BY received DESC, mac_name`,
  );
  return r.map((x) => ({
    macName: String(x.mac_name),
    received: num(x.received),
    filed: num(x.filed),
    filedOnOrBeforeDue: num(x.on_time),
    deniedNoResponse: num(x.no_response),
  }));
}

export interface DenialTotals {
  readonly opened: number;
  /** Integer cents. */
  readonly cents: number;
  readonly macReasonAsTyped: number;
}

export async function denialTotals(
  tx: Tx,
  range: InstantRange,
  macReasonCode: string,
  s: ScopeArgs,
): Promise<DenialTotals> {
  const D = schema.denialCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT count(*)::int AS opened, round(coalesce(sum(dollar_value), 0) * 100)::bigint::text AS cents,
        count(*) FILTER (WHERE upper(btrim(mac_reason_code)) = ${macReasonCode})::int AS typed
      FROM denial_case
     WHERE opened_at >= ${range.startsAt}::timestamptz AND opened_at < ${range.endsBefore}::timestamptz ${scoped(D.providerEntityId, s)}`,
  );
  const row = r[0] ?? {};
  return { opened: num(row.opened), cents: num(row.cents), macReasonAsTyped: num(row.typed) };
}

export interface ReasonRow {
  readonly codeKind: string;
  readonly code: string;
  readonly covered: boolean;
  readonly count: number;
  /** Integer cents. */
  readonly cents: number;
}

/**
 * Denials opened in the range grouped by the most specific code they carry (MAC reason, else RARC, else CARC), with
 * whether the denial panel WOULD find a playbook for that denial: the same inputs and matching as `loadDenialCodes` and
 * `resolvePlaybook` (the denial's MAC comes from the newest ADR logged against it, else the newest unlinked ADR on its claim;
 * a published, in-effect playbook matches on any of the denial's codes, and a MAC-specific playbook only on that MAC,
 * compared case-insensitively). Coverage is decided PER DENIAL, so one reason can have covered and uncovered denials.
 */
export async function denialReasons(
  tx: Tx,
  range: InstantRange,
  s: ScopeArgs,
  /** The UTC day playbooks are read as of (the report's clock, not the database's). */
  asOf: string,
): Promise<ReasonRow[]> {
  const D = schema.denialCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT kind, code, covered, count(*)::int AS n, round(coalesce(sum(dollar_value), 0) * 100)::bigint::text AS cents
      FROM (SELECT denial_case.dollar_value,
          CASE WHEN nullif(btrim(denial_case.mac_reason_code), '') IS NOT NULL THEN 'mac_reason'
               WHEN nullif(btrim(denial_case.rarc_code), '') IS NOT NULL THEN 'rarc' ELSE 'carc' END AS kind,
          upper(btrim(coalesce(nullif(btrim(denial_case.mac_reason_code), ''), nullif(btrim(denial_case.rarc_code), ''), denial_case.carc_code))) AS code,
          EXISTS (SELECT 1 FROM denial_playbook_version v JOIN denial_playbook p ON p.id = v.playbook_id
            WHERE v.status = 'published' AND v.effective_from <= ${asOf}::date
              AND (p.mac_name IS NULL OR upper(btrim(p.mac_name)) = upper(btrim(coalesce(m.mac_name, ''))))
              AND ((p.code_kind = 'mac_reason' AND upper(btrim(p.code)) = upper(btrim(denial_case.mac_reason_code)))
                OR (p.code_kind = 'rarc' AND upper(btrim(p.code)) = upper(btrim(denial_case.rarc_code)))
                OR (p.code_kind = 'carc' AND upper(btrim(p.code)) = upper(btrim(denial_case.carc_code))))) AS covered
        FROM denial_case
        LEFT JOIN LATERAL (
          SELECT mac_name FROM (
            SELECT mac_name, 1 AS pri, created_at FROM adr_case WHERE denial_case_id = denial_case.id
            UNION ALL
            SELECT mac_name, 2 AS pri, created_at FROM adr_case
             WHERE denial_case.claim_id IS NOT NULL AND claim_id = denial_case.claim_id AND denial_case_id IS NULL) x
          ORDER BY pri, created_at DESC LIMIT 1) m ON true
       WHERE denial_case.opened_at >= ${range.startsAt}::timestamptz AND denial_case.opened_at < ${range.endsBefore}::timestamptz ${scoped(D.providerEntityId, s)}) d
     GROUP BY kind, code, covered`,
  );
  return r.map((x) => ({
    codeKind: String(x.kind),
    code: String(x.code),
    covered: x.covered === true,
    count: num(x.n),
    cents: num(x.cents),
  }));
}

export async function denialsByMonth(
  tx: Tx,
  range: InstantRange,
  s: ScopeArgs,
): Promise<{ month: string; count: number; cents: number }[]> {
  const D = schema.denialCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, count(*)::int AS n,
        round(coalesce(sum(dollar_value), 0) * 100)::bigint::text AS cents
      FROM denial_case
     WHERE opened_at >= ${range.startsAt}::timestamptz AND opened_at < ${range.endsBefore}::timestamptz ${scoped(D.providerEntityId, s)}
     GROUP BY 1 ORDER BY 1`,
  );
  return r.map((x) => ({ month: String(x.month), count: num(x.n), cents: num(x.cents) }));
}

export async function denialClosures(
  tx: Tx,
  range: InstantRange,
  s: ScopeArgs,
): Promise<{ outcome: string; count: number }[]> {
  const D = schema.denialCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT closure_outcome AS outcome, count(*)::int AS n FROM denial_case
     WHERE closed_at >= ${range.startsAt}::timestamptz AND closed_at < ${range.endsBefore}::timestamptz
       AND closure_outcome IS NOT NULL ${scoped(D.providerEntityId, s)}
     GROUP BY 1 ORDER BY n DESC, 1`,
  );
  return r.map((x) => ({ outcome: String(x.outcome), count: num(x.n) }));
}

export interface AppealFiledRow {
  readonly tier: string;
  readonly filed: number;
  readonly filedOnOrBeforeDeadline: number;
}

/** Appeals filed (submitted_at) in the range by tier; "on or before" compares with the deadline stored on the case. */
export async function appealsFiled(
  tx: Tx,
  range: InstantRange,
  s: ScopeArgs,
): Promise<AppealFiledRow[]> {
  const P = schema.appealCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT tier::text AS tier, count(*)::int AS filed,
        count(*) FILTER (WHERE submitted_at <= tier_deadline_at)::int AS on_time
      FROM appeal_case
     WHERE submitted_at >= ${range.startsAt}::timestamptz AND submitted_at < ${range.endsBefore}::timestamptz ${scoped(P.providerEntityId, s)}
     GROUP BY tier ORDER BY tier`,
  );
  return r.map((x) => ({
    tier: String(x.tier),
    filed: num(x.filed),
    filedOnOrBeforeDeadline: num(x.on_time),
  }));
}

export async function appealsDecided(
  tx: Tx,
  range: InstantRange,
  s: ScopeArgs,
): Promise<{ outcome: string; count: number }[]> {
  const P = schema.appealCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT decision_outcome::text AS outcome, count(*)::int AS n FROM appeal_case
     WHERE decided_at >= ${range.startsAt}::timestamptz AND decided_at < ${range.endsBefore}::timestamptz
       AND decision_outcome IS NOT NULL ${scoped(P.providerEntityId, s)}
     GROUP BY 1 ORDER BY 1`,
  );
  return r.map((x) => ({ outcome: String(x.outcome), count: num(x.n) }));
}

export async function appealsOpenByTier(
  tx: Tx,
  s: ScopeArgs,
): Promise<{ tier: string; count: number }[]> {
  const P = schema.appealCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT tier::text AS tier, count(*)::int AS n FROM appeal_case
     WHERE state IN ('draft', 'submitted', 'under_review') ${scoped(P.providerEntityId, s)}
     GROUP BY tier ORDER BY tier`,
  );
  return r.map((x) => ({ tier: String(x.tier), count: num(x.n) }));
}

export async function reopeningsOpened(tx: Tx, range: InstantRange, s: ScopeArgs): Promise<number> {
  const R = schema.reopeningCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT count(*)::int AS n FROM reopening_case
     WHERE created_at >= ${range.startsAt}::timestamptz AND created_at < ${range.endsBefore}::timestamptz ${scoped(R.providerEntityId, s)}`,
  );
  return num(r[0]?.n);
}

export async function reopeningsDecided(
  tx: Tx,
  range: InstantRange,
  s: ScopeArgs,
): Promise<{ outcome: string; count: number }[]> {
  const R = schema.reopeningCase;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT outcome, count(*)::int AS n FROM reopening_case
     WHERE decided_at >= ${range.startsAt}::timestamptz AND decided_at < ${range.endsBefore}::timestamptz
       AND outcome IS NOT NULL ${scoped(R.providerEntityId, s)}
     GROUP BY 1 ORDER BY 1`,
  );
  return r.map((x) => ({ outcome: String(x.outcome), count: num(x.n) }));
}

/** Open audit requests now, and how many of them have no recorded deadline and no "none stated" attestation. */
export async function auditFigures(
  tx: Tx,
  s: ScopeArgs,
): Promise<{ open: number; openWithNoRecordedDeadline: number }> {
  const U = schema.auditRequest;
  const r = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT count(*)::int AS open,
        count(*) FILTER (WHERE deadline_none_stated_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM recorded_deadline d WHERE d.audit_request_id = audit_request.id))::int AS no_deadline
      FROM audit_request
     WHERE state IN ('received', 'in_assembly', 'in_review') ${scoped(U.providerEntityId, s)}`,
  );
  return { open: num(r[0]?.open), openWithNoRecordedDeadline: num(r[0]?.no_deadline) };
}
