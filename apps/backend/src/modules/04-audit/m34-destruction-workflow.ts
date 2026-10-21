import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";

/** M4-owned destruction-certificate/legal-hold adapter injected into M34 at the composition root. */
export function createM34DestructionWorkflow() {
  return {
    async authorizationFacts(
      tx: DbClient,
      input: { readonly orgId: string; readonly destructionCertId: string },
    ) {
      const [certificate] = await tx
        .select()
        .from(schema.destructionCertificates)
        .where(
          and(
            eq(schema.destructionCertificates.id, input.destructionCertId),
            eq(schema.destructionCertificates.organizationId, input.orgId),
          ),
        )
        .limit(1);
      const [hold] = await tx
        .select({ id: schema.legalHolds.id })
        .from(schema.legalHolds)
        .where(
          and(
            eq(schema.legalHolds.organizationId, input.orgId),
            eq(schema.legalHolds.status, "active"),
          ),
        )
        .limit(1);
      return {
        certificate: certificate
          ? {
              organizationId: certificate.organizationId,
              status: certificate.status,
              method: certificate.method,
              approvedBy: certificate.approvedBy,
            }
          : null,
        activeLegalHold: Boolean(hold),
      };
    },
    async recordCertificateRefusal(
      tx: DbClient,
      input: {
        readonly destructionCertId: string;
        readonly reason: "part_two_retention";
        readonly refusedRowsByModule: readonly unknown[];
      },
    ) {
      await tx
        .update(schema.destructionCertificates)
        .set({
          status: "partial_refused",
          refusalReason: input.reason,
          refusedRowsByModule: [...input.refusedRowsByModule],
        })
        .where(eq(schema.destructionCertificates.id, input.destructionCertId));
    },
    async fileCertificate(
      tx: DbClient,
      input: { readonly destructionCertId: string; readonly dekDestroyedAt: Date },
    ) {
      await tx
        .update(schema.destructionCertificates)
        .set({
          status: "executed",
          executedAt: input.dekDestroyedAt,
          dekDestroyedAt: input.dekDestroyedAt,
          refusalReason: null,
          refusedRowsByModule: [],
        })
        .where(eq(schema.destructionCertificates.id, input.destructionCertId));
    },
  };
}
