// @wardenx/db — `session` (M1 Foundation §3.8, Better Auth table). Cross-org session
// state owned by a user; the active org is carried as a nullable column rather than a
// scoping FK, so `session` is NON_ORG_SCOPED in check-tenancy.ts.
//
// M2-T03 (M2 spec §2.2.4, §3.6) extends this base shape with the session-class /
// lifecycle / step-up fields. Better Auth drives these as `additionalFields`
// (packages/auth/src/identity); the columns + CHECKs below are their at-rest shape:
//   • session_class        — which of the four session classes this is (drives policy)
//   • scope                — class-specific scope, e.g. { patientId } for collaborator/funeral
//   • engagement_start/end — the auditor engagement window
//   • screen_locked_at     — UI screen-lock timestamp (staff/auditor lifecycle)
//   • last_step_up_at / last_step_up_factor — step-up freshness (paired-write, D8)
//   • device_attestation_id — the attested device this session runs on (SecHardening §12.4)
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sessionClass, stepUpFactor } from "../enums";
import { users } from "./users";

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: uuid("active_organization_id"),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // M2-T03 additional fields (M2 spec §3.6).
    sessionClass: sessionClass("session_class").notNull().default("staff"),
    // `{ patientId }` for external_collaborator / funeral_home; `{ portalAccountId, patientId? }` for the
    // three M31 portal classes — `patientId` arrives only when `select-patient` binds the session's one
    // patient (§2.3 / D2), so it is absent on a freshly minted portal session. Shape enforced per class
    // by `session_scope_chk`.
    scope: jsonb("scope"),
    engagementStart: timestamp("engagement_start", { withTimezone: true }),
    engagementEnd: timestamp("engagement_end", { withTimezone: true }),
    screenLockedAt: timestamp("screen_locked_at", { withTimezone: true }),
    lastStepUpAt: timestamp("last_step_up_at", { withTimezone: true }),
    lastStepUpFactor: stepUpFactor("last_step_up_factor"),
    // SecHardening §12.4 — the `device_attestation` row this session is bound to, stamped at mint when
    // the device proved itself. NULL on a browser session, which offers no hardware-backed posture
    // assertion: absent is the correct answer there, not a missing one, and the §12.4 gate denies it.
    // Deliberately a plain uuid with no FK, matching `evv_device.m2_device_attestation_id`: `session` is
    // a Better Auth table on the NON_ORG_SCOPED side and the attestation is org-scoped, so a hard FK
    // would tie session deletion to an org-RLS'd row. The resolver re-reads the attestation and re-checks
    // it is live, so a dangling pointer denies rather than admits.
    deviceAttestationId: uuid("device_attestation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("session_user_idx").on(t.userId),
    expiresIdx: index("session_expires_idx").on(t.expiresAt),
    // M3's step_up_recent predicate looks sessions up by step-up freshness.
    stepUpRecentIdx: index("idx_session_step_up_recent")
      .on(t.lastStepUpAt)
      .where(sql`${t.lastStepUpAt} IS NOT NULL`),
    // Class-specific scope invariant (M2 spec §3.6): collaborator/funeral sessions must
    // carry scope.patientId; auditor sessions must carry both engagement bounds.
    scopeChk: check(
      "session_scope_chk",
      // COALESCE, not a bare `?`: `NULL ? 'k'` is NULL, and a CHECK PASSES on NULL — so without it the
      // scope requirements do not bind on a row whose `scope` is absent (migration 0220).
      sql`(${t.sessionClass} IN ('external_collaborator','funeral_home') AND COALESCE(${t.scope}, '{}'::jsonb) ? 'patientId')
        OR (${t.sessionClass} = 'auditor' AND ${t.engagementStart} IS NOT NULL AND ${t.engagementEnd} IS NOT NULL)
        OR (${t.sessionClass} IN ('patient_portal','caregiver_portal','bereaved_portal') AND COALESCE(${t.scope}, '{}'::jsonb) ? 'portalAccountId')
        OR (${t.sessionClass} IN ('external_triage_vendor','external_triage_operator'))
        OR (${t.sessionClass} = 'staff')`,
    ),
    // Step-up paired-write invariant (D8): both NULL or both set.
    stepUpPairedWriteChk: check(
      "session_step_up_paired_write",
      sql`(${t.lastStepUpAt} IS NULL AND ${t.lastStepUpFactor} IS NULL)
        OR (${t.lastStepUpAt} IS NOT NULL AND ${t.lastStepUpFactor} IS NOT NULL)`,
    ),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
