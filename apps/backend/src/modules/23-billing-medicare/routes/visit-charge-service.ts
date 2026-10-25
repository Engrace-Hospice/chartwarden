// apps/backend/src/modules/23-billing-medicare/routes/visit-charge-service.ts — M23 tenant-entered hospice VISIT-CHARGE
// SCHEDULE service (migration 1056): create / supersede / list / get / effective-on, plus the ORG-EXPLICIT lookup the
// claim-assembly `referenceData` adapter binds (`visitChargeVersionsForOrg`, the F-121 org-explicit seam-function pattern:
// boot-time closures have no ambient request context, so each read opens its own `withOrgContext`).
//
// The shape is the rate-table service's (rate-table-service.ts): the pure rules in `@chartwarden/billing`
// (`validateVisitChargeEntry`) run first for a precise 422; the overlap pre-check names the conflicting version for a
// precise 409; the migration's EXCLUDE constraint is the race-safe backstop. Charges are append-only: a correction
// SUPERSEDES the old version (it stays readable as history) and already-assembled claims are unaffected because the
// assembled line charge is snapshotted onto `claim_line`.
import { randomUUID } from "node:crypto";
import {
  type VisitChargeVersion,
  type VisitUnitCharges,
  dateRangesOverlap,
  repositories,
  validateVisitChargeEntry,
} from "@chartwarden/billing";
import type * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type {
  CreateVisitChargeBody,
  SupersedeVisitChargeBody,
  VisitChargeView,
} from "./visit-charge-typebox";

type BillingDb = repositories.BillingDb;
type ScheduleBody = CreateVisitChargeBody | SupersedeVisitChargeBody;

export interface VisitChargeRouteService {
  createVisitCharge(actor: M23WriteActor, body: CreateVisitChargeBody): Promise<VisitChargeView>;
  supersedeVisitCharge(
    actor: M23WriteActor,
    id: string,
    body: SupersedeVisitChargeBody,
  ): Promise<VisitChargeView>;
  listVisitCharges(
    actor: M23ReadActor,
    providerEntityId: string,
    opts: { includeSuperseded?: boolean },
  ): Promise<readonly VisitChargeView[]>;
  getVisitCharge(
    actor: M23ReadActor,
    providerEntityId: string,
    id: string,
  ): Promise<VisitChargeView>;
  effectiveVisitCharge(
    actor: M23ReadActor,
    providerEntityId: string,
    onDate: string,
  ): Promise<VisitChargeView | null>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The stored row's per-discipline charges in the pure domain's vocabulary (an aide is `chha`). */
export function chargesOfRow(row: schema.HospiceVisitChargeSchedule): VisitUnitCharges {
  return {
    rn: row.rnUnitChargeCents,
    lpn: row.lpnUnitChargeCents,
    chha: row.aideUnitChargeCents,
    msw: row.mswUnitChargeCents,
    pt: row.ptUnitChargeCents,
    ot: row.otUnitChargeCents,
    slp: row.slpUnitChargeCents,
  };
}

/** The request body's per-discipline charges in the pure domain's vocabulary; an omitted field is no charge. */
export function chargesOfBody(body: ScheduleBody): VisitUnitCharges {
  return {
    rn: body.rnUnitChargeCents ?? null,
    lpn: body.lpnUnitChargeCents ?? null,
    chha: body.aideUnitChargeCents ?? null,
    msw: body.mswUnitChargeCents ?? null,
    pt: body.ptUnitChargeCents ?? null,
    ot: body.otUnitChargeCents ?? null,
    slp: body.slpUnitChargeCents ?? null,
  };
}

export function toVisitChargeVersion(row: schema.HospiceVisitChargeSchedule): VisitChargeVersion {
  return {
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    charges: chargesOfRow(row),
  };
}

export function mapVisitCharge(row: schema.HospiceVisitChargeSchedule): VisitChargeView {
  return {
    visitChargeScheduleId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    rnUnitChargeCents: row.rnUnitChargeCents,
    lpnUnitChargeCents: row.lpnUnitChargeCents,
    aideUnitChargeCents: row.aideUnitChargeCents,
    mswUnitChargeCents: row.mswUnitChargeCents,
    ptUnitChargeCents: row.ptUnitChargeCents,
    otUnitChargeCents: row.otUnitChargeCents,
    slpUnitChargeCents: row.slpUnitChargeCents,
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
 * ORG-EXPLICIT: the LIVE versions whose window intersects `[from, to]` for a provider entity (a claim can span a
 * schedule change). The claim-assembly adapter's only read of this table; runs in its own `withOrgContext` so RLS
 * scopes it to `orgId`.
 */
export async function visitChargeVersionsForOrg(
  db: BillingDb,
  orgId: string,
  providerEntityId: string,
  range: { readonly from: string; readonly to: string },
): Promise<readonly VisitChargeVersion[]> {
  return withOrgContext<BillingDb, readonly VisitChargeVersion[]>(
    db,
    { organizationId: orgId, userId: "" },
    async (tx) =>
      (
        await new repositories.HospiceVisitChargeScheduleRepository(tx).findLiveOverlapping(
          providerEntityId,
          range.from,
          range.to,
        )
      ).map(toVisitChargeVersion),
  );
}

export function buildDrizzleVisitChargeService(
  db: BillingDb,
  now: () => Date = () => new Date(),
): VisitChargeRouteService {
  const inCtx = <T>(actor: M23ReadActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  function validated(body: ScheduleBody): string | null {
    const v = validateVisitChargeEntry({
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      charges: chargesOfBody(body),
    });
    if (!v.ok) {
      throw new ChartWardenError(
        "VISIT_CHARGE_INVALID",
        `invalid visit-charge schedule: ${v.errors.join("; ")}`,
        422,
      );
    }
    return v.effectiveTo;
  }

  function overlapError(clash: schema.HospiceVisitChargeSchedule): ChartWardenError {
    return new ChartWardenError(
      "VISIT_CHARGE_OVERLAP",
      `the effective window overlaps live visit-charge schedule ${clash.id} (${clash.effectiveFrom}..${clash.effectiveTo ?? "open"}); supersede that version instead of entering a second one`,
      409,
    );
  }

  async function insertVersion(
    tx: BillingDb,
    actor: M23WriteActor,
    body: ScheduleBody,
    effectiveTo: string | null,
    id: string,
    excludeId?: string,
  ): Promise<schema.HospiceVisitChargeSchedule> {
    const repo = new repositories.HospiceVisitChargeScheduleRepository(tx);
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
    const charges = chargesOfBody(body);
    try {
      return await repo.create({
        id,
        organizationId: actor.organizationId,
        providerEntityId: body.providerEntityId,
        effectiveFrom: body.effectiveFrom,
        effectiveTo,
        rnUnitChargeCents: charges.rn,
        lpnUnitChargeCents: charges.lpn,
        aideUnitChargeCents: charges.chha,
        mswUnitChargeCents: charges.msw,
        ptUnitChargeCents: charges.pt,
        otUnitChargeCents: charges.ot,
        slpUnitChargeCents: charges.slp,
        enteredByMembershipId: actor.membershipId,
        ...(body.entryReason !== undefined ? { entryReason: body.entryReason } : {}),
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new ChartWardenError(
          "VISIT_CHARGE_OVERLAP",
          "the effective window overlaps a live visit-charge schedule entered concurrently",
          409,
        );
      }
      throw err;
    }
  }

  return {
    async createVisitCharge(actor, body) {
      const effectiveTo = validated(body);
      return inCtx(actor, async (tx) =>
        mapVisitCharge(await insertVersion(tx, actor, body, effectiveTo, randomUUID())),
      );
    },

    async supersedeVisitCharge(actor, id, body) {
      const effectiveTo = validated(body);
      return inCtx(actor, async (tx) => {
        const repo = new repositories.HospiceVisitChargeScheduleRepository(tx);
        const old = await repo.findById(id);
        // RLS already hides other tenants' rows; a provider-entity mismatch is the same 404 (no existence leak).
        if (!old || old.providerEntityId !== body.providerEntityId) {
          throw new NotFoundError("visit-charge schedule");
        }
        if (old.supersededAt !== null) {
          throw new ChartWardenError(
            "VISIT_CHARGE_ALREADY_SUPERSEDED",
            `visit-charge schedule ${id} was already superseded by ${old.supersededById}`,
            409,
          );
        }
        // The successor's id is minted first so the old row can name it; the old row is superseded BEFORE the
        // insert so the successor may reuse (or shrink/extend into) the freed window without tripping the EXCLUDE.
        const successorId = randomUUID();
        const marked = await repo.markSuperseded(id, successorId, now());
        if (!marked) {
          throw new ChartWardenError(
            "VISIT_CHARGE_ALREADY_SUPERSEDED",
            `visit-charge schedule ${id} was already superseded`,
            409,
          );
        }
        return mapVisitCharge(await insertVersion(tx, actor, body, effectiveTo, successorId, id));
      });
    },

    async listVisitCharges(actor, providerEntityId, opts) {
      return inCtx(actor, async (tx) => {
        const rows = await new repositories.HospiceVisitChargeScheduleRepository(
          tx,
        ).listForProviderEntity(
          providerEntityId,
          opts.includeSuperseded ? { includeSuperseded: true } : {},
        );
        return rows.filter((r) => r.organizationId === actor.organizationId).map(mapVisitCharge);
      });
    },

    async getVisitCharge(actor, providerEntityId, id) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.HospiceVisitChargeScheduleRepository(tx).findById(id);
        if (
          !row ||
          row.organizationId !== actor.organizationId ||
          row.providerEntityId !== providerEntityId
        ) {
          throw new NotFoundError("visit-charge schedule");
        }
        return mapVisitCharge(row);
      });
    },

    async effectiveVisitCharge(actor, providerEntityId, onDate) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.HospiceVisitChargeScheduleRepository(tx).findEffectiveOn(
          providerEntityId,
          onDate,
        );
        return row && row.organizationId === actor.organizationId ? mapVisitCharge(row) : null;
      });
    },
  };
}
