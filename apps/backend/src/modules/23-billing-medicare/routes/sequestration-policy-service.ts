// apps/backend/src/modules/23-billing-medicare/routes/sequestration-policy-service.ts — M23 tenant-entered SEQUESTRATION
// POLICY service (F-212): create / supersede / list / get / active / effective-on.
//
// The same shape as the F-210 rate-table service, because it is the same problem: claim assembly fails closed unless a
// tenant-entered, effective-dated row covers the service date. Validation is layered: the pure rules in `@chartwarden/billing`
// (`validateSequestrationPolicyEntry`: plausibility band 0-2%, reason required off-2%, effective window) run first for a precise
// 422; the overlap pre-check names the clashing row for a precise 409; migration 0281's EXCLUDE constraint is the race-safe
// backstop (a concurrent writer that slips past the pre-check surfaces as the same 409, never as two live rows).
//
// APPEND-ONLY. A row's percentage/start/reason is never edited: a correction SUPERSEDES it (it stays readable as history), and
// the one in-place change the database allows is CLOSING an open period so a successor can take over. Already-assembled claims
// are unaffected (assembly snapshots `claim.sequestration_applied_pct` + `sequestration_policy_id`).
//
// NO silent default. There is deliberately no "assume 2%" (or 0%) fallback: a wrong withhold silently mis-states every claim's
// expected payment. A tenant with no row for the service date gets `SEQUESTRATION_POLICY_UNAVAILABLE` naming this route.
import { randomUUID } from "node:crypto";
import { addDaysIso, repositories, validateSequestrationPolicyEntry } from "@chartwarden/billing";
import type * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type {
  CreateSequestrationPolicyBody,
  SequestrationPolicyView,
  SupersedeSequestrationPolicyBody,
} from "./sequestration-policy-typebox";

type BillingDb = repositories.BillingDb;

export interface SequestrationPolicyRouteService {
  createPolicy(
    actor: M23WriteActor,
    body: CreateSequestrationPolicyBody,
  ): Promise<SequestrationPolicyView>;
  supersedePolicy(
    actor: M23WriteActor,
    id: string,
    body: SupersedeSequestrationPolicyBody,
  ): Promise<SequestrationPolicyView>;
  listPolicies(
    actor: M23ReadActor,
    providerEntityId: string,
    opts: { includeSuperseded?: boolean },
  ): Promise<readonly SequestrationPolicyView[]>;
  getPolicy(
    actor: M23ReadActor,
    providerEntityId: string,
    id: string,
  ): Promise<SequestrationPolicyView>;
  /** The live open-ended (current-schedule) policy, or null. */
  activePolicy(
    actor: M23ReadActor,
    providerEntityId: string,
  ): Promise<SequestrationPolicyView | null>;
  /** The live policy covering `onDate` (what claim assembly would use), or null. */
  effectivePolicy(
    actor: M23ReadActor,
    providerEntityId: string,
    onDate: string,
  ): Promise<SequestrationPolicyView | null>;
}

export function mapSequestrationPolicy(row: schema.SequestrationPolicy): SequestrationPolicyView {
  return {
    policyId: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    percentage: row.percentage,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo ?? null,
    setByMembershipId: row.setByMembershipId,
    setReason: row.setReason ?? null,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    supersededById: row.supersededById ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Postgres `exclusion_violation` — the EXCLUDE backstop tripped by a concurrent overlapping writer. */
function isExclusionViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23P01" || e?.cause?.code === "23P01";
}

export function buildDrizzleSequestrationPolicyService(
  db: BillingDb,
  now: () => Date = () => new Date(),
): SequestrationPolicyRouteService {
  const inCtx = <T>(actor: M23ReadActor, fn: (tx: BillingDb) => Promise<T>): Promise<T> =>
    withOrgContext<BillingDb, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  function validated(body: CreateSequestrationPolicyBody | SupersedeSequestrationPolicyBody) {
    const v = validateSequestrationPolicyEntry(
      {
        percentage: body.percentage,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        setReason: body.setReason ?? null,
      },
      now().toISOString().slice(0, 10),
    );
    if (!v.ok) {
      throw new ChartWardenError(
        "SEQUESTRATION_POLICY_INVALID",
        `invalid sequestration policy: ${v.errors.join("; ")}`,
        422,
      );
    }
    return v.effectiveTo;
  }

  function overlapError(clash: schema.SequestrationPolicy): ChartWardenError {
    return new ChartWardenError(
      "SEQUESTRATION_POLICY_OVERLAP",
      `the effective window overlaps live sequestration policy ${clash.id} (${clash.percentage}% ${clash.effectiveFrom}..${clash.effectiveTo ?? "open"}); supersede that policy instead of entering a second one`,
      409,
    );
  }

  async function insertVersion(
    tx: BillingDb,
    actor: M23WriteActor,
    body: CreateSequestrationPolicyBody | SupersedeSequestrationPolicyBody,
    effectiveTo: string | null,
    id: string,
    excludeId?: string,
  ): Promise<schema.SequestrationPolicy> {
    const repo = new repositories.SequestrationPolicyRepository(tx);
    const clashes = await repo.findLiveOverlapping(
      body.providerEntityId,
      body.effectiveFrom,
      effectiveTo,
      excludeId,
    );
    // A new OPEN-ENDED policy that starts after a live open-ended one simply takes over from it (the annual-change case): the
    // predecessor is closed the day before. Anything else that overlaps is a conflict the caller must resolve by superseding.
    const takeover =
      effectiveTo === null
        ? clashes.filter((c) => c.effectiveTo === null && c.effectiveFrom < body.effectiveFrom)
        : [];
    const conflicts = clashes.filter((c) => !takeover.includes(c));
    if (conflicts[0]) throw overlapError(conflicts[0]);
    try {
      for (const c of takeover) {
        await repo.closeOpenPeriod(c.id, addDaysIso(body.effectiveFrom, -1));
      }
      return await repo.create({
        id,
        organizationId: actor.organizationId,
        providerEntityId: body.providerEntityId,
        percentage: body.percentage,
        effectiveFrom: body.effectiveFrom,
        effectiveTo,
        setByMembershipId: actor.membershipId,
        ...(body.setReason !== undefined ? { setReason: body.setReason } : {}),
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new ChartWardenError(
          "SEQUESTRATION_POLICY_OVERLAP",
          "the effective window overlaps a live sequestration policy entered concurrently",
          409,
        );
      }
      throw err;
    }
  }

  return {
    async createPolicy(actor, body) {
      const effectiveTo = validated(body);
      return inCtx(actor, async (tx) =>
        mapSequestrationPolicy(await insertVersion(tx, actor, body, effectiveTo, randomUUID())),
      );
    },

    async supersedePolicy(actor, id, body) {
      const effectiveTo = validated(body);
      return inCtx(actor, async (tx) => {
        const repo = new repositories.SequestrationPolicyRepository(tx);
        const old = await repo.findById(id);
        // RLS already hides other tenants' rows; a provider-entity mismatch is the same 404 (no existence leak).
        if (!old || old.providerEntityId !== body.providerEntityId) {
          throw new NotFoundError("sequestration policy");
        }
        if (old.supersededAt !== null) {
          throw new ChartWardenError(
            "SEQUESTRATION_POLICY_ALREADY_SUPERSEDED",
            `sequestration policy ${id} was already superseded by ${old.supersededById}`,
            409,
          );
        }
        // The successor's id is minted first so the old row can name it; the old row is superseded BEFORE the insert so the
        // successor may reuse (or shrink/extend into) the freed window without tripping the EXCLUDE.
        const successorId = randomUUID();
        const marked = await repo.markSuperseded(id, successorId, now());
        if (!marked) {
          throw new ChartWardenError(
            "SEQUESTRATION_POLICY_ALREADY_SUPERSEDED",
            `sequestration policy ${id} was already superseded`,
            409,
          );
        }
        return mapSequestrationPolicy(
          await insertVersion(tx, actor, body, effectiveTo, successorId, id),
        );
      });
    },

    async listPolicies(actor, providerEntityId, opts) {
      return inCtx(actor, async (tx) => {
        const rows = await new repositories.SequestrationPolicyRepository(tx).listForProviderEntity(
          providerEntityId,
          opts.includeSuperseded ? { includeSuperseded: true } : {},
        );
        return rows
          .filter((r) => r.organizationId === actor.organizationId)
          .map(mapSequestrationPolicy);
      });
    },

    async getPolicy(actor, providerEntityId, id) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.SequestrationPolicyRepository(tx).findById(id);
        if (
          !row ||
          row.organizationId !== actor.organizationId ||
          row.providerEntityId !== providerEntityId
        ) {
          throw new NotFoundError("sequestration policy");
        }
        return mapSequestrationPolicy(row);
      });
    },

    async activePolicy(actor, providerEntityId) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.SequestrationPolicyRepository(
          tx,
        ).findActiveForProviderEntity(providerEntityId);
        return row && row.organizationId === actor.organizationId
          ? mapSequestrationPolicy(row)
          : null;
      });
    },

    async effectivePolicy(actor, providerEntityId, onDate) {
      return inCtx(actor, async (tx) => {
        const row = await new repositories.SequestrationPolicyRepository(tx).findEffectiveOn(
          providerEntityId,
          onDate,
        );
        return row && row.organizationId === actor.organizationId
          ? mapSequestrationPolicy(row)
          : null;
      });
    },
  };
}
