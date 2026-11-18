// apps/backend/src/modules/08-encounters/closure/closure-route-service.ts — the production service behind the visit-note closure
// routes (ADR-0113): it composes the policy, override, reader and board services inside `withOrgContext` so RLS scopes every row
// as the unprivileged `chartwarden_app` role. The routes (routes/closure-routes.ts) stay thin and a test can fake this interface.
import type { AuditContext } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { DocumentationObligationKind } from "@chartwarden/types";
import { evaluateMemberClosure } from "./closure-reader";
import type { ClosureVerdict, NoteClosureMode, NoteClosureStage } from "./note-clock";
import { type OverdueBoard, listOverdueNotes } from "./overdue-board";
import {
  type ClosureOverrideView,
  grantClosureOverride,
  revokeClosureOverride,
} from "./override-service";
import {
  type ClosurePolicy,
  type ClosurePolicyCache,
  createClosurePolicyCache,
  putClosurePolicy,
  readClosurePolicy,
} from "./policy-service";

/** Slice 1 serves one obligation kind. */
const VISIT_NOTE = "visit_note" as const;

/** The authenticated caller of a closure route (the route reads it off `request.context`, never the body). */
export interface ClosureActor {
  readonly organizationId: string;
  /** Better Auth user id: the RLS / audit-trigger actor and `configured_by_user_id`. */
  readonly userId: string;
  /** The caller's membership: `granted_by` / `revoked_by` and "my notes". */
  readonly membershipId: string;
}

export interface ClosureStatusView {
  readonly mode: NoteClosureMode;
  readonly thresholdHours: number;
  readonly verdict: ClosureVerdict;
  readonly stage: NoteClosureStage;
  readonly encounterId: string | null;
  readonly deadlineAt: string | null;
  readonly hoursOverdue: number;
  readonly overdueCount: number;
  readonly overrideExpiresAt: string | null;
}

export interface ClosureOverrideWire {
  readonly id: string;
  readonly subjectMembershipId: string;
  readonly grantedByMembershipId: string;
  readonly obligationKind: DocumentationObligationKind;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** A revoked grant on the wire, plus whether another supervisor's grant still lifts the same clinician. */
export interface ClosureOverrideRevokedWire extends ClosureOverrideWire {
  /** The latest expiry of any OTHER active grant for the same clinician; null when the revoke re-blocks them. */
  readonly remainingActiveUntil: string | null;
}

export interface ClosurePolicyWire {
  readonly obligationKind: "visit_note";
  readonly mode: NoteClosureMode;
  readonly thresholdHours: number;
  readonly enforceFrom: string | null;
}

export interface GrantClosureOverrideRequest {
  readonly subjectMembershipId: string;
  readonly reason: string;
  readonly hours?: number;
  /** The grantor's location scope, as the board reads it: `null` = org-wide, otherwise their sites. */
  readonly locationIds: readonly string[] | null;
  /** The request's audit context for the explicit audit event. */
  readonly audit: AuditContext;
}

export interface ClosureRouteService {
  /** The caller's own position on the clock, for the banner. */
  closureStatus(actor: ClosureActor): Promise<ClosureStatusView>;
  /** The supervisor board; `locationIds: null` is org-wide scope. */
  overdueNotes(
    actor: ClosureActor,
    query: { limit: number; locationIds: readonly string[] | null },
  ): Promise<OverdueBoard>;
  grantOverride(
    actor: ClosureActor,
    request: GrantClosureOverrideRequest,
  ): Promise<ClosureOverrideWire>;
  revokeOverride(
    actor: ClosureActor,
    overrideId: string,
    audit: AuditContext,
  ): Promise<ClosureOverrideRevokedWire>;
  getPolicy(organizationId: string): Promise<ClosurePolicyWire>;
  /** Upserts the policy, records the explicit audit event and invalidates the gate's cache for the organization. */
  putPolicy(
    actor: ClosureActor,
    body: { mode: NoteClosureMode; thresholdHours: number },
    audit: AuditContext,
  ): Promise<ClosurePolicyWire>;
}

const iso = (instant: Date | null): string | null =>
  instant === null ? null : instant.toISOString();

function overrideWire(view: ClosureOverrideView): ClosureOverrideWire {
  return {
    id: view.id,
    subjectMembershipId: view.subjectMembershipId,
    grantedByMembershipId: view.grantedByMembershipId,
    obligationKind: view.obligationKind,
    grantedAt: view.grantedAt.toISOString(),
    expiresAt: view.expiresAt.toISOString(),
    revokedAt: iso(view.revokedAt),
  };
}

function policyWire(policy: ClosurePolicy): ClosurePolicyWire {
  return {
    obligationKind: VISIT_NOTE,
    mode: policy.mode,
    thresholdHours: policy.thresholdHours,
    enforceFrom: iso(policy.enforceFrom),
  };
}

/**
 * The gate's and the status route's shared policy cache over the database (5s per organization and kind). The composition root
 * builds ONE and hands it to both the gate and `mountEncounterRoutes`, so a policy PUT invalidates what the gate reads.
 */
export function createDbClosurePolicyCache(db: DbClient): ClosurePolicyCache {
  return createClosurePolicyCache({
    load: (organizationId, kind) =>
      withOrgContext(db, systemOrgContext(organizationId), (tx) =>
        readClosurePolicy(tx as unknown as DbClient, organizationId, kind),
      ),
  });
}

export interface ClosureRouteServiceDeps {
  readonly db: DbClient;
  /** Shared with the gate; created over `db` when absent. */
  readonly policyCache?: ClosurePolicyCache;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: () => Date;
}

export function createDbClosureRouteService(deps: ClosureRouteServiceDeps): ClosureRouteService {
  const { db } = deps;
  const policyCache = deps.policyCache ?? createDbClosurePolicyCache(db);
  const clock = deps.now ?? (() => new Date());
  const inOrg = <T>(actor: ClosureActor, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, (tx) =>
      fn(tx as unknown as DbClient),
    );

  return {
    async closureStatus(actor) {
      const now = clock();
      const policy = await policyCache.get(actor.organizationId, VISIT_NOTE);
      const evaluation = await inOrg(actor, (tx) =>
        evaluateMemberClosure(tx, {
          organizationId: actor.organizationId,
          membershipId: actor.membershipId,
          now,
          policy,
        }),
      );
      return {
        mode: evaluation.mode,
        thresholdHours: evaluation.thresholdHours,
        verdict: evaluation.verdict,
        stage: evaluation.decision.stage,
        encounterId: evaluation.encounterId,
        deadlineAt: iso(evaluation.decision.deadlineAt),
        hoursOverdue: evaluation.decision.hoursOverdue,
        overdueCount: evaluation.overdueCount,
        overrideExpiresAt: iso(evaluation.overrideExpiresAt),
      };
    },

    async overdueNotes(actor, query) {
      const policy = await policyCache.get(actor.organizationId, VISIT_NOTE);
      return inOrg(actor, (tx) =>
        listOverdueNotes(tx, {
          organizationId: actor.organizationId,
          policy,
          now: clock(),
          limit: query.limit,
          locationIds: query.locationIds,
        }),
      );
    },

    async grantOverride(actor, request) {
      const view = await inOrg(actor, (tx) =>
        grantClosureOverride(tx, {
          organizationId: actor.organizationId,
          subjectMembershipId: request.subjectMembershipId,
          grantedByMembershipId: actor.membershipId,
          obligationKind: VISIT_NOTE,
          reason: request.reason,
          ...(request.hours === undefined ? {} : { hours: request.hours }),
          locationIds: request.locationIds,
          audit: request.audit,
          now: clock(),
        }),
      );
      return overrideWire(view);
    },

    async revokeOverride(actor, overrideId, audit) {
      const revoked = await inOrg(actor, (tx) =>
        revokeClosureOverride(tx, {
          organizationId: actor.organizationId,
          overrideId,
          revokedByMembershipId: actor.membershipId,
          audit,
          now: clock(),
        }),
      );
      return {
        ...overrideWire(revoked.override),
        remainingActiveUntil: iso(revoked.remainingActiveUntil),
      };
    },

    async getPolicy(organizationId) {
      // A fresh read, not the cache: the settings screen must show what is stored.
      const policy = await withOrgContext(db, systemOrgContext(organizationId), (tx) =>
        readClosurePolicy(tx as unknown as DbClient, organizationId, VISIT_NOTE),
      );
      return policyWire(policy);
    },

    async putPolicy(actor, body, audit) {
      const written = await inOrg(actor, (tx) =>
        putClosurePolicy(tx, {
          organizationId: actor.organizationId,
          obligationKind: VISIT_NOTE,
          mode: body.mode,
          thresholdHours: body.thresholdHours,
          actorUserId: actor.userId,
          audit,
          now: clock(),
        }),
      );
      // After the commit, so a reader that reloads cannot repopulate the cache with the previous row.
      policyCache.invalidate(actor.organizationId);
      return policyWire(written);
    },
  };
}
