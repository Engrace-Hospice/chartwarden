// @chartwarden/db -- `patient_wristband` (M5; GAP-020, migration 0850). One row per wristband GENERATION.
//
// A wristband encodes an opaque random token (`@chartwarden/types` wristband codec) -- never an MRN or a name. Only
// `payload_digest = sha256("wx.wristband.v1|" || organization_id || "|" || token)` is stored: the raw token is
// shown once at print time and is not recoverable, so a database leak is not a set of scannable bands.
// Printing again supersedes the previous generation in the same transaction (a lost or reprinted band is dead the
// moment its replacement exists); `voided_at` is a hard kill (identity error, merge, death, compromise) that
// never validates, even for an offline scan. At most one ACTIVE generation per patient (partial unique index).
// PHI-adjacent identity material: three-column tenancy, ENABLE+FORCE RLS, M4 write-audit trigger with
// `payload_digest` scrubbed. The app role cannot DELETE; only the M5 destruction eraser (destruction connection, under a certificate) does.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientWristbands = pgTable(
  "patient_wristband",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    generation: integer("generation").notNull(),
    payloadDigest: text("payload_digest").notNull(), // DENYLISTED (audit scrub)
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    issuedByUserId: uuid("issued_by_user_id").notNull(), // logical FK (no cross-module FK)
    issueReason: text("issue_reason").notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id"),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    generationUq: uniqueIndex("patient_wristband_generation_uq").on(
      t.organizationId,
      t.patientId,
      t.generation,
    ),
    digestUq: uniqueIndex("patient_wristband_digest_uq").on(t.organizationId, t.payloadDigest),
    activeUq: uniqueIndex("patient_wristband_active_uq")
      .on(t.organizationId, t.patientId)
      .where(sql`${t.supersededAt} IS NULL AND ${t.voidedAt} IS NULL`),
    patientIdx: index("patient_wristband_patient_idx").on(t.organizationId, t.patientId),
    patientFkIdx: index("patient_wristband_patient_id_idx").on(t.patientId), // 1073: covers the patient FK
    digestShape: check("patient_wristband_digest_chk", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    issueReasonChk: check(
      "patient_wristband_issue_reason_chk",
      sql`${t.issueReason} IN ('first_issue','reprint_lost','reprint_damaged','reprint_other','identity_correction')`,
    ),
    voidShape: check(
      "patient_wristband_void_shape_chk",
      sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
    ),
    voidReasonChk: check(
      "patient_wristband_void_reason_chk",
      sql`${t.voidReason} IS NULL OR ${t.voidReason} IN ('identity_error','patient_merged','patient_deceased','compromised')`,
    ),
    supersededOrder: check(
      "patient_wristband_superseded_order_chk",
      sql`${t.supersededAt} IS NULL OR ${t.supersededAt} >= ${t.issuedAt}`,
    ),
  }),
);

export type PatientWristband = typeof patientWristbands.$inferSelect;
export type NewPatientWristband = typeof patientWristbands.$inferInsert;
