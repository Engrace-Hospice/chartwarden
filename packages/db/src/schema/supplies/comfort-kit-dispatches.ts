// @wardenx/db — `comfort_kit_dispatch` (M21 §3.1.8). D6/D17: one row per physical kit that left a DEA
// registration, unified across every deployment site (home / ALF / SNF-as-residence / IPU room) behind the
// single `deployment_site` discriminator. This is the head of the 21 CFR §1304 chain of custody; the
// per-medication lines hang off it in `comfort_kit_dispatched_content`.
//
// D12 / §3.6: partitioned monthly by RANGE (`dispatched_at`), composite PRIMARY KEY (id, dispatched_at)
// declared in migration 0105 (Drizzle cannot express a partitioned table, so `.primaryKey()` below is the
// ORM's view of row identity only). Its OWN file, separate from `supply_request`'s 0104, because
// check-ddl-legality derives one partition column per file and these two differ.
//
// WHY `dispatched_at` AND NOT `created_at`: the DEA question is always "what left the hub in March", and
// `dispatched_at` is the fact a surveyor's date range is expressed in. Partitioning on row-creation time
// would scatter one month's custody records across two partitions whenever a dispatch is recorded late.
//
// §3.0 / M21-F04: §3.1 is normative — `kit_serial_number`, `dispatched_by_membership_id`,
// `controlled_substance_handling_policy_digest`, `ipu_room_id`, `admission_id` and `location_id` are all
// restored, and the draft-only `m21_comfort_kit_dispatch_status` enum is folded IN (it is load-bearing in
// §5/§7 and in the published `ActiveDispatchView`). Two further folds the published types require:
// `deployed_at_patient_at` + `deployed_by_membership_id`, which `M21ComfortKitDeployedAtPatientPayload`
// (locked in M21-T01) publishes as `deployedAt` / `deployedByMembershipId` — a status enum with a
// `deployed_at_patient` value and nowhere to record WHEN and BY WHOM would make that payload unbuildable.
// `facility_identifier_jsonb` is folded per D17 (the facility roster / room identity for a non-home site);
// D17's "required for non-home sites" stays a write-boundary rule, since §3.1 declares no CHECK for it and
// §3.1 governs the storage layer.
//
// POLICY DIGEST, NOT POLICY POINTER: `controlled_substance_handling_policy_digest` freezes the template's
// handling policy AS DISPATCHED. A tenant that loosens its lock-box rule next quarter must not retroactively
// change what the courier was instructed to do on this kit.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + patient_id + admission_id + location_id +
// provider_entity_id, all NOT NULL. Canonical app.org_id RLS on the PARTITIONED PARENT; policies and grants
// propagate to every partition (PG11+).
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) and the unpartitioned
// intra-M21 `comfort_kit_template_id` carry real FKs. `supply_request_id` is a LOGICAL uuid — its target is
// itself partitioned on a different key, so a real FK would need the composite. patient_id (M5),
// admission_id (M6), pharmacy_partner_id (M40), bol_document_id (M22), m13_deployment_id (M13),
// ipu_room_id (M37 forward seam) and every `*_membership_id` (M2) are logical uuid.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  comfortKitDeploymentSite,
  comfortKitDispatchSource,
  comfortKitDispatchStatus,
  pharmacyDispatchMode,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { comfortKitTemplate } from "./comfort-kit-templates";

export const comfortKitDispatch = pgTable(
  "comfort_kit_dispatch",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, dispatched_at) declared in SQL (0105)
    supplyRequestId: uuid("supply_request_id").notNull(), // logical FK → supply_request (partitioned)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    admissionId: uuid("admission_id").notNull(), // logical FK → M6
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    comfortKitTemplateId: uuid("comfort_kit_template_id")
      .notNull()
      .references(() => comfortKitTemplate.id, { onDelete: "restrict" }),

    deploymentSite: comfortKitDeploymentSite("deployment_site").notNull(),
    dispatchStatus: comfortKitDispatchStatus("dispatch_status").notNull().default("dispatched"),
    ipuRoomId: uuid("ipu_room_id"), // D17 forward seam → M37; non-null iff deployment_site = 'ipu_room'
    /** Facility roster / room identity for a non-home site (D17). */
    facilityIdentifierJsonb: jsonb("facility_identifier_jsonb"),

    pharmacyDispatchMode: pharmacyDispatchMode("pharmacy_dispatch_mode").notNull(),
    /** WHICH DEA registration it physically left from — distinct from the routing decision above. */
    dispatchSource: comfortKitDispatchSource("dispatch_source").notNull(),
    pharmacyPartnerId: uuid("pharmacy_partner_id"), // logical FK → M40 Pharmacy

    kitSerialNumber: text("kit_serial_number").notNull(),
    dispatchedByMembershipId: uuid("dispatched_by_membership_id").notNull(), // logical FK → M2
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).notNull().defaultNow(), // PART. KEY

    // §3.0 fold — the `deployed_at_patient` transition, which the published deployed payload carries.
    deployedAtPatientAt: timestamp("deployed_at_patient_at", { withTimezone: true }),
    deployedByMembershipId: uuid("deployed_by_membership_id"), // logical FK → M2

    bolDocumentId: uuid("bol_document_id"), // logical FK → M22

    // Set when M13 acks the deployment. Until then the dispatch is live but unlinked, which is what the
    // `m13_link_pending` index below queues for the reconciliation worker.
    m13DeploymentId: uuid("m13_deployment_id"),
    m13DeploymentLinkResolvedAt: timestamp("m13_deployment_link_resolved_at", {
      withTimezone: true,
    }),

    /** Frozen digest of the template's controlled-substance handling policy AS DISPATCHED (see header). */
    controlledSubstanceHandlingPolicyDigest: text(
      "controlled_substance_handling_policy_digest",
    ).notNull(),
    /** Denormalized manifest of what went out, for the BOL render and the offline courier view. The
     *  authoritative per-line accounting is `comfort_kit_dispatched_content`. */
    dispatchedContentsJsonb: jsonb("dispatched_contents_jsonb").notNull(),
    /** Free-text — D13 audit-denylisted. */
    specialHandlingNotes: text("special_handling_notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("comfort_kit_dispatch_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.dispatchedAt,
    ),
    supplyRequestIdx: index("comfort_kit_dispatch_supply_req_idx").on(t.supplyRequestId),
    ipuRoomIdx: index("comfort_kit_dispatch_ipu_room_idx")
      .on(t.locationId, t.ipuRoomId)
      .where(sql`deployment_site = 'ipu_room'`),
    m13LinkPendingIdx: index("comfort_kit_dispatch_m13_link_pending_idx")
      .on(t.dispatchedAt)
      .where(sql`m13_deployment_id IS NULL`),
    kitSerialIdx: index("comfort_kit_dispatch_kit_serial_idx").on(
      t.organizationId,
      t.kitSerialNumber,
    ),

    // Both directions: an IPU dispatch names its room, and a home dispatch must not claim one.
    ipuRoomMatchesSite: check(
      "m21_ckit_dispatch_ipu_room_site",
      sql`(deployment_site = 'ipu_room' AND ipu_room_id IS NOT NULL)
          OR (deployment_site <> 'ipu_room' AND ipu_room_id IS NULL)`,
    ),
    // The folded transition columns move together — a deployment time with no deployer is an
    // unattributable chain-of-custody link.
    deploymentIsAttributed: check(
      "m21_ckit_dispatch_deploy_attributed",
      sql`(deployed_at_patient_at IS NULL) = (deployed_by_membership_id IS NULL)`,
    ),
  }),
);

export type ComfortKitDispatchRow = typeof comfortKitDispatch.$inferSelect;
export type NewComfortKitDispatchRow = typeof comfortKitDispatch.$inferInsert;
