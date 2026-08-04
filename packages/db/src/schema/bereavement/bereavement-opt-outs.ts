// @wardenx/db — `bereavement_opt_out` (M16 §3.3.8). D9's second level: the per-contact, post-creation
// opt-out. (The FIRST level is M5's patient-level `bereavement_opt_out` flag, which prevents the plan from
// ever being created — that one lives in M5, not here.)
//
// Only `full` closes the contact; `channel_specific` restricts modalities and `pause_temporarily` suspends
// without closing — which is why the partial unique index is scoped to `opt_out_kind = 'full'`: a survivor
// may legitimately hold several live channel-specific restrictions at once, but never two active full
// opt-outs. `rescinded_at` is the 90-day portal self-service undo window; re-enrollment past that is a
// counselor action with fresh M39 consent (D9 — no accidental un-opt-out via a portal click).
//
// `source_kind` includes `m39_revocation_cascade`: when M39 emits `m39.consent.revoked` for a
// `bereavement_outreach_consent` record, M16 CASCADES (§2.6) — it does not gate-keep. M39 is the truth.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// CROSS-MODULE FK POLICY: org/PE/location + the intra-M16 contact parent carry real FKs; plan_id is
// denormalized for the plan-level "have all contacts opted out?" rollup, and the membership ids are logical.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bereavementOptOutKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavedContact } from "./bereaved-contacts";
import { bereavementPlan } from "./bereavement-plans";

export const bereavementOptOut = pgTable(
  "bereavement_opt_out",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }), // denormalized for the plan rollup

    optOutKind: bereavementOptOutKind("opt_out_kind").notNull(),
    channelKinds: jsonb("channel_kinds"), // required iff opt_out_kind = 'channel_specific'
    reasonRedacted: text("reason_redacted"), // D11 audit-denylisted

    optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid("recorded_by_user_id"), // NULL when the portal self-service path recorded it
    // Mirrors `BereavementOptOutSourceKind` in @wardenx/types.
    sourceKind: text("source_kind").notNull(),

    rescindedAt: timestamp("rescinded_at", { withTimezone: true }), // D9 90-day self-service undo
    rescindedByUserId: uuid("rescinded_by_user_id"),
  },
  (t) => ({
    contactIdx: index("berv_optout_contact_idx").on(t.bereavedContactId, t.optedOutAt),
    planIdx: index("berv_optout_plan_idx").on(t.planId, t.optedOutAt),
    // At most one ACTIVE full opt-out per contact — the row that drives `closed_declined`.
    activeUnique: uniqueIndex("berv_optout_active_per_contact")
      .on(t.bereavedContactId)
      .where(sql`rescinded_at IS NULL AND opt_out_kind = 'full'`),

    sourceKindValues: check(
      "berv_optout_source_kind_ck",
      sql`source_kind IN ('counselor_recorded','portal_self_service','m39_revocation_cascade','written_request_uploaded')`,
    ),
    // A channel-specific opt-out that names no channels restricts nothing — it would read as an opt-out in
    // the roster while leaving every modality open.
    channelSpecificRequiresKinds: check(
      "berv_optout_channel_specific_requires_kinds",
      sql`opt_out_kind <> 'channel_specific' OR channel_kinds IS NOT NULL`,
    ),
    rescindAfterOptOut: check(
      "berv_optout_rescind_after_opt_out",
      sql`rescinded_at IS NULL OR rescinded_at >= opted_out_at`,
    ),
  }),
);

export type BereavementOptOutRow = typeof bereavementOptOut.$inferSelect;
export type NewBereavementOptOutRow = typeof bereavementOptOut.$inferInsert;
