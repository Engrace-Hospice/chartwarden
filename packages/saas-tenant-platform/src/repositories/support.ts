// @chartwarden/saas-tenant-platform · repositories — support-session data port: `support_consent_grant`
// + `support_session` + `support_session_event` (M34 §3.6).
//
// The tenant-consented break-glass *variant* (M34-F01): a tenant compliance_officer files a consent
// grant (scope + expiry ≤ 72h); a DISTINCT platform-ops actor (the distinct-actor rule, D16, enforced
// in the service + route, not here) starts a support_session against it; every PHI touch during the
// session writes a `support_session_event` at audit severity=critical (§7.4). This repo is the thin
// reader/writer; the grant-narrows-never-replaces-dual-control invariant and the distinct-actor check
// live in services/support-session-service.ts.
import { type DbClient, schema } from "@chartwarden/db";
import { type SQL, and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";

const G = schema.supportConsentGrant;
const S = schema.supportSession;
const E = schema.supportSessionEvent;

/** Keyset cursor for the high-volume session-event ledger (newest-first by (occurredAt, id)). */
export interface SupportEventCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

function eventOlderThan(cursor?: SupportEventCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(E.occurredAt, cursor.occurredAt),
    and(eq(E.occurredAt, cursor.occurredAt), lt(E.id, cursor.id)),
  );
}

/** Data port for the support-session triple (consent grant → session → event ledger). */
export class SupportRepository {
  constructor(private readonly db: DbClient) {}

  // ── support_consent_grant ──────────────────────────────────────────────────────────────────

  /** File a consent grant (tenant compliance_officer; scope + ≤72h expiry, CHECK-enforced). */
  async createConsentGrant(
    values: schema.NewSupportConsentGrant,
  ): Promise<schema.SupportConsentGrant> {
    const [row] = await this.db.insert(G).values(values).returning();
    if (!row) throw new Error("support_consent_grant insert returned no row");
    return row;
  }

  /** Fetch a consent grant by id, or `null`. */
  async findConsentGrantById(id: string): Promise<schema.SupportConsentGrant | null> {
    const [row] = await this.db.select().from(G).where(eq(G.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Active (unrevoked, unexpired as of `now`) consent grants for a tenant, newest-first — the set a
   * platform-ops actor may start a session against.
   */
  async listActiveConsentGrants(
    tenantAccountId: string,
    now: Date = new Date(),
  ): Promise<readonly schema.SupportConsentGrant[]> {
    return this.db
      .select()
      .from(G)
      .where(and(eq(G.tenantAccountId, tenantAccountId), isNull(G.revokedAt), gt(G.expiresAt, now)))
      .orderBy(desc(G.issuedAt));
  }

  /** Revoke a consent grant (stamps revokedAt / revokedByMembershipId / revocationReason). */
  async revokeConsentGrant(
    id: string,
    patch: Pick<
      schema.NewSupportConsentGrant,
      "revokedAt" | "revokedByMembershipId" | "revocationReason"
    >,
  ): Promise<schema.SupportConsentGrant> {
    const [row] = await this.db.update(G).set(patch).where(eq(G.id, id)).returning();
    if (!row) throw new Error(`support_consent_grant ${id} not found for revoke`);
    return row;
  }

  // ── support_session ────────────────────────────────────────────────────────────────────────

  /** Start a support session against a consent grant (distinct-actor rule enforced upstream). */
  async createSession(values: schema.NewSupportSession): Promise<schema.SupportSession> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("support_session insert returned no row");
    return row;
  }

  /** Fetch a support session by id, or `null`. */
  async findSessionById(id: string): Promise<schema.SupportSession | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** Open (not-yet-closed) sessions for a tenant, newest-first. */
  async listOpenSessions(tenantAccountId: string): Promise<readonly schema.SupportSession[]> {
    return this.db
      .select()
      .from(S)
      .innerJoin(G, eq(S.supportConsentGrantId, G.id))
      .where(and(eq(G.tenantAccountId, tenantAccountId), isNull(S.closedAt)))
      .orderBy(desc(S.startedAt))
      .then((rows) => rows.map((r) => r.support_session));
  }

  /** Close a session (manual | expired | grant_revoked | forced_terminated). */
  async closeSession(
    id: string,
    patch: Pick<schema.NewSupportSession, "closedAt" | "closeReason">,
  ): Promise<schema.SupportSession> {
    const [row] = await this.db.update(S).set(patch).where(eq(S.id, id)).returning();
    if (!row) throw new Error(`support_session ${id} not found for close`);
    return row;
  }

  // ── support_session_event ───────────────────────────────────────────────────────────────────

  /** Append a session-event row (one per PHI touch during the session; severity=critical audit). */
  async appendSessionEvent(
    values: schema.NewSupportSessionEvent,
  ): Promise<schema.SupportSessionEvent> {
    const [row] = await this.db.insert(E).values(values).returning();
    if (!row) throw new Error("support_session_event insert returned no row");
    return row;
  }

  /** Newest-first keyset page of a session's event ledger. */
  async listSessionEvents(
    supportSessionId: string,
    opts: { limit?: number; cursor?: SupportEventCursor } = {},
  ): Promise<readonly schema.SupportSessionEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(E)
      .where(and(eq(E.supportSessionId, supportSessionId), eventOlderThan(opts.cursor)))
      .orderBy(desc(E.occurredAt), desc(E.id))
      .limit(limit);
  }

  /** Surveyor query: session-events touching a given patient, newest-first. */
  async listSessionEventsByPatient(
    patientId: string,
    opts: { limit?: number; cursor?: SupportEventCursor } = {},
  ): Promise<readonly schema.SupportSessionEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.db
      .select()
      .from(E)
      .where(and(eq(E.patientId, patientId), eventOlderThan(opts.cursor)))
      .orderBy(desc(E.occurredAt), desc(E.id))
      .limit(limit);
  }
}
