// apps/backend/src/modules/28-fhir/abac-resolver-drizzle.ts — M28-T08 (§4.7).
//
// The Drizzle-backed {@link FhirGatewayAbacResolver} the six §4.7 predicates load their subject facts
// through. Every ORG-SCOPED read opens `withOrgContext` so RLS scopes it to the ACTING org — an ABAC
// predicate must never see across a tenant boundary, so a cross-tenant subject resolves to `null`, which
// the predicates turn into a fail-CLOSED deny (§8.2's isolation shape). Every read swallows its own error
// into `null`: a guard that 500s on a database blip is a worse outcome than one that denies.
//
// `holdsPermission` reaches M3's effective-permission store through an injected PORT (the M32/M19/M20
// precedent — no M2/M3 import edge). M28's `*_membership_id` columns hold MEMBERSHIP ids and M3's grant
// store is keyed on USER id, so the membership→user translation matters for the same reason it did there:
// a direct lookup would return zero grants, denying every legitimate reviewer for the wrong reason.
import { resolveEffectivePermissions } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { FhirInboundOwnerModule } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

import type {
  FhirBulkExportJobAbacFacts,
  FhirClientActiveFacts,
  FhirGatewayAbacResolver,
  FhirInboundSubjectFacts,
} from "./abac-predicates";

/** The M3 effective-permission store `holdsPermission` derives from — structurally typed (no M3 import). */
export interface FhirEffectivePermissionReader {
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

/** The M39 disclosure-consent port `disclosureAllowed` consults (bound at boot from the consumed seam). */
export interface FhirConsentDisclosurePort {
  evaluateForDisclosure(args: {
    organizationId: string;
    patientId: string;
    recipientClientId?: string;
  }): Promise<{ allowed: boolean }>;
}

/** The M40 BAA port `clientActiveFacts` consults (bound at boot from the consumed seam). */
export interface FhirBaaStatusPort {
  isBaaActive(input: {
    organizationId: string;
    contractReference: string;
    asOf: string;
  }): Promise<boolean>;
}

export interface FhirGatewayAbacDrizzleDeps {
  readonly db: DbClient;
  /** UNBOUND ⇒ `holdsPermission` answers `null` (denies) — the fail-closed shape when no store is wired. */
  readonly permissions?: FhirEffectivePermissionReader;
  /** UNBOUND ⇒ `disclosureAllowed` answers `null` (denies). */
  readonly consent?: FhirConsentDisclosurePort;
  /** UNBOUND ⇒ `clientActiveFacts` reports `baaActive: false` (denies `fhir_client_active`). */
  readonly baa?: FhirBaaStatusPort;
  /** Injected clock (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Build the Drizzle resolver. `userId` is empty on the ABAC path (the org is the scoping fact RLS needs). */
export function buildDrizzleFhirGatewayAbacResolver(
  deps: FhirGatewayAbacDrizzleDeps,
): FhirGatewayAbacResolver {
  const { db } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const CLIENT = schema.fhirClient;
  const JOB = schema.fhirBulkExportJob;
  const INBOUND = schema.fhirInboundResource;
  const MEMBERSHIP = schema.memberships;

  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async clientOrgId(clientId) {
      try {
        const [row] = await db
          .select({ organizationId: CLIENT.organizationId })
          .from(CLIENT)
          .where(eq(CLIENT.id, clientId))
          .limit(1);
        return row?.organizationId ?? null;
      } catch {
        return null;
      }
    },

    async inboundOwnerModule(orgId, proposalId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<FhirInboundOwnerModule | null> => {
            const [row] = await tx
              .select({ ownerModule: INBOUND.ownerModule, organizationId: INBOUND.organizationId })
              .from(INBOUND)
              .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return row.ownerModule as FhirInboundOwnerModule;
          },
        );
      } catch {
        return null;
      }
    },

    async inboundSubjectPatient(orgId, proposalId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<FhirInboundSubjectFacts | null> => {
            const [row] = await tx
              .select({
                resourceType: INBOUND.resourceType,
                subjectPatientId: INBOUND.subjectPatientId,
              })
              .from(INBOUND)
              .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, orgId)))
              .limit(1);
            return row ?? null;
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

    async clientAllowedResourceTypes(clientId) {
      try {
        const [row] = await db
          .select({ allowedScopes: CLIENT.allowedScopes })
          .from(CLIENT)
          .where(eq(CLIENT.id, clientId))
          .limit(1);
        if (!row) return null;
        // `system/Patient.read` → `Patient`.
        return asStringArray(row.allowedScopes).map(
          (s) => s.replace(/^system\//, "").split(".")[0]!,
        );
      } catch {
        return null;
      }
    },

    async loadBulkExportJob(orgId, jobId) {
      try {
        return await withOrgContext(
          db,
          ctx(orgId),
          async (tx): Promise<FhirBulkExportJobAbacFacts | null> => {
            const [row] = await tx
              .select({
                id: JOB.id,
                organizationId: JOB.organizationId,
                clientId: JOB.clientId,
                initiatedByMembershipId: JOB.initiatedByMembershipId,
              })
              .from(JOB)
              .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, orgId)))
              .limit(1);
            if (!row) return null;
            return {
              jobId: row.id,
              organizationId: row.organizationId,
              clientId: row.clientId,
              initiatedByMembershipId: row.initiatedByMembershipId,
            };
          },
        );
      } catch {
        return null;
      }
    },

    async clientActiveFacts(clientId) {
      try {
        const [row] = await db
          .select({
            organizationId: CLIENT.organizationId,
            status: CLIENT.status,
            ipAllowlist: CLIENT.ipAllowlist,
            baaContractReference: CLIENT.baaContractReference,
          })
          .from(CLIENT)
          .where(eq(CLIENT.id, clientId))
          .limit(1);
        if (!row) return null;
        let baaActive = false;
        if (deps.baa !== undefined) {
          baaActive = await deps.baa
            .isBaaActive({
              organizationId: row.organizationId,
              contractReference: row.baaContractReference,
              asOf: now(),
            })
            .catch(() => false);
        }
        const facts: FhirClientActiveFacts = {
          organizationId: row.organizationId,
          status: row.status,
          ipAllowlist: asStringArray(row.ipAllowlist),
          baaActive,
        };
        return facts;
      } catch {
        return null;
      }
    },

    async disclosureAllowed(orgId, patientId, recipientClientId) {
      if (deps.consent === undefined) return null;
      try {
        const decision = await deps.consent.evaluateForDisclosure({
          organizationId: orgId,
          patientId,
          recipientClientId,
        });
        return decision.allowed;
      } catch {
        return null;
      }
    },
  };
}
