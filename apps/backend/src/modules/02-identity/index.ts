// apps/backend/src/modules/02-identity — Module 2 (Identity & Org) backend surface. Owned
// per module-manifest.ts codePath `apps/backend/src/modules/02-identity`.
//
// M2-T05 lands the step-up primitive (M2 spec §4.4): the step-up route (initiate + verify),
// the login-MFA step-up initializer, the tighten-only policy resolver Module 3's
// `step_up_recent` predicate consumes, and the supporting ports + slice adapters. M2-T06
// adds the `/api/v1/*` identity route inventory. M2-T07 (./seams) registers M2's published
// cross-module seams (SessionContextResolver + AuditorSessionMinter, §4.7) into the M1 registry.
export {
  type IdentitySeamDeps,
  registerIdentitySeams,
} from "./seams";
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
export function mountDeviceAttestationRoutes(app: FastifyInstance, db: DbClient): void {
  _registerDeviceAttestationRoutes(app, {
    challenges: createInMemoryDeviceAttestationChallengeStore(),
    verifier: _managedEnrollmentVerifier(),
    store: _dbDeviceAttestationStore(db),
    audit: db,
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

import type { DbClient } from "@wardenx/db";
import type { AdminMembershipReader } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
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
} from "./identity-ports";
import {
  createDbInvitationStore as _dbInvitations,
  createDbUserDirectory as _dbUserDirectory,
} from "./identity-stores-db";
import { createDbMembershipRepository as _dbMemberships } from "./membership-repository";
import { registerDeviceAttestationRoutes as _registerDeviceAttestationRoutes } from "./routes/device-attestation";
import { registerIdentityRoutes as _registerIdentityRoutes } from "./routes/identity-routes";
import { createDbSessionWriter as _dbSessionWriter } from "./session-writer-db";

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
export function mountIdentityRoutes(
  app: FastifyInstance,
  db: DbClient,
  admin: AdminMembershipReader,
  // TASK-030 — the M36 transactional-email transport + the web app's origin, threaded from the
  // composition root so the invite-create/resend routes can deliver (or admin-visibly echo) the
  // accept link. Both optional: omitted, invites still record — they just stay copy-link-only.
  invite?: { emailTransport?: IdentityRouteDeps["emailTransport"]; webAppBaseUrl?: string },
): void {
  const deps: IdentityRouteDeps = {
    actors: _ctxActor(),
    memberships: _dbMemberships(db, admin),
    sessions: _dbSessionWriter(db),
    invitations: _dbInvitations(db),
    collaborators: _collabStore().store, // no table exists — see the header
    users: _dbUserDirectory(db),
    audit: db,
    // GAP-043 — the §3.7 named-approval-authority write surface over the real table. This is what makes
    // M27's approver predicate reachable: the seam READS `membership_elevated_approval`, these routes are
    // the only thing that ever puts a row in it.
    elevatedApprovals: _elevatedApprovalService(_drizzleElevatedApprovalStore(db)),
    ...(invite?.emailTransport ? { emailTransport: invite.emailTransport } : {}),
    ...(invite?.webAppBaseUrl ? { webAppBaseUrl: invite.webAppBaseUrl } : {}),
  };
  _registerIdentityRoutes(app, deps);
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
