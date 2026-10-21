// @chartwarden/db — `order_signature` (M11 §3.3 / §2.5). The polymorphic signature ledger (D4): one row per
// signature / cosignature / verbal_attestation against either an `order_record` or an M12
// `medication_order` (the `target_kind` discriminator routes the app layer; it is NOT a security boundary
// — both targets live under the same org RLS scope, §3.6). There is NO SQL FK across the discriminator;
// `target_id` is resolved by the service. PHI-bearing → the three-column tenancy rule. Non-partitioned
// (§3.7). The §3.4 signature-apply trigger flips the linked order to `active` when a primary signature
// lands and cosign prerequisites are met. Actor refs go to M1 `membership`. RLS + grants + M4 write-audit
// trigger (attestation_text / on_behalf_reason denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orderSignatureKind, orderSignatureTargetKind } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const orderSignatures = pgTable(
  "order_signature",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0131 (M11L): denormalized siting backfills from the signed order/admission.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    // Polymorphic target (D4) — NO SQL FK across discriminator.
    targetKind: orderSignatureTargetKind("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),

    signatureKind: orderSignatureKind("signature_kind").notNull(),
    signerMembershipId: uuid("signer_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    signerDiscipline: text("signer_discipline").notNull(),
    cosignerRole: text("cosigner_role"),
    onBehalfOfMembershipId: uuid("on_behalf_of_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    onBehalfReason: text("on_behalf_reason"), // denylisted
    attestationText: text("attestation_text"), // denylisted
    signatureContext: jsonb("signature_context").notNull().default(sql`'{}'::jsonb`),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetSignatureUq: uniqueIndex("order_signature_target_signature_uq")
      .on(t.targetKind, t.targetId)
      .where(sql`signature_kind = 'signature'`),
    byTarget: index("order_signature_target_idx").on(t.targetKind, t.targetId),
    bySigner: index("order_signature_signer_idx").on(
      t.organizationId,
      t.signerMembershipId,
      t.signedAt,
    ),
  }),
);

export type OrderSignature = typeof orderSignatures.$inferSelect;
export type NewOrderSignature = typeof orderSignatures.$inferInsert;
