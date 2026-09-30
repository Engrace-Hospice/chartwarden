// apps/backend/src/modules/29-external-interfaces/abac-resolver-drizzle.ts — M29-T08 (§4.8).
//
// The Drizzle-backed {@link M29AbacResolver} the six §4.8 predicates load their subject facts through.
// Every ORG-SCOPED read opens `withOrgContext` so RLS scopes it to the ACTING org — an ABAC predicate must
// never see across a tenant boundary, so a cross-tenant subject resolves to `null`, which the predicates
// turn into a fail-CLOSED deny (§8.2). Every read swallows its own error into `null`: a guard that 500s on a
// database blip is a worse outcome than one that denies.
//
// `holdsPermission` reaches M3's effective-permission store through an injected PORT (the M28/M19/M20
// precedent — no M2/M3 import edge). M29's `*_membership_id` columns hold MEMBERSHIP ids and M3's grant
// store is keyed on USER id, so the membership→user translation matters: a direct lookup would return zero
// grants, denying every legitimate reviewer for the wrong reason.
//
// `isInCaseload` reaches M5's `CaseloadProvider` through an injected port (bound at boot from the consumed
// seam). UNBOUND ⇒ it answers `null` (denies), the fail-closed shape before M5 registers the real provider.
import { resolveEffectivePermissions } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { Hl7ProposalOwnerModule } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

import type {
  Hl7ProposalAbacFacts,
  LabObservationAbacFacts,
  M29AbacResolver,
} from "./abac-predicates";

/** The M3 effective-permission store `holdsPermission` derives from — structurally typed (no M3 import). */
export interface M29EffectivePermissionReader {
  loadGrants(
    orgId: string,
    userId: string,
  ):
    | Promise<
        readonly {
          readonly permissionKeys: readonly string[];
          readonly enabled: boolean;
          readonly expiresAt: Date | null;
        }[]
      >
    | readonly {
        readonly permissionKeys: readonly string[];
        readonly enabled: boolean;
        readonly expiresAt: Date | null;
      }[];
}

/** The M5 caseload port `isInCaseload` consults (bound at boot from the `CaseloadProvider` consumed seam). */
export interface M29CaseloadPort {
  isInCaseload(input: {
    organizationId: string;
    userId: string;
    patientId: string;
  }): Promise<boolean>;
}

export interface M29AbacDrizzleDeps {
  readonly db: DbClient;
  /** UNBOUND ⇒ `holdsPermission` answers `null` (denies) — the fail-closed shape when no store is wired. */
  readonly permissions?: M29EffectivePermissionReader;
  /** UNBOUND ⇒ `isInCaseload` answers `null` (denies). */
  readonly caseload?: M29CaseloadPort;
  /** Injected clock (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

const OWNER_MODULES: readonly string[] = ["m5", "m6"];

/** Build the Drizzle resolver. `userId` is empty on the ABAC path (the org is the scoping fact RLS needs). */
export function buildDrizzleM29AbacResolver(deps: M29AbacDrizzleDeps): M29AbacResolver {
  const { db } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const FEED = schema.externalFeed;
  const PROPOSAL = schema.hl7InboundProposal;
  const OBSERVATION = schema.labObservation;
  const MEMBERSHIP = schema.memberships;

  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async feedOrgId(feedId, contextOrgId) {
      try {
        // Under the CALLER'S org context. `external_feed` is FORCE RLS, so a bare-pool read as `wardenx_app` sees no
        // rows at all and this used to answer `null` for every feed — every per-feed admin route 404'd (F-189). Under
        // the caller's org the feed is visible iff it is theirs, which is exactly the answer the predicate needs.
        return await withOrgContext(db, ctx(contextOrgId), async (tx) => {
          const [row] = await tx
            .select({ organizationId: FEED.organizationId })
            .from(FEED)
            .where(eq(FEED.id, feedId))
            .limit(1);
          return row?.organizationId ?? null;
        });
      } catch {
        return null;
      }
    },

    async proposalFacts(orgId, proposalId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<Hl7ProposalAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: PROPOSAL.organizationId,
                ownerModule: PROPOSAL.ownerModule,
              })
              .from(PROPOSAL)
              .where(and(eq(PROPOSAL.id, proposalId), eq(PROPOSAL.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            if (!OWNER_MODULES.includes(row.ownerModule)) return null;
            return {
              organizationId: row.organizationId,
              ownerModule: row.ownerModule as Hl7ProposalOwnerModule,
            };
          },
        );
      } catch {
        return null;
      }
    },

    async observationFacts(orgId, observationId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<LabObservationAbacFacts | null> => {
            const [row] = await tx
              .select({
                organizationId: OBSERVATION.organizationId,
                patientId: OBSERVATION.patientId,
              })
              .from(OBSERVATION)
              .where(and(eq(OBSERVATION.id, observationId), eq(OBSERVATION.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return { organizationId: row.organizationId, patientId: row.patientId ?? null };
          },
        );
      } catch {
        return null;
      }
    },

    async holdsPermission(orgId, membershipId, permissionKey) {
      if (deps.permissions === undefined) return null;
      try {
        const [member] = await db
          .select({ userId: MEMBERSHIP.userId })
          .from(MEMBERSHIP)
          .where(and(eq(MEMBERSHIP.id, membershipId), eq(MEMBERSHIP.organizationId, orgId)))
          .limit(1);
        if (!member) return null;
        const grants = await deps.permissions.loadGrants(orgId, member.userId);
        const { permissions } = resolveEffectivePermissions(
          grants.map((g) => ({
            roleKey: "",
            permissionKeys: [...g.permissionKeys],
            enabled: g.enabled,
            expiresAt: g.expiresAt,
          })),
          Date.parse(now()),
        );
        return permissions.has(permissionKey);
      } catch {
        return null;
      }
    },

    async isInCaseload(orgId, userId, patientId) {
      if (deps.caseload === undefined) return null;
      try {
        return await deps.caseload.isInCaseload({ organizationId: orgId, userId, patientId });
      } catch {
        return null;
      }
    },

    async feedBaaSatisfied(orgId, feedId) {
      // Route-level BAA-on-file check: an inbound/outbound HL7 feed needs an unexpired BAA contract ref on
      // file before activation (D16). The full M40 as-of gate is consulted at listener bind / dispatch (T03/
      // T06); this is the lighter activation guard, self-contained against the feed row.
      try {
        return await withOrgContext(db, ctx(orgId), async (tx): Promise<boolean> => {
          const [row] = await tx
            .select({
              baaContractRef: FEED.baaContractRef,
              baaExpiresOn: FEED.baaExpiresOn,
            })
            .from(FEED)
            .where(and(eq(FEED.id, feedId), eq(FEED.organizationId, orgId)))
            .limit(1);
          if (!row) return false;
          if (!row.baaContractRef) return false;
          if (row.baaExpiresOn !== null && row.baaExpiresOn.getTime() <= Date.parse(now())) {
            return false;
          }
          return true;
        });
      } catch {
        return null;
      }
    },
  };
}
