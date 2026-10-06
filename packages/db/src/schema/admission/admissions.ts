// @wardenx/db — `admission` (M6 §3.3). The episode root: one row per hospice episode for a patient.
// PHI-bearing → the three-column tenancy rule; here provider_entity_id + location_id are NOT NULL
// (an admission is always sited). The "one open admission per patient" invariant is a partial unique
// index. Cross-module refs (M5 patient/caregiver, M40 physicians) are plain uuid app-validated; the
// referral FK is intra-M6. RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { admissionStatus, physicianSignerCapacity } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { patientAddresses } from "../patient/patient-addresses";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { referrals } from "./referrals";

export const admissions = pgTable(
  "admission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Nullable at draft (M6L-T02): a referral-minted draft admission has no provider entity/location
    // assigned until the §7.2 admission wizard runs, before activation. See migration 0123.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientResidenceAddressId: uuid("patient_residence_address_id").references(
      () => patientAddresses.id,
      { onDelete: "restrict" },
    ),
    serviceAddressLine1: text("service_address_line1"),
    serviceAddressLine2: text("service_address_line2"),
    serviceAddressCity: text("service_address_city"),
    serviceAddressState: text("service_address_state"),
    serviceAddressPostalCode: text("service_address_postal_code"),
    serviceAddressCountry: text("service_address_country"),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    referralId: uuid("referral_id").references(() => referrals.id, { onDelete: "set null" }),
    status: admissionStatus("status").notNull().default("referred"),
    admissionAt: timestamp("admission_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    holdAt: timestamp("hold_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    holdReason: text("hold_reason"),
    dischargedAt: timestamp("discharged_at", { withTimezone: true }),
    admittedByPhysicianId: uuid("admitted_by_physician_id"), // M40 physician; nullable at draft (0123)
    hospicePhysicianId: uuid("hospice_physician_id"), // M40 physician selected to certify CTI (app-validated)
    attendingPhysicianId: uuid("attending_physician_id"), // M40 physician (app-validated)
    primaryCaregiverId: uuid("primary_caregiver_id"), // M5 caregiver (app-validated)
    transferredIn: boolean("transferred_in").notNull().default(false),
    transferredInFromCcn: text("transferred_in_from_ccn"),
    inheritedPeriodSequence: smallint("inherited_period_sequence"),
    // 42 CFR 418.25(a) (FY 2026 rule, effective 2025-10-01; migration 0389) — the physician admission
    // recommendation: a USER validated against the medical director / physician designee / patient-IDG
    // physician signer set, with the attending-consultation fact. All-or-none (CHECK); the note is scrubbed.
    recommendedByUserId: uuid("recommended_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    recommenderCapacity: physicianSignerCapacity("recommender_capacity"),
    recommendedAt: timestamp("recommended_at", { withTimezone: true }),
    attendingConsulted: boolean("attending_consulted"),
    attendingConsultNote: text("attending_consult_note"),
    recommendationRecordedByUserId: uuid("recommendation_recorded_by_user_id"), // acting user (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    // The "one open admission per patient" rule — partial unique.
    patientOpenIdx: uniqueIndex("admission_patient_open_idx")
      .on(t.organizationId, t.patientId)
      .where(sql`status NOT IN ('discharged','bereavement','closed')`),
    orgStatusAdmIdx: index("admission_org_status_idx").on(
      t.organizationId,
      t.status,
      t.admissionAt,
    ),
    peStatusIdx: index("admission_pe_status_idx").on(t.providerEntityId, t.status),
    patientResidenceAddressIdx: index("admission_patient_residence_address_idx").on(
      t.patientResidenceAddressId,
    ),
    hospicePhysicianIdx: index("admission_hospice_physician_idx").on(t.hospicePhysicianId),
    attendingIdx: index("admission_attending_idx").on(t.attendingPhysicianId),
    referralOnceIdx: uniqueIndex("admission_org_referral_once_uidx")
      .on(t.organizationId, t.referralId)
      .where(sql`referral_id IS NOT NULL`),
  }),
);

export type Admission = typeof admissions.$inferSelect;
export type NewAdmission = typeof admissions.$inferInsert;
