// apps/backend/src/modules/36-messaging/oncall-directory/oncall-coverage-service.ts - WP 4.12 (ADR-0080): the read-only "who is covering
// now" directory. It asks the EscalationRouter seam (M19 owns rosters) tier by tier for one role and one patient's team, names the people
// through the org-scoped member lookup, and states one of four statuses. Honesty rules: a coverage gap is its own state, "no router bound"
// is UNKNOWN (never an empty list), a router failure propagates (never turned into a gap), the zone is the roster's, and a shift end is
// shown only if the roster supplied a valid one. Ids never leave the server; only display names do.
import {
  type EscalationRouteAnswer,
  type EscalationRouter,
  NotFoundError,
  ONCALL_DIRECTORY_MAX_TIERS,
  type OnCallCoverageDto,
  type OnCallDirectoryRole,
  type OnCallDirectoryStatus,
  type OnCallRank,
  type OnCallTierDto,
} from "@wardenx/types";

export interface OnCallCoverageDeps {
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The guarded router (org and answer checks); test sources are refused by the guard. */
  readonly router: EscalationRouter;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

export interface OnCallCoverageService {
  get(
    actor: { readonly orgId: string },
    input: { readonly role: OnCallDirectoryRole; readonly patientId: string },
  ): Promise<OnCallCoverageDto>;
}

/** A shift end is shown only when it is a real instant after `asOf`; anything else is "not provided". */
export function validShiftEnd(value: string | undefined, asOf: Date): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) || at <= asOf ? null : at.toISOString();
}

/**
 * The router's order IS the rank (EscalationRouter contract, ADR-0057 item 12): first = primary, the rest = backup. No sort. A repeated
 * id keeps its FIRST position, so a user who is both primary and backup is the primary. Callers normalise id case first.
 */
export function rankedIds(
  userIds: readonly string[],
): readonly { readonly id: string; readonly rank: OnCallRank }[] {
  return [...new Set(userIds)].map((id, index) => ({
    id,
    rank: index === 0 ? "primary" : "backup",
  }));
}

export function unavailableStatus(
  answer: Extract<EscalationRouteAnswer, { kind: "unavailable" }>,
): OnCallDirectoryStatus {
  return answer.source === "deny_stub" || answer.reason === "router_not_bound"
    ? "roster_not_connected"
    : "not_configured";
}

export function createOnCallCoverageService(deps: OnCallCoverageDeps): OnCallCoverageService {
  const now = deps.now ?? (() => new Date());
  return {
    async get(actor, input) {
      if (!(await deps.isEnabled(actor.orgId))) throw new NotFoundError("oncall directory");
      const asOfDate = now();
      const asOf = asOfDate.toISOString();
      const tiers: OnCallTierDto[] = [];
      let status: OnCallDirectoryStatus = "not_configured";
      let next: number | null = 1;
      while (next !== null && tiers.length < ONCALL_DIRECTORY_MAX_TIERS) {
        const answer: EscalationRouteAnswer = await deps.router.resolveTier(actor.orgId, {
          patientId: input.patientId,
          requiredRole: input.role,
          tier: next,
          asOf,
        });
        if (answer.kind === "unavailable") {
          if (tiers.length === 0) status = unavailableStatus(answer);
          break;
        }
        if (tiers.length === 0) status = answer.kind === "resolved" ? "covered" : "coverage_gap";
        const people =
          answer.kind === "resolved"
            ? await Promise.all(
                rankedIds(answer.userIds).map(async ({ id, rank }) => ({
                  display_name: await deps.displayName(actor.orgId, id),
                  rank,
                })),
              )
            : [];
        tiers.push({
          tier: answer.tier,
          state: answer.kind === "resolved" ? "covering" : "coverage_gap",
          people,
          shift_ends_at:
            answer.kind === "resolved" ? validShiftEnd(answer.shiftEndsAt, asOfDate) : null,
          time_zone: answer.timeZone,
        });
        next = answer.nextTier;
      }
      return { role: input.role, as_of: asOf, status, tiers };
    },
  };
}
