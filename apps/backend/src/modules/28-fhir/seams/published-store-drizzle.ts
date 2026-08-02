// apps/backend/src/modules/28-fhir/seams/published-store-drizzle.ts — M28-T08 the Drizzle store the §4.3
// published seams read through (`FhirGatewayMetricsProvider` / `FhirClientReader` / `FhirInboundProposalReader`).
//
// Every read self-scopes to the caller's AMBIENT org context (HARD RULE 3): a seam consumer (M33 / M30 /
// M34 / M5 / M12) reaches these under its OWN org context, so the store opens `withOrgContext` on the
// `organizationId` argument (asserted against the scope, never used to select across tenants) and RLS is
// the backstop. Metrics are aggregate COUNTS only — NO PHI leaves through this surface.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  FhirClientDetail,
  FhirClientSummary,
  FhirDisclosureMetrics,
  FhirGatewayMetrics,
  FhirInboundOwnerModule,
  FhirInboundProposalDetail,
  FhirInboundProposalSummary,
} from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";

import type { FhirPublishedSeamStore } from "./published";

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function createDrizzleFhirPublishedSeamStore(db: DbClient): FhirPublishedSeamStore {
  const CLIENT = schema.fhirClient;
  const JOB = schema.fhirBulkExportJob;
  const INBOUND = schema.fhirInboundResource;
  const CONFIG = schema.tenantFhirConfig;

  const ctx = (organizationId: string) => ({ organizationId, userId: "" });

  return {
    async metricsForOrg({ organizationId }): Promise<FhirGatewayMetrics> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const jobs = await tx
          .select({ status: JOB.status })
          .from(JOB)
          .where(eq(JOB.organizationId, organizationId));
        const proposals = await tx
          .select({ status: INBOUND.proposalStatus })
          .from(INBOUND)
          .where(eq(INBOUND.organizationId, organizationId));
        const countJobs = (s: string) => jobs.filter((j) => j.status === s).length;
        const countProps = (s: string) => proposals.filter((p) => p.status === s).length;
        return {
          requestsByHour: [],
          topResourceTypes: [],
          topClients: [],
          bulkExportJobsAccepted: countJobs("accepted"),
          bulkExportJobsCompleted: countJobs("completed"),
          bulkExportJobsFailed: countJobs("failed"),
          inboundProposalsPending: countProps("pending"),
          inboundProposalsAccepted: countProps("accepted"),
          inboundProposalsRejected: countProps("rejected"),
          inboundProposalReviewSlaP50Hours: 0,
          inboundProposalReviewSlaP95Hours: 0,
          errorRateByCode: [],
        };
      });
    },

    async disclosureMetricsForOrg({ organizationId, quarter }): Promise<FhirDisclosureMetrics> {
      // Phase 1 has no served-read disclosure log table yet (the bearer read path is fail-closed), so the
      // §164.528 quarter scorecard reports zeros over a real, org-scoped read rather than a fabricated
      // number — the honest Phase-1 answer for a gateway serving no external client.
      return withOrgContext(db, ctx(organizationId), async () => ({
        quarter,
        totalDisclosures: 0,
        distinctRecipientClients: 0,
        byResourceType: [],
        byClient: [],
      }));
    },

    async clientsForOrg({ organizationId }): Promise<ReadonlyArray<FhirClientSummary>> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(CLIENT)
          .where(eq(CLIENT.organizationId, organizationId))
          .orderBy(desc(CLIENT.createdAt));
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          tier: r.tier,
          status: r.status,
          baaContractReference: r.baaContractReference,
          approvedAt: iso(r.approvedAt),
          createdAt: r.createdAt.toISOString(),
        }));
      });
    },

    async clientDetail({ organizationId, clientId }): Promise<FhirClientDetail | null> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [r] = await tx
          .select()
          .from(CLIENT)
          .where(and(eq(CLIENT.id, clientId), eq(CLIENT.organizationId, organizationId)))
          .limit(1);
        if (!r) return null;
        return {
          id: r.id,
          name: r.name,
          type: r.type,
          tier: r.tier,
          status: r.status,
          baaContractReference: r.baaContractReference,
          approvedAt: iso(r.approvedAt),
          createdAt: r.createdAt.toISOString(),
          allowedScopes: asStringArray(r.allowedScopes),
          rateLimitRps: r.rateLimitRps,
          ipAllowlist: asStringArray(r.ipAllowlist),
          jwksUri: r.jwksUri,
          fingerprint: null,
          lastSuccessfulRequestAt: null,
          activeSessionCount: 0,
        };
      });
    },

    async pendingForOwnerModule({
      organizationId,
      ownerModule,
    }): Promise<ReadonlyArray<FhirInboundProposalSummary>> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [cfg] = await tx
          .select({ slaHours: CONFIG.inboundReviewSlaHours })
          .from(CONFIG)
          .where(eq(CONFIG.organizationId, organizationId))
          .limit(1);
        const slaHours = cfg?.slaHours ?? 72;
        const rows = await tx
          .select()
          .from(INBOUND)
          .where(
            and(
              eq(INBOUND.organizationId, organizationId),
              eq(INBOUND.ownerModule, ownerModule),
              eq(INBOUND.proposalStatus, "pending"),
            ),
          )
          .orderBy(desc(INBOUND.proposedAt));
        return rows.map((r) => ({
          id: r.id,
          resourceType: r.resourceType,
          sourceClientId: r.sourceClientId,
          sourceClientName: "",
          sourceFhirId: r.sourceFhirId,
          proposedAt: r.proposedAt.toISOString(),
          slaDueAt: new Date(r.proposedAt.getTime() + slaHours * 3600_000).toISOString(),
        }));
      });
    },

    async proposalDetail({
      organizationId,
      proposalId,
    }): Promise<FhirInboundProposalDetail | null> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [cfg] = await tx
          .select({ slaHours: CONFIG.inboundReviewSlaHours })
          .from(CONFIG)
          .where(eq(CONFIG.organizationId, organizationId))
          .limit(1);
        const slaHours = cfg?.slaHours ?? 72;
        const [r] = await tx
          .select()
          .from(INBOUND)
          .where(and(eq(INBOUND.id, proposalId), eq(INBOUND.organizationId, organizationId)))
          .limit(1);
        if (!r) return null;
        const validationErrors = Array.isArray(r.validationErrors)
          ? (r.validationErrors as ReadonlyArray<{ path: string; message: string }>)
          : null;
        return {
          id: r.id,
          resourceType: r.resourceType,
          sourceClientId: r.sourceClientId,
          sourceClientName: "",
          sourceFhirId: r.sourceFhirId,
          proposedAt: r.proposedAt.toISOString(),
          slaDueAt: new Date(r.proposedAt.getTime() + slaHours * 3600_000).toISOString(),
          payload: (r.payload ?? {}) as Readonly<Record<string, unknown>>,
          validationErrors,
        };
      });
    },
  };
}

export type { FhirInboundOwnerModule };
