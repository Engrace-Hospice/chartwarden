// apps/backend/src/modules/23-billing-medicare/routes/rate-table-service.ts — M23 tenant-entered hospice RATE TABLE
// service (F-210): create / supersede / list / get / effective-on, plus the ORG-EXPLICIT lookup the claim-assembly
// `referenceData` adapter binds (`hospiceRateTableEffectiveForOrg`, the F-121 org-explicit seam-function pattern:
// boot-time closures have no ambient request context, so each read opens its own `withOrgContext`).
//
// Validation is layered: the pure rules in `@wardenx/billing` (`validateRateTableEntry`) run first for a precise
// 422; the overlap pre-check names the conflicting version for a precise 409; migration 0279's EXCLUDE constraint is
// the race-safe backstop (a concurrent writer that slips past the pre-check surfaces as the same 409, never as two
// live rows). Rates are append-only: a correction SUPERSEDES the old version (it stays readable as history) and
// already-assembled claims are unaffected because assembly snapshots the priced per-diems onto `hipps_calculation`.
import { randomUUID } from "node:crypto";
import { dateRangesOverlap, repositories, validateRateTableEntry } from "@wardenx/billing";
import type * as schema from "@wardenx/db/schema";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type { CreateRateTableBody, RateTableView, SupersedeRateTableBody } from "./rate-table-typebox";

type BillingDb = repositories.BillingDb;

export interface RateTableRouteService {
  createRateTable(actor: M23WriteActor, body: CreateRateTableBody): Promise<RateTableView>;
  supersedeRateTable(
    actor: M23WriteActor,
    id: string,
    body: SupersedeRateTableBody,
  ): Promise<RateTableView>;
  listRateTables(
    actor: M23ReadActor,
    providerEntityId: string,
    opts: { includeSuperseded?: boolean },
  ): Promise<readonly RateTableView[]>;
  getRateTable(actor: M23ReadActor, providerEntityId: string, id: string): Promise<RateTableView>;
  effectiveRateTable(
    actor: M23ReadActor,
    providerEntityId: string,
    onDate: string,
  ): Promise<RateTableView | null>;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function mapRateTable(row: schema.HospiceRateTable): RateTableView {
  return {
    rateTableId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    fiscalYearStarting: row.fiscalYearStarting,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    rhcDays1to60PerDiemCents: row.rhcDays1to60PerDiemCents,
    rhcDays61PlusPerDiemCents: row.rhcDays61PlusPerDiemCents,
    chcPerDiemCents: row.chcPerDiemCents,
    ircPerDiemCents: row.ircPerDiemCents,
    gipPerDiemCents: row.gipPerDiemCents,
    chcHourlyRateCents: row.chcHourlyRateCents,
    laborShareRhc: row.laborShareRhc,
    laborShareChc: row.laborShareChc,
    laborShareIrc: row.laborShareIrc,
    laborShareGip: row.laborShareGip,
    enteredByMembershipId: row.enteredByMembershipId,
    entryReason: row.entryReason,
    supersededAt: iso(row.supersededAt),
    supersededById: row.supersededById,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Postgres `exclusion_violation` — the EXCLUDE backstop tripped by a concurrent overlapping writer. */
function isExclusionViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23P01" || e?.cause?.code === "23P01";
}

/**
 * ORG-EXPLICIT: the LIVE rate table covering `date` for a provider entity, or `null`. The claim-assembly adapter's
 * only read of this table; runs in its own `withOrgContext` so RLS scopes it to `orgId`.
 */
export async function hospiceRateTableEffectiveForOrg(
  db: BillingDb,
  orgId: string,
  providerEntityId: string,
  date: string,
): Promise<schema.HospiceRateTable | null> {
  return withOrgContext<BillingDb, schema.HospiceRateTable | null>(
    db,
    { organizationId: orgId, userId: "" },
    (tx) => new repositories.HospiceRateTableRepository(tx).findEffectiveOn(providerEntityId, date),
  );
}

export function buildDrizzleRateTableService(
  db: BillingDb,
  now: () => Date = () => new Date(),
): RateTableRouteService {
  const inCtx = <T>(actor: M23ReadActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);

  function validated(body: CreateRateTableBody | SupersedeRateTableBody): string {
    const v = validateRateTableEntry(body);
    if (!v.ok) {
      throw new WardenXError("RATE_TABLE_INVALID", `invalid rate table: ${v.errors.join("; ")}`, 422);
    }
    return v.effectiveTo;
  }

  function overlapError(clash: schema.HospiceRateTable): WardenXError {
    return new WardenXError(
      "RATE_TABLE_OVERLAP",
      `the effective window overlaps live rate table ${clash.id} (${clash.effectiveFrom}..${clash.effectiveTo ?? "open"}); supersede that version instead of entering a second one`,
      409,
    );
  }

  async function insertVersion(
    tx: BillingDb,
    actor: M23WriteActor,
    body: CreateRateTableBody | SupersedeRateTableBody,
    effectiveTo: string,
    id: string,
    excludeId?: string,
  ): Promise<schema.HospiceRateTable> {
    const repo = new repositories.HospiceRateTableRepository(tx);
    const clashes = await repo.findLiveOverlapping(
      body.providerEntityId,
      body.effectiveFrom,
      effectiveTo,
      excludeId,
    );
    const clash = clashes.find((c) =>
      dateRangesOverlap(
        { from: c.effectiveFrom, to: c.effectiveTo },
        { from: body.effectiveFrom, to: effectiveTo },
      ),
    );
    if (clash) throw overlapError(clash);
    try {
      return await repo.create({
        id,
        organizationId: actor.organizationId,
        providerEntityId: body.providerEntityId,
        fiscalYearStarting: body.fiscalYearStarting,
        effectiveFrom: body.effectiveFrom,
        effectiveTo,
        rhcDays1to60PerDiemCents: body.rhcDays1to60PerDiemCents,
        rhcDays61PlusPerDiemCents: body.rhcDays61PlusPerDiemCents,
        chcPerDiemCents: body.chcPerDiemCents,
        ircPerDiemCents: body.ircPerDiemCents,
        gipPerDiemCents: body.gipPerDiemCents,
        chcHourlyRateCents: body.chcHourlyRateCents,
        laborShareRhc: body.laborShareRhc,
        laborShareChc: body.laborShareChc,
        laborShareIrc: body.laborShareIrc,
        laborShareGip: body.laborShareGip,
        enteredByMembershipId: actor.membershipId,
        ...(body.entryReason !== undefined ? { entryReason: body.entryReason } : {}),
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new WardenXError(
          "RATE_TABLE_OVERLAP",
          "the effective window overlaps a live rate table entered concurrently",
          409,
        );
      }
      throw err;
    }
  }

  return {
    async createRateTable(actor, body) {
      const effectiveTo = validated(body);
      return inCtx(actor, async (tx) =>
        mapRateTable(await insertVersion(tx, actor, body, effectiveTo, randomUUID())),
      );
    },

    async supersedeRateTable(actor, id, body) {
      const effectiveTo = validated(body);
      return inCtx(actor, async (tx) => {
        const repo = new repositories.HospiceRateTableRepository(tx);
        const old = await repo.findById(id);
        // RLS already hides other tenants' rows; a provider-entity mismatch is the same 404 (no existence leak).
        if (!old || old.providerEntityId !== body.providerEntityId) {
          throw new NotFoundError("rate table");
        }
        if (old.supersededAt !== null) {
          throw new WardenXError(
            "RATE_TABLE_ALREADY_SUPERSEDED",
            `rate table ${id} was already superseded by ${old.supersededById}`,
            409,
          );
        }
        // The successor's id is minted first so the old row can name it; the old row is superseded BEFORE the
        // insert so the successor may reuse (or shrink/extend into) the freed window without tripping the EXCLUDE.
        const successorId = randomUUID();
        const marked = await repo.markSuperseded(id, successorId, now());
        if (!marked) {
          throw new WardenXError("RATE_TABLE_ALREADY_SUPERSEDED", `rate table ${id} was already superseded`, 409);
        }
        return mapRateTable(await insertVersion(tx, actor, body, effectiveTo, successorId, id));
      });
    },

    async listRateTables(actor, providerEntityId, opts) {
      return inCtx(actor, async (tx) => {
        const rows = await new repositories.HospiceRateTableRepository(tx).listForProviderEntity(
          providerEntityId,
          opts.includeSuperseded ? { includeSuperseded: true } : {},
        );
        return rows.filter((r) => r.organizationId === actor.organizationId).map(mapRateTable);
      });
    },

    async getRateTable(actor, providerEntityId, id) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.HospiceRateTableRepository(tx).findById(id);
        if (!row || row.organizationId !== actor.organizationId || row.providerEntityId !== providerEntityId) {
          throw new NotFoundError("rate table");
        }
        return mapRateTable(row);
      });
    },

    async effectiveRateTable(actor, providerEntityId, onDate) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.HospiceRateTableRepository(tx).findEffectiveOn(providerEntityId, onDate);
        return row && row.organizationId === actor.organizationId ? mapRateTable(row) : null;
      });
    },
  };
}
