// apps/backend/src/modules/02-identity/elevated-approvals.ts — M2 §3.7 the per-membership NAMED
// APPROVAL AUTHORITY surface (GAP-043): the `ElevatedApprovalReader` seam plus the grant/revoke/list
// service the tenant-admin routes drive.
//
// WHY THIS EXISTS. M27's §4.7 `cost_report_approver_for_provider` predicate ends by asking "does this
// membership carry the per-tenant elevated-approval designation?" — a fact with no table, no column and no
// seam anywhere in the system, so the production resolver hardcoded `false` and the entire cost-report
// approve / submit / reopen lifecycle was unreachable in every tenant. `membership_elevated_approval`
// (migration 0204) is the fact; this file is its reader and its ENTRANCE.
//
// THE ENTRANCE MATTERS AS MUCH AS THE READER. A reader over an empty table that nothing can write to
// answers `false` for exactly the same reason the hardcoded stub did — the gap would read as closed while
// behaving identically. The grant/revoke half below, and the routes that call it, are what make the
// designation something a tenant can actually make.
//
// Pure orchestration over an injected store port: the in-memory store backs the slice/tests, production
// injects the Drizzle-backed one (every statement inside `withOrgContext`, so RLS scopes by app.org_id).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, type ElevatedApprovalReader } from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getSeam, registerSeam } from "../../bootstrap/index";

const EA = schema.membershipElevatedApprovals;

/** The `elevated_approval_kind` member M27's approver predicate keys on (spec §4.7 pseudo-code). */
export const COST_REPORT_APPROVAL_KIND = "cost_report_approval";

/** Every kind the enum declares — the boundary validates against this before touching the store. */
export const ELEVATED_APPROVAL_KINDS = [COST_REPORT_APPROVAL_KIND] as const;
export type ElevatedApprovalKind = (typeof ELEVATED_APPROVAL_KINDS)[number];

/** One designation row as the admin surface reports it. */
export interface ElevatedApprovalGrantView {
  readonly id: string;
  readonly membershipId: string;
  readonly approvalKind: string;
  readonly grantedByMembershipId: string;
  readonly grantedAt: string;
  readonly grantReason: string;
  readonly revokedAt: string | null;
  readonly revokedByMembershipId: string | null;
  readonly revokedReason: string | null;
}

/** The data port the reader + service compose over (Drizzle over membership_elevated_approval in prod). */
export interface ElevatedApprovalStore {
  /** Is there a LIVE (unrevoked) grant of `kind` for this membership? */
  hasLiveGrant(organizationId: string, membershipId: string, kind: string): Promise<boolean>;
  /** Every grant for a membership, newest first — live and revoked (the designation history). */
  listForMembership(
    organizationId: string,
    membershipId: string,
  ): Promise<readonly ElevatedApprovalGrantView[]>;
  /** Insert a live grant. Returns null when one already exists (the partial unique index's answer). */
  grant(input: {
    organizationId: string;
    membershipId: string;
    kind: string;
    grantedByMembershipId: string;
    grantReason: string;
  }): Promise<ElevatedApprovalGrantView | null>;
  /** Revoke the live grant. Returns null when there was none to revoke. */
  revoke(input: {
    organizationId: string;
    membershipId: string;
    kind: string;
    revokedByMembershipId: string;
    revokedReason: string;
  }): Promise<ElevatedApprovalGrantView | null>;
}

/** Build the {@link ElevatedApprovalReader} seam over an injected store. */
export function createElevatedApprovalReader(store: ElevatedApprovalStore): ElevatedApprovalReader {
  return {
    async hasElevatedApproval({ organizationId, membershipId, kind }) {
      // An unrecognized kind is `false`, never a throw: the only consumer is an ABAC predicate, and a
      // thrown error there is an opaque 500 where a deny is the specified behaviour.
      if (!(ELEVATED_APPROVAL_KINDS as readonly string[]).includes(kind)) return false;
      return store.hasLiveGrant(organizationId, membershipId, kind);
    },
  };
}

/** The tenant-admin write surface (the routes' service). */
export interface ElevatedApprovalService {
  list(organizationId: string, membershipId: string): Promise<readonly ElevatedApprovalGrantView[]>;
  grant(input: {
    organizationId: string;
    membershipId: string;
    kind: string;
    grantedByMembershipId: string;
    grantReason: string;
  }): Promise<ElevatedApprovalGrantView>;
  revoke(input: {
    organizationId: string;
    membershipId: string;
    kind: string;
    revokedByMembershipId: string;
    revokedReason: string;
  }): Promise<ElevatedApprovalGrantView>;
}

export function createElevatedApprovalService(
  store: ElevatedApprovalStore,
): ElevatedApprovalService {
  return {
    list: (organizationId, membershipId) => store.listForMembership(organizationId, membershipId),
    async grant(input) {
      const row = await store.grant(input);
      // 409, not a silent re-grant: the partial unique index says one live designation per kind, and
      // quietly returning the existing row would hide that the caller's reason was never recorded.
      if (!row) {
        throw new ConflictError(
          `membership already holds a live '${input.kind}' elevated approval`,
        );
      }
      return row;
    },
    async revoke(input) {
      const row = await store.revoke(input);
      // 404 rather than a no-op 200: "there was nothing to revoke" and "the authority is now gone" are
      // different answers, and an admin acting on a stale list must be told which one happened.
      if (!row) throw new NotFoundError(`live '${input.kind}' elevated approval`, input.membershipId);
      return row;
    },
  };
}

// ── Drizzle store ──────────────────────────────────────────────────────────────────────────────────

const toView = (r: typeof EA.$inferSelect): ElevatedApprovalGrantView => ({
  id: r.id,
  membershipId: r.membershipId,
  approvalKind: r.approvalKind,
  grantedByMembershipId: r.grantedByMembershipId,
  grantedAt: r.grantedAt.toISOString(),
  grantReason: r.grantReason,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  revokedByMembershipId: r.revokedByMembershipId ?? null,
  revokedReason: r.revokedReason ?? null,
});

export function createDrizzleElevatedApprovalStore(db: DbClient): ElevatedApprovalStore {
  /** The seam reads run with no user actor — the audit actor is the WRITE's, not the predicate's. */
  const withOrg = <T>(
    organizationId: string,
    userId: string,
    fn: (tx: DbClient) => Promise<T>,
  ): Promise<T> =>
    withOrgContext(db, { organizationId, userId }, fn as never) as Promise<T>;

  return {
    async hasLiveGrant(organizationId, membershipId, kind) {
      return withOrg(organizationId, "", async (tx) => {
        const [row] = await tx
          .select({ id: EA.id })
          .from(EA)
          .where(
            and(
              eq(EA.organizationId, organizationId),
              eq(EA.membershipId, membershipId),
              eq(EA.approvalKind, kind as ElevatedApprovalKind),
              isNull(EA.revokedAt),
            ),
          )
          .limit(1);
        return row !== undefined;
      });
    },

    async listForMembership(organizationId, membershipId) {
      return withOrg(organizationId, "", async (tx) => {
        const rows = await tx
          .select()
          .from(EA)
          .where(and(eq(EA.organizationId, organizationId), eq(EA.membershipId, membershipId)))
          .orderBy(desc(EA.grantedAt));
        return rows.map(toView);
      });
    },

    async grant(input) {
      return withOrg(input.organizationId, input.grantedByMembershipId, async (tx) => {
        // `onConflictDoNothing` against the partial unique index: a concurrent second granter gets zero
        // rows back and the service turns that into a 409, instead of both writes appearing to succeed.
        const [row] = await tx
          .insert(EA)
          .values({
            organizationId: input.organizationId,
            membershipId: input.membershipId,
            approvalKind: input.kind as ElevatedApprovalKind,
            grantedByMembershipId: input.grantedByMembershipId,
            grantReason: input.grantReason,
          })
          .onConflictDoNothing()
          .returning();
        return row ? toView(row) : null;
      });
    },

    async revoke(input) {
      return withOrg(input.organizationId, input.revokedByMembershipId, async (tx) => {
        // The `revoked_at IS NULL` predicate is the atomic claim — two concurrent revokes cannot both
        // win, and the loser gets a 404 rather than a second revocation stamped over the first.
        const [row] = await tx
          .update(EA)
          .set({
            revokedAt: new Date(),
            revokedByMembershipId: input.revokedByMembershipId,
            revokedReason: input.revokedReason,
          })
          .where(
            and(
              eq(EA.organizationId, input.organizationId),
              eq(EA.membershipId, input.membershipId),
              eq(EA.approvalKind, input.kind as ElevatedApprovalKind),
              isNull(EA.revokedAt),
            ),
          )
          .returning();
        return row ? toView(row) : null;
      });
    },
  };
}

// ── in-memory slice store ──────────────────────────────────────────────────────────────────────────

/** A seed designation for the slice/tests. */
export interface SeedElevatedApproval {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly kind: string;
  readonly grantedByMembershipId?: string;
  readonly grantReason?: string;
}

export function createInMemoryElevatedApprovalStore(seed: readonly SeedElevatedApproval[] = []): {
  store: ElevatedApprovalStore;
} {
  let seq = 0;
  // Mutable mirror of the readonly view type — the store owns these rows and revoke() stamps them.
  type Row = { -readonly [K in keyof ElevatedApprovalGrantView]: ElevatedApprovalGrantView[K] } & {
    organizationId: string;
  };
  const rows: Row[] = [];
  const push = (s: SeedElevatedApproval) => {
    seq += 1;
    rows.push({
      organizationId: s.organizationId,
      id: `ea-${seq}`,
      membershipId: s.membershipId,
      approvalKind: s.kind,
      grantedByMembershipId: s.grantedByMembershipId ?? s.membershipId,
      grantedAt: new Date(0).toISOString(),
      grantReason: s.grantReason ?? "seeded designation (slice)",
      revokedAt: null,
      revokedByMembershipId: null,
      revokedReason: null,
    });
  };
  for (const s of seed) push(s);

  const liveOf = (o: string, m: string, k: string) =>
    rows.find(
      (r) =>
        r.organizationId === o && r.membershipId === m && r.approvalKind === k && !r.revokedAt,
    );

  return {
    store: {
      async hasLiveGrant(organizationId, membershipId, kind) {
        return liveOf(organizationId, membershipId, kind) !== undefined;
      },
      async listForMembership(organizationId, membershipId) {
        return rows
          .filter((r) => r.organizationId === organizationId && r.membershipId === membershipId)
          .map(({ organizationId: _o, ...v }) => v)
          .reverse();
      },
      async grant(input) {
        if (liveOf(input.organizationId, input.membershipId, input.kind)) return null;
        push(input);
        const row = rows[rows.length - 1];
        if (!row) return null;
        const { organizationId: _o, ...view } = row;
        return view;
      },
      async revoke(input) {
        const row = liveOf(input.organizationId, input.membershipId, input.kind);
        if (!row) return null;
        row.revokedAt = new Date(1).toISOString();
        row.revokedByMembershipId = input.revokedByMembershipId;
        row.revokedReason = input.revokedReason;
        const { organizationId: _o, ...view } = row;
        return view;
      },
    },
  };
}

// ── registration ───────────────────────────────────────────────────────────────────────────────────

/** Register M2's `ElevatedApprovalReader` into the M1 registry (before validateSeams()). */
export function registerElevatedApprovalSeam(store?: ElevatedApprovalStore): void {
  registerSeam(
    "ElevatedApprovalReader",
    createElevatedApprovalReader(store ?? createInMemoryElevatedApprovalStore().store),
  );
}

/** Typed resolver for the registered reader (validateSeams() guarantees an instance, fail-closed). */
export function getElevatedApprovalReader(): ElevatedApprovalReader {
  return getSeam("ElevatedApprovalReader");
}
