import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23MacJurisdiction } from "./types";

/** Claim.MD Medicare route is non-secret; payerId is the canonical M40 payer UUID. Dates are inclusive. */
export const claimmdMedicarePayerRoute = pgTable(
  "claimmd_medicare_payer_route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical M40 provider ref, validated in service
    payerId: uuid("payer_id").notNull(), // logical canonical M40 payer ref
    macJurisdiction: m23MacJurisdiction("mac_jurisdiction").notNull(),
    accountReference: text("account_reference").notNull(), // stable identity, never a credential
    usage: text("usage").notNull(),
    externalPayerId: text("external_payer_id").notNull(), // text preserves leading zeroes
    transactionType: text("transaction_type").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: text("status").notNull().default("active"),
    provenance: text("provenance").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookup: index("claimmd_medicare_route_lookup_idx").on(
      t.organizationId,
      t.providerEntityId,
      t.payerId,
      t.accountReference,
      t.usage,
      t.transactionType,
      t.effectiveFrom,
    ),
  }),
);

/** Verification is explicit evidence, not implied by the existence of a route or a working API key. */
export const claimmdMedicarePayerEnrollment = pgTable(
  "claimmd_medicare_payer_enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    payerId: uuid("payer_id").notNull(),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").notNull(),
    transactionType: text("transaction_type").notNull(),
    status: text("status").notNull(),
    verificationSource: text("verification_source"),
    verificationRef: text("verification_ref"),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookup: index("claimmd_medicare_enrollment_lookup_idx").on(
      t.organizationId,
      t.providerEntityId,
      t.payerId,
      t.accountReference,
      t.usage,
      t.transactionType,
      t.effectiveFrom,
    ),
  }),
);

export const CLAIMMD_MEDICARE_TRANSACTION = "837i" as const;
export const CLAIMMD_MEDICARE_ROUTE_DATE_POLICY = "inclusive" as const;
