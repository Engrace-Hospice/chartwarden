// apps/backend/src/modules/35-subscription/routes/current-subscription.ts — which subscription is an organization's CURRENT one, and who
// else is live beside it.
//
// An organization can hold several subscriptions over time (a canceled one and the one signed after it; an old paused one and a new one).
// "The current subscription" is the NEWEST by `started_at`, and every reader and writer must pick it the same way, or two of them act on
// different rows: the tenant's view, the m2 lifecycle consumer, the tenant's own resume and the hourly pause-resume sweep. Writers either
// supply their application-clock start instant or use the database default; the id tie-break makes the choice total when two rows share that
// instant. Subscription readers and writers use this ordering; contract selection has its own created_at/id ordering.
import { type DbClient, schema } from "@chartwarden/db";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";

const S = schema.subscriptionRow;

type SubRow = typeof S.$inferSelect;

/** The ORDER BY of "the organization's current subscription": newest `started_at`, then the highest id. Spread it into `.orderBy(...)`. */
export const currentSubscriptionOrder = () => [desc(S.startedAt), desc(S.id)] as const;

/** The organization's current subscription, read PLAINLY (no lock), or null. */
export async function selectNewestSubscription(
  tx: DbClient,
  organizationId: string,
): Promise<SubRow | null> {
  const [sub] = await tx
    .select()
    .from(S)
    .where(eq(S.organizationId, organizationId))
    .orderBy(...currentSubscriptionOrder())
    .limit(1);
  return sub ?? null;
}

/**
 * The organization's current subscription read `FOR UPDATE` in the caller's org-scoped transaction, or null. It is the row every M35
 * lifecycle path acts on (the org-lifecycle consumer, the tenant resume, the hourly pause-resume sweep): an older, superseded subscription is
 * never a candidate, and a path that reads this row under the lock finishes before another judges it.
 */
export async function lockNewestSubscription(
  tx: DbClient,
  organizationId: string,
): Promise<SubRow | null> {
  const [sub] = await tx
    .select()
    .from(S)
    .where(eq(S.organizationId, organizationId))
    .orderBy(...currentSubscriptionOrder())
    .limit(1)
    .for("update");
  return sub ?? null;
}

/**
 * The id of ANOTHER subscription of the organization that counts as live (`subscription_org_active_uq`: one per organization that is
 * neither canceled nor paused), or null. Resuming a paused subscription while one exists violates that index (the database refuses it with
 * a raw error), so every resume path asks first.
 */
export async function findOtherLiveSubscriptionId(
  tx: DbClient,
  sub: Pick<SubRow, "id" | "organizationId">,
): Promise<string | null> {
  const [other] = await tx
    .select({ id: S.id })
    .from(S)
    .where(
      and(
        eq(S.organizationId, sub.organizationId),
        ne(S.id, sub.id),
        notInArray(S.status, ["canceled", "paused"]),
      ),
    )
    .limit(1);
  return other?.id ?? null;
}
