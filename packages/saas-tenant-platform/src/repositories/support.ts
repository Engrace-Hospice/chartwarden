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
import { type SQL, and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

const G = schema.supportConsentGrant;
const S = schema.supportSession;
const E = schema.supportSessionEvent;

/** The ledger kind of one operator write made while a session is open (a start / elevate / close row is not an action). */
export const OPS_WRITE_EVENT_KIND = "ops.write";

/** Keyset cursor for the high-volume session-event ledger (newest-first by (occurredAt, id)). */
export interface SupportEventCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/** Keyset cursor for support sessions (newest-first by startedAt, id). */
export interface SupportSessionCursor {
  readonly startedAt: Date;
  readonly id: string;
}

function eventOlderThan(cursor?: SupportEventCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(E.occurredAt, cursor.occurredAt),
    and(eq(E.occurredAt, cursor.occurredAt), lt(E.id, cursor.id)),
  );
}

function sessionOlderThan(cursor?: SupportSessionCursor): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(S.startedAt, cursor.startedAt),
    and(eq(S.startedAt, cursor.startedAt), lt(S.id, cursor.id)),
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
   * Fetch a consent grant and take a SHARE lock on its row, so a revoke (an UPDATE of the row) that has not committed yet
   * makes this wait, and a start that has locked it makes a concurrent revoke wait until the session it inserts is visible
   * to the revoke's own "close every open session" read. Judged on the platform lane (the carrier is BYPASSRLS and holds a
   * column UPDATE on the revoke columns, which a locking read needs); never used by the tenant lane, where the UPDATE policy
   * would hide an already-revoked row from a locking read.
   */
  async findConsentGrantByIdForShare(id: string): Promise<schema.SupportConsentGrant | null> {
    const [row] = await this.db.select().from(G).where(eq(G.id, id)).limit(1).for("share");
    return row ?? null;
  }

  /**
   * Revoke a grant that is still unrevoked: the guarded UPDATE a cascade uses. Returns the row, or `null` when the grant was
   * already revoked (nothing is overwritten, so the first revoke's time, actor and reason stand).
   */
  async markConsentGrantRevoked(
    id: string,
    patch: Pick<
      schema.NewSupportConsentGrant,
      "revokedAt" | "revokedByMembershipId" | "revocationReason"
    >,
  ): Promise<schema.SupportConsentGrant | null> {
    const [row] = await this.db
      .update(G)
      .set(patch)
      .where(and(eq(G.id, id), isNull(G.revokedAt)))
      .returning();
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

  /** Close a session that is still open: `null` when it was already closed (idempotent, race-safe, never overwrites a close). */
  async closeSessionIfOpen(
    id: string,
    patch: Pick<schema.NewSupportSession, "closedAt" | "closeReason">,
  ): Promise<schema.SupportSession | null> {
    const [row] = await this.db
      .update(S)
      .set(patch)
      .where(and(eq(S.id, id), isNull(S.closedAt)))
      .returning();
    return row ?? null;
  }

  /** Every session of a grant that has not been closed, oldest first (the revoke cascade closes them in this order). */
  async listOpenSessionsByGrant(
    supportConsentGrantId: string,
  ): Promise<readonly schema.SupportSession[]> {
    return this.db
      .select()
      .from(S)
      .where(and(eq(S.supportConsentGrantId, supportConsentGrantId), isNull(S.closedAt)))
      .orderBy(S.startedAt, S.id);
  }

  /** The sessions of a grant a revoke already closed, in close order (what a repeated revoke answers). */
  async listSessionIdsClosedAs(
    supportConsentGrantId: string,
    closeReason: string,
  ): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: S.id })
      .from(S)
      .where(
        and(eq(S.supportConsentGrantId, supportConsentGrantId), eq(S.closeReason, closeReason)),
      )
      .orderBy(S.closedAt, S.id);
    return rows.map((r) => r.id);
  }

  /** The one session a help screen summarises: the open one if any, else the most recently started. */
  async findSummarySessionByGrant(
    supportConsentGrantId: string,
  ): Promise<schema.SupportSession | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(eq(S.supportConsentGrantId, supportConsentGrantId))
      .orderBy(sql`(${S.closedAt} IS NULL) DESC`, desc(S.startedAt), desc(S.id))
      .limit(1);
    return row ?? null;
  }

  /** The `ops.write` ledger rows of each session: how many and when the newest was (a lifecycle row is not an action). */
  async opsWriteStats(
    supportSessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly count: number; readonly lastAt: Date | null }>> {
    if (supportSessionIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        sessionId: E.supportSessionId,
        count: sql<number>`count(*)::int`,
        lastAt: sql<Date | null>`max(${E.occurredAt})`,
      })
      .from(E)
      .where(
        and(
          inArray(E.supportSessionId, [...supportSessionIds]),
          eq(E.eventKind, OPS_WRITE_EVENT_KIND),
        ),
      )
      .groupBy(E.supportSessionId);
    return new Map(
      rows.map((r) => [
        r.sessionId,
        { count: Number(r.count), lastAt: r.lastAt === null ? null : new Date(r.lastAt) },
      ]),
    );
  }

  /** A bounded keyset page of sessions (RLS scopes the tenant lane). */
  async listSessions(
    opts: { limit?: number; cursor?: SupportSessionCursor } = {},
  ): Promise<readonly schema.SupportSession[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 201);
    return this.db
      .select()
      .from(S)
      .where(sessionOlderThan(opts.cursor))
      .orderBy(desc(S.startedAt), desc(S.id))
      .limit(limit);
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
    opts: { limit?: number; cursor?: SupportEventCursor; organizationId?: string } = {},
  ): Promise<readonly schema.SupportSessionEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 201);
    return this.db
      .select()
      .from(E)
      .where(
        and(
          eq(E.supportSessionId, supportSessionId),
          opts.organizationId ? eq(E.organizationId, opts.organizationId) : undefined,
          eventOlderThan(opts.cursor),
        ),
      )
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
