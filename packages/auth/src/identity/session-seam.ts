// @chartwarden/auth · identity — the published `SessionContextResolver` seam (M2-T07; M2 spec §4.7).
//
// M2 publishes the authenticated, org-scoped request context as a boot-registered seam so
// consumers need NO dependsOn edge on M2: Module 3's `step_up_recent` predicate reads
// `lastStepUpAt`/`lastStepUpFactor` through `resolveStepUpState`, Module 4 reads the actor
// for the audit trail, and every module needing an authenticated context resolves the actor.
// The contract type lives in @chartwarden/types (leaf); the IMPLEMENTATION here is injected at
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
  ResolvedStepUpPolicy,
  SessionContextResolver,
  SessionStepUpFields,
  StepUpFactor,
} from "@chartwarden/types";
import { type StepUpOverrideStore, tightenStepUpPolicy } from "./step-up-policy";

/** A session row as the resolver needs it (sourced from the M1-owned `session` table). */
export interface SessionContextRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly membershipId: string | null;
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly providerEntityIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly lastStepUpAt: Date | null;
  readonly lastStepUpFactor: StepUpFactor | null;
  /** The §2.2.4 session class. `"staff"` when the store has nothing better (F-030). */
  readonly sessionClass: string;
  /** M31 portal sessions only — the account the session acts for. */
  readonly portalAccountId: string | null;
  /**
   * The one patient this session is pinned to — a portal session after `select-patient`, a
   * collaborator/funeral session from mint — or null on an org-scoped class (F-030).
   */
  readonly sessionPatientId: string | null;
  /**
   * The platform's verdict on the device this session runs on, or null when no LIVE attestation stands
   * behind it (SecHardening §12.4). Optional on the record so the in-memory slice and every existing
   * fixture keep their current shape and resolve to null — which is what a session with no device
   * should say, and what the gate must read as deny.
   */
  readonly deviceAttestation?: {
    readonly valid: boolean;
    readonly verifiedAt?: string;
    readonly attestationId?: string;
  } | null;
  /** The vendor an M19 answering-service session acts for; null on every other class (F-030). */
  readonly externalActorId?: string | null;
  /** The engagement an auditor session was minted for; null on every other class (GAP-093(c)). */
  readonly engagementId?: string | null;
  /** An auditor session's enrolment stage (M2 §7.7); null on every other class. Absent reads as null. */
  readonly auditorStage?: "enrolment" | "active" | null;
}

/** Reads a session-context row by id within an org scope (M1 `session` repo in production). */
export interface SessionContextStore {
  read(
    scope: OrgScope,
    sessionId: string,
  ): Promise<SessionContextRecord | null> | SessionContextRecord | null;
}

/**
 * Build the `SessionContextResolver` seam over a `SessionContextStore`.
 *
 * `overrides` is the per-tenant step-up policy store (§4.3.2, D9). It is OPTIONAL and its absence
 * means "this deployment has no override table to read" — every operation then resolves to the
 * platform floor, which is the strictest thing an absent tenant configuration can mean. It is not
 * a fail-open default: an override can only ever tighten, so having none is the safe end.
 */
export function createSessionContextResolver(
  store: SessionContextStore,
  overrides?: StepUpOverrideStore,
): SessionContextResolver {
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
        providerEntityIds: row.providerEntityIds,
        locationIds: row.locationIds,
        sessionClass: row.sessionClass,
        portalAccountId: row.portalAccountId,
        sessionPatientId: row.sessionPatientId,
        deviceAttestation: row.deviceAttestation ?? null,
        externalActorId: row.externalActorId ?? null,
        engagementId: row.engagementId ?? null,
        auditorStage: row.auditorStage ?? null,
      };
    },
    async resolveStepUpState(scope, sessionId): Promise<SessionStepUpFields | null> {
      const row = await readScoped(scope, sessionId);
      if (!row) return null;
      return { lastStepUpAt: row.lastStepUpAt, lastStepUpFactor: row.lastStepUpFactor };
    },
    async resolveStepUpPolicy(scope, operationKey): Promise<ResolvedStepUpPolicy> {
      // `tightenStepUpPolicy(null)` IS the floor, so a missing store and a missing row take the
      // same path — there is no branch here that can hand back something looser than the floor.
      return tightenStepUpPolicy(overrides ? await overrides.find(scope, operationKey) : null);
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
