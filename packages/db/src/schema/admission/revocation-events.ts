// @wardenx/db — `revocation_event` (M6 §3.3). A beneficiary's revocation of the hospice election for
// a period (drives `m6.revocation.created`). Org-scoped (no direct patient identifier; tenancy via
// the admission FK). Cross-module refs (M39 representative consent, M22 document) are plain uuid
// app-validated; admission + election_period FKs are intra-M6. One revocation per period (unique).
// RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { bigint, date, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { electionSignerKind, revocationReason } from "../../enums";
import { organizations } from "../organizations";
import { admissions } from "./admissions";
import { electionPeriods } from "./election-periods";

// Registered business rules (Bug 4): a `23505` on these indexes — two writers racing past the service's
// own pre-check — answers 409 with this sentence instead of a bare 500 (the F-022 / #55 convention).
// Declared outside `pgTable`'s lazily-invoked config callback so the error handler can see them.
const REVOCATION_PERIOD_IDX = businessRule(
  "revocation_period_idx",
  "This benefit period has already been revoked.",
);

export const revocationEvents = pgTable(
  "revocation_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    electionPeriodId: uuid("election_period_id")
      .notNull()
      .references(() => electionPeriods.id, { onDelete: "restrict" }),
    signerKind: electionSignerKind("signer_kind").notNull(),
    representativeConsentId: uuid("representative_consent_id"), // M39 consent (app-validated)
    effectiveAt: date("effective_at").notNull(),
    signedAt: date("signed_at").notNull(),
    revocationReason: revocationReason("revocation_reason").notNull(),
    narrative: text("narrative"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    periodUnique: uniqueIndex(REVOCATION_PERIOD_IDX).on(t.electionPeriodId),
  }),
);

export type RevocationEvent = typeof revocationEvents.$inferSelect;
export type NewRevocationEvent = typeof revocationEvents.$inferInsert;
