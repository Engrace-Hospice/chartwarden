// @chartwarden/db — `collaborator_link` (M2 Identity, GAP-115 follow-up; migration 0521). The durable, hash-only,
// bounded-use magic-link store behind the external-collaborator and funeral-home session classes. The token is
// stored ONLY as a SHA-256 digest (`token_hash`); `max_uses`/`use_count` make a redemption a single conditional
// UPDATE; `principal_user_id` is the synthetic credential-less M2 `user` the redeemed session row belongs to.
// Patient-bearing (it pins the one patient a session may read), so it carries the ARCH-011 provider_entity_id
// NOT NULL + location_id resolved from the patient's admission at issue time.
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
import { locations } from "./locations";
import { organizations } from "./organizations";
import { providerEntities } from "./provider-entities";
import { users } from "./users";

export const collaboratorLinks = pgTable(
  "collaborator_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5 patient
    /** The session class a redemption yields: `external_collaborator` | `funeral_home`. */
    kind: text("kind").notNull(),
    invitedByMembershipId: uuid("invited_by_membership_id").notNull(),
    tokenHash: text("token_hash").notNull(), // sha256 hex of the raw token; the raw token is never stored
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Lifetime of the SESSION a redemption mints (collaborator up to 8h, funeral 72h by default). */
    sessionTtlSec: integer("session_ttl_sec").notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    firstRedeemedAt: timestamp("first_redeemed_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    principalUserId: uuid("principal_user_id").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("collaborator_link_token_hash_uq").on(t.tokenHash),
    orgPatientIdx: index("collaborator_link_org_patient_idx").on(t.organizationId, t.patientId),
    providerEntityIdx: index("collaborator_link_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("collaborator_link_location_idx").on(t.locationId),
    kindChk: check(
      "collaborator_link_kind_chk",
      sql`${t.kind} IN ('external_collaborator','funeral_home')`,
    ),
    usesChk: check(
      "collaborator_link_uses_chk",
      sql`${t.maxUses} >= 1 AND ${t.useCount} >= 0 AND ${t.useCount} <= ${t.maxUses}`,
    ),
    sessionTtlChk: check("collaborator_link_session_ttl_chk", sql`${t.sessionTtlSec} > 0`),
  }),
);

export type CollaboratorLink = typeof collaboratorLinks.$inferSelect;
export type NewCollaboratorLink = typeof collaboratorLinks.$inferInsert;
