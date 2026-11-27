/**
 * ChartWarden - the CW-PI-04 visit pairing reconciliation runner: argument parsing and the per-tenant
 * orchestration behind `scripts/m17-reconcile-visit-pairings.ts`.
 *
 * DRY-RUN BY DEFAULT: without `--apply` it plans every tenant read-only and reports counts and ids. With
 * `--apply` it first plans EVERY tenant, refuses the whole run (nothing written, exit 3) when the restamps in
 * all tenants together exceed `--max-rows`, and only then applies tenant by tenant (one transaction each, an
 * audit event per changed visit). What a "fix" is, and what is left for a person, is documented in
 * `apps/backend/src/modules/17-scheduling/visit-pairing-reconcile.ts`.
 *
 * Output is ids and codes only: no names, no clinical text.
 */
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import {
  type OrgApplyResult,
  type OrgPairingPlan,
  type OrgPairingReport,
  applyVisitPairingRestampsForOrg,
  pairingReport,
  planVisitPairingsForOrg,
} from "../../apps/backend/src/modules/17-scheduling/visit-pairing-reconcile";

/** A conservative default: a first apply is expected to be small and reviewable. */
export const DEFAULT_MAX_ROWS = 25;
/** The largest cap an operator may ask for; a plan above it is a decision for engineering, not a flag. */
export const MAX_ROWS_CEILING = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATOR = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const FLAGS_WITH_VALUE = new Set(["--max-rows", "--org", "--operator"]);

export interface RunArgs {
  readonly apply: boolean;
  readonly maxRows: number;
  /** Tenants to run for; null means every tenant the caller can list. */
  readonly orgIds: readonly string[] | null;
  readonly operator: string;
}

export type ParseResult =
  | { readonly ok: true; readonly args: RunArgs }
  | { readonly ok: false; readonly message: string };

export function parseRunArgs(argv: readonly string[]): ParseResult {
  let apply = false;
  let maxRows = DEFAULT_MAX_ROWS;
  let operator = "";
  const orgIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) return { ok: false, message: `unknown argument '${flag}'` };
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${flag} needs a value` };
    }
    if (flag === "--max-rows") {
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > MAX_ROWS_CEILING) {
        return {
          ok: false,
          message: `--max-rows must be an integer from 1 to ${MAX_ROWS_CEILING}`,
        };
      }
      maxRows = Number(value);
    } else if (flag === "--org") {
      if (!UUID.test(value)) return { ok: false, message: "--org must be an organization uuid" };
      orgIds.push(value.toLowerCase());
    } else {
      if (!OPERATOR.test(value)) {
        return { ok: false, message: "--operator must be a short label: letters, digits, . _ -" };
      }
      operator = value;
    }
  }
  if (apply && operator === "") {
    return {
      ok: false,
      message: "--apply requires --operator <label> (recorded in the audit trail)",
    };
  }
  return {
    ok: true,
    args: { apply, maxRows, orgIds: orgIds.length > 0 ? [...new Set(orgIds)] : null, operator },
  };
}

export interface RunSummary {
  readonly mode: "dry-run" | "apply";
  readonly runId: string;
  readonly maxRows: number;
  readonly plannedRestamps: number;
  readonly reviewQueue: number;
  /** True when `--apply` would be refused whole under this cap (reported by a dry run, enforced by apply). */
  readonly exceedsCap: boolean;
  readonly refused: boolean;
  readonly organizations: readonly OrgPairingReport[];
  readonly applied: readonly OrgApplyResult[];
  readonly error?: string;
}

export interface RunResult {
  /** 0 ok, 1 a tenant failed (earlier tenants stay committed; re-run is safe), 3 plan refused over the cap. */
  readonly exitCode: 0 | 1 | 3;
  readonly summary: RunSummary;
}

/** Prove the connection enforces RLS: a superuser/BYPASSRLS connection makes a tenant context decorative. */
export async function assertRlsEnforcedRole(db: DbClient): Promise<void> {
  const result = (await db.execute(
    sql`SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
  )) as unknown as { rows: { rolsuper: boolean; rolbypassrls: boolean }[] };
  const who = result.rows[0];
  if (!who || who.rolsuper || who.rolbypassrls) {
    throw new Error(
      "DATABASE_URL must connect as a role that enforces RLS (the application role: NOSUPERUSER, NOBYPASSRLS), not a superuser",
    );
  }
}

export async function runVisitPairingReconciliation(
  db: DbClient,
  orgIds: readonly string[],
  args: RunArgs,
  runId: string,
): Promise<RunResult> {
  const mode = args.apply ? "apply" : "dry-run";
  const plans: OrgPairingPlan[] = [];
  try {
    for (const orgId of orgIds) plans.push(await planVisitPairingsForOrg(db, orgId));
  } catch (error) {
    return {
      exitCode: 1,
      summary: {
        mode,
        runId,
        maxRows: args.maxRows,
        plannedRestamps: 0,
        reviewQueue: 0,
        exceedsCap: false,
        refused: false,
        organizations: plans.map(pairingReport),
        applied: [],
        error: errorCode(error, `tenant ${plans.length + 1} of ${orgIds.length}`),
      },
    };
  }
  const plannedRestamps = plans.reduce((n, p) => n + p.restamp.length, 0);
  const report = {
    mode,
    runId,
    maxRows: args.maxRows,
    plannedRestamps,
    reviewQueue: plans.reduce((n, p) => n + p.review.length, 0),
    exceedsCap: plannedRestamps > args.maxRows,
    organizations: plans.map(pairingReport),
  } as const;
  if (!args.apply) return { exitCode: 0, summary: { ...report, refused: false, applied: [] } };
  if (report.exceedsCap) return { exitCode: 3, summary: { ...report, refused: true, applied: [] } };

  const applied: OrgApplyResult[] = [];
  let remaining = args.maxRows;
  for (const plan of plans) {
    if (plan.restamp.length === 0) continue;
    try {
      const result = await applyVisitPairingRestampsForOrg(db, plan, {
        maxRows: remaining,
        runId,
        operator: args.operator,
      });
      applied.push(result);
      remaining -= result.changed.length;
    } catch (error) {
      const error_ = errorCode(error, `organization ${plan.organizationId}`);
      return {
        exitCode: 1,
        summary: { ...report, refused: false, applied, error: error_ },
      };
    }
  }
  return { exitCode: 0, summary: { ...report, refused: false, applied } };
}

/**
 * The failure as codes: the error name, the SQLSTATE when the driver gave one, and where. Never the driver's
 * message: it can echo row values.
 */
function errorCode(error: unknown, where: string): string {
  const name = error instanceof Error ? error.name : "Error";
  const state = sqlState(error);
  return `${name}${state ? ` (SQLSTATE ${state})` : ""} while processing ${where}`;
}

const MAX_CAUSE_DEPTH = 3;

/** The driver's SQLSTATE, found on the error or on its `cause` chain (the query layer wraps the driver error). */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = cause;
  }
  return undefined;
}
