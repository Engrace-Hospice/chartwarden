// apps/backend/src/modules/35-subscription/routes/resume-transition.ts — what a `paused` -> `active` resume writes, whoever resumes it.
//
// Two writers resume a paused subscription of an operator's making: the operator's own resume (service-drizzle.ts `adminResumeSubscription`,
// on the platform runner, audited by operator) and the hourly sweep that resumes a pause whose end date has passed (billing-runtime/
// pause-resume.ts, org-scoped, no operator). They differ in WHO and WHEN (the sweep dates its ledger row at the pause's own end date), not
// in WHAT is written: the same columns, the same ledger shape, the same `m35.subscription.resumed` event. These three builders are that
// shared part, so the two paths cannot drift apart.
import type { schema } from "@chartwarden/db";

type SubRow = typeof schema.subscriptionRow.$inferSelect;

/** The only event a resume announces (the operator's resume and the sweep publish it; nothing else is emitted for a resume). */
export const SUBSCRIPTION_RESUMED_EVENT = "m35.subscription.resumed";

/** The `subscription` columns a resume writes: back to `active`, the pause's own timestamps cleared. */
export const resumedColumns = (at: Date) =>
  ({ status: "active", pausedAt: null, pausedUntil: null, updatedAt: at }) as const;

/**
 * The tenant-readable ledger row of the resume. `actorMembershipId` is always NULL: the row is tenant-readable (and audit-copied into the
 * tenant's trail), and an operator is named only in the platform audit row. `transitionedAt` is the instant the ledger says the pause ended.
 */
export const resumedLedgerRow = (
  sub: Pick<SubRow, "id" | "organizationId" | "status">,
  transition: { readonly transitionedAt: Date; readonly reasonCode: string },
) =>
  ({
    subscriptionId: sub.id,
    organizationId: sub.organizationId,
    fromStatus: sub.status,
    toStatus: "active",
    transitionedAt: transition.transitionedAt,
    actorMembershipId: null,
    reasonCode: transition.reasonCode,
  }) as const;

/** The outbox intent of the resume (`resumedAt` is the instant the resume took effect, as the ledger row dates it). */
export const resumedEventIntent = (sub: Pick<SubRow, "id" | "organizationId">, resumedAt: Date) =>
  ({
    eventName: SUBSCRIPTION_RESUMED_EVENT,
    payload: {
      subscriptionId: sub.id,
      organizationId: sub.organizationId,
      resumedAt: resumedAt.toISOString(),
    },
    organizationId: sub.organizationId,
    aggregateKind: "subscription",
    aggregateId: sub.id,
  }) as const;
