// apps/backend/src/modules/31-portal/routes/store.ts — M31-T07 Drizzle-backed store over M31's THREE owned
// tables (portal_account / portal_access_grant / telehealth_visit).
//
// This is the single home of the org-scoped SQL: every method opens `withOrgContext` (RLS pins app.org_id)
// and reads/writes only the three owned tables. It fulfils the T06 {@link M31SeamStores} port bundle (so the
// seven published seams go live) AND the extra owned-table operations the §4.1 routes need (account
// suspend/reinstate + roster, grant roster, telehealth join/leave/recording/end lifecycle). The lay-language
// READ surfaces are NOT here — they compose upstream seams through `../read-surfaces/resolve.ts`, never a
// cross-module table.
//
// PHI CIPHERS ARE NEVER PROJECTED. The digests expose ids, enum tokens, counts and instants — never
// `display_name_cipher`, `vendor_room_url_cipher` or a scope jsonb blob a consumer could not read.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  IsoInstant,
  M31EventName,
  PortalAccessGrantDigest,
  PortalAccountDigest,
  PortalDataCategory,
  PortalDisclosureRecord,
  PortalEngagementMetrics,
  PortalScopeSet,
  TelehealthEndReason,
  TelehealthLifecycleState,
  TelehealthScheduledVisitSetting,
  TelehealthVendor,
  TelehealthVisitDigest,
} from "@chartwarden/types";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { M31EventEmitter } from "../events";
import type { M31SeamStores } from "../seams/stores";

const { portalAccounts, portalAccessGrants, telehealthVisits } = schema;

const iso = (d: Date | null): IsoInstant | null => (d ? (d.toISOString() as IsoInstant) : null);
const ctx = (orgId: string, userId = "") => ({ organizationId: orgId, userId });

type AccountRow = typeof portalAccounts.$inferSelect;
type GrantRow = typeof portalAccessGrants.$inferSelect;
type VisitRow = typeof telehealthVisits.$inferSelect;

function toAccountDigest(r: AccountRow): PortalAccountDigest {
  return {
    portalAccountId: r.id,
    userId: r.userId,
    relationship: r.relationship,
    status: r.status,
    activatedAt: iso(r.activatedAt),
    lastActiveAt: iso(r.lastActiveAt),
  };
}
function toGrantDigest(r: GrantRow): PortalAccessGrantDigest {
  return {
    grantId: r.id,
    portalAccountId: r.portalAccountId,
    patientId: r.patientId,
    grantKind: r.grantKind,
    scopeSet: r.scopeSetJsonb as PortalScopeSet,
    grantedAt: r.grantedAt.toISOString() as IsoInstant,
    revokedAt: iso(r.revokedAt),
  };
}
function toVisitDigest(r: VisitRow): TelehealthVisitDigest {
  return {
    telehealthVisitId: r.id,
    m17VisitId: r.m17VisitId,
    patientId: r.patientId,
    assignedMembershipId: r.assignedMembershipId,
    lifecycleState: r.lifecycleState as TelehealthLifecycleState,
    vendor: r.vendor as TelehealthVendor,
    scheduledVisitSetting: r.scheduledVisitSetting as TelehealthScheduledVisitSetting,
    audioOnlyFallbackActive: r.audioOnlyFallbackActive,
    visitStartedAt: iso(r.visitStartedAt),
    visitEndedAt: iso(r.visitEndedAt),
    totalDurationSec: r.totalDurationSec ?? null,
    endReason: (r.endReason as TelehealthEndReason | null) ?? null,
    linkedEncounterId: r.linkedEncounterId ?? null,
  };
}

/** GAP-095 — the telehealth room facts the vendor-facing routes read (ciphers stay sealed here). */
export interface TelehealthRoomFacts {
  readonly vendorRoomIdCipher: string;
  readonly vendorRoomUrlCipher: string;
  readonly vendorRecordingId: string | null;
  readonly patientLeftAt: string | null;
  readonly clinicianLeftAt: string | null;
}

/**
 * GAP-159 - the telehealth events a lifecycle patch implies (pure): `in_progress` is "both parties present" ->
 * visit_started; an `ended_*` state -> visit_ended; recording switched on -> recording_started. `recording_completed`
 * is NOT derivable here: it needs the vendor `recording_completed` webhook payload, which the webhook route does not
 * yet map (see docs/history/m31-portal-deferrals.md).
 */
export function lifecycleEventsFor(
  patch: {
    lifecycleState?: TelehealthLifecycleState;
    recordingEnabled?: boolean;
  },
  row: {
    id: string;
    m17VisitId: string;
    visitStartedAt: Date | null;
    endReason: string | null;
    totalDurationSec: number | null;
    audioOnlyFallbackActive: boolean;
    lifecycleState: string;
  },
): readonly { name: M31EventName; payload: Record<string, unknown> }[] {
  const out: { name: M31EventName; payload: Record<string, unknown> }[] = [];
  if (patch.lifecycleState === "in_progress") {
    out.push({
      name: "m31.telehealth.visit_started",
      payload: {
        telehealthVisitId: row.id,
        m17VisitId: row.m17VisitId,
        startedAt: (row.visitStartedAt ?? new Date()).toISOString(),
      },
    });
  }
  if (patch.lifecycleState === "ended_clean" || patch.lifecycleState === "ended_aborted") {
    out.push({
      name: "m31.telehealth.visit_ended",
      payload: {
        telehealthVisitId: row.id,
        m17VisitId: row.m17VisitId,
        lifecycleState: row.lifecycleState,
        endReason: row.endReason ?? "unspecified",
        ...(row.totalDurationSec !== null ? { totalDurationSec: row.totalDurationSec } : {}),
        audioOnlyFallback: row.audioOnlyFallbackActive,
      },
    });
  }
  if (patch.recordingEnabled === true) {
    out.push({
      name: "m31.telehealth.recording_started",
      payload: { telehealthVisitId: row.id },
    });
  }
  return out;
}

/** The extra owned-table operations the §4.1 routes need beyond the seven seam ports. */
export interface PortalOwnedTableOps {
  /** Account facts for the §4.7 predicate resolver + admin detail (fail-null on absent/cross-tenant). */
  accountById(orgId: string, id: string): Promise<PortalAccountDigest | null>;
  /** Per-tenant account roster (§4.1 admin). */
  accountList(orgId: string): Promise<PortalAccountDigest[]>;
  /**
   * Portal sign-in — stamp `last_login_at` / `last_active_at` on the account a session was just bound to. Matches on
   * id AND an active/bereaved status; `false` ⇒ no such live account in this org (nothing was written).
   */
  recordLogin(orgId: string, portalAccountId: string, at: Date): Promise<boolean>;
  /** Per-account grant roster (§4.1 admin), active + revoked. */
  grantsForAccount(orgId: string, portalAccountId: string): Promise<PortalAccessGrantDigest[]>;
  /** The ACTIVE grant pairing an account with a patient (the §4.7 predicate read). */
  activeGrant(
    orgId: string,
    portalAccountId: string,
    patientId: string,
  ): Promise<PortalAccessGrantDigest | null>;
  /**
   * §4.1 admin suspend — org-admin temporary disable (returns the new status).
   *
   * `reasonCipher` is the sealed operator reason (#117); it is REQUIRED because the route publishes
   * `reason` as `required: true` and a suspension recorded without one is the defect that filed the
   * issue. The route seals it before calling — the store never sees plaintext.
   */
  suspendAccount(
    orgId: string,
    userId: string,
    id: string,
    reasonCipher: string,
  ): Promise<PortalAccountDigest | null>;
  /** §4.1 admin reinstate — reverse of suspend; the same sealed reason contract. */
  reinstateAccount(
    orgId: string,
    userId: string,
    id: string,
    reasonCipher: string,
  ): Promise<PortalAccountDigest | null>;
  /** Telehealth visit facts (§4.7 predicate + admin detail + join/recording transitions). */
  telehealthById(orgId: string, id: string): Promise<TelehealthVisitDigest | null>;
  /** F-220 — the room for an M17 visit, if one was minted (unique on `m17_visit_id`). */
  telehealthByM17VisitId(orgId: string, m17VisitId: string): Promise<TelehealthVisitDigest | null>;
  /** F-220 — the lazy mint's INSERT; `null` when a row for the M17 visit already exists (lost the race). */
  insertTelehealthVisitIfAbsent(
    orgId: string,
    userId: string,
    row: {
      readonly id: string;
      readonly providerEntityId: string;
      readonly locationId: string | null;
      readonly m17VisitId: string;
      readonly patientId: string;
      readonly assignedMembershipId: string;
      readonly vendor: TelehealthVendor;
      readonly vendorRoomIdCipher: string;
      readonly vendorRoomUrlCipher: string;
      readonly scheduledVisitSetting: "telephonic";
    },
  ): Promise<TelehealthVisitDigest | null>;
  /** Per-tenant telehealth roster (§4.1 admin). */
  telehealthList(orgId: string): Promise<TelehealthVisitDigest[]>;
  /**
   * GAP-093 — the recording facts stop-recording decides over: whether a recording is on and the user who
   * started it (`null` ⇒ unknown: a recording started before migration 0339). `null` result ⇒ no such visit in this org.
   */
  telehealthRecordingState(
    orgId: string,
    id: string,
  ): Promise<{ enabled: boolean; startedByUserId: string | null } | null>;
  /**
   * GAP-095 — the room facts the join/leave/recording/end routes drive the VENDOR with: the sealed room id/url
   * (decrypted only by the room cipher), the vendor's recording id and who has left. `null` ⇒ no such visit.
   */
  telehealthRoomFacts(orgId: string, id: string): Promise<TelehealthRoomFacts | null>;
  /** Apply a telehealth lifecycle transition + optional side-effect columns, returning the new digest. */
  updateTelehealthLifecycle(
    orgId: string,
    userId: string,
    id: string,
    patch: {
      lifecycleState?: TelehealthLifecycleState;
      audioOnlyFallbackActive?: boolean;
      recordingEnabled?: boolean;
      recordingRequested?: boolean;
      /** The session user who started the recording (GAP-093). */
      recordingStartedByUserId?: string | null;
      visitStartedAt?: Date;
      visitEndedAt?: Date;
      endReason?: TelehealthEndReason;
      totalDurationSec?: number;
      firstParticipantJoinedAt?: Date;
      /** GAP-095 — set on leave, cleared (null) on re-join. */
      patientLeftAt?: Date | null;
      clinicianLeftAt?: Date | null;
      /** GAP-095 — the vendor's opaque recording id (null once stopped). */
      vendorRecordingId?: string | null;
    },
  ): Promise<TelehealthVisitDigest | null>;
}

/** The full store the composition root binds: the seven seam ports + the route-only owned-table ops. */
export type PortalStore = M31SeamStores & PortalOwnedTableOps;

/** Build the Drizzle-backed {@link PortalStore} (the seven seams + the §4.1 route ops). */
/**
 * GAP-052 - where the section 164.528 portal-disclosure lines come from. M22 owns `document_access_log`, so M31 takes
 * the reader as a port bound at the composition root instead of naming that table. ABSENT => the seam reports no lines.
 */
export type PortalDisclosureSource = (
  organizationId: string,
  patientId: string,
  from: Date,
  to: Date,
) => Promise<
  readonly {
    readonly portalAccountId: string;
    readonly patientId: string;
    readonly documentId: string;
    readonly accessedAt: Date;
  }[]
>;

export function buildDrizzlePortalStore(
  db: DbClient,
  events?: M31EventEmitter,
  disclosureSource?: PortalDisclosureSource,
): PortalStore {
  const activeGrantsFor = async (
    orgId: string,
    portalAccountId: string,
  ): Promise<PortalAccessGrantDigest[]> =>
    withOrgContext(db, ctx(orgId), async (tx) => {
      const rows = await tx
        .select()
        .from(portalAccessGrants)
        .where(
          and(
            eq(portalAccessGrants.portalAccountId, portalAccountId),
            isNull(portalAccessGrants.revokedAt),
          ),
        );
      return rows.map(toGrantDigest);
    });

  return {
    // ── seam 1: PortalAccountReader ─────────────────────────────────────────────────────────────────────
    accounts: {
      async countByStatus(orgId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const rows = await tx
            .select({ status: portalAccounts.status, n: sql<number>`count(*)::int` })
            .from(portalAccounts)
            .groupBy(portalAccounts.status);
          const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
          return {
            active: by("active"),
            invited: by("invited"),
            revoked: by("revoked"),
            bereaved: by("bereaved"),
          };
        });
      },
      async accountsForPatient(orgId, patientId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const rows = await tx
            .select({ a: portalAccounts })
            .from(portalAccessGrants)
            .innerJoin(portalAccounts, eq(portalAccounts.id, portalAccessGrants.portalAccountId))
            .where(
              and(
                eq(portalAccessGrants.patientId, patientId),
                isNull(portalAccessGrants.revokedAt),
              ),
            );
          return rows.map((r) => toAccountDigest(r.a));
        });
      },
      async accountByUserId(orgId, userId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const [row] = await tx
            .select()
            .from(portalAccounts)
            .where(eq(portalAccounts.userId, userId))
            .limit(1);
          return row ? toAccountDigest(row) : null;
        });
      },
    },

    // ── seam 2: PortalAccessGrantReader ───────────────────────────────────────────────────────────────
    grants: {
      activeGrantsForAccount: activeGrantsFor,
      async activeGrantForAccountAndPatient(orgId, portalAccountId, patientId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const [row] = await tx
            .select()
            .from(portalAccessGrants)
            .where(
              and(
                eq(portalAccessGrants.portalAccountId, portalAccountId),
                eq(portalAccessGrants.patientId, patientId),
                isNull(portalAccessGrants.revokedAt),
              ),
            )
            .limit(1);
          return row ? toGrantDigest(row) : null;
        });
      },
      async patientsWithActiveGrantsInOrg(orgId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const rows = await tx
            .select({
              patientId: portalAccessGrants.patientId,
              n: sql<number>`count(*)::int`,
            })
            .from(portalAccessGrants)
            .where(isNull(portalAccessGrants.revokedAt))
            .groupBy(portalAccessGrants.patientId);
          return rows.map((r) => ({ patientId: r.patientId, grantCount: r.n }));
        });
      },
    },

    // ── seam 3: PortalEngagementProvider (owned-table aggregates only; behavioural counts are M4's) ─────
    engagement: {
      async engagementForPatient(orgId, patientId) {
        const active = await withOrgContext(db, ctx(orgId), async (tx) => {
          const rows = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(portalAccessGrants)
            .innerJoin(portalAccounts, eq(portalAccounts.id, portalAccessGrants.portalAccountId))
            .where(
              and(
                eq(portalAccessGrants.patientId, patientId),
                isNull(portalAccessGrants.revokedAt),
                sql`${portalAccounts.status} in ('active','bereaved')`,
              ),
            );
          return rows[0]?.n ?? 0;
        });
        return {
          hasActiveAccount: active > 0,
          daysActive: 0,
          lastViewedAt: null,
          messagesSent: 0,
          documentsViewed: 0,
          amendmentsSubmitted: 0,
          administrationsAttested: 0,
        };
      },
      async engagementMetricsForOrg(orgId): Promise<PortalEngagementMetrics> {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const statusRows = await tx
            .select({ status: portalAccounts.status, n: sql<number>`count(*)::int` })
            .from(portalAccounts)
            .groupBy(portalAccounts.status);
          const by = (s: string) => statusRows.find((r) => r.status === s)?.n ?? 0;
          const [row] = await tx
            .select({ n: sql<number>`count(distinct ${portalAccessGrants.patientId})::int` })
            .from(portalAccessGrants)
            .where(isNull(portalAccessGrants.revokedAt));
          return {
            accountsActive: by("active"),
            accountsInvited: by("invited"),
            accountsRevoked: by("revoked"),
            accountsBereaved: by("bereaved"),
            patientsWithActiveGrant: row?.n ?? 0,
            sessionsInWindow: 0,
          };
        });
      },
    },

    // ── seams 4 + 5: TelehealthVisitReader + TelehealthMetricsProvider ─────────────────────────────────
    telehealth: {
      async getById(orgId, telehealthVisitId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const [row] = await tx
            .select()
            .from(telehealthVisits)
            .where(eq(telehealthVisits.id, telehealthVisitId))
            .limit(1);
          return row ? toVisitDigest(row) : null;
        });
      },
      async getByM17VisitId(orgId, m17VisitId) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const [row] = await tx
            .select()
            .from(telehealthVisits)
            .where(eq(telehealthVisits.m17VisitId, m17VisitId))
            .limit(1);
          return row ? toVisitDigest(row) : null;
        });
      },
      async metricsForOrg(orgId, fromIso, toIso) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const rows = await tx
            .select({
              lifecycleState: telehealthVisits.lifecycleState,
              audioOnlyFallbackActive: telehealthVisits.audioOnlyFallbackActive,
              recordingEnabled: telehealthVisits.recordingEnabled,
            })
            .from(telehealthVisits)
            .where(
              and(
                gte(telehealthVisits.roomMintedAt, new Date(fromIso)),
                lte(telehealthVisits.roomMintedAt, new Date(toIso)),
              ),
            );
          const total = rows.length;
          const clean = rows.filter((r) => r.lifecycleState === "ended_clean").length;
          const aborted = rows.filter((r) => r.lifecycleState === "ended_aborted").length;
          const audio = rows.filter((r) => r.audioOnlyFallbackActive).length;
          const recorded = rows.filter((r) => r.recordingEnabled).length;
          return {
            visitsTotal: total,
            visitsCompletedClean: clean,
            visitsCompletedAborted: aborted,
            audioOnlyFallbackRate: total === 0 ? 0 : audio / total,
            recordingRate: total === 0 ? 0 : recorded / total,
            vendorOutageDurationMin: 0,
          };
        });
      },
      async minutesByTenant(orgId, fromIso, toIso) {
        return withOrgContext(db, ctx(orgId), async (tx) => {
          const rows = await tx
            .select({
              totalDurationSec: telehealthVisits.totalDurationSec,
              recordingEnabled: telehealthVisits.recordingEnabled,
            })
            .from(telehealthVisits)
            .where(
              and(
                gte(telehealthVisits.roomMintedAt, new Date(fromIso)),
                lte(telehealthVisits.roomMintedAt, new Date(toIso)),
              ),
            );
          let totalMinutes = 0;
          let recordedMinutes = 0;
          for (const r of rows) {
            const min = Math.round((r.totalDurationSec ?? 0) / 60);
            totalMinutes += min;
            if (r.recordingEnabled) recordedMinutes += min;
          }
          return { totalMinutes, recordedMinutes };
        });
      },
    },

    // ── seam 6: PortalSessionMinter create-half (M28 SMART launch; no owned session table, so this is a
    //    no-op handle that returns a synthetic id — the real session row is M2's) ─────────────────────────
    sessions: {
      async createSmartLaunchSession(input) {
        return { sessionId: `smart:${input.portalAccountId}:${input.activeGrantId}` };
      },
    },

    // ── seam 7: PortalDisclosureAccountingProvider - the section 164.528 lines for a patient are the PORTAL-accessor
    //    rows of M22`s `document_access_log`, read through the injected {@link PortalDisclosureSource} (GAP-052) ──
    disclosures: {
      async disclosuresForPatient(
        orgId,
        patientId,
        fromIso,
        toIso,
      ): Promise<PortalDisclosureRecord[]> {
        if (!disclosureSource) return [];
        const rows = await disclosureSource(orgId, patientId, new Date(fromIso), new Date(toIso));
        return rows.map((r) => ({
          portalAccountId: r.portalAccountId as PortalDisclosureRecord["portalAccountId"],
          patientId: r.patientId as PortalDisclosureRecord["patientId"],
          routePath: `/portal/documents/${r.documentId}`,
          dataCategoriesDisclosed: ["documents"],
          viewedAt: r.accessedAt.toISOString() as PortalDisclosureRecord["viewedAt"],
        }));
      },
    },

    // ── the §4.1 route-only owned-table ops ───────────────────────────────────────────────────────────
    async accountById(orgId, id) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(portalAccounts)
          .where(eq(portalAccounts.id, id))
          .limit(1);
        return row ? toAccountDigest(row) : null;
      });
    },
    async recordLogin(orgId, portalAccountId, at) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const rows = await tx
          .update(portalAccounts)
          .set({ lastLoginAt: at, lastActiveAt: at, updatedAt: at })
          .where(
            and(
              eq(portalAccounts.id, portalAccountId),
              eq(portalAccounts.organizationId, orgId),
              sql`${portalAccounts.status} IN ('active', 'bereaved')`,
            ),
          )
          .returning({ id: portalAccounts.id });
        return rows.length === 1;
      });
    },
    async accountList(orgId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const rows = await tx
          .select()
          .from(portalAccounts)
          .orderBy(desc(portalAccounts.invitedAt))
          .limit(200);
        return rows.map(toAccountDigest);
      });
    },
    grantsForAccount(orgId, portalAccountId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const rows = await tx
          .select()
          .from(portalAccessGrants)
          .where(eq(portalAccessGrants.portalAccountId, portalAccountId))
          .orderBy(desc(portalAccessGrants.grantedAt));
        return rows.map(toGrantDigest);
      });
    },
    async activeGrant(orgId, portalAccountId, patientId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(portalAccessGrants)
          .where(
            and(
              eq(portalAccessGrants.portalAccountId, portalAccountId),
              eq(portalAccessGrants.patientId, patientId),
              isNull(portalAccessGrants.revokedAt),
            ),
          )
          .limit(1);
        return row ? toGrantDigest(row) : null;
      });
    },
    async suspendAccount(orgId, userId, id, reasonCipher) {
      return withOrgContext(db, ctx(orgId, userId), async (tx) => {
        const [row] = await tx
          .update(portalAccounts)
          .set({
            status: "suspended",
            suspendedAt: new Date(),
            statusChangeReasonCipher: reasonCipher,
            updatedAt: new Date(),
          })
          .where(eq(portalAccounts.id, id))
          .returning();
        if (row) {
          // GAP-159 - same-tx: the sealed reason never leaves the row; the event carries a fixed token.
          await events?.emitInTx(
            tx,
            orgId,
            "m31.portal_account.suspended",
            { kind: "portal_account", id },
            { portalAccountId: id, reason: "admin_suspend" },
          );
        }
        return row ? toAccountDigest(row) : null;
      });
    },
    async reinstateAccount(orgId, userId, id, reasonCipher) {
      return withOrgContext(db, ctx(orgId, userId), async (tx) => {
        const [row] = await tx
          .update(portalAccounts)
          .set({
            status: "active",
            suspendedAt: null,
            statusChangeReasonCipher: reasonCipher,
            updatedAt: new Date(),
          })
          .where(eq(portalAccounts.id, id))
          .returning();
        return row ? toAccountDigest(row) : null;
      });
    },
    async telehealthById(orgId, id) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(telehealthVisits)
          .where(eq(telehealthVisits.id, id))
          .limit(1);
        return row ? toVisitDigest(row) : null;
      });
    },
    async telehealthByM17VisitId(orgId, m17VisitId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select()
          .from(telehealthVisits)
          .where(
            and(
              eq(telehealthVisits.organizationId, orgId),
              eq(telehealthVisits.m17VisitId, m17VisitId),
            ),
          )
          .limit(1);
        return row ? toVisitDigest(row) : null;
      });
    },
    async insertTelehealthVisitIfAbsent(orgId, userId, row) {
      return withOrgContext(db, ctx(orgId, userId), async (tx) => {
        const [inserted] = await tx
          .insert(telehealthVisits)
          .values({ ...row, organizationId: orgId })
          .onConflictDoNothing({ target: telehealthVisits.m17VisitId })
          .returning();
        if (inserted) {
          await events?.emitInTx(
            tx,
            orgId,
            "m31.telehealth.room_created",
            { kind: "telehealth_visit", id: inserted.id },
            {
              telehealthVisitId: inserted.id,
              m17VisitId: inserted.m17VisitId,
              patientId: inserted.patientId,
              vendor: inserted.vendor,
            },
          );
        }
        return inserted ? toVisitDigest(inserted) : null;
      });
    },
    async telehealthList(orgId) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const rows = await tx
          .select()
          .from(telehealthVisits)
          .orderBy(desc(telehealthVisits.roomMintedAt))
          .limit(200);
        return rows.map(toVisitDigest);
      });
    },
    async telehealthRecordingState(orgId, id) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select({
            enabled: telehealthVisits.recordingEnabled,
            startedBy: telehealthVisits.recordingStartedByUserId,
          })
          .from(telehealthVisits)
          .where(eq(telehealthVisits.id, id))
          .limit(1);
        // GAP-093(b): NULL ⇒ no recording, or one started before 0339 (stop falls back to the assignee).
        return row ? { enabled: row.enabled, startedByUserId: row.startedBy } : null;
      });
    },
    async telehealthRoomFacts(orgId, id) {
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const [row] = await tx
          .select({
            vendorRoomIdCipher: telehealthVisits.vendorRoomIdCipher,
            vendorRoomUrlCipher: telehealthVisits.vendorRoomUrlCipher,
            vendorRecordingId: telehealthVisits.vendorRecordingId,
            patientLeftAt: telehealthVisits.patientLeftAt,
            clinicianLeftAt: telehealthVisits.clinicianLeftAt,
          })
          .from(telehealthVisits)
          .where(eq(telehealthVisits.id, id))
          .limit(1);
        return row
          ? {
              vendorRoomIdCipher: row.vendorRoomIdCipher,
              vendorRoomUrlCipher: row.vendorRoomUrlCipher,
              vendorRecordingId: row.vendorRecordingId ?? null,
              patientLeftAt: iso(row.patientLeftAt),
              clinicianLeftAt: iso(row.clinicianLeftAt),
            }
          : null;
      });
    },
    async updateTelehealthLifecycle(orgId, userId, id, patch) {
      return withOrgContext(db, ctx(orgId, userId), async (tx) => {
        const [row] = await tx
          .update(telehealthVisits)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(telehealthVisits.id, id))
          .returning();
        if (row && events) {
          for (const e of lifecycleEventsFor(patch, row)) {
            await events.emitInTx(
              tx,
              orgId,
              e.name,
              { kind: "telehealth_visit", id: row.id },
              e.payload,
            );
          }
        }
        return row ? toVisitDigest(row) : null;
      });
    },
  } as PortalStore;
}

/** Adapt the Drizzle store into the {@link PortalAbacResolver} shape the §4.7 predicates read (the digests
 *  are supersets of the predicate facts, so the projection is direct). */
export function buildPortalAbacResolverFromStore(store: PortalStore): {
  loadAccount: (orgId: string, id: string) => Promise<PortalAccountDigest | null>;
  activeGrant: (
    orgId: string,
    portalAccountId: string,
    patientId: string,
  ) => Promise<PortalAccessGrantDigest | null>;
  loadTelehealthVisit: (orgId: string, id: string) => Promise<TelehealthVisitDigest | null>;
} {
  return {
    loadAccount: (orgId, id) => store.accountById(orgId, id),
    activeGrant: (orgId, portalAccountId, patientId) =>
      store.activeGrant(orgId, portalAccountId, patientId),
    loadTelehealthVisit: (orgId, id) => store.telehealthById(orgId, id),
  };
}

/** The lay data-category taxonomy the disclosure-accounting emit drives off (re-exported for the routes). */
export const PORTAL_DISCLOSURE_CATEGORIES: readonly PortalDataCategory[] = [
  "care_plan",
  "visits",
  "medications",
  "administrations",
  "documents",
  "triage",
  "bereavement",
];
