// apps/backend/src/modules/23-billing-medicare/routes/wage-index-service.ts — M23 tenant-entered WAGE INDEX service (F-211):
// create / supersede / list / get / live-for-(ccn, fiscal year), plus the ORG-EXPLICIT lookup the claim-assembly
// `referenceData.wageIndexForCcn` adapter binds (`resolveWageIndexForOrg`, the F-121 org-explicit seam-function pattern: boot-
// time closures have no ambient request context, so each read opens its own `withOrgContext`).
//
// Validation is layered: the pure rules in `@chartwarden/billing` (`validateWageIndexEntry`) run first for a precise 422; the
// "one live value per CCN + fiscal year" pre-check names the clashing version for a precise 409; migration 0280's partial
// unique index is the race-safe backstop (a concurrent writer surfaces as the same 409, never as two live rows). Values are
// append-only: a correction SUPERSEDES the old row (kept as history); already-assembled claims are unaffected because assembly
// snapshots the applied factor onto `per_diem_rate_calculation`.
import { randomUUID } from "node:crypto";
import { repositories, resolveWageIndex, validateWageIndexEntry } from "@chartwarden/billing";
import type { ResolvedWageIndex } from "@chartwarden/billing";
import type * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError, ChartWardenError } from "@chartwarden/types";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type {
  CreateWageIndexBody,
  SupersedeWageIndexBody,
  WageIndexView,
} from "./wage-index-typebox";

type BillingDb = repositories.BillingDb;

export interface WageIndexRouteService {
  createWageIndex(actor: M23WriteActor, body: CreateWageIndexBody): Promise<WageIndexView>;
  supersedeWageIndex(
    actor: M23WriteActor,
    id: string,
    body: SupersedeWageIndexBody,
  ): Promise<WageIndexView>;
  listWageIndexes(
    actor: M23ReadActor,
    opts: { ccn?: string; fiscalYearStarting?: number; includeSuperseded?: boolean },
  ): Promise<readonly WageIndexView[]>;
  getWageIndex(actor: M23ReadActor, id: string): Promise<WageIndexView>;
  /** The live tenant value for a CCN + fiscal year, or `null`. */
  liveWageIndex(
    actor: M23ReadActor,
    ccn: string,
    fiscalYearStarting: number,
  ): Promise<WageIndexView | null>;
}

export function mapWageIndex(row: schema.TenantWageIndex): WageIndexView {
  return {
    wageIndexId: row.id,
    organizationId: row.organizationId,
    ccn: row.ccn,
    fiscalYearStarting: row.fiscalYearStarting,
    cbsaCode: row.cbsaCode,
    factorDecimal: row.factorDecimal,
    sourceReference: row.sourceReference,
    enteredByMembershipId: row.enteredByMembershipId,
    entryReason: row.entryReason,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    supersededById: row.supersededById,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Postgres `unique_violation` — the partial unique index tripped by a concurrent writer for the same CCN + fiscal year. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * ORG-EXPLICIT: the wage index claim assembly prices from, or `null`. Precedence (pure `resolveWageIndex`): the tenant's own
 * live `tenant_wage_index` row, then an AUTHORITATIVE platform `wage_index_factor` row; a non-authoritative placeholder never
 * qualifies. The platform read is under the same org context (its RLS is `SELECT USING (true)`).
 */
export async function resolveWageIndexForOrg(
  db: BillingDb,
  orgId: string,
  ccn: string,
  fiscalYearStarting: number,
): Promise<ResolvedWageIndex | null> {
  return withOrgContext<BillingDb, ResolvedWageIndex | null>(
    db,
    { organizationId: orgId, userId: "" },
    async (tx) => {
      const tenant = await new repositories.TenantWageIndexRepository(tx).findLive(
        ccn,
        fiscalYearStarting,
      );
      const platform = await new repositories.WageIndexFactorRepository(tx).findByCcnAndFiscalYear(
        ccn,
        fiscalYearStarting,
      );
      return resolveWageIndex({
        tenant: tenant ? { factorDecimal: tenant.factorDecimal, cbsaCode: tenant.cbsaCode } : null,
        platform: platform
          ? {
              factorDecimal: platform.factorDecimal,
              cbsaCode: platform.cbsaCode,
              isAuthoritative: platform.isAuthoritative,
            }
          : null,
      });
    },
  );
}

export function buildDrizzleWageIndexService(
  db: BillingDb,
  now: () => Date = () => new Date(),
): WageIndexRouteService {
  const inCtx = <T>(actor: M23ReadActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  function validated(body: CreateWageIndexBody | SupersedeWageIndexBody): void {
    const v = validateWageIndexEntry(body, now().toISOString().slice(0, 10));
    if (!v.ok) {
      throw new ChartWardenError(
        "WAGE_INDEX_INVALID",
        `invalid wage index: ${v.errors.join("; ")}`,
        422,
      );
    }
  }

  function clashError(clash: schema.TenantWageIndex): ChartWardenError {
    return new ChartWardenError(
      "WAGE_INDEX_EXISTS",
      `a live wage index (${clash.id}) already exists for CCN ${clash.ccn} fiscal year ${clash.fiscalYearStarting}; supersede it instead of entering a second one`,
      409,
    );
  }

  async function insertVersion(
    tx: BillingDb,
    actor: M23WriteActor,
    body: CreateWageIndexBody | SupersedeWageIndexBody,
    id: string,
  ): Promise<schema.TenantWageIndex> {
    const repo = new repositories.TenantWageIndexRepository(tx);
    const clash = await repo.findLive(body.ccn, body.fiscalYearStarting);
    if (clash) throw clashError(clash);
    try {
      return await repo.create({
        id,
        organizationId: actor.organizationId,
        ccn: body.ccn,
        fiscalYearStarting: body.fiscalYearStarting,
        cbsaCode: body.cbsaCode ?? null,
        factorDecimal: body.factorDecimal,
        sourceReference: body.sourceReference,
        enteredByMembershipId: actor.membershipId,
        ...(body.entryReason !== undefined ? { entryReason: body.entryReason } : {}),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ChartWardenError(
          "WAGE_INDEX_EXISTS",
          "a live wage index for that CCN and fiscal year was entered concurrently",
          409,
        );
      }
      throw err;
    }
  }

  return {
    async createWageIndex(actor, body) {
      validated(body);
      return inCtx(actor, async (tx) =>
        mapWageIndex(await insertVersion(tx, actor, body, randomUUID())),
      );
    },

    async supersedeWageIndex(actor, id, body) {
      validated(body);
      return inCtx(actor, async (tx) => {
        const repo = new repositories.TenantWageIndexRepository(tx);
        const old = await repo.findById(id);
        // RLS already hides other tenants' rows: a foreign or unknown id is the same 404 (no existence leak).
        if (!old || old.organizationId !== actor.organizationId)
          throw new NotFoundError("wage index");
        if (old.ccn !== body.ccn || old.fiscalYearStarting !== body.fiscalYearStarting) {
          throw new ChartWardenError(
            "WAGE_INDEX_KEY_MISMATCH",
            "a supersede must keep the same CCN and fiscal year; enter a different CCN/year as a new wage index",
            422,
          );
        }
        if (old.supersededAt !== null) {
          throw new ChartWardenError(
            "WAGE_INDEX_ALREADY_SUPERSEDED",
            `wage index ${id} was already superseded by ${old.supersededById}`,
            409,
          );
        }
        // Successor id minted first so the old row can name it; the old row is superseded BEFORE the insert so the
        // successor reuses the freed (ccn, fiscal year) key without tripping the live-unique index.
        const successorId = randomUUID();
        const marked = await repo.markSuperseded(id, successorId, now());
        if (!marked) {
          throw new ChartWardenError(
            "WAGE_INDEX_ALREADY_SUPERSEDED",
            `wage index ${id} was already superseded`,
            409,
          );
        }
        return mapWageIndex(await insertVersion(tx, actor, body, successorId));
      });
    },

    async listWageIndexes(actor, opts) {
      return inCtx(actor, async (tx) => {
        const rows = await new repositories.TenantWageIndexRepository(tx).list({
          ...(opts.ccn ? { ccn: opts.ccn } : {}),
          ...(opts.fiscalYearStarting !== undefined
            ? { fiscalYearStarting: opts.fiscalYearStarting }
            : {}),
          ...(opts.includeSuperseded ? { includeSuperseded: true } : {}),
        });
        return rows.filter((r) => r.organizationId === actor.organizationId).map(mapWageIndex);
      });
    },

    async getWageIndex(actor, id) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.TenantWageIndexRepository(tx).findById(id);
        if (!row || row.organizationId !== actor.organizationId)
          throw new NotFoundError("wage index");
        return mapWageIndex(row);
      });
    },

    async liveWageIndex(actor, ccn, fiscalYearStarting) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.TenantWageIndexRepository(tx).findLive(
          ccn,
          fiscalYearStarting,
        );
        return row && row.organizationId === actor.organizationId ? mapWageIndex(row) : null;
      });
    },
  };
}
