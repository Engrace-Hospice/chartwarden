// Production persistence and routing adapters for the internal Medicare notice renderer.
// These adapters read under app.org_id and deliberately expose no transport or MAC-portal capability.
import { createHash } from "node:crypto";
import { repositories } from "@chartwarden/billing";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { resolveMedicareProviderRouting } from "./medicare-provider-routing";
import {
  type MedicareNoticePersistencePort,
  type MedicareNoticeRoutePort,
} from "./medicare-notice-source-loader";
import { MedicareNoticeRenderHold } from "./medicare-notice-renderer";

type Binding = { readonly vendor: string | null; readonly account?: "tenant" };
const claimMdEnrollmentReady = (status: string | null, count: number): boolean =>
  count === 1 && (status === "verified" || status === "not_required");

export function buildDrizzleMedicareNoticePersistence(
  db: DbClient,
): MedicareNoticePersistencePort {
  const scoped = <T>(organizationId: string, read: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => read(tx as DbClient));
  return {
    noeById: (organizationId, id) => scoped(organizationId, async (tx) => {
      const row = await new repositories.NoeRepository(tx).findById(id);
      return row?.organizationId === organizationId ? row : null;
    }),
    notrById: (organizationId, id) => scoped(organizationId, async (tx) => {
      const row = await new repositories.NotrRepository(tx).findById(id);
      return row?.organizationId === organizationId ? row : null;
    }),
    transferById: (organizationId, id) => scoped(organizationId, async (tx) => {
      const row = await new repositories.TransferNoticeRepository(tx).findById(id);
      return row?.organizationId === organizationId ? row : null;
    }),
    submissionById: (organizationId, id) => scoped(organizationId, async (tx) => {
      const row = await new repositories.ClaimSubmissionRepository(tx).findById(id);
      return row?.organizationId === organizationId ? row : null;
    }),
    finalClaimFiledForAdmission: (organizationId, admissionId, throughDate) =>
      scoped(organizationId, async (tx) => {
        const rows = await tx.select({ id: schema.claim.id }).from(schema.claim).where(and(
          eq(schema.claim.organizationId, organizationId),
          eq(schema.claim.admissionId, admissionId),
          eq(schema.claim.tob, "814"),
          eq(schema.claim.serviceTo, throughDate),
          inArray(schema.claim.state, [
            "SUBMITTED", "ACK_PENDING", "ACK_ACCEPTED", "ACK_PARTIAL", "PAID", "PARTIAL_PAID", "DENIED",
          ]),
        )).limit(1);
        return rows.length === 1;
      }),
  };
}

export function buildDrizzleMedicareNoticeRoutePort(deps: {
  readonly db: DbClient;
  readonly bindingForOrg: (organizationId: string) => Promise<Binding>;
  readonly usageForOrg: (organizationId: string) => Promise<ClearinghouseContext["usage"]>;
  readonly accountReferenceFor: (
    organizationId: string,
    binding: Binding,
  ) => Promise<string>;
  readonly coveragePayerFacts: (input: {
    organizationId: string;
    patientId: string;
    patientPayerId: string;
  }) => Promise<{ payerId: string; coverageKind: string; effectiveFrom: string; effectiveTo: string | null } | null>;
  readonly activeMedicarePayerById: (
    tx: DbClient,
    payerId: string,
  ) => Promise<{ id: string; x12PayerId: string | null; updatedAt: Date } | null>;
}): MedicareNoticeRoutePort {
  return {
    async resolve(input) {
      const binding = await deps.bindingForOrg(input.organizationId);
      if (binding.vendor !== "claimmd" && binding.vendor !== "stedi" && binding.vendor !== "direct_mac") {
        throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "clearinghouse.binding");
      }
      const vendor = binding.vendor;
      const usage = await deps.usageForOrg(input.organizationId);
      const accountReference = await deps.accountReferenceFor(input.organizationId, binding);
      if (!accountReference.trim()) {
        throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "clearinghouse.accountReference");
      }
      const routing = await resolveMedicareProviderRouting(deps.db, {
        organizationId: input.organizationId,
        providerEntityId: input.providerEntityId,
        effectiveDate: input.effectiveDate,
      });
      const coverage = await deps.coveragePayerFacts(input);
      if (
        !coverage || coverage.coverageKind !== "medicare_ffs" ||
        coverage.effectiveFrom > input.effectiveDate ||
        (coverage.effectiveTo !== null && coverage.effectiveTo < input.effectiveDate)
      ) {
        throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "payer.coverage");
      }
      return withOrgContext(deps.db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const payer = await deps.activeMedicarePayerById(tx as DbClient, coverage.payerId);
        if (!payer) throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "payer.canonical");
        let payerId = payer.x12PayerId?.trim() ?? "";
        let routeId = `canonical:${payer.id}`;
        let enrollmentId = "not-applicable";
        if (vendor === "claimmd") {
          const R = schema.claimmdMedicarePayerRoute;
          const routes = await tx.select().from(R).where(and(
            eq(R.organizationId, input.organizationId),
            eq(R.providerEntityId, input.providerEntityId),
            eq(R.payerId, payer.id),
            eq(R.macJurisdiction, routing.macJurisdiction),
            eq(R.accountReference, accountReference),
            eq(R.usage, usage),
            eq(R.transactionType, "837i"),
            eq(R.status, "active"),
            lte(R.effectiveFrom, input.effectiveDate),
            or(isNull(R.effectiveTo), gte(R.effectiveTo, input.effectiveDate)),
          )).limit(2);
          if (routes.length !== 1 || !routes[0]) {
            throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "payer.claimmdRoute");
          }
          const E = schema.claimmdMedicarePayerEnrollment;
          const enrollments = await tx.select().from(E).where(and(
            eq(E.organizationId, input.organizationId),
            eq(E.providerEntityId, input.providerEntityId),
            eq(E.payerId, payer.id),
            eq(E.accountReference, accountReference),
            eq(E.usage, usage),
            eq(E.transactionType, "837i"),
            lte(E.effectiveFrom, input.effectiveDate),
            or(isNull(E.effectiveTo), gte(E.effectiveTo, input.effectiveDate)),
          )).limit(2);
          if (!claimMdEnrollmentReady(enrollments[0]?.status ?? null, enrollments.length)) {
            throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "payer.claimmdEnrollment");
          }
          payerId = routes[0].externalPayerId;
          routeId = routes[0].id;
          enrollmentId = enrollments[0]!.id;
        }
        if (!payerId) throw new MedicareNoticeRenderHold("NOTICE_ROUTE_NOT_READY", "payer.externalId");
        return {
          jurisdiction: routing.macJurisdiction,
          vendor,
          accountReference,
          usage,
          payerId,
          canonicalPayerId: payer.id,
          // CM-4B.2 must verify notice support independently. An 837I claim route never proves notice support.
          transactionSupportVerified: false,
          routeFingerprint: createHash("sha256").update(JSON.stringify({
            providerEntityId: input.providerEntityId,
            jurisdiction: routing.macJurisdiction,
            payerId: payer.id,
            payerUpdatedAt: payer.updatedAt,
            routeId,
            enrollmentId,
            vendor,
            accountReference,
            usage,
            transaction: input.transaction,
          })).digest("hex"),
        };
      });
    },
  };
}
