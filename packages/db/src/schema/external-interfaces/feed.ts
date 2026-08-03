// @wardenx/db — `external_feed` + `external_feed_credential` (M29 §3.3). The per-tenant HL7 feed registry
// and its rotating channel-credential material.
//
// TENANT-SCOPED, UNPARTITIONED: `organization_id` NOT NULL with a REAL FK to `organization` (the M1 spine),
// canonical app.org_id RLS (§3.5). `external_feed` is operational metadata only (empty §3.6 denylist) so it
// audits through M1's baseline `wardenx_audit_trigger()`. `external_feed_credential.secret_cipher` is the
// per-tenant DEK-encrypted channel secret — §3.6-DENYLISTED from the audit value_capture (a channel secret
// in the clear in an immutable audit log is still a leak), so it audits through a GENERATED scrubbing
// trigger and the §3.7 eraser destroys it while keeping the `fingerprint` for ops display.
//
// FK POLICY (architecture §25.15): `organization` and the intra-M29 parent (`external_feed`) carry REAL
// FKs. Every cross-module reference — `sending_facility_allowlist` (M40 Facility ids),
// `proposed_by_membership_id` / `approved_by_*_id` (M2 memberships) — is a LOGICAL uuid validated at the
// write boundary; no DB FK crosses a module edge.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import {
  externalFeedCredentialKind,
  externalFeedCredentialStatus,
  externalFeedKind,
  externalFeedProtocol,
  externalFeedStatus,
} from "./enums";

export const externalFeed = pgTable(
  "external_feed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: externalFeedKind("kind").notNull(),
    displayName: text("display_name").notNull(),
    /** null for an inbound listener (WardenX owns the bind address). */
    host: text("host"),
    port: integer("port").notNull(),
    protocol: externalFeedProtocol("protocol").notNull(),
    /** sha256(certPEM) — null only for `mllp_plain` (test only). */
    channelCertPin: text("channel_cert_pin"),
    /** string[] of M40 Facility ids — the per-feed MSH-4 sender allowlist (§4.11.2). */
    sendingFacilityAllowlist: jsonb("sending_facility_allowlist")
      .notNull()
      .default([])
      .$type<string[]>(),
    /** The M34 BAA contract ref — enforced present at activation (D16). */
    baaContractRef: text("baa_contract_ref"),
    /** Soft expiry; a -30d warning is emitted before dispatch is blocked. */
    baaExpiresOn: timestamp("baa_expires_on", { withTimezone: true }),
    activeFrom: timestamp("active_from", { withTimezone: true }),
    activeThrough: timestamp("active_through", { withTimezone: true }),
    status: externalFeedStatus("status").notNull().default("proposed"),
    /** Logical M2 membership refs — the §2.2 dual-approval (D18) actors, validated at the write boundary. */
    proposedByMembershipId: uuid("proposed_by_membership_id").notNull(),
    approvedByOpId: uuid("approved_by_op_id"),
    approvedByComplId: uuid("approved_by_compl_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Set on §3.7 eraser tombstone (`status='revoked'`); the row survives as disclosure evidence. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rateLimitMsgPerSec: integer("rate_limit_msg_per_sec").notNull().default(50),
    retryPolicy: jsonb("retry_policy")
      .notNull()
      .default({ maxAttempts: 5, backoffSecs: [1, 4, 16, 64, 256] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgKindIdx: index("idx_external_feed_org_kind").on(t.organizationId, t.kind),
    uniqOrgPortKind: uniqueIndex("uq_external_feed_org_port_kind").on(
      t.organizationId,
      t.port,
      t.kind,
    ),
    statusIdx: index("idx_external_feed_status").on(t.status),
  }),
);

export const externalFeedCredential = pgTable(
  "external_feed_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => externalFeed.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: externalFeedCredentialKind("kind").notNull(),
    /** Per-tenant DEK envelope-encrypted secret — §3.6-denylisted; destroyed by the §3.7 eraser. */
    secretCipher: text("secret_cipher").notNull(),
    /** sha256 first 8 hex for ops display — retained through the eraser. */
    fingerprint: text("fingerprint").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }).notNull().defaultNow(),
    status: externalFeedCredentialStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    feedStatusIdx: index("idx_efc_feed_status").on(t.feedId, t.status),
  }),
);

export type ExternalFeedRow = typeof externalFeed.$inferSelect;
export type NewExternalFeedRow = typeof externalFeed.$inferInsert;
export type ExternalFeedCredentialRow = typeof externalFeedCredential.$inferSelect;
export type NewExternalFeedCredentialRow = typeof externalFeedCredential.$inferInsert;
