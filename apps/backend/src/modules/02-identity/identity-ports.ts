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
import type { FastifyRequest } from "fastify";

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
    readonly grantedByUserId: string;
  }): Promise<{ readonly attached: readonly string[]; readonly unresolved: readonly string[] }>;
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

/** The scope an external-collaborator session carries (exactly one patient, spec §7.6). */
export interface CollaboratorScope {
  readonly patientId: string;
  readonly organizationId: string;
}

/** Mint / consume per-patient external-collaborator magic-links (30-min TTL, one-time). */
export interface CollaboratorLinkStore {
  create(input: {
    organizationId: string;
    patientId: string;
    invitedByMembershipId: string;
  }): Promise<{ linkId: string; expiresAt: string }> | { linkId: string; expiresAt: string };
  /** Atomically consume a token → its scope. Throws on expired/used (route maps to 410/409). */
  consume(token: string): Promise<CollaboratorScope> | CollaboratorScope;
}

/** Disables a user's credentials everywhere (full offboard §7.5). */
export interface UserDirectory {
  deactivate(userId: string, reason: string): Promise<void> | void;
}

/** A typed error the stores throw so routes can map link failures to the spec's HTTP codes. */
export class LinkError extends Error {
  constructor(
    readonly kind: "expired" | "used" | "verification_required",
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/** The full injection surface for `registerIdentityRoutes`. */
export interface IdentityRouteDeps {
  actors: ActorResolver;
  memberships: MembershipRepository;
  sessions: SessionWriter;
  invitations: InvitationStore;
  collaborators: CollaboratorLinkStore;
  users: UserDirectory;
  /** Audit sink for the M2 lifecycle events (audit() executor — denylist runs there). */
  audit: import("@wardenx/audit").AuditExecutor;
  /** Org-binding session TTL in seconds (spec §SESSION_POLICY); default 12h. */
  sessionTtlSec?: number;
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
        membershipId: null,
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
        (r.email?.toLowerCase().includes(needle) ?? false);
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
    create({ organizationId, patientId }) {
      const token = crypto.randomUUID();
      const linkId = crypto.randomUUID();
      links.set(token, {
        token,
        organizationId,
        patientId,
        expiresAtMs: Date.now() + 30 * 60 * 1000, // 30-min TTL (§7.6)
        consumed: false,
      });
      return { linkId, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    },
    consume(token) {
      const link = links.get(token);
      if (!link) throw new LinkError("expired", "collaborator link invalid or expired");
      if (link.consumed) throw new LinkError("used", "collaborator link already used");
      if (link.expiresAtMs <= Date.now())
        throw new LinkError("expired", "collaborator link expired");
      link.consumed = true; // one-time (§7.6: useless after first consumption)
      return { patientId: link.patientId, organizationId: link.organizationId };
    },
  };
  return {
    store,
    tokenFor: (patientId) =>
      [...links.values()].find((l) => l.patientId === patientId && !l.consumed)?.token,
  };
}

/** In-memory user directory exposing deactivated ids for assertions. */
export function createInMemoryUserDirectory(): {
  directory: UserDirectory;
  isDeactivated(userId: string): boolean;
} {
  const deactivated = new Set<string>();
  return {
    directory: {
      deactivate(userId) {
        deactivated.add(userId);
      },
    },
    isDeactivated: (userId) => deactivated.has(userId),
  };
}
