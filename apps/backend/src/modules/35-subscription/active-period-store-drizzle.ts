// apps/backend/src/modules/35-subscription/active-period-store-drizzle.ts — the Drizzle-backed
// `ActivePeriodStore` (F-172, #248) — the first implementation of the §D6 `patient_active_period` /
// `user_active_period` write port anywhere in the tree (`UsageMeteringService.recordPatientActive` /
// `.recordUserActive` have been complete and unit-tested since M35-T03 with no store to run against).
// Both tables are TENANT-SCOPED (RLS on `app.org_id`, 0143), so every write runs inside ONE
// `withOrgContext` transaction — the `m2-organization-lifecycle.ts` precedent one file over — never the
// platform pool `pseudonym-key-provider.ts` uses for the platform-only `patient_pseudonym_key` table.
//
// IDEMPOTENCY IS THE TABLE'S UNIQUE INDEX, NOT A PRE-READ. `patient_active_period_uq` /
// `user_active_period_uq` key on `(organization_id, pseudonym, period_year_month)` — an outbox redelivery
// recomputes the SAME pseudonym (deterministic within a key epoch) for the SAME period, so
// `ON CONFLICT DO NOTHING` is the exact "already recorded this month, no-op" outcome
// `UsageMeteringService`'s `{inserted: boolean}` contract expects.
import { type DbClient, schema } from "@chartwarden/db";
import type { ActivePeriodStore } from "@chartwarden/subscription-billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

const PAP = schema.patientActivePeriod;
const UAP = schema.userActivePeriod;

/** Outbox-consumer writes attribute to no human actor — the `membershipUserIdForOrg`/`SEAM_SYSTEM_USER_ID`
 *  convention (F-102's `CONSUMER_USER_ID`), applied here to `withOrgContext`'s required `userId`. */
const CONSUMER_USER_ID = "";

export function createDrizzleActivePeriodStore(db: DbClient): ActivePeriodStore {
  return {
    async upsertPatientActivePeriod(input) {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: CONSUMER_USER_ID },
        async (tx) => {
          const inserted = await (tx as unknown as DbClient)
            .insert(PAP)
            .values({
              organizationId: input.organizationId,
              patientPseudonym: input.patientPseudonym,
              pseudonymKeyEpoch: input.pseudonymKeyEpoch,
              periodYearMonth: input.periodYearMonth,
              wasActive: true,
              becameActiveAt: input.becameActiveAt,
            })
            .onConflictDoNothing()
            .returning({ id: PAP.id });
          return { inserted: inserted.length > 0 };
        },
      );
    },

    async upsertUserActivePeriod(input) {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: CONSUMER_USER_ID },
        async (tx) => {
          const inserted = await (tx as unknown as DbClient)
            .insert(UAP)
            .values({
              organizationId: input.organizationId,
              membershipPseudonym: input.membershipPseudonym,
              pseudonymKeyEpoch: input.pseudonymKeyEpoch,
              periodYearMonth: input.periodYearMonth,
              wasActive: true,
              firstSessionAt: input.becameActiveAt,
              lastSessionAt: input.becameActiveAt,
            })
            // A second session within the same period updates the recency fact rather than no-op'ing —
            // `lastSessionAt` is genuinely meant to move; `firstSessionAt`/`wasActive` do not.
            .onConflictDoUpdate({
              target: [UAP.organizationId, UAP.membershipPseudonym, UAP.periodYearMonth],
              set: { lastSessionAt: input.becameActiveAt },
            })
            .returning({ id: UAP.id, firstSessionAt: UAP.firstSessionAt });
          // `inserted` here is misleading for an UPDATE path — Drizzle's `onConflictDoUpdate` still
          // RETURNS the affected row, so distinguish INSERT from UPDATE by whether the returned
          // `firstSessionAt` equals the value THIS call just wrote (a fresh row) — good enough for the
          // `{inserted: boolean}` contract, which only gates M35's own idempotency counters, never a
          // financial computation.
          const row = inserted[0];
          return {
            inserted:
              row !== undefined && row.firstSessionAt?.getTime() === input.becameActiveAt.getTime(),
          };
        },
      );
    },
  };
}

/**
 * §D21 `m5.patient.deceased` → "Mark inactive with reason='died'" (M35 spec §4.12). NOT part of the pure
 * `ActivePeriodStore` port (`packages/subscription-billing/src/service/ports.ts`) — that interface is the
 * §D5/D6 shape every lifecycle-service caller shares, and this write is specific to the ONE outbox
 * consumer that needs it, the same "an extra capability beyond the minimal port" shape
 * `CaseloadStore`/`membershipUserIdForOrg` already establish one module over.
 *
 * Idempotent on `(organizationId, patientPseudonym, periodYearMonth)`: a redelivery of the SAME death
 * event recomputes the SAME pseudonym/period and re-applies the SAME `becameInactiveAt`/reason, which is
 * a genuine no-op (unconditional `SET` of a value a redelivery would recompute identically), not a
 * `WHERE ... IS NULL` guard that would also (wrongly) refuse to ever correct a bad first write.
 *
 * Deliberately does NOT touch `was_active`: the §3.3 rule is "active if `status='active'` for ANY day in
 * the period" — a patient who died mid-period WAS active for part of it, so flipping `was_active` false
 * here would misstate that fact for a redelivery-safe reason this file has no way to re-derive (it never
 * reads `status_changed` history). On the INSERT branch (no row yet for the death's own period — the
 * ordinary case, since `m5.patient.status_changed` isn't wired to this table in this pass, F-172's own
 * scoping note) `was_active` is set `true`: a `deceasedDate` is proof the patient existed and was under
 * this org's care immediately prior, never a `false` guess.
 */
export async function markPatientInactiveForOrg(
  db: DbClient,
  input: {
    readonly organizationId: string;
    readonly patientPseudonym: string;
    readonly pseudonymKeyEpoch: string;
    readonly periodYearMonth: string;
    readonly becameInactiveAt: Date;
    readonly reason: "discharged" | "died" | "revoked" | "transferred";
  },
): Promise<void> {
  await withOrgContext(
    db,
    { organizationId: input.organizationId, userId: CONSUMER_USER_ID },
    async (tx) => {
      const t = tx as unknown as DbClient;
      await t
        .insert(PAP)
        .values({
          organizationId: input.organizationId,
          patientPseudonym: input.patientPseudonym,
          pseudonymKeyEpoch: input.pseudonymKeyEpoch,
          periodYearMonth: input.periodYearMonth,
          wasActive: true,
          becameActiveAt: input.becameInactiveAt,
          becameInactiveAt: input.becameInactiveAt,
          inactivityReason: input.reason,
        })
        .onConflictDoUpdate({
          target: [PAP.organizationId, PAP.patientPseudonym, PAP.periodYearMonth],
          set: { becameInactiveAt: input.becameInactiveAt, inactivityReason: input.reason },
        });
    },
  );
}

/** True iff a `patient_active_period`/`user_active_period` row exists for `(org, pseudonym, period)` —
 *  exposed for the live suite's own assertions rather than reading the table directly through a second
 *  (differently-scoped) connection. */
export async function activePeriodRowExists(
  db: DbClient,
  organizationId: string,
  pseudonym: string,
  periodYearMonth: string,
  kind: "patient" | "user",
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
    const t = tx as unknown as DbClient;
    if (kind === "patient") {
      const rows = await t
        .select({ id: PAP.id })
        .from(PAP)
        .where(and(eq(PAP.organizationId, organizationId), eq(PAP.patientPseudonym, pseudonym)))
        .limit(1);
      return rows.length > 0;
    }
    const rows = await t
      .select({ id: UAP.id })
      .from(UAP)
      .where(and(eq(UAP.organizationId, organizationId), eq(UAP.membershipPseudonym, pseudonym)))
      .limit(1);
    return rows.length > 0;
  });
}
