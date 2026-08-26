// @wardenx/db — `device_attestation` (M2 Identity, SecHardening §12.2/§12.4; adjudicates ADR-0023 D2).
//
// THE PLATFORM'S OWN VERDICT about the device a session is running on. `AbacContext.attributes
// .deviceAttestation` is read from here and nowhere else — never from a request header, body or query,
// because a device-integrity claim supplied by the device being judged is not evidence.
//
// WHY IT EXISTS NOW. ADR-0023 D2 adjudicated four surfaces consumers assert on M2 but that were absent
// from M2's `ownedTables`: each is EITHER added to M2 with a real manifest edit (the
// `tenant_step_up_policy_override` precedent) OR declared vapor and removed from the consuming spec.
// `device_attestation` has two consumers, so it is added rather than dropped: M3's
// `device_attestation_valid` predicate (the only gate on M33's `report.drilldown.bulk_export`, a CSV of
// patient-identifiable navigation links), and M18's `evv_device.m2_device_attestation_id`, declared in
// that table as "M2 row (app-validated; no FK)" — a logical FK to a table that did not exist, which M18's
// own write path filled with `randomUUID()`.
//
// WHY A TABLE AND NOT A SESSION COLUMN. Attestation outlives the session (a clinician's phone is attested
// once and used across many sessions), it is REVOCABLE independently of any session (a lost device is
// revoked once, not chased through session rows), and M18 already references it BY ROW ID. The session
// carries only the pointer, `session.device_attestation_id`.
//
// SHAPE follows `membership_elevated_approval` (GAP-043) and `membership_credential` (GAP-093) — the repo's
// per-membership named-grant pattern: one LIVE row per (membership, device) via a partial unique index,
// superseded and revoked rows retained in place as the trail rather than deleted.
//
// TENANCY (ADR-0010 / ARCH-011): a STAFF-authority row, not a patient row — `organization_id` only, no
// provider_entity_id/location_id (the three-column rule scopes PHI-bearing tables).
//
// `posture` records the §12.2 facts the check reported (OS version, biometric availability, screen lock,
// jailbreak/root verdict). `failure_reason` is DENYLISTED from audit: it quotes the detector, and the
// detector's exact wording is a map of what the platform looks for.
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  deviceAttestationPlatform,
  deviceAttestationProvider,
  deviceAttestationVerdict,
} from "../enums";
import { memberships } from "./memberships";
import { organizations } from "./organizations";

export const deviceAttestations = pgTable(
  "device_attestation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),

    /** The device identity. Pairs with `evv_device.device_key_fingerprint` — same device, same value, so
     *  M18's registration and this attestation describe one phone rather than two. */
    deviceKeyFingerprint: text("device_key_fingerprint").notNull(),
    platform: deviceAttestationPlatform("platform").notNull(),
    /** What the verdict rests on — the evidence class, not the outcome. */
    provider: deviceAttestationProvider("provider").notNull(),

    verdict: deviceAttestationVerdict("verdict").notNull(),
    /** The §12.2 posture facts the check reported. Advisory context for review; the gate reads `verdict`. */
    posture: jsonb("posture"),
    /** Why the check failed. DENYLISTED from audit — it quotes the detector. */
    failureReason: text("failure_reason"),

    /** When the platform reached this verdict. Never client-supplied. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    /** Attestations are time-boxed: a device proves itself again on expiry. An expired row is not
     *  revoked and not a failure — it simply stops satisfying the gate, which is why the predicate
     *  compares against this rather than trusting `verdict` alone. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** Set on revoke; the row stays as history. `revoked_at IS NULL` plus an unexpired window IS the
     *  live attestation. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id").references(() => memberships.id),
    revokedReason: text("revoked_reason"),

    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one LIVE attestation per device. Re-attesting inserts a NEW row and revokes the old, so the
    // history reads as a sequence of proofs rather than one mutated flag.
    liveUq: uniqueIndex("device_attestation_live_uq")
      .on(t.organizationId, t.membershipId, t.deviceKeyFingerprint)
      .where(sql`verdict = 'attested' AND revoked_at IS NULL`),
    // The hot path: resolving a session's attestation on every authenticated request.
    liveLookupIdx: index("device_attestation_live_lookup_idx")
      .on(t.organizationId, t.membershipId)
      .where(sql`verdict = 'attested' AND revoked_at IS NULL`),
  }),
);

export type DeviceAttestation = typeof deviceAttestations.$inferSelect;
export type NewDeviceAttestation = typeof deviceAttestations.$inferInsert;
