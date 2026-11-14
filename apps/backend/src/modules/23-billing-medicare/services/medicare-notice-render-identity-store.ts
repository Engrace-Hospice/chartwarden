import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { SubmissionAttemptStore } from "@chartwarden/x12-837-client";
import { and, eq } from "drizzle-orm";
import {
  type MedicareNoticeRenderIdentity,
  type MedicareNoticeRenderIdentityStore,
  type MedicareNoticeRenderReservation,
  MedicareNoticeRenderHold,
} from "./medicare-notice-renderer";

/** Durable store: allocates ISA13/time via the existing platform-unique memo and immutably binds them to the attempt. */
export function buildDrizzleMedicareNoticeRenderIdentityStore(
  db: DbClient,
  attempts: SubmissionAttemptStore,
): MedicareNoticeRenderIdentityStore {
  const table = schema.medicareNoticeRenderIdentity;
  return {
    async reserve({ identity, fingerprint }): Promise<MedicareNoticeRenderReservation> {
      const memo = await attempts.allocateInterchangeNumber(
        identity.organizationId,
        `m23-notice:${identity.kind}:${identity.providerEntityId}`,
        identity.submissionId,
        identity.usage,
      );
      const isa13 = memo.number.padStart(9, "0");
      return withOrgContext(db, { organizationId: identity.organizationId, userId: "" }, async (tx) => {
        await tx.insert(table).values({
          organizationId: identity.organizationId,
          noticeId: identity.noticeId,
          submissionId: identity.submissionId,
          noticeKind: identity.kind,
          relatedSourceId: identity.relatedSourceId,
          providerEntityId: identity.providerEntityId,
          jurisdiction: identity.jurisdiction,
          vendor: identity.vendor,
          accountReference: identity.accountReference,
          usage: identity.usage,
          routeFingerprint: identity.routeFingerprint,
          sourceVersion: identity.sourceVersion,
          mapperVersion: identity.mapperVersion,
          controlNumber: identity.controlNumber,
          fingerprint,
          isa13,
          renderedAt: memo.renderedAt,
        }).onConflictDoNothing();
        const rows = await tx.select().from(table).where(and(
          eq(table.organizationId, identity.organizationId),
          eq(table.submissionId, identity.submissionId),
        )).limit(2);
        const row = rows[0];
        if (!row || rows.length !== 1) throw new MedicareNoticeRenderHold("NOTICE_RENDER_IDENTITY_UNAVAILABLE");
        const rowMatches = row.noticeId === identity.noticeId && row.noticeKind === identity.kind &&
          row.relatedSourceId === identity.relatedSourceId && row.providerEntityId === identity.providerEntityId &&
          row.jurisdiction === identity.jurisdiction && row.vendor === identity.vendor &&
          row.accountReference === identity.accountReference && row.usage === identity.usage &&
          row.routeFingerprint === identity.routeFingerprint && row.sourceVersion === identity.sourceVersion &&
          row.mapperVersion === identity.mapperVersion && row.controlNumber === identity.controlNumber;
        if (!rowMatches) throw new MedicareNoticeRenderHold("NOTICE_IDENTITY_CHANGED");
        return {
          identity,
          fingerprint: row.fingerprint,
          interchangeNumber: Number(row.isa13),
          renderedAt: row.renderedAt,
        };
      });
    },
  };
}
