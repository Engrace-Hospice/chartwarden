// apps/backend/src/modules/19-oncall/routes/vendor-session-reader-drizzle.ts — F-030 / #75.
//
// The one org-scoped read behind the vendor-session bind gate: the vendor's D13 posture and the tenant's
// D3 deployment model, in a single round trip.
//
// ORG-SCOPED IN SQL, not just in the caller. Both predicates carry `organization_id = :orgId`, so a
// vendor id belonging to another tenant is simply not found — which is why the route can answer 404 for
// absent and cross-tenant alike without leaking which it was. RLS is the floor underneath; this is the
// query-level twin, the `portal-session-store.ts` posture.
//
// The policy read is NOT keyed on a provider entity. `tenant_oncall_policy` is per (org, provider
// entity), and the question here is "has this TENANT engaged an outsourced model at all" — a vendor
// binding is org-wide, and narrowing it to one PE would refuse a legitimate bind for an agency whose
// outsourced coverage starts at a different entity. Any row naming an outsourced model answers yes.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, inArray } from "drizzle-orm";
import type { VendorBindingFacts, VendorSessionBindReader } from "./vendor-sessions.routes";

const OUTSOURCED = ["hybrid", "centralized"] as const;

export function buildDrizzleVendorSessionBindReader(db: DbClient): VendorSessionBindReader {
  const VENDOR = schema.externalTriageVendor;
  const POLICY = schema.tenantOncallPolicy;

  return {
    async loadBindingFacts({ organizationId, externalActorId }): Promise<VendorBindingFacts> {
      const vendorRows = await db
        .select({
          id: VENDOR.id,
          rnCoverageAttested: VENDOR.rnCoverageAttested,
          baaInEffect: VENDOR.baaInEffect,
          baaExpiresOn: VENDOR.baaExpiresOn,
        })
        .from(VENDOR)
        .where(and(eq(VENDOR.organizationId, organizationId), eq(VENDOR.id, externalActorId)))
        .limit(1);
      const vendor = vendorRows[0] ?? null;
      if (!vendor) return { vendor: null, model: null };

      const policyRows = await db
        .select({ model: POLICY.model })
        .from(POLICY)
        .where(
          and(eq(POLICY.organizationId, organizationId), inArray(POLICY.model, [...OUTSOURCED])),
        )
        .limit(1);

      return {
        vendor: {
          id: vendor.id,
          rnCoverageAttested: vendor.rnCoverageAttested,
          baaInEffect: vendor.baaInEffect,
          baaExpiresOn: vendor.baaExpiresOn ?? null,
        },
        // `direct` when no outsourced row exists: the gate refuses on anything that is not
        // hybrid/centralized, so a tenant with no policy row at all is refused rather than defaulted in.
        model: policyRows[0]?.model ?? "direct",
      };
    },
  };
}
