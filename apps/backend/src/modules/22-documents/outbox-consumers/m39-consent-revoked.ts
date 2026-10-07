// apps/backend/src/modules/22-documents/outbox-consumers/m39-consent-revoked.ts — M22's leg of the M39 §2.2.3
// revocation cascade (GAP-171). Subscribes to `m39.consent.revoked`, applies the one persistent effect M22 has,
// and ACKs the cascade so it can complete.
//
// WHAT M22 ACTUALLY HAS TO DO. Documents are never served from a long-lived URL: every signed-URL MINT re-checks
// consent through the ConsentEvaluator seam (F-197 — a PULL at mint time), so there is no cached disclosure state to
// purge for `42_cfr_part_2_release` / `hipaa_release`. The one PUSH-able state is `document.disclosure_restricted`
// (schema comment: "set true when a media_release consent is revoked"): on `media_release` revocation every
// disclosure-attached document of the patient is flagged restricted so it stops riding outbound disclosures.
// Every other consent type needs no M22 write — the ACK then attests exactly that ("the pull path is live and no
// push state exists"), which is what the cascade ledger needs to be able to say "M22 is done".
//
// TENANT from the envelope, never the payload. IDEMPOTENT: the UPDATE only touches rows not yet restricted, so a
// redelivery matches nothing, and the ACK is idempotent. The ACK runs AFTER the write commits; a throw fails the
// delivery so the outbox retries (at-least-once, exactly the cascade's contract).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const DOC = schema.documents;

export const M22_CONSENT_REVOKED_CONSUMER = {
  eventName: "m39.consent.revoked",
  consumerName: "m22.m39-consent-revoked",
} as const;

/** Consent types whose revocation restricts the patient's disclosure-attached documents. */
export const M22_DISCLOSURE_RESTRICTING_TYPES: readonly string[] = ["media_release"];

export interface M22ConsentRevokedDeps {
  readonly db: DbClient;
  /** Records M22's `m22_documents` ACK on M39's cascade (the composition root binds `recordCascadeAckForOrg`). */
  readonly ackCascade: (input: {
    readonly organizationId: string;
    readonly consentRecordId: string;
  }) => Promise<unknown>;
}

interface RevokedFacts {
  readonly consentRecordId: string;
  readonly patientId: string | null;
  readonly typeKey: string;
}

function factsOf(payload: unknown): RevokedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const consentRecordId = p.consentRecordId;
  if (typeof consentRecordId !== "string" || consentRecordId.length === 0) {
    throw new Error(`${M22_CONSENT_REVOKED_CONSUMER.consumerName}: payload has no consentRecordId`);
  }
  return {
    consentRecordId,
    patientId: typeof p.patientId === "string" && p.patientId.length > 0 ? p.patientId : null,
    typeKey: typeof p.typeKey === "string" ? p.typeKey : "",
  };
}

export function buildM22ConsentRevokedConsumer(deps: M22ConsentRevokedDeps) {
  return {
    consumerName: M22_CONSENT_REVOKED_CONSUMER.consumerName,
    consumerModule: "m22" as const,
    eventTypes: [M22_CONSENT_REVOKED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;
      if (M22_DISCLOSURE_RESTRICTING_TYPES.includes(facts.typeKey) && facts.patientId !== null) {
        const patientId = facts.patientId;
        await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
          const tx = scoped as unknown as DbClient;
          await tx
            .update(DOC)
            .set({ disclosureRestricted: true, updatedAt: new Date() })
            .where(
              and(
                eq(DOC.organizationId, organizationId),
                eq(DOC.patientId, patientId),
                eq(DOC.attachToDisclosures, true),
                eq(DOC.disclosureRestricted, false),
              ),
            );
        });
      }
      await deps.ackCascade({ organizationId, consentRecordId: facts.consentRecordId });
    },
  };
}
