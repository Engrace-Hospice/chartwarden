// apps/backend/src/modules/02-identity/identity-ports.ts — M2-T06 identity route
// dependency ports + slice in-memory adapters (M2 spec §4.1–4.2, §7.1–7.7).
//
// The WardenX-specific `/api/v1/*` identity routes (memberships / select-organization /
// org-invitations / member lifecycle / user deactivation / external-collaborator links) are
// wired through injected ports, matching the M2-T05 step-up-ports pattern: every external
// dependency is injected with a slice-safe in-memory default, so the route contract + the
// §7.1–7.7 happy paths are provable with Fastify `inject` and no live infra.
//
// Production adapters (tracked follow-ups, consistent with the slice's forward-seam pattern):
//   • ActorResolver        → Better Auth session resolution (M2-T07 published seam)
//   • MembershipRepository → M1's exported MembershipRepository (M01-F01: M2 mutates the
//                            M1-owned `membership` table ONLY through M1's repo, never a
//                            direct Drizzle write)
//   • SessionWriter        → M1's exported SessionRepository (org-bind / revoke, inside
//                            withOrgContext + the outbox helper)
//   • InvitationStore      → SELECT/INSERT on the M2-owned `organization_invitation` table
//   • CollaboratorLinkStore→ magic-link mint/consume (Valkey TTL + one-time token)
//   • UserDirectory        → M1's exported user service (credential disable on offboard)
//
// Cross-module note: every record M2 reads/writes here is org-scoped identity data, not PHI
// (no patient health record), so the three-column / RLS / eraser PHI mandates do not attach
// to these routes; the org-bound context guard + the org-scoped audit() trail are the
// controls. The external-collaborator link carries a `patientId` *scope* (not a clinical
// record); M3's caseload ABAC predicate (deny-stubbed here) governs which patient an actor
// may scope a link to.
import type { DbClient } from "@wardenx/db";
import { requireRequestContext, withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type { FastifyRequest } from "fastify";

/**
 * The transactional-outbox port M2's route files publish `m2.*` events through. Takes no `tx` at the call
 * site — the production adapter (`createOrgScopedIdentityOutbox` below) wraps each publish in
 * `withOrgContextFromRequest` internally, for the same reason `createOrgScopedAuditExecutor` wraps
 * `audit()`: see that function's doc for the RLS bug this closes.
 */
export interface IdentityOutboxPort {
  publish(input: {
    readonly eventName: string;
    readonly payload: Record<string, unknown>;
    readonly organizationId: string | null;
    readonly aggregateKind: string;
    readonly aggregateId: string;
  }): Promise<void>;
}

/**
 * Adapts a tx-taking outbox publisher (the composition root's catalog-validating `m2OutboxPublisher`,
 * `bindCallerModule(txOutboxPublisher, "m2")`) into an `IdentityOutboxPort` that opens its own
 * `withOrgContextFromRequest` transaction per publish — the same fix `createOrgScopedAuditExecutor`
 * applies to `audit()`, for the identical reason: `outbox_event`'s RLS policy is org-scoped
 * (`current_setting('app.org_id', true)::uuid`), and nothing sets that GUC outside a `withOrgContext` tx.
 */
export function createOrgScopedIdentityOutbox(
  db: DbClient,
  publisher: {
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
  },
): IdentityOutboxPort {
  return {
    publish: (input) => {
      // `select-organization` binds the session to an org and THEN publishes `m2.session.created` in the SAME request:
      // the ambient request context was resolved before the bind, so it carries no organizationId yet. Opening the
      // publish transaction from that context set `app.org_id` to '' and `outbox_event`'s policy
      // (`organization_id = current_setting('app.org_id', true)::uuid`) threw 22P02 — a 500 on every org selection
      // through the real composition (the suite mounted no outbox and connected as a superuser, so it never saw it).
      // The event's own organizationId IS the org just bound; use it ONLY when the request has none. A request that
      // already carries an org keeps it, so an event for a DIFFERENT org still fails RLS closed, as before.
      const ambient = requireRequestContext();
      if (ambient.organizationId || input.organizationId === null) {
        return withOrgContextFromRequest(db, (tx) => publisher.publish(tx as DbClient, input));
      }
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: ambient.userId },
        (tx) => publisher.publish(tx as DbClient, input),
      );
    },
  };
}

/**
 * Adapts a bare `DbClient` into an `AuditExecutor` that opens its own `withOrgContextFromRequest`
 * transaction per audit() call.
 *
 * FIXES A REAL BUG (found while wiring M2's outbox catalog, #205). `mountIdentityRoutes` used to construct
 * `audit: db` directly — a bare, non-org-context client — even though `audit/identity-audit.ts`'s own
 * header says "production passes the Drizzle transaction so the audit row commits atomically with the
 * membership/invitation write". `audit_event`'s RLS policy (`audit_event_org_append`, migration 0119)
 * requires `organization_id = current_setting('app.org_id', true)::uuid`, and nothing sets that GUC outside
 * a `withOrgContext` transaction — so a bare `db` insert could never satisfy it. Confirmed empirically
 * against a real NOBYPASSRLS `wardenx_app` connection: every M2 mutation route's `audit()` call threw
 * "new row violates row-level security policy for table audit_event", AFTER the underlying store write had
 * already committed — so the route 500'd on a write that had, in fact, succeeded, and no audit row was ever
 * written. Migration 0119's own header names "M2's identity/step-up events" as one of the things it was
 * written to fix; the policy landed but the application code never opened the transaction the policy
 * assumes. (The OTHER thing that migration named, the PHI read-audit path, was fixed correctly —
 * `bootstrap/plugins/read-audit.ts` already wraps in `withOrgContext`.)
 */
export function createOrgScopedAuditExecutor(db: DbClient): import("@wardenx/audit").AuditExecutor {
  return {
    insert(table) {
      return {
        values: (row) => {
          // `POST /invitations/accept` audits BEFORE any org is bound to the session (the invitee has
          // none yet), so the ambient request context's organizationId is '' and `audit_event`'s policy
          // cast failed (22P02, a 500 on every real accept). Use the ROW's own org ONLY when the request
          // has none — the same rule `createOrgScopedIdentityOutbox` applies. A request already bound to
          // another org keeps it, so a row for a different org still fails RLS closed.
          const ambient = requireRequestContext();
          const rowOrg = (row as { organizationId?: string | null }).organizationId;
          if (ambient.organizationId || !rowOrg) {
            return withOrgContextFromRequest(db, (tx) => tx.insert(table).values(row));
          }
          return withOrgContext(db, { organizationId: rowOrg, userId: ambient.userId }, (tx) =>
            tx.insert(table).values(row),
          );
        },
      };
    },
  };
}

/** Membership lifecycle status mirrored from the M1-owned `membership` enum (spec §2.2.2). */
export type MembershipStatus = "active" | "suspended" | "revoked";

/** Account-level status mirrored from the M1-owned `user.status` enum (drives the "locked" KPI). */
export type AccountStatus = "created" | "active" | "suspended" | "deactivated";

/** A membership row as the routes see it (M1-owned table; read via M1's repo in production). */
export interface MembershipRecord {
  readonly membershipId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  status: MembershipStatus;
  /** True if this membership carries an `org_admin` role (for the last-admin lockout guard). */
  isAdmin: boolean;
  defaultLocationIds: string[];
  // --- Wrapped-user identity, joined in by the live repo (FB-T12). M2 reads these from the
  // M1-owned `user`/`session` tables (dependsOn 1) — they are org-scoped identity, not PHI. ---
  /** The user's display name (M1 `user.name`); null when unset. */
  displayName?: string | null;
  /** The user's email (M1 `user.email`); null only in slice seeds that omit it. */
  email?: string | null;
  /** Canonical global username; null for legacy email-only identities. */
  username?: string | null;
  /** Safe password lifecycle projection (never credential material). */
  credentialState?: "active" | "password_change_required";
  /** ISO timestamp of the user's most recent session start (M1 `session`), or null if never seen. */
  lastLoginAt?: string | null;
  /** The user's account-level status (M1 `user.status`) — drives the "locked accounts" KPI. */
  accountStatus?: AccountStatus;
}

/** The membership view returned to clients (no internal-only fields beyond the lifecycle). */
export interface MembershipView {
  readonly membershipId: string;
  /** The user this membership wraps — the staff facet's identity key. */
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly status: MembershipStatus;
  readonly isAdmin: boolean;
  readonly defaultLocationIds: readonly string[];
  /** The wrapped user's display name, email, last-login and account status (FB-T12). */
  readonly displayName: string | null;
  readonly email: string | null;
  readonly username: string | null;
  readonly credentialState: "active" | "password_change_required";
  readonly lastLoginAt: string | null;
  readonly accountStatus: AccountStatus | null;
}

/**
 * The authenticated actor a route acts on. `organizationId`/`membershipId` are null for a
 * PRE-ORG session (post-login, before `select-organization` binds the org) — the
 * memberships + select-organization routes operate in that window (spec §4.1 `session(pre-org)`).
 */
export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string | null;
  readonly membershipId: string | null;
  readonly roles: readonly string[];
}

/** Resolves the current request's actor (null ⇒ unauthenticated). */
export interface ActorResolver {
  resolve(request: FastifyRequest): Promise<Actor | null> | Actor | null;
}

/** Reads/writes memberships via M1's repository (M01-F01 — never a direct Drizzle write). */
export interface MembershipRepository {
  listForUser(userId: string): Promise<MembershipRecord[]> | MembershipRecord[];
  findActive(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRecord | null> | MembershipRecord | null;
  /**
   * List an org's memberships. `q` (optional) narrows by the wrapped user's identity — the staff
   * facet of Global Search (FB-T11). The filter is forward-compatible: when the roster joins name/
   * email (FB-T12), the same `q` extends to those fields server-side.
   */
  listForOrg(organizationId: string, q?: string): Promise<MembershipRecord[]> | MembershipRecord[];
  get(membershipId: string): Promise<MembershipRecord | null> | MembershipRecord | null;
  setStatus(
    membershipId: string,
    status: MembershipStatus,
  ): Promise<MembershipRecord> | MembershipRecord;
  setDefaultScope(
    membershipId: string,
    defaultLocationIds: string[],
  ): Promise<MembershipRecord> | MembershipRecord;
  create(input: {
    userId: string;
    organizationId: string;
    organizationName: string;
    defaultLocationIds: string[];
  }): Promise<MembershipRecord> | MembershipRecord;
  /** Hard-delete only a just-created membership while compensating failed provisioning. */
  removeProvisioned(membershipId: string): Promise<void> | void;
  /** Count of `active` memberships carrying `org_admin` (last-admin lockout guard). */
  activeAdminCount(organizationId: string): Promise<number> | number;
}

/** The org binding written by `select-organization` (server-bound, spec §4.2). */
export interface OrgBinding {
  readonly activeOrganizationId: string;
  readonly organizationName: string;
  readonly expiresAt: string;
}

/** Writes session lifecycle via M1's SessionRepository (org-bind / revoke). */
export interface SessionWriter {
  bindOrganization(input: {
    sessionId: string;
    organizationId: string;
    organizationName: string;
  }): Promise<OrgBinding> | OrgBinding;
  /** Revoke every session tied to a membership (offboard §7.5). Returns # revoked. */
  revokeForMembership(membershipId: string): Promise<number> | number;
  /** Revoke every session belonging to a user (full deactivation §7.5). Returns # revoked. */
  revokeAllForUser(userId: string): Promise<number> | number;
}

/** A pending org invitation as the routes need it (M2-owned `organization_invitation`). */
export interface InvitationDetail {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly proposedRoleKeys: readonly string[];
  readonly defaultLocationIds: readonly string[];
  /** GAP-008 — who issued the invitation; `null` for a legacy row or a since-deleted inviter. */
  readonly inviterId?: string | null;
}

/**
 * A minted or re-minted invitation, as the route needs it to build the accept link + deliver it.
 * TASK-030: unlike the historical `create()` shape, the raw `token` now DOES leave the store — the
 * route is the only caller, and it uses the token exactly once (build the link, hand it to the email
 * transport, and — since no vendor sender is wired yet — echo it to the inviting admin as a copyable
 * link). The token is still never persisted anywhere but its hash.
 */
export interface MintedInvitation {
  readonly invitationId: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** One row of an org's invitation roster (Staff Management pending-invite list, TASK-030). Never
 *  carries the token — only `resend`/`create` mint (and briefly expose) a fresh one. */
export interface InvitationListItem {
  readonly invitationId: string;
  readonly email: string;
  /** Mirrors the M1 `invitation_status` enum. `expired` is enum-legal but never application-set today
   *  (expiry is enforced at consume/peek time, not a status sweep) — reserved for a future cron sweep. */
  readonly status: "pending" | "accepted" | "expired" | "revoked";
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * Delivers the invite-acceptance link to an invitee. Declared locally (not imported from
 * @wardenx/messaging) so M2 takes no `dependsOn` edge on M36 — the composition root binds the SAME
 * M36 `TransactionalEmailTransport` instance here via structural typing, mirroring
 * packages/auth/src/identity/email-transport.ts's `EmailTransport` port for the same reason.
 */
export interface InvitationEmailTransport {
  send(email: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
  }): Promise<void>;
}

/**
 * Attaches an accepted invitation's `proposedRoleKeys` to the new membership.
 *
 * Declared locally, like {@link InvitationEmailTransport} above and for the same reason: the
 * implementation is M3's (`03-authorization/proposed-role-attacher.ts`) and M2 is `dependsOn: [1]`, so
 * the composition root binds it by structural typing rather than M2 taking an edge on M3.
 *
 * F-097 — M2 §D3 records this handshake as **Decided** ("M2 carries `proposedRoleKeys` … and creates
 * the membership; M3 attaches roles on accept") and nothing ever performed it. The accept route
 * consumed the invitation, created the membership, and dropped the keys with a comment naming M3 as the
 * owner of a step no code took. So every invitation on the platform produced a membership with no
 * grants: the invitee holds nothing, no error is raised, and the invitation row still lists the roles
 * that were asked for.
 */
export interface ProposedRoleAttacher {
  attach(input: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly roleKeys: readonly string[];
    /** GAP-008 — the INVITER; the attach is bounded by THEIR permissions. `null` ⇒ nothing attaches. */
    readonly grantedByUserId: string | null;
  }): Promise<{ readonly attached: readonly string[]; readonly unresolved: readonly string[] }>;
}

/**
 * GAP-008 — M3's invite-creation guard, declared locally like {@link ProposedRoleAttacher} (M2 is
 * `dependsOn: [1]`). Throws 403 `ESCALATION_BLOCKED` / 422 `RESERVED_ROLE` when the inviter may not
 * propose `roleKeys` (needs `role.assign` + every permission of every proposed role).
 */
export interface ProposedRoleGuard {
  assertProposable(input: {
    readonly organizationId: string;
    readonly inviterUserId: string;
    readonly roleKeys: readonly string[];
    readonly auditContext: import("@wardenx/audit").AuditContext;
  }): Promise<void>;
}

/**
 * Seeds the org's platform-shipped ("day-one") dashboards on accept.
 *
 * Declared locally, like {@link ProposedRoleAttacher} above and for the same reason: the implementation
 * is M33's (`33-reporting/system-dashboard-seeder.ts`) and M2 is `dependsOn: [1]`, so the composition
 * root binds it by structural typing rather than M2 taking an edge on M33.
 *
 * #138/F-060/F-116 — M33's own spec names a "catalog-of-platform-shipped dashboards that lets an agency
 * go live on day one … without the agency authoring a single definition" and nothing built it: a
 * freshly provisioned tenant's `/reports` was empty until someone authored a report. This runs HERE,
 * on invitation accept, rather than in M34's `tenant.provision` job — `report_view.owner_membership_id`
 * is NOT NULL, and no membership exists yet when that job runs; this is the earliest point one does.
 */
export interface DashboardSeeder {
  ensureSystemDashboards(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly ownerMembershipId: string;
  }): Promise<{ readonly created: readonly string[]; readonly alreadyPresent: readonly string[] }>;
}

/** Mint / consume / rescind / re-mint / peek org invitations (M2-owned table). */
export interface InvitationStore {
  pendingExists(organizationId: string, email: string): Promise<boolean> | boolean;
  /** Count of an org's still-pending invitations (the Staff Management "pending invites" KPI, FB-T12). */
  pendingCount(organizationId: string): Promise<number> | number;
  /** List an org's invitations (roster for the pending-invite list, TASK-030), newest first. */
  list(organizationId: string): Promise<InvitationListItem[]> | InvitationListItem[];
  create(input: {
    organizationId: string;
    organizationName: string;
    email: string;
    proposedRoleKeys: string[];
    defaultLocationIds: string[];
    proposedProviderEntityId?: string;
    /** GAP-008 — the inviting user, stored so accept can bound the attach by THEIR permissions. */
    inviterId?: string;
  }): Promise<MintedInvitation> | MintedInvitation;
  /**
   * Regenerate the token + expiry on a still-pending invite (invalidates any prior link). Returns
   * null when the invitation is gone or no longer pending (route maps to 404).
   */
  resend(invitationId: string): Promise<MintedInvitation | null> | MintedInvitation | null;
  /** Atomically consume a token → its invitation. Throws on expired/used (route maps to 410/409). */
  consume(token: string): Promise<InvitationDetail> | InvitationDetail;
  /**
   * Read-only preview of a still-pending token's target (email + org name), WITHOUT consuming it —
   * lets an unauthenticated invitee's browser pre-fill a sign-up form before an account exists to
   * call `consume` through (TASK-030). Throws the same LinkError kinds as `consume`.
   */
  peek(token: string): Promise<InvitationDetail> | InvitationDetail;
  rescind(invitationId: string): Promise<boolean> | boolean;
}

/** Whether a patient of an org is deceased — the one M5 fact the funeral-home link needs. */
export interface DeceasedPatientReader {
  isDeceased(organizationId: string, patientId: string): Promise<boolean>;
}

/** The scope an external-collaborator session carries (exactly one patient, spec §7.6). */
export interface CollaboratorScope {
  readonly patientId: string;
  readonly organizationId: string;
  /** Which session class the link yields (GAP-115: `funeral_home` links share this store). Default collaborator. */
  readonly kind?: "external_collaborator" | "funeral_home";
  /** The durable link row (absent on the per-process slice store). */
  readonly linkId?: string;
  /** The credential-less principal `user` the redeemed session row belongs to (durable store only). */
  readonly principalUserId?: string;
  /** Lifetime of the session this redemption mints, in seconds (durable store only). */
  readonly sessionTtlSec?: number;
  /** Redemptions spent including this one (durable store only). */
  readonly useCount?: number;
}

/** What a durable store reports about a refused redemption of a link it KNOWS (audit-only; never sent to a client). */
export interface RefusedLinkInfo {
  readonly linkId: string;
  readonly organizationId: string;
  readonly kind: "external_collaborator" | "funeral_home";
  readonly reason: "expired" | "used" | "revoked" | "not_eligible";
}

/** Mint / consume per-patient external-collaborator magic-links (30-min TTL, one-time). */
export interface CollaboratorLinkStore {
  create(input: {
    organizationId: string;
    patientId: string;
    invitedByMembershipId: string;
    /** GAP-115 — `funeral_home` mints the per-deceased link (72h); default `external_collaborator` (30 min). */
    kind?: "external_collaborator" | "funeral_home";
    /** Override the link's TTL (seconds). */
    ttlSec?: number;
    /** Lifetime of the session a redemption mints (seconds). Durable store only; the slice store ignores it. */
    sessionTtlSec?: number;
    /** Redemptions the link allows (default 1 - single use). Durable store only. */
    maxUses?: number;
  }): Promise<CreatedLink> | CreatedLink;
  /** Atomically consume a token → its scope. Throws on expired/used (route maps to 410/409). */
  consume(token: string): Promise<CollaboratorScope> | CollaboratorScope;
  /**
   * Give back the use a failed session mint spent (durable store only): without it a transient Better Auth failure
   * would burn a single-use link the holder never got a session for. Idempotent and org-scoped.
   */
  release?(scope: { organizationId: string; linkId: string }): Promise<void>;
  /** Revoke ONE link (durable store only), e.g. when its token could not be delivered. Idempotent and org-scoped. */
  revoke?(scope: { organizationId: string; linkId: string }): Promise<void>;
  /** Revoke every live link for a patient (durable store only) - e.g. the patient is no longer deceased. */
  revokeForPatient?(scope: { organizationId: string; patientId: string }): Promise<number>;
}

/** A freshly minted link: the raw token is delivered ONCE and never stored (the store keeps its hash). */
export interface CreatedLink {
  readonly linkId: string;
  readonly expiresAt: string;
  /** The raw single-use token, for the delivery port. Never returned to a client, never logged. */
  readonly token?: string;
}

/**
 * Outcome of an org-bounded global deactivation (GAP-001):
 *   `deactivated`      — the user's only live membership is in the caller's org; credentials disabled.
 *   `not_member`       — no NON-revoked membership in the caller's org (a former member is not the org's
 *                        to offboard globally) — the route answers 404, no existence oracle.
 *   `member_elsewhere` — still a non-revoked member of another org — the route answers 409.
 */
export type OrgBoundedDeactivation = "deactivated" | "not_member" | "member_elsewhere";

/** The membership facts the GAP-001 decision reads. */
export type MembershipStanding = Pick<MembershipRecord, "organizationId" | "status">;

/** The GAP-001 decision, pure — shared by the DB and in-memory directories so they cannot drift. */
export function decideOrgBoundedDeactivation(
  memberships: readonly MembershipStanding[],
  organizationId: string,
): OrgBoundedDeactivation {
  const live = memberships.filter((m) => m.status !== "revoked");
  if (!live.some((m) => m.organizationId === organizationId)) return "not_member";
  if (live.some((m) => m.organizationId !== organizationId)) return "member_elsewhere";
  return "deactivated";
}

/**
 * GAP-009 — reads the signed-in user's account email so accept can tie a token to the invitee. Declared
 * as its own port (not on `UserDirectory`) so a deployment that forgets to bind it FAILS CLOSED at the
 * accept route instead of silently skipping the comparison.
 */
export interface UserIdentityReader {
  emailOf(userId: string): Promise<string | null> | string | null;
  /**
   * GAP-009 — record that `userId` proved control of their mailbox. Called on accept AFTER the
   * invitation email matched the account's email: the one-time token only ever reached that address, so
   * redeeming it IS the verification. Idempotent.
   */
  markEmailVerified(userId: string): Promise<void> | void;
}

/** Disables a user's credentials everywhere (full offboard §7.5). */
export interface UserDirectory {
  /**
   * GAP-001 — deactivate `userId` only when their sole live membership is in `organizationId`. The
   * membership check and the status flip are ONE atomic step, so an invite accepted in another org
   * concurrently cannot slip between the check and the write.
   */
  deactivateFromOrg(input: {
    userId: string;
    organizationId: string;
    reason: string;
  }): Promise<OrgBoundedDeactivation> | OrgBoundedDeactivation;
  /**
   * §4.7 `platform_ops (any)` — deactivate `userId` platform-wide, regardless of org (the platform route
   * only; the tenant route stays org-bounded). Atomic under the same user-row lock `deactivateFromOrg`
   * takes. Reports the orgs the user was still a live (non-revoked) member of, for the audit record.
   */
  deactivateGlobally(input: { userId: string }): Promise<GlobalDeactivation> | GlobalDeactivation;
}

/**
 * Outcome of a platform-wide deactivation:
 *   `deactivated`         — the user's status flipped to `deactivated` in this call.
 *   `already_deactivated` — it was already `deactivated`; nothing written (the route stays idempotent).
 *   `not_found`           — no such user (the route answers 404).
 */
export interface GlobalDeactivation {
  readonly outcome: "deactivated" | "already_deactivated" | "not_found";
  /** Orgs where the user held a non-revoked membership at the moment of the decision. */
  readonly memberOrganizationIds: readonly string[];
  /**
   * The memberships this call revoked (§2.2.1 "all memberships revoked"). Swept on a repeat call too, so
   * an `already_deactivated` user still holding a live membership is brought to the same end state.
   */
  readonly revokedMemberships: readonly RevokedMembership[];
}

/** One membership a deactivation revoked. */
export interface RevokedMembership {
  readonly membershipId: string;
  readonly organizationId: string;
}

/** Live (non-revoked) membership orgs, sorted — shared by the DB and in-memory directories. */
export function liveMembershipOrganizationIds(
  memberships: readonly MembershipStanding[],
): readonly string[] {
  return [
    ...new Set(memberships.filter((m) => m.status !== "revoked").map((m) => m.organizationId)),
  ].sort();
}

/**
 * §11 D19 auth-time enforcement — reads the `organization.status` this module's own
 * `organization-lifecycle.ts` writer now maintains. `select-organization` refuses to bind a fresh
 * session to a non-`active` org (the reverse of `organization-lifecycle.ts`'s own session_cascade,
 * which revokes sessions ALREADY bound at the moment of suspension/close — this closes the other
 * direction: a suspended org's user retrying sign-in afterward). `null` ⇒ unreadable/unknown, which
 * this port's ONE caller treats as "skip the check" rather than "deny" — the same non-fabrication
 * posture as every other optional M2 port; the composition root binds a real reader.
 */
export interface OrganizationStatusReader {
  getStatus(
    organizationId: string,
  ):
    | Promise<"created" | "active" | "suspended" | "closed" | null>
    | ("created" | "active" | "suspended" | "closed" | null);
}

/** A typed error the stores throw so routes can map link failures to the spec's HTTP codes. */
export class LinkError extends Error {
  constructor(
    readonly kind: "expired" | "used" | "verification_required",
    message: string,
    /** Present only when the store KNOWS the link (a token that parses to no row carries none: no oracle). */
    readonly link?: RefusedLinkInfo,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/**
 * Delivers a freshly minted collaborator / funeral-home link to its recipient. The raw token is handed here ONCE
 * and never returned to a client. Unbound (the transactional email provider is not wired in production) the invite
 * routes refuse 503 `LINK_DELIVERY_UNAVAILABLE` before minting anything: a link nobody can receive is a credential
 * that exists for no one.
 */
export interface LinkDeliveryPort {
  deliver(input: {
    readonly kind: "external_collaborator" | "funeral_home";
    readonly email: string;
    readonly token: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

/** The minimum decedent facts a funeral-home session reads (M5's published read, injected). */
export interface FuneralCaseReader {
  read(
    organizationId: string,
    patientId: string,
  ): Promise<{ decedentName: string; dateOfDeath: string } | null>;
}

/** The full injection surface for `registerIdentityRoutes`. */
export interface IdentityRouteDeps {
  actors: ActorResolver;
  memberships: MembershipRepository;
  sessions: SessionWriter;
  invitations: InvitationStore;
  collaborators: CollaboratorLinkStore;
  /**
   * GAP-115 — M5's deceased-status fact, injected as a local port (M2 may not read M5). Unbound ->
   * `POST /funeral/invite` refuses 503 `DECEASED_STATUS_UNAVAILABLE` (fail closed).
   */
  deceasedPatients?: DeceasedPatientReader;
  /**
   * GAP-115 follow-up - the server-only Better Auth session mint behind link redemption. Unbound ->
   * `POST /collaborators/consume` keeps its legacy slice behaviour (no session row); a durable mount ALWAYS binds
   * it, and a durable store with no minter refuses 503 `LINK_SESSION_UNAVAILABLE` WITHOUT consuming the link.
   */
  linkSessions?: import("@wardenx/auth").LinkSessionMinter;
  /** GAP-115 follow-up - delivers the minted token. Unbound -> invite routes refuse 503 (see {@link LinkDeliveryPort}). */
  linkDelivery?: LinkDeliveryPort;
  /**
   * True on a durable mount: the invite routes then REQUIRE `recipientEmail` (422) - a durable link with nobody to
   * send it to is unreachable. The slice/test mounts leave it unset and keep the legacy "no delivery" behaviour.
   */
  linkRecipientRequired?: boolean;
  /** GAP-115 follow-up - the failed-redemption budget (per IP). Unbound -> only the global rate tier applies. */
  linkRedeemThrottle?: import("@wardenx/auth").CredentialThrottle;
  /** GAP-115 follow-up - M5's minimum decedent read for `GET /funeral/case`. Unbound -> that route answers 503. */
  funeralCases?: FuneralCaseReader;
  users: UserDirectory;
  /** Audit sink for the M2 lifecycle events (audit() executor — denylist runs there). */
  audit: import("@wardenx/audit").AuditExecutor;
  /** The `m2.*` transactional-outbox publisher. Omitted → record-only, no-op (the M28 `NOOP_FHIR_OUTBOX`
   *  precedent) — every existing route keeps working without it. */
  outbox?: IdentityOutboxPort;
  /** External-collaborator session TTL in seconds (spec §7.6, up to 8h); default 8h. */
  collaboratorSessionTtlSec?: number;
  /**
   * Delivers the invite-acceptance link (TASK-030). Omitted → invites are recorded but not emailed
   * (the admin-visible `inviteUrl` in the create/resend response is still usable).
   */
  emailTransport?: InvitationEmailTransport;
  /**
   * The web app's origin, for building the `/invite/:token` link (e.g. `https://app.wardenx.example`).
   * Omitted → the route falls back to a relative path only (no origin to safely guess).
   */
  webAppBaseUrl?: string;
  /**
   * GAP-043 — the per-membership NAMED APPROVAL AUTHORITY surface (§3.7). Omitted → the three
   * elevated-approval routes are not mounted at all, rather than mounted over a store that cannot
   * persist: a 404 on an unmounted route is honest, a 200 from a write nobody can read back is not.
   */
  elevatedApprovals?: import("./elevated-approvals").ElevatedApprovalService;
  /**
   * F-097 — the §D3 M3 role attach on accept. Optional because a no-db slice boot has no M3 store to
   * bind; when it is absent the accept route SAYS SO in its response (`rolesAttached: null`) rather
   * than reporting an empty grant set as if the invitation had proposed none. The difference matters:
   * "this deployment cannot attach roles" and "this invitation asked for none" are different facts, and
   * conflating them is how the missing handshake stayed invisible for as long as it did.
   */
  roleAttacher?: ProposedRoleAttacher;
  /**
   * GAP-008 — the invite-creation anti-escalation guard. When an invitation proposes roles and no guard
   * is bound the route REFUSES (503) rather than storing an unchecked proposal.
   */
  proposedRoleGuard?: ProposedRoleGuard;
  /** GAP-009 — account email of the session user, for the invitee-binding check on accept. */
  userIdentity?: UserIdentityReader;
  /**
   * #138/F-060/F-116 — the day-one dashboard seed. Optional for the same reason `roleAttacher` is: a
   * no-db slice boot has no M33 store to bind. When absent, accept simply does not seed dashboards
   * (no error) — the same "the difference matters" rule as `roleAttacher`, but here there is nothing on
   * the wire to report either way, since a missing seeder is not something the invitee asked for.
   */
  dashboardSeeder?: DashboardSeeder;
  /** §11 D19 — omitted → `select-organization` skips the active-org check (a no-db slice boot has no
   *  organization-lifecycle writer to read back). See {@link OrganizationStatusReader}. */
  organizations?: OrganizationStatusReader;
  /**
   * GAP-005 - the MFA matrix gate (M2 section 2.3). Present: `select-organization` refuses to bind an organization
   * whose roles require a second factor the user has not enrolled (403 MFA_ENROLMENT_REQUIRED). Omitted (slice
   * boots, unit tests) means no enforcement at bind time; the authenticate hook is the second, independent gate.
   */
  mfaGate?: {
    forMembership(input: {
      userId: string;
      sessionId: string;
      organizationId: string;
      membershipId: string;
    }): Promise<{ satisfied: boolean; requirement: string; reason?: string }>;
  };
}

// --- Slice in-memory adapters ------------------------------------------------------------

/** Fixed-actor resolver — returns the same actor regardless of request (slice/test). */
export function createFixedActorResolver(actor: Actor | null): ActorResolver {
  return { resolve: () => actor };
}

/** Header-driven actor resolver — derives the actor from the populated request.context. */
export function createContextActorResolver(): ActorResolver {
  return {
    resolve(request) {
      const ctx = request.context;
      if (!ctx?.userId) return null;
      const sid =
        ctx.attributes && typeof ctx.attributes.sessionId === "string"
          ? ctx.attributes.sessionId
          : String(request.id);
      return {
        userId: ctx.userId,
        sessionId: sid,
        organizationId: ctx.organizationId || null,
        // The acting MEMBERSHIP, from the same request attribute the step-up context resolver reads
        // (step-up-adapters-db.ts). It was hard-coded null, which made every route that attributes an action to
        // a membership (the collaborator / funeral link mint, the step-up override configuredBy) refuse a real
        // staff session with "an org-bound staff session is required".
        membershipId:
          ctx.attributes && typeof ctx.attributes.membershipId === "string"
            ? ctx.attributes.membershipId
            : null,
        roles: ctx.roles,
      };
    },
  };
}

/** In-memory membership repository seeded with `MembershipRecord[]` (slice/test). */
export function createInMemoryMembershipRepository(seed: MembershipRecord[] = []): {
  repo: MembershipRepository;
  all(): MembershipRecord[];
} {
  const rows = new Map<string, MembershipRecord>(seed.map((r) => [r.membershipId, { ...r }]));
  const repo: MembershipRepository = {
    listForUser: (userId) => [...rows.values()].filter((r) => r.userId === userId),
    findActive: (userId, organizationId) =>
      [...rows.values()].find(
        (r) => r.userId === userId && r.organizationId === organizationId && r.status === "active",
      ) ?? null,
    listForOrg: (organizationId, q) => {
      const needle = q?.trim().toLowerCase();
      const matches = (r: MembershipRecord) =>
        !needle ||
        r.userId.toLowerCase().includes(needle) ||
        (r.displayName?.toLowerCase().includes(needle) ?? false) ||
        (r.email?.toLowerCase().includes(needle) ?? false) ||
        (r.username?.toLowerCase().includes(needle) ?? false);
      return [...rows.values()].filter((r) => r.organizationId === organizationId && matches(r));
    },
    get: (membershipId) => rows.get(membershipId) ?? null,
    setStatus: (membershipId, status) => {
      const row = rows.get(membershipId);
      if (!row) throw new Error(`unknown membership ${membershipId}`);
      row.status = status;
      return row;
    },
    setDefaultScope: (membershipId, defaultLocationIds) => {
      const row = rows.get(membershipId);
      if (!row) throw new Error(`unknown membership ${membershipId}`);
      row.defaultLocationIds = defaultLocationIds;
      return row;
    },
    create: (input) => {
      const row: MembershipRecord = {
        membershipId: crypto.randomUUID(),
        userId: input.userId,
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        status: "active",
        isAdmin: false,
        defaultLocationIds: input.defaultLocationIds,
      };
      rows.set(row.membershipId, row);
      return row;
    },
    removeProvisioned: (membershipId) => {
      rows.delete(membershipId);
    },
    activeAdminCount: (organizationId) =>
      [...rows.values()].filter(
        (r) => r.organizationId === organizationId && r.status === "active" && r.isAdmin,
      ).length,
  };
  return { repo, all: () => [...rows.values()] };
}

/** In-memory session writer exposing revoked/bound state for assertions (slice/test). */
export function createInMemorySessionWriter(): {
  writer: SessionWriter;
  boundOrg(sessionId: string): string | undefined;
  revokedMemberships(): string[];
  revokedUsers(): string[];
} {
  const bound = new Map<string, string>();
  const revokedMemberships: string[] = [];
  const revokedUsers: string[] = [];
  const writer: SessionWriter = {
    bindOrganization({ sessionId, organizationId, organizationName }) {
      bound.set(sessionId, organizationId);
      return {
        activeOrganizationId: organizationId,
        organizationName,
        expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      };
    },
    revokeForMembership(membershipId) {
      revokedMemberships.push(membershipId);
      return 1;
    },
    revokeAllForUser(userId) {
      revokedUsers.push(userId);
      return 1;
    },
  };
  return {
    writer,
    boundOrg: (sessionId) => bound.get(sessionId),
    revokedMemberships: () => revokedMemberships,
    revokedUsers: () => revokedUsers,
  };
}

/** In-memory invitation store (token held internally; never returned in a response body). */
export function createInMemoryInvitationStore(
  orgNameOf: (organizationId: string) => string = () => "Org",
): {
  store: InvitationStore;
  /** Test helper: the opaque token minted for the most recent `create` to `email`. */
  tokenFor(email: string): string | undefined;
} {
  interface Pending extends InvitationDetail {
    invitationId: string;
    token: string;
    createdAtMs: number;
    expiresAtMs: number;
    status: "pending" | "accepted" | "expired" | "revoked";
  }
  const INVITE_TTL_MS = 72 * 3600 * 1000;
  const pending = new Map<string, Pending>(); // keyed by invitationId
  const tokens = new Map<string, string>(); // token → invitationId

  function mint(p: Pending): MintedInvitation {
    return {
      invitationId: p.invitationId,
      token: p.token,
      expiresAt: new Date(p.expiresAtMs).toISOString(),
    };
  }

  const store: InvitationStore = {
    pendingExists: (organizationId, email) =>
      [...pending.values()].some(
        (p) => p.organizationId === organizationId && p.email === email && p.status === "pending",
      ),
    pendingCount: (organizationId) =>
      [...pending.values()].filter(
        (p) => p.organizationId === organizationId && p.status === "pending",
      ).length,
    list: (organizationId) =>
      [...pending.values()]
        .filter((p) => p.organizationId === organizationId)
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map((p) => ({
          invitationId: p.invitationId,
          email: p.email,
          status: p.status,
          expiresAt: new Date(p.expiresAtMs).toISOString(),
          createdAt: new Date(p.createdAtMs).toISOString(),
        })),
    create(input) {
      const invitationId = crypto.randomUUID();
      const token = crypto.randomUUID();
      const now = Date.now();
      const p: Pending = {
        invitationId,
        token,
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        email: input.email,
        proposedRoleKeys: input.proposedRoleKeys,
        defaultLocationIds: input.defaultLocationIds,
        inviterId: input.inviterId ?? null,
        createdAtMs: now,
        expiresAtMs: now + INVITE_TTL_MS,
        status: "pending",
      };
      pending.set(invitationId, p);
      tokens.set(token, invitationId);
      return mint(p);
    },
    resend(invitationId) {
      const p = pending.get(invitationId);
      if (!p || p.status !== "pending") return null;
      tokens.delete(p.token); // invalidate the prior link
      p.token = crypto.randomUUID();
      p.expiresAtMs = Date.now() + INVITE_TTL_MS;
      tokens.set(p.token, invitationId);
      return mint(p);
    },
    consume(token) {
      const invitationId = tokens.get(token);
      const p = invitationId ? pending.get(invitationId) : undefined;
      if (!p) throw new LinkError("expired", "invitation token invalid or expired");
      if (p.status === "accepted") throw new LinkError("used", "invitation already accepted");
      if (p.status !== "pending") throw new LinkError("expired", "invitation is no longer valid");
      if (p.expiresAtMs <= Date.now()) throw new LinkError("expired", "invitation expired");
      p.status = "accepted"; // atomic one-time consumption (§7.12 double-click → used)
      return {
        organizationId: p.organizationId,
        organizationName: p.organizationName,
        email: p.email,
        proposedRoleKeys: p.proposedRoleKeys,
        defaultLocationIds: p.defaultLocationIds,
        inviterId: p.inviterId ?? null,
      };
    },
    peek(token) {
      const invitationId = tokens.get(token);
      const p = invitationId ? pending.get(invitationId) : undefined;
      if (!p) throw new LinkError("expired", "invitation token invalid or expired");
      if (p.status === "accepted") throw new LinkError("used", "invitation already accepted");
      if (p.status !== "pending") throw new LinkError("expired", "invitation is no longer valid");
      if (p.expiresAtMs <= Date.now()) throw new LinkError("expired", "invitation expired");
      return {
        organizationId: p.organizationId,
        organizationName: p.organizationName,
        email: p.email,
        proposedRoleKeys: p.proposedRoleKeys,
        defaultLocationIds: p.defaultLocationIds,
        inviterId: p.inviterId ?? null,
      };
    },
    rescind(invitationId) {
      const p = pending.get(invitationId);
      if (!p || p.status !== "pending") return false;
      p.status = "revoked";
      return true;
    },
  };
  // unused arg guard for orgNameOf — kept for signature parity with production wiring
  void orgNameOf;
  return {
    store,
    tokenFor: (email) =>
      [...pending.values()].find((p) => p.email === email && p.status === "pending")?.token,
  };
}

/** In-memory {@link UserIdentityReader} seeded with `userId → email` (slice/test). */
export function createInMemoryUserIdentityReader(
  emails: Readonly<Record<string, string>> = {},
): UserIdentityReader & { isVerified(userId: string): boolean } {
  const verified = new Set<string>();
  return {
    emailOf: (userId) => emails[userId] ?? null,
    markEmailVerified: (userId) => {
      verified.add(userId);
    },
    isVerified: (userId) => verified.has(userId),
  };
}

/** A funeral-home magic link's default lifetime: 72 hours (M2 spec §3.6 — "72 hr default (configurable)"). */
export const FUNERAL_LINK_TTL_SEC = 72 * 3600;

/** In-memory external-collaborator link store (30-min TTL, one-time token). */
export function createInMemoryCollaboratorLinkStore(): {
  store: CollaboratorLinkStore;
  tokenFor(patientId: string): string | undefined;
} {
  interface Link extends CollaboratorScope {
    token: string;
    expiresAtMs: number;
    consumed: boolean;
  }
  const links = new Map<string, Link>(); // token → link
  const store: CollaboratorLinkStore = {
    create({ organizationId, patientId, kind, ttlSec }) {
      const token = crypto.randomUUID();
      const linkId = crypto.randomUUID();
      // §7.6 — a collaborator link lives 30 min; a funeral-home link (GAP-115, §3.6) 72 h by default.
      const ttlMs = (ttlSec ?? (kind === "funeral_home" ? FUNERAL_LINK_TTL_SEC : 30 * 60)) * 1000;
      links.set(token, {
        token,
        organizationId,
        patientId,
        kind: kind ?? "external_collaborator",
        expiresAtMs: Date.now() + ttlMs,
        consumed: false,
      });
      return { linkId, expiresAt: new Date(Date.now() + ttlMs).toISOString(), token };
    },
    consume(token) {
      const link = links.get(token);
      if (!link) throw new LinkError("expired", "collaborator link invalid or expired");
      if (link.consumed) throw new LinkError("used", "collaborator link already used");
      if (link.expiresAtMs <= Date.now())
        throw new LinkError("expired", "collaborator link expired");
      link.consumed = true; // one-time (§7.6: useless after first consumption)
      return { patientId: link.patientId, organizationId: link.organizationId, kind: link.kind };
    },
  };
  return {
    store,
    tokenFor: (patientId) =>
      [...links.values()].find((l) => l.patientId === patientId && !l.consumed)?.token,
  };
}

/**
 * In-memory user directory exposing deactivated ids for assertions. It reads memberships from the
 * same repository the routes use (single-threaded, so the check-then-write is trivially atomic).
 */
export function createInMemoryUserDirectory(
  memberships: Pick<MembershipRepository, "listForUser" | "setStatus">,
): {
  directory: UserDirectory;
  isDeactivated(userId: string): boolean;
} {
  const deactivated = new Set<string>();
  const revokeLive = async (
    userId: string,
    organizationIds: readonly string[],
  ): Promise<RevokedMembership[]> => {
    const live = (await memberships.listForUser(userId)).filter(
      (m) => m.status !== "revoked" && organizationIds.includes(m.organizationId),
    );
    for (const m of live) await memberships.setStatus(m.membershipId, "revoked");
    return live.map((m) => ({ membershipId: m.membershipId, organizationId: m.organizationId }));
  };
  return {
    directory: {
      async deactivateFromOrg({ userId, organizationId }) {
        const outcome = decideOrgBoundedDeactivation(
          await memberships.listForUser(userId),
          organizationId,
        );
        if (outcome !== "deactivated") return outcome;
        deactivated.add(userId);
        await revokeLive(userId, [organizationId]);
        return outcome;
      },
      // The slice has no `user` table: a user "exists" when they hold any membership row (any status).
      async deactivateGlobally({ userId }) {
        const rows = await memberships.listForUser(userId);
        const memberOrganizationIds = liveMembershipOrganizationIds(rows);
        if (rows.length === 0) {
          return { outcome: "not_found", memberOrganizationIds, revokedMemberships: [] };
        }
        const revokedMemberships = await revokeLive(userId, memberOrganizationIds);
        if (deactivated.has(userId)) {
          return { outcome: "already_deactivated", memberOrganizationIds, revokedMemberships };
        }
        deactivated.add(userId);
        return { outcome: "deactivated", memberOrganizationIds, revokedMemberships };
      },
    },
    isDeactivated: (userId) => deactivated.has(userId),
  };
}
