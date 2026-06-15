// @wardenx/auth · identity — the published `SessionContextResolver` seam (M2-T07; M2 spec §4.7).
//
// M2 publishes the authenticated, org-scoped request context as a boot-registered seam so
// consumers need NO dependsOn edge on M2: Module 3's `step_up_recent` predicate reads
// `lastStepUpAt`/`lastStepUpFactor` through `resolveStepUpState`, Module 4 reads the actor
// for the audit trail, and every module needing an authenticated context resolves the actor.
// The contract type lives in @wardenx/types (leaf); the IMPLEMENTATION here is injected at
// boot and validated by validateSeams().
//
// Resolution is org-scoped by construction: a session row whose `organizationId` ≠ the
// caller's `scope.orgId` resolves to null, so the seam cannot leak a session across tenants
// even before the row-level RLS layer (defense in depth, matching the §9.3 isolation invariant).
//
// SLICE NOTE: the resolver reads through an injected `SessionContextStore` port — the slice
// has no live DB. Production injects the store that selects the M1-owned `session` row (joined
// to its `membership`/roles) inside `withOrgContext`, so RLS scopes the read by `app.org_id`.
import type {
  OrgScope,
  ResolvedActor,
  SessionContextResolver,
  SessionStepUpFields,
  StepUpFactor,
} from "@wardenx/types";

/** A session row as the resolver needs it (sourced from the M1-owned `session` table). */
export interface SessionContextRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly membershipId: string | null;
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: StepUpFactor | null;
}

/** Reads a session-context row by id within an org scope (M1 `session` repo in production). */
export interface SessionContextStore {
  read(
    scope: OrgScope,
    sessionId: string,
  ): Promise<SessionContextRecord | null> | SessionContextRecord | null;
}

/** Build the `SessionContextResolver` seam over a `SessionContextStore`. */
export function createSessionContextResolver(store: SessionContextStore): SessionContextResolver {
  /** Read + org-scope guard shared by both resolver methods. */
  const readScoped = async (scope: OrgScope, sessionId: string) => {
    const row = await store.read(scope, sessionId);
    return row && row.organizationId === scope.orgId ? row : null;
  };
  return {
    async resolveActor(scope, sessionId): Promise<ResolvedActor | null> {
      const row = await readScoped(scope, sessionId);
      if (!row) return null;
      return {
        userId: row.userId,
        membershipId: row.membershipId,
        organizationId: row.organizationId,
        roles: row.roles,
      };
    },
    async resolveStepUpState(scope, sessionId): Promise<SessionStepUpFields | null> {
      const row = await readScoped(scope, sessionId);
      if (!row) return null;
      return { lastStepUpAt: row.lastStepUpAt, lastStepUpFactor: row.lastStepUpFactor };
    },
  };
}

/** In-memory session-context store seeded with rows (slice/test default). */
export function createInMemorySessionContextStore(seed: SessionContextRecord[] = []): {
  store: SessionContextStore;
  put(row: SessionContextRecord): void;
} {
  const rows = new Map<string, SessionContextRecord>(seed.map((r) => [r.sessionId, r]));
  return {
    store: {
      read: (scope, sessionId) => {
        const row = rows.get(sessionId);
        return row && row.organizationId === scope.orgId ? row : null;
      },
    },
    put: (row) => rows.set(row.sessionId, row),
  };
}
