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
}

/** The membership view returned to clients (no internal-only fields beyond the lifecycle). */
export interface MembershipView {
  readonly membershipId: string;
  /** The user this membership wraps — the staff facet's identity key (richer name/email arrives FB-T12). */
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly status: MembershipStatus;
  readonly isAdmin: boolean;
  readonly defaultLocationIds: readonly string[];
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
  listForOrg(
    organizationId: string,
    q?: string,
  ): Promise<MembershipRecord[]> | MembershipRecord[];
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

/** Mint / consume / rescind org invitations (M2-owned table; token never leaves the store). */
export interface InvitationStore {
  pendingExists(organizationId: string, email: string): Promise<boolean> | boolean;
  create(input: {
    organizationId: string;
    organizationName: string;
    email: string;
    proposedRoleKeys: string[];
    defaultLocationIds: string[];
    proposedProviderEntityId?: string;
  }):
    | Promise<{ invitationId: string; expiresAt: string }>
    | {
        invitationId: string;
        expiresAt: string;
      };
  /** Atomically consume a token → its invitation. Throws on expired/used (route maps to 410/409). */
  consume(token: string): Promise<InvitationDetail> | InvitationDetail;
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
      return {
        userId: ctx.userId,
        sessionId: String(request.id),
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
      return [...rows.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          (!needle || r.userId.toLowerCase().includes(needle)),
      );
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
    expiresAtMs: number;
    consumed: boolean;
  }
  const pending = new Map<string, Pending>(); // keyed by invitationId
  const tokens = new Map<string, string>(); // token → invitationId

  const store: InvitationStore = {
    pendingExists: (organizationId, email) =>
      [...pending.values()].some(
        (p) => p.organizationId === organizationId && p.email === email && !p.consumed,
      ),
    create(input) {
      const invitationId = crypto.randomUUID();
      const token = crypto.randomUUID();
      pending.set(invitationId, {
        invitationId,
        token,
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        email: input.email,
        proposedRoleKeys: input.proposedRoleKeys,
        defaultLocationIds: input.defaultLocationIds,
        expiresAtMs: Date.now() + 72 * 3600 * 1000, // 72h invite TTL
        consumed: false,
      });
      tokens.set(token, invitationId);
      return { invitationId, expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString() };
    },
    consume(token) {
      const invitationId = tokens.get(token);
      const p = invitationId ? pending.get(invitationId) : undefined;
      if (!p) throw new LinkError("expired", "invitation token invalid or expired");
      if (p.consumed) throw new LinkError("used", "invitation already accepted");
      if (p.expiresAtMs <= Date.now()) throw new LinkError("expired", "invitation expired");
      p.consumed = true; // atomic one-time consumption (§7.12 double-click → used)
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
      if (!p || p.consumed) return false;
      pending.delete(invitationId);
      tokens.delete(p.token);
      return true;
    },
  };
  // unused arg guard for orgNameOf — kept for signature parity with production wiring
  void orgNameOf;
  return {
    store,
    tokenFor: (email) => [...pending.values()].find((p) => p.email === email && !p.consumed)?.token,
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
