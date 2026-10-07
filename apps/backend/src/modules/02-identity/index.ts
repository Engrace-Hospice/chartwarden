// apps/backend/src/modules/02-identity — Module 2 (Identity & Org) backend surface. Owned
// per module-manifest.ts codePath `apps/backend/src/modules/02-identity`.
//
// M2-T05 lands the step-up primitive (M2 spec §4.4): the step-up route (initiate + verify),
// the login-MFA step-up initializer, the tighten-only policy resolver Module 3's
// `step_up_recent` predicate consumes, and the supporting ports + slice adapters. M2-T06
// adds the `/api/v1/*` identity route inventory. M2-T07 (./seams) registers M2's published
// cross-module seams (SessionContextResolver + AuditorSessionMinter, §4.7) into the M1 registry.
export { type IdentitySeamDeps, registerIdentitySeams } from "./seams";
export { M2_OUTBOX_EVENTS } from "./events-by-m2";
// F-142 (#248) — M2's first outbox consumer: the §2.6/D7 M39 `m39.consent.revoked` → portal-session
// termination cascade (`portal_access` only; see the file's own header for why `family_caregiver_access`
// stays unbound). Exported for composition-root wiring + the live test.
export {
  type ConsentRevokedSessionTerminationDeps,
  M2_CONSENT_REVOKED_CONSUMER,
  buildM2ConsentRevokedConsumer,
} from "./outbox-consumers/m39-consent-revoked";
// GAP-043 — the §3.7 per-membership NAMED APPROVAL AUTHORITY surface: the `ElevatedApprovalReader` seam
// M27's §4.7 approver predicate reads, and the grant/revoke service its admin routes drive.
export {
  type ElevatedApprovalGrantView,
  type ElevatedApprovalKind,
  type ElevatedApprovalService,
  type ElevatedApprovalStore,
  type SeedElevatedApproval,
  COST_REPORT_APPROVAL_KIND,
  ELEVATED_APPROVAL_KINDS,
  createDrizzleElevatedApprovalStore,
  createElevatedApprovalReader,
  createElevatedApprovalService,
  createInMemoryElevatedApprovalStore,
  getElevatedApprovalReader,
  registerElevatedApprovalSeam,
} from "./elevated-approvals";
export {
  type ResolvedStepUpPolicy,
  type SessionStepUpState,
  type StepUpDecision,
  type StepUpOverride,
  type StepUpOverrideReader,
  createInMemoryStepUpOverrideReader,
  resolveStepUpPolicy,
  stepUpSatisfies,
  tightenStepUpPolicy,
} from "./policy/step-up-resolver";
export {
  STEP_UP_AUDIT_EVENTS,
  type StepUpSource,
  auditStepUpCompleted,
  auditStepUpFailed,
  auditStepUpLockout,
} from "./audit/step-up-audit";
export {
  type AuthenticatedSession,
  type MfaEnrollmentReader,
  type MfaVerifier,
  type SessionResolver,
  type SessionStepUpWriter,
  type StepUpChallenge,
  type StepUpChallengeStore,
  type StepUpQualifyingFactor,
  type StepUpRouteDeps,
  createCodeVerifier,
  createFixedSessionResolver,
  createInMemoryAuditExecutor,
  createInMemoryMfaEnrollment,
  createInMemorySessionStepUpWriter,
  createInMemoryStepUpChallengeStore,
} from "./step-up-ports";
export { registerSessionStepUpRoutes } from "./routes/session-step-up";

// M2 §4.4 — the PRODUCTION step-up adapters + the mount. `registerSessionStepUpRoutes` existed with
// slice adapters and exactly one caller (its own test), so `session.last_step_up_at` was written by
// nothing in production and every step-up gate on the platform answered "not fresh" forever.
export {
  createContextSessionResolver,
  createDbMfaEnrollmentReader,
  createDbMfaVerifier,
  createDbSessionStepUpWriter,
  createDbStepUpSessionResolver,
} from "./step-up-adapters-db";

/**
 * Mount the step-up routes with the production adapters.
 *
 * The challenge + lockout store is Valkey-backed when `redis` is supplied (a dedicated,
 * non-lazy-connect client — the queue connection, per the composition root), which is what makes a
 * challenge minted on one replica spendable on another and the consecutive-failure counter
 * cluster-wide rather than per-instance. Without one it falls back to a per-process Map with
 * TTL/window eviction: it still fails CLOSED across replicas (the caller retries), but a distributed
 * attacker gets the threshold per replica rather than once — a real weakening, which is why the
 * fallback is a documented in-memory binding rather than left for someone to find.
 */
export function mountSessionStepUpRoutes(
  app: FastifyInstance,
  db: DbClient,
  redis?: Redis | null,
  /** The `m2.*` outbox publisher (#205). Omitted → record-only, no-op. */
  outbox?: M2RawOutboxPublisher,
): void {
  _registerSessionStepUpRoutes(app, {
    sessions: _contextSessionResolver(),
    writer: _dbSessionStepUpWriter(db),
    enrollment: _dbMfaEnrollmentReader(db),
    verifier: _dbMfaVerifier(db),
    challenges: redis
      ? createValkeyStepUpChallengeStore(redis)
      : createInMemoryStepUpChallengeStore(),
    // #205 — fixes a real RLS bug: `audit: db` (bare, no org context) could never satisfy
    // `audit_event_org_append`'s WITH CHECK. See createOrgScopedAuditExecutor's doc.
    audit: _orgScopedAuditExecutor(db),
    ...(outbox ? { outbox: _orgScopedIdentityOutbox(db, outbox) } : {}),
  });
}

// ADR-0023 D2 / SecHardening §12.2/§12.4 — the device-attestation surface. Exported AND mounted from the
// composition root below: an unmounted write path would leave `device_attestation` a table nothing can
// ever put a row in, which is the same shape as the dead attribute this closes (F-030).
export type {
  DeviceAttestationAssertion,
  DeviceAttestationChallenge,
  DeviceAttestationChallengeStore,
  DeviceAttestationPlatform,
  DeviceAttestationProvider,
  DeviceAttestationRecord,
  DeviceAttestationSession,
  DeviceAttestationStore,
  DeviceAttestationVerdict,
  DeviceAttestationVerifier,
} from "./device-attestation-ports";
export {
  DEVICE_ENROLLMENT_SECRET_ENV,
  attestationMacPayload,
  createManagedEnrollmentVerifier,
  orgEnrollmentKey,
  posturePolicyFailure,
} from "./device-attestation-verifier";
export { createDbDeviceAttestationStore } from "./device-attestation-store-db";
export {
  type DeviceAttestationRouteDeps,
  registerDeviceAttestationRoutes,
} from "./routes/device-attestation";

/**
 * Mount the device-attestation routes with the production adapters.
 *
 * The challenge store is a per-process Map with TTL eviction rather than Redis. That is a real
 * limitation and it is stated rather than hidden: a challenge minted on one backend instance cannot be
 * spent on another, so a multi-instance deployment behind a round-robin balancer will see enrolment
 * attempts fail with `challenge_expired_or_invalid` until the device retries onto the same instance.
 * It FAILS CLOSED, which is why it ships this way rather than blocking on a Redis dependency the boot
 * path does not require — the same call the collaborator magic-link store makes two functions up, and
 * for the same reason. Moving it to Valkey is a store swap behind `DeviceAttestationChallengeStore`.
 */
export function mountDeviceAttestationRoutes(
  app: FastifyInstance,
  db: DbClient,
  /** The `m2.*` outbox publisher (#205). Omitted → record-only, no-op. */
  outbox?: M2RawOutboxPublisher,
): void {
  _registerDeviceAttestationRoutes(app, {
    challenges: createInMemoryDeviceAttestationChallengeStore(),
    verifier: _managedEnrollmentVerifier(),
    store: _dbDeviceAttestationStore(db),
    // #205 — fixes a real RLS bug: `audit: db` (bare, no org context) could never satisfy
    // `audit_event_org_append`'s WITH CHECK. See createOrgScopedAuditExecutor's doc.
    audit: _orgScopedAuditExecutor(db),
    ...(outbox ? { outbox: _orgScopedIdentityOutbox(db, outbox) } : {}),
  });
}

/** A per-process, TTL-evicting challenge store. Single-use by construction: `take` deletes. */
export function createInMemoryDeviceAttestationChallengeStore(): _DeviceAttestationChallengeStore {
  const rows = new Map<string, { challenge: _DeviceAttestationChallenge; expiresAt: number }>();
  return {
    async put(id: string, challenge: _DeviceAttestationChallenge, ttlSec: number) {
      rows.set(id, { challenge, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async take(id: string) {
      const row = rows.get(id);
      // Delete on ANY read, hit or miss-by-expiry. A challenge that has been looked at is spent, which
      // is what makes a captured assertion unreplayable even if it is replayed inside the TTL.
      rows.delete(id);
      if (!row || row.expiresAt <= Date.now()) return null;
      return row.challenge;
    },
  };
}
export {
  type LoginMfaCompletedContext,
  type LoginMfaCompletedDeps,
  onLoginMfaCompleted,
} from "./hooks/login-mfa-completed";
// M2-T06 — the WardenX `/api/v1/*` identity route inventory + its injected ports.
export {
  type Actor,
  type ActorResolver,
  type CollaboratorLinkStore,
  type CollaboratorScope,
  type IdentityOutboxPort,
  type IdentityRouteDeps,
  type InvitationDetail,
  type InvitationEmailTransport,
  type InvitationListItem,
  type InvitationStore,
  LinkError,
  type MintedInvitation,
  type MembershipRecord,
  type MembershipRepository,
  type MembershipStatus,
  type MembershipView,
  type OrgBinding,
  type SessionWriter,
  type UserDirectory,
  createContextActorResolver,
  createFixedActorResolver,
  createInMemoryCollaboratorLinkStore,
  createInMemoryInvitationStore,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
  createInMemoryUserIdentityReader,
  type ProposedRoleGuard,
  type UserIdentityReader,
} from "./identity-ports";
export {
  IDENTITY_AUDIT_EVENTS,
  auditCollaboratorInvited,
  auditCollaboratorSessionStarted,
  auditInvitationRescinded,
  auditMembershipAccepted,
  auditMembershipRevoked,
  auditMembershipStatusChanged,
  auditUserDeactivated,
  auditUserInvited,
} from "./audit/identity-audit";
export { registerIdentityRoutes } from "./routes/identity-routes";
export { createDbMembershipRepository } from "./membership-repository";
// Org-explicit BATCHED staff display read (name only), injected into other modules' route layers as a port at the
// composition root (e.g. M14's finalized-minutes "Finalized by") — consumers import no identity code/schema.
export {
  MEMBERSHIP_DISPLAY_MAX_IDS,
  type MembershipDisplayLabel,
  membershipDisplayForOrg,
  toMembershipDisplayLabel,
} from "./membership-display-for-org";
// §11 D19 (#205 hard half) — the real org activate/suspend/close capability + its one ABAC predicate.
export {
  type OrganizationLifecycleEvent,
  type OrganizationLifecycleOutboxPort,
  type OrganizationLifecycleStatus,
  type OrganizationLifecycleWriter,
  type OrganizationTransitionResult,
  createDrizzleOrganizationLifecycleWriter,
} from "./organization-lifecycle";
export {
  M2_ABAC_PREDICATES,
  USER_LIFECYCLE_PLATFORM_ROLE_KEYS,
  registerM2AbacPredicates,
  userLifecyclePlatformOpsPredicate,
} from "./abac-predicates";
export { registerOrganizationLifecycleRoutes } from "./routes/organization-lifecycle-routes";
export {
  type PlatformUserRouteDeps,
  registerPlatformUserRoutes,
} from "./routes/platform-user-routes";

import type { DbClient } from "@wardenx/db";
import type { AdminMembershipReader } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import type Redis from "ioredis";
import { registerM2AbacPredicates as _registerM2AbacPredicates } from "./abac-predicates";
import type {
  DeviceAttestationChallenge as _DeviceAttestationChallenge,
  DeviceAttestationChallengeStore as _DeviceAttestationChallengeStore,
} from "./device-attestation-ports";
import { createDbDeviceAttestationStore as _dbDeviceAttestationStore } from "./device-attestation-store-db";
import { createManagedEnrollmentVerifier as _managedEnrollmentVerifier } from "./device-attestation-verifier";
import {
  createDrizzleElevatedApprovalStore as _drizzleElevatedApprovalStore,
  createElevatedApprovalService as _elevatedApprovalService,
} from "./elevated-approvals";
import {
  type IdentityRouteDeps,
  createInMemoryCollaboratorLinkStore as _collabStore,
  createContextActorResolver as _ctxActor,
  createOrgScopedAuditExecutor as _orgScopedAuditExecutor,
  createOrgScopedIdentityOutbox as _orgScopedIdentityOutbox,
} from "./identity-ports";
import {
  createDbInvitationStore as _dbInvitations,
  createDbUserDirectory as _dbUserDirectory,
  createDbUserIdentityReader as _dbUserIdentity,
} from "./identity-stores-db";
import { createDbMembershipRepository as _dbMemberships } from "./membership-repository";
import {
  type OrganizationLifecycleOutboxPort,
  createDrizzleOrganizationLifecycleWriter as _organizationLifecycleWriter,
} from "./organization-lifecycle";
import { registerDeviceAttestationRoutes as _registerDeviceAttestationRoutes } from "./routes/device-attestation";
import { registerIdentityRoutes as _registerIdentityRoutes } from "./routes/identity-routes";
import { registerOrganizationLifecycleRoutes as _registerOrganizationLifecycleRoutes } from "./routes/organization-lifecycle-routes";
import { registerPlatformUserRoutes as _registerPlatformUserRoutes } from "./routes/platform-user-routes";
import { registerSessionStepUpRoutes as _registerSessionStepUpRoutes } from "./routes/session-step-up";
import { createDbSessionWriter as _dbSessionWriter } from "./session-writer-db";
import {
  createContextSessionResolver as _contextSessionResolver,
  createDbMfaEnrollmentReader as _dbMfaEnrollmentReader,
  createDbMfaVerifier as _dbMfaVerifier,
  createDbSessionStepUpWriter as _dbSessionStepUpWriter,
} from "./step-up-adapters-db";
import { createValkeyStepUpChallengeStore } from "./step-up-challenge-valkey";
import { createInMemoryStepUpChallengeStore } from "./step-up-ports";

/**
 * Mount the M2 identity REST routes on a server (composition root, via buildServer's
 * registerModuleRoutes hook, when a DB client is present).
 *
 * Everything here is now DB-backed except the external-collaborator link store — see below. Four of
 * these deps used to be process-local `Map`s ON THE PRODUCTION MOUNT, which meant an invitation minted
 * on one replica did not exist on another, a §7.5 offboard "disabled" credentials in a Map, and every
 * identity/step-up AUDIT EVENT — the trail an intrusion investigation starts from — was written to
 * memory and died with the process.
 *
 * `audit: db` is correct rather than a shortcut: `AuditExecutor` is structurally just
 * `insert(table).values(row)` (packages/audit/src/audit.ts), which the Drizzle client satisfies, and
 * `audit()` is documented as "the only sanctioned path to audit_event". Migration 0119 is what makes
 * it actually work — `wardenx_app` held the INSERT grant but no INSERT POLICY, so under production RLS
 * every application-level audit write was refused with "new row violates row-level security policy".
 *
 * ⚠ STILL IN MEMORY: `collaborators`. The external-collaborator magic-link store mints a one-time,
 * 30-minute token per patient — and there is NO TABLE for it. M2 owns exactly four tables (two_factor,
 * passkey, organization_invitation, tenant_step_up_policy_override); the `session` row for an
 * `external_collaborator` is what the token eventually PRODUCES, not where the pending token lives.
 * Making this durable needs a new M2-owned table (token hash, patient scope, inviter, TTL, consumed-at)
 * plus its RLS + audit trigger, which is a schema change, not a wiring change. Left explicit rather
 * than bound to something that would look durable and not be.
 */

/**
 * The composition root's catalog-validating `m2OutboxPublisher` shape (`bindCallerModule(txOutboxPublisher,
 * "m2")`) — takes the open tx, so `mountIdentityRoutes`/`mountDeviceAttestationRoutes`/
 * `mountSessionStepUpRoutes` can wrap it in `createOrgScopedIdentityOutbox` themselves rather than making
 * every caller do it.
 */
export interface M2RawOutboxPublisher {
  publish(
    tx: DbClient,
    input: {
      eventName: string;
      payload: Record<string, unknown>;
      organizationId: string | null;
      aggregateKind: string;
      aggregateId: string;
    },
  ): Promise<void>;
}

export function mountIdentityRoutes(
  app: FastifyInstance,
  db: DbClient,
  admin: AdminMembershipReader,
  // TASK-030 — the M36 transactional-email transport + the web app's origin, threaded from the
  // composition root so the invite-create/resend routes can deliver (or admin-visibly echo) the
  // accept link. Both optional: omitted, invites still record — they just stay copy-link-only.
  // F-097 — `roleAttacher` is M3's implementation, threaded from the composition root rather than
  // constructed here: M2 is `dependsOn: [1]`, so importing `03-authorization` from this file is an
  // import-boundary violation. Same reason `emailTransport` arrives as a parameter instead of an M36
  // import. Omitted → the accept route reports `rolesAttached: null` rather than an empty grant set.
  invite?: {
    emailTransport?: IdentityRouteDeps["emailTransport"];
    webAppBaseUrl?: string;
    roleAttacher?: IdentityRouteDeps["roleAttacher"];
    /** GAP-008 — M3's invite-creation anti-escalation guard (same import-boundary reason). */
    proposedRoleGuard?: IdentityRouteDeps["proposedRoleGuard"];
    /** #138/F-060/F-116 — threaded the same way as `roleAttacher`, for the same import-boundary reason
     *  (M33's implementation, M2 is `dependsOn: [1]`). Omitted → accept seeds no dashboards. */
    dashboardSeeder?: IdentityRouteDeps["dashboardSeeder"];
    /** The `m2.*` outbox publisher (#205). Omitted → record-only, no-op. */
    outbox?: M2RawOutboxPublisher;
  },
): void {
  const deps: IdentityRouteDeps = {
    actors: _ctxActor(),
    memberships: _dbMemberships(db, admin),
    sessions: _dbSessionWriter(db),
    invitations: _dbInvitations(db),
    collaborators: _collabStore().store, // no table exists — see the header
    users: _dbUserDirectory(db),
    // #205 — fixes a real RLS bug found while wiring the outbox: `audit: db` (bare, no org context)
    // could never satisfy `audit_event_org_append`'s WITH CHECK. See createOrgScopedAuditExecutor's doc.
    audit: _orgScopedAuditExecutor(db),
    // GAP-043 — the §3.7 named-approval-authority write surface over the real table. This is what makes
    // M27's approver predicate reachable: the seam READS `membership_elevated_approval`, these routes are
    // the only thing that ever puts a row in it.
    elevatedApprovals: _elevatedApprovalService(_drizzleElevatedApprovalStore(db)),
    ...(invite?.emailTransport ? { emailTransport: invite.emailTransport } : {}),
    ...(invite?.webAppBaseUrl ? { webAppBaseUrl: invite.webAppBaseUrl } : {}),
    ...(invite?.roleAttacher ? { roleAttacher: invite.roleAttacher } : {}),
    ...(invite?.proposedRoleGuard ? { proposedRoleGuard: invite.proposedRoleGuard } : {}),
    // GAP-009 — always bound on a db mount: accept refuses without it (fail closed).
    userIdentity: _dbUserIdentity(db),
    ...(invite?.dashboardSeeder ? { dashboardSeeder: invite.dashboardSeeder } : {}),
    ...(invite?.outbox ? { outbox: _orgScopedIdentityOutbox(db, invite.outbox) } : {}),
    // §11 D19 — real auth-time enforcement: `select-organization` refuses to bind a fresh session to a
    // non-active org. The reader needs no outbox (it never writes); see organization-lifecycle.ts.
    organizations: { getStatus: _organizationLifecycleWriter(db).getStatus },
  };
  _registerIdentityRoutes(app, deps);
  // §4.7 `user.deactivate` "platform_ops (any)" — the cross-org offboard the org-bounded tenant route
  // (GAP-001) no longer serves. Its ABAC predicate is registered here too (idempotent) so the route never
  // depends on `mountOrganizationLifecycleRoutes` having run first.
  _registerM2AbacPredicates();
  _registerPlatformUserRoutes(app, deps);
}

/**
 * Mount the §11 D19 org activate/suspend/close route + register its one ABAC predicate.
 *
 * `organization.status` had no UPDATE anywhere in the codebase before this (#205 hard half) — M35's four
 * `m2.organization.*` / `m2.session.created` subscriptions had no producer, matching the M35 spec's own
 * worked example ("a `platform_admin` suspends the org via M2 admin route", §11 D19). See
 * organization-lifecycle.ts for the transition graph + session-revocation write, and
 * abac-predicates.ts for the platform-ops-only gate.
 */
export function mountOrganizationLifecycleRoutes(
  app: FastifyInstance,
  db: DbClient,
  /** The `m2.*` outbox publisher (#205). Omitted → transition still lands, event is dropped. */
  outbox?: OrganizationLifecycleOutboxPort,
): void {
  _registerM2AbacPredicates();
  _registerOrganizationLifecycleRoutes(app, _organizationLifecycleWriter(db, outbox));
}
// M2-T10 — the `identity` data eraser (two_factor/passkey + pending invitations) + its ports.
// TASK-003/ARCH-007: `createDrizzleIdentityEraserStore` is the production store the composition
// root injects via `deps.store` so the erase destroys real rows, not an in-memory Map.
export {
  type IdentityEraserDeps,
  type IdentityEraserSeed,
  type IdentityEraserStore,
  createDrizzleIdentityEraserStore,
  createIdentityEraser,
  createInMemoryIdentityEraserStore,
  registerIdentityErasers,
} from "./erasers/identity-eraser";

export { createValkeyStepUpChallengeStore } from "./step-up-challenge-valkey";

export {
  createProductionStepUpVerifier,
  type StepUpVerifierOptions,
} from "./step-up-verifier";
export { createPortalInviteeUserPort } from "./portal-invitee-user";
