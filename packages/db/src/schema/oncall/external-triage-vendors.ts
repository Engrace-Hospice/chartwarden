// @wardenx/db — `external_triage_vendor` (M19 §3.3). D13 / ADR-0026: the tenant's BINDING to an external
// after-hours triage vendor for the Hybrid and Centralized models. Org-scoped CONFIGURATION — the canonical
// vendor ENTITY is M40's (`mdm_vendor_id`, a logical uuid resolved through M40's reader), so a vendor is
// not re-keyed per tenant; what lives here is this tenant's own attestation, adapter selection and
// minimization profile for it.
//
// M19 MINTS NO TOKENS (ADR-0026): a vendor operator authenticates through Better Auth's
// `external_triage_vendor` session class (org + vendor + shift scoped, MFA). There is deliberately no
// secret, api_key or token column on this table — the absence is the control.
//
// NO `baa_in_effect ⇒ baa_expires_on IS NOT NULL` CHECK, on purpose. `@wardenx/triage-vendors`'
// `assertVendorBindingActive` (M19-T01, already published) types `baaExpiresOn` as `string | null` and
// documents null as "the BAA has no stated expiry" — a NOT NULL pairing here would make a legitimately
// perpetual BAA unwritable and would contradict a contract that is already locked. The gate that matters
// runs at binding-creation AND at every handoff, in that function.
import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";

export const externalTriageVendor = pgTable(
  "external_triage_vendor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    /** M40 canonical vendor entity — LOGICAL uuid, validated through M40's `VendorReader` at write. */
    mdmVendorId: uuid("mdm_vendor_id").notNull(),
    name: text("name").notNull(),
    /** Selects the `@wardenx/triage-vendors` adapter (§8.5 / architecture §25.14 adapter mandate). */
    adapterKey: text("adapter_key").notNull(),

    /** D13 — the tenant attests the vendor staffs RNs on the covered nights. */
    rnCoverageAttested: boolean("rn_coverage_attested").notNull().default(false),
    /** D13 — BAA on file. NULL `baa_expires_on` means "no stated expiry", not "unknown". */
    baaInEffect: boolean("baa_in_effect").notNull().default(false),
    baaExpiresOn: timestamp("baa_expires_on", { withTimezone: true, mode: "date" }),

    /** §7.10 — the minimization profile every outbound handoff is filtered through. */
    defaultMinimizationPolicy: jsonb("default_minimization_policy").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgAdapterUq: uniqueIndex("external_triage_vendor_org_adapter_uq").on(
      t.organizationId,
      t.adapterKey,
    ),
    // A binding whose adapter key is empty resolves to no adapter at all and would fail at 2 a.m. rather
    // than at configuration time.
    adapterKeyPresent: check(
      "m19_external_triage_vendor_adapter_key",
      sql`length(btrim("adapter_key")) > 0`,
    ),
  }),
);

export type ExternalTriageVendorRow = typeof externalTriageVendor.$inferSelect;
export type NewExternalTriageVendorRow = typeof externalTriageVendor.$inferInsert;
