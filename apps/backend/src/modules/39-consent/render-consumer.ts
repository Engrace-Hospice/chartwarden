// M39 signed-consent → M22 render bridge. The outbox dispatcher owns retry/receipts: a renderer
// outage leaves the source event pending and never rewrites or un-signs the legally operative row.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../bootstrap/outbox-dispatcher";
import { renderConsentRecordDocument } from "./consumed-seams";

const CR = schema.consentRecord;
const CRR = schema.consentRecordRecipient;

function recordId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["consentRecordId", "newConsentRecordId"]) {
    if (typeof p[key] === "string") return p[key] as string;
  }
  return null;
}

export function buildM39ConsentRenderConsumer(db: DbClient): OutboxConsumerBinding {
  return {
    consumerName: "m22-consent-record-render",
    consumerModule: "m22",
    eventTypes: ["m39.consent.signed", "m39.consent.supersedes", "m39.consent.renewed"],
    async handle(event) {
      const consentId = recordId(event.payload);
      if (!consentId) throw new Error(`${event.eventType} has no consent record id`);
      const material = await withOrgContext(
        db,
        { organizationId: event.organizationId, userId: "" },
        async (tx) => {
          const row = (
            await tx
              .select()
              .from(CR)
              .where(and(eq(CR.organizationId, event.organizationId), eq(CR.id, consentId)))
              .limit(1)
          )[0];
          if (!row || !row.signedAt)
            throw new Error(`signed consent '${consentId}' is unavailable for rendering`);
          const recipients = await tx
            .select({
              kind: CRR.recipientKind,
              displayName: CRR.recipientResolvedDisplayName,
            })
            .from(CRR)
            .where(
              and(eq(CRR.organizationId, event.organizationId), eq(CRR.consentRecordId, consentId)),
            );
          return { row, recipients };
        },
      );

      await renderConsentRecordDocument(
        { orgId: event.organizationId },
        {
          aggregateId: material.row.id,
          consentRecordId: material.row.id,
          patientId: material.row.patientId,
          typeKey: material.row.typeKey,
          grantorKind: material.row.grantorKind,
          effectiveAt: material.row.effectiveAt.toISOString(),
          ...(material.row.expiresAt ? { expiresAt: material.row.expiresAt.toISOString() } : {}),
          recipients: material.recipients,
          ...(material.row.jurisdictionCode
            ? { jurisdictionCode: material.row.jurisdictionCode }
            : {}),
        },
      );
    },
  };
}
