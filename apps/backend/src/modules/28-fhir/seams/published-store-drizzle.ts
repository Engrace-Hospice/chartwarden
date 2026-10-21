// apps/backend/src/modules/28-fhir/seams/published-store-drizzle.ts — M28-T08 the Drizzle store the §4.3
// published seams read through (`FhirGatewayMetricsProvider` / `FhirClientReader` / `FhirInboundProposalReader`).
//
// Every read self-scopes to the caller's AMBIENT org context (HARD RULE 3): a seam consumer (M33 / M30 /
// M34 / M5 / M12) reaches these under its OWN org context, so the store opens `withOrgContext` on the
// `organizationId` argument (asserted against the scope, never used to select across tenants) and RLS is
// the backstop. Metrics are aggregate COUNTS only — NO PHI leaves through this surface.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  FhirClientDetail,
  FhirClientSummary,
  FhirDisclosureMetrics,
  FhirGatewayMetrics,
  FhirInboundOwnerModule,
  FhirInboundProposalDetail,
  FhirInboundProposalSummary,
} from "@chartwarden/types";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";

import type { FhirPublishedSeamStore } from "./published";

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * `YYYY-Qn` → the half-open instant range `[from, to)` for the §164.528 quarter scorecard. Half-open on
 * purpose: a closed upper bound either double-counts a disclosure served exactly at midnight on the
 * boundary or loses it, depending on which quarter you ask about first.
 */
function quarterRange(quarter: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3;
  return {
    from: new Date(Date.UTC(year, startMonth, 1)),
    to: new Date(Date.UTC(year, startMonth + 3, 1)),
  };
}

export function createDrizzleFhirPublishedSeamStore(db: DbClient): FhirPublishedSeamStore {
  const CLIENT = schema.fhirClient;
  const JOB = schema.fhirBulkExportJob;
  const INBOUND = schema.fhirInboundResource;
  const CONFIG = schema.tenantFhirConfig;
  const DISCLOSURE = schema.fhirReadDisclosure;

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
      // §164.528 over the real `fhir_read_disclosure` ledger (F-035, migration 0233). This used to
      // return hard zeros, correctly: the bearer read path served nothing, so there was no disclosure to
      // account for. Binding the read path (#95) made that same answer a false compliance statement, so
      // the ledger and this reader landed together — a gateway that discloses PHI while its accounting
      // says zero is worse than one that discloses nothing.
      const range = quarterRange(quarter);
      if (range === null) {
        // An unparseable quarter is a caller error, not an empty quarter. Refusing beats answering zero:
        // "no disclosures in 2026-Q9" and "2026-Q9 is not a quarter" must not look alike to a scorecard.
        throw new Error(`FHIR disclosure metrics: '${quarter}' is not a YYYY-Qn quarter`);
      }
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select({
            fhirClientId: DISCLOSURE.fhirClientId,
            resourceType: DISCLOSURE.resourceType,
          })
          .from(DISCLOSURE)
          .where(
            and(
              eq(DISCLOSURE.organizationId, organizationId),
              gte(DISCLOSURE.servedAt, range.from),
              lt(DISCLOSURE.servedAt, range.to),
            ),
          );
        const byResource = new Map<string, number>();
        const byClientId = new Map<string, number>();
        for (const r of rows) {
          byResource.set(r.resourceType, (byResource.get(r.resourceType) ?? 0) + 1);
          byClientId.set(r.fhirClientId, (byClientId.get(r.fhirClientId) ?? 0) + 1);
        }
        // The client NAME and BAA reference come from `fhir_client`, which a revoked-and-erased partner
        // may no longer have (the ledger deliberately outlives its client — 0233). An unresolvable id
        // still reports its disclosures, under its id, rather than dropping the row: an accounting that
        // silently omits the disclosures of a deleted recipient is not an accounting.
        const clientRows =
          byClientId.size === 0
            ? []
            : await tx
                .select({
                  id: CLIENT.id,
                  name: CLIENT.name,
                  baaContractReference: CLIENT.baaContractReference,
                })
                .from(CLIENT)
                .where(
                  and(
                    eq(CLIENT.organizationId, organizationId),
                    inArray(CLIENT.id, [...byClientId.keys()]),
                  ),
                );
        const clientById = new Map(clientRows.map((c) => [c.id, c]));
        return {
          quarter,
          totalDisclosures: rows.length,
          distinctRecipientClients: byClientId.size,
          byResourceType: [...byResource.entries()]
            .map(([resourceType, disclosures]) => ({ resourceType, disclosures }))
            .sort(
              (a, b) =>
                b.disclosures - a.disclosures || a.resourceType.localeCompare(b.resourceType),
            ),
          byClient: [...byClientId.entries()]
            .map(([clientId, disclosures]) => ({
              clientId,
              clientName: clientById.get(clientId)?.name ?? "(client no longer registered)",
              baaReference: clientById.get(clientId)?.baaContractReference ?? "",
              disclosures,
            }))
            .sort((a, b) => b.disclosures - a.disclosures || a.clientId.localeCompare(b.clientId)),
        };
      });
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
