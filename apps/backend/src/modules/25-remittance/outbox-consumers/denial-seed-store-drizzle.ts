// apps/backend/src/modules/25-remittance/outbox-consumers/denial-seed-store-drizzle.ts — the first real
// implementation of `DenialSeedStore` (F-153/F-156, #248). Nothing implemented this port before: the two
// consumer functions (`handleClaimRejected`/`handleEvvAggregatorRejected`, consumers/handlers.ts) have been
// complete and unit-tested since M25-T0x, but every test drove them over an in-memory fake — this is the
// Drizzle binding the composition root needs to actually wire `m23.claim.rejected` /
// `m18.evv.aggregator_rejected` to a real `denial_case` row.
//
// `seedDenial`'s idempotency is a real database constraint as of migration 0249
// (`denial_case_source_idempotency_key_uq`, `(organization_id, source_idempotency_key)`, NULLS DISTINCT so
// every `remittance_adjustment`-sourced row — which never sets this column — coexists freely): the INSERT
// conditions on it via `.onConflictDoNothing()` (the `elevated-approvals.ts` grant() / M33
// `report_definition_system_org_base_uq` precedent), and a lost race or a genuine redelivery re-selects the
// existing row by the same key rather than fabricating a second worklist entry.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { DenialSeedStore } from "../consumers/handlers";

const DC = schema.denialCase;
const AC = schema.appealCase;

type DenialCategoryDbValue = (typeof DC.category.enumValues)[number];
type DenialSourceDbValue = (typeof DC.source.enumValues)[number];
type TaxonomyStatusDbValue = (typeof DC.taxonomyStatus.enumValues)[number];

/** Build the live {@link DenialSeedStore} over the real `denial_case` / `appeal_case` tables, RLS-scoped
 *  per call via `withOrgContext` — the `cost-report-seams.ts` / `claim-match-adapter.ts` shape. */
export function buildDrizzleDenialSeedStore(db: DbClient): DenialSeedStore {
  return {
    async seedDenial(input) {
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const [inserted] = await tx
          .insert(DC)
          .values({
            organizationId: input.organizationId,
            providerEntityId: input.providerEntityId,
            claimId: input.claimId,
            sourceEvvAggregatorSubmissionId: input.sourceEvvAggregatorSubmissionId,
            carcCode: input.carcCode,
            rarcCode: input.rarcCode,
            category: input.category as DenialCategoryDbValue,
            taxonomyStatus: input.taxonomyStatus as TaxonomyStatusDbValue,
            source: input.source as DenialSourceDbValue,
            dollarValue: input.dollarValue,
            sourceIdempotencyKey: input.idempotencyKey,
          })
          .onConflictDoNothing()
          .returning({ id: DC.id });
        if (inserted) return { denialCaseId: inserted.id, created: true };

        // Lost a race against a concurrent delivery, or this is a genuine redelivery of an already-seeded
        // event — the row already exists under the same (org, idempotencyKey). Re-select rather than throw:
        // "already seeded" is a successful outcome for an idempotent seed, not a failure.
        const [existing] = await tx
          .select({ id: DC.id })
          .from(DC)
          .where(
            and(
              eq(DC.organizationId, input.organizationId),
              eq(DC.sourceIdempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (!existing) {
          // The constraint and this SELECT have drifted — refuse rather than guess at an id.
          throw new Error(
            `m25.denial-seed-store: onConflictDoNothing() reported a conflict but no row matches ` +
              `idempotencyKey=${input.idempotencyKey} for org ${input.organizationId}`,
          );
        }
        return { denialCaseId: existing.id, created: false };
      });
    },

    // m22.document.rendered → back-reference (NOT one of this pass's two target events — m23.claim.rejected
    // / m18.evv.aggregator_rejected — implemented here only because DenialSeedStore is one interface).
    // `appeal_case.appeal_packet_document_id` is a real column (M22 back-ref); `denial_case` carries NO
    // document-reference column at all (checked against the schema, not assumed — every `denial_case`
    // column is listed in packages/db/src/schema/remittance/denial.ts and none of them is one), so the
    // header comment's "denial_case.resolution_letter ref" is aspirational, not built. A `denial_case`
    // aggregate honestly no-ops (`updated: false`) rather than writing to a column that does not exist.
    async backrefDocument(input) {
      if (input.aggregateType === "denial_case") {
        return { updated: false };
      }
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const [updated] = await tx
          .update(AC)
          .set({ appealPacketDocumentId: input.documentId })
          .where(and(eq(AC.organizationId, input.organizationId), eq(AC.id, input.aggregateId)))
          .returning({ id: AC.id });
        return { updated: Boolean(updated) };
      });
    },
  };
}
