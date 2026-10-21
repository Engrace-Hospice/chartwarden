// apps/backend/src/modules/35-subscription/outbox-consumers/m2-organization-lifecycle.ts — the §4.12
// `org-lifecycle-handler` binding over `m2.organization.activated` / `.suspended` / `.closed`
// (F-16x, #248). M35's own D21 (locked, exhaustive: "8 inbound subscriptions") names these three events
// by their handler name and D19's own text states the mechanism decisively for two of the three:
// "M35 reactively pauses Stripe billing" on `.suspended`, "M35 cancels the Stripe subscription at period
// end" on `.closed` — both already-real operations `service-drizzle.ts` implements today
// (`adminPauseSubscription` / the tenant self-serve `cancelSubscription`), mirrored here rather than
// re-invented so a cross-module cascade and a human-initiated action write state identically.
//
// `.activated`'s own catalogued description ("M35 resumes/starts the Stripe subscription in sympathy")
// and the §4.12 table's own hedge ("(optionally) create initial trial subscription on tenant go-live")
// are TWO different actions bundled under one event, and only the first is decisive. RESUME (a `paused`
// subscription returning to `active`, mirroring `resumeSubscription`/`adminResumeSubscription`) is built:
// it needs no new fact, no plan choice, and both existing routes agree on the target state (`active`,
// never `trialing` — resuming a paused subscription does not re-derive whether a trial was still open).
// CREATE ("start" — a brand-new org's very first subscription) is DELIBERATELY NOT BUILT: `createSubscription`
// (`@chartwarden/subscription-billing`'s `SubscriptionLifecycleService`) requires a `planId`, and nothing in
// this event's payload, this consumer's injected facts, or the spec's own text names which of the three
// platform plan tiers (Starter/Professional/Enterprise, D1) a newly-activated org should default onto —
// the "(optionally)" hedge is the spec's own tell that this half was never decided. Inventing a default
// tier here would be exactly the fabricated-business-logic move this build is instructed not to make.
// An org whose FIRST activation finds no subscription row at all is therefore a documented no-op: M35
// stays silent (no Stripe subscription exists to resume), which is the honest state until a real plan-
// selection mechanism (a route, an onboarding wizard step, or a decided platform default) is built
// elsewhere. An org in dunning-`suspended` (D7, a billing-driven state distinct from this event's
// platform-admin-driven `.suspended`/`.activated`) is likewise left untouched by `.activated` — resolving
// a billing suspension needs an actual payment outcome, not an org-level admin action.
//
// IDEMPOTENCY WITHOUT A NEW COLUMN: `subscription` carries no `version` column (unlike, e.g.,
// `telehealth_visit`), so each write conditions its `WHERE` on the SAME status the SELECT used to pick the
// row — the `m6-admission-discharged-cascade.ts` / `m31-visit-cancelled-telehealth.ts` precedent applied
// to a status-keyed table instead of a state-machine-keyed one. A lost race (another delivery, or a human
// route call, already moved the row) is a silent no-op: the correct outcome is to leave the row exactly
// where the other writer left it, never to clobber it back. A genuine redelivery of the SAME event after
// the first delivery committed finds nothing left to act on either, since the WHERE no longer matches.
//
// `subscription_state_history.actor_membership_id` is NULL "for system transitions" (its own schema
// comment) — the F-102 `CONSUMER_USER_ID` convention applied to a nullable FK column rather than a
// sentinel string, since this table has a real nullable actor column to express "nobody, a cascade did
// this" rather than needing a fake row id.
//
// `.closed` mirrors the TENANT self-serve `cancelSubscription`, not the platform `adminCancelSubscription`:
// D19/§4.12 both say "at period end", and the tenant route is the one that schedules
// (`cancelAtPeriodEnd = true`, `status` left untouched) rather than transitioning `status` to `canceled`
// immediately — matching that route's own shape exactly, including its choice not to write a
// `subscription_state_history` row (status did not change, so there is no state transition to log).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/service-drizzle";

const S = schema.subscriptionRow;
const SH = schema.subscriptionStateHistory;

export const M35_ORG_LIFECYCLE_CONSUMER = {
  eventNames: [
    "m2.organization.activated",
    "m2.organization.suspended",
    "m2.organization.closed",
  ] as const,
  consumerName: "m35.m2-organization-lifecycle",
} as const;

export interface OrgLifecycleConsumerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly now?: () => Date;
}

function reasonOf(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return typeof p.reason === "string" && p.reason.length > 0 ? p.reason : "";
}

const isoReq = (d: Date): string => d.toISOString();

/**
 * M35's live `m2.organization.{activated,suspended,closed}` binding (§4.12 `org-lifecycle-handler`).
 * See the file header for exactly which sub-case of `.activated` is built and which is a documented gap.
 */
export function buildM35OrgLifecycleConsumer(deps: OrgLifecycleConsumerDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    consumerName: M35_ORG_LIFECYCLE_CONSUMER.consumerName,
    consumerModule: "m35" as const,
    eventTypes: M35_ORG_LIFECYCLE_CONSUMER.eventNames,
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const organizationId = event.organizationId;
      const reason = reasonOf(event.payload);

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) return; // no subscription for this org yet — see the `.activated` "CREATE" note above.

        const at = now();

        if (event.eventType === "m2.organization.suspended") {
          if (sub.status === "paused" || sub.status === "canceled") return; // idempotent no-op
          const updated = await tx
            .update(S)
            .set({ status: "paused", pausedAt: at, pausedUntil: null, updatedAt: at })
            .where(and(eq(S.id, sub.id), eq(S.status, sub.status)))
            .returning({ id: S.id });
          if (updated.length === 0) return; // lost a race to another writer — leave it alone.

          await tx.insert(SH).values({
            subscriptionId: sub.id,
            organizationId,
            fromStatus: sub.status,
            toStatus: "paused",
            transitionedAt: at,
            actorMembershipId: null,
            reasonCode: "org_suspended_by_platform_admin",
            reasonDetail: reason.length > 0 ? reason : null,
          });
          await deps.outbox.publish(tx, {
            eventName: "m35.subscription.paused",
            payload: {
              subscriptionId: sub.id,
              organizationId,
              pausedAt: isoReq(at),
              pausedUntil: null,
            },
            organizationId,
            aggregateKind: "subscription",
            aggregateId: sub.id,
          });
          return;
        }

        if (event.eventType === "m2.organization.activated") {
          if (sub.status !== "paused") return; // nothing to resume — see the file header's CREATE note.
          const updated = await tx
            .update(S)
            .set({ status: "active", pausedAt: null, pausedUntil: null, updatedAt: at })
            .where(and(eq(S.id, sub.id), eq(S.status, "paused")))
            .returning({ id: S.id });
          if (updated.length === 0) return; // lost a race — leave it alone.

          await tx.insert(SH).values({
            subscriptionId: sub.id,
            organizationId,
            fromStatus: "paused",
            toStatus: "active",
            transitionedAt: at,
            actorMembershipId: null,
            reasonCode: "org_activated_by_platform_admin",
            reasonDetail: reason.length > 0 ? reason : null,
          });
          await deps.outbox.publish(tx, {
            eventName: "m35.subscription.resumed",
            payload: { subscriptionId: sub.id, organizationId, resumedAt: isoReq(at) },
            organizationId,
            aggregateKind: "subscription",
            aggregateId: sub.id,
          });
          return;
        }

        if (event.eventType === "m2.organization.closed") {
          if (sub.status === "canceled" || sub.cancelAtPeriodEnd) return; // idempotent no-op
          const updated = await tx
            .update(S)
            .set({ cancelAtPeriodEnd: true, canceledAt: at, updatedAt: at })
            .where(and(eq(S.id, sub.id), eq(S.cancelAtPeriodEnd, false)))
            .returning({ id: S.id });
          if (updated.length === 0) return; // lost a race — leave it alone.

          // No `subscription_state_history` row: `status` does not change on a period-end schedule, the
          // same shape the tenant self-serve `cancelSubscription` route already establishes — there is no
          // transition to log, only a flag.
          await deps.outbox.publish(tx, {
            eventName: "m35.subscription.canceled",
            payload: {
              subscriptionId: sub.id,
              organizationId,
              canceledAt: isoReq(at),
              reasonCode: "org_closed_by_platform_admin",
              atPeriodEnd: true,
            },
            organizationId,
            aggregateKind: "subscription",
            aggregateId: sub.id,
          });
        }
      });
    },
  };
}
