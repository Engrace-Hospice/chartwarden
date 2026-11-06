// apps/backend/src/modules/16-bereavement/routes/timeline-read.ts — route 52: a contact's program timeline (ADR-0109 D10).
//
// The contact log holds two row families: a touchpoint (an outreach's log: a call, a letter, a visit) and a PROGRAM ACTIVITY (a newsletter or holiday
// mailing, a group session, a memorial attendance: no outreach, no cadence item, never counted in M30). This reads both for one contact, newest first, so
// the contact screen can show "what has this family been sent or invited to".
//
// REACH is the plan's: the same read-side rule as every plan-scoped read, and an out-of-reach contact is indistinguishable from an absent one (the 404 never
// reveals that a patient died). VOLUNTEER FILTER (D10): a bereavement volunteer sees WHEN each touchpoint happened and its kind, and the full activity entries
// (a mailing, a session), but NOT the outcome of a touchpoint: what happened on a call (a crisis referral, a request for no further contact) is clinical
// content. Redaction is shape, not status: the field is ABSENT and `clinical_risk` is named in `redactedCategories`. The sealed note column is never read.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BereavementActivityKind, IsoInstant } from "@chartwarden/types";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { M16ReadActor } from "./actor";
import {
  type Cursor,
  M16_PAGE_SIZES,
  clampLimit,
  decodeCheckedCursor,
  toCursorPage,
} from "./concurrency";
import type { BereavementDisclosureDecision } from "./disclosure";
import type { ContactTimelineEntry, ContactTimelinePage } from "./read-service";

type PlanRow = typeof schema.bereavementPlan.$inferSelect;

export interface ContactTimelineDeps {
  /** The read-side reach rule of the plan (the read service's own). */
  readonly mayReachPlan: (actor: M16ReadActor, plan: PlanRow) => boolean;
  /** The §7.13 / D10 disclosure posture for this actor on this decedent. */
  readonly disclosure: (
    actor: M16ReadActor,
    patientId: string,
  ) => Promise<BereavementDisclosureDecision>;
}

export async function listContactTimeline(
  db: DbClient,
  actor: M16ReadActor,
  contactId: string,
  query: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  deps: ContactTimelineDeps,
): Promise<ContactTimelinePage | null> {
  const LOG = schema.bereavementContactLog;
  const scope = { organizationId: actor.organizationId, userId: actor.userId };
  const limit = clampLimit(query.limit, M16_PAGE_SIZES.dashboard);
  const after: Cursor | null = decodeCheckedCursor(query.cursor, "instant");

  const found = await withOrgContext(db, scope, async (tx) => {
    const [contact] = await tx
      .select({ planId: schema.bereavedContact.planId })
      .from(schema.bereavedContact)
      .where(eq(schema.bereavedContact.id, contactId))
      .limit(1);
    if (!contact) return null;
    const [plan] = await tx
      .select()
      .from(schema.bereavementPlan)
      .where(eq(schema.bereavementPlan.id, contact.planId))
      .limit(1);
    if (!plan || !deps.mayReachPlan(actor, plan)) return null;
    const rows = await tx
      .select({
        id: LOG.id,
        contactAt: LOG.contactAt,
        kind: LOG.kind,
        outcome: LOG.outcome,
        activityKind: LOG.activityKind,
      })
      .from(LOG)
      .where(
        and(
          // plan_id leads the (plan, contact, contact_at) index.
          eq(LOG.planId, plan.id),
          eq(LOG.bereavedContactId, contactId),
          after === null
            ? undefined
            : or(
                lt(LOG.contactAt, new Date(after.a)),
                and(eq(LOG.contactAt, new Date(after.a)), lt(LOG.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(LOG.contactAt), desc(LOG.id))
      .limit(limit + 1);
    return { patientId: plan.patientId, rows };
  });
  if (found === null) return null;

  const gate = await deps.disclosure(actor, found.patientId);
  const page = toCursorPage(
    found.rows,
    limit,
    (row) => ({ a: row.contactAt.toISOString(), id: row.id }),
    (row): ContactTimelineEntry => {
      const isActivity = row.activityKind !== null;
      return {
        entryId: row.id,
        at: row.contactAt.toISOString() as IsoInstant,
        source: isActivity ? "program_activity" : "outreach",
        kind: row.kind ?? null,
        activityKind: (row.activityKind ?? null) as BereavementActivityKind | null,
        // D10: an outreach entry's outcome is clinical content; an activity entry's (mailed / emailed / attended) is not.
        ...(isActivity || gate.clinicalRiskAllowed ? { outcome: row.outcome } : {}),
      };
    },
  );
  return { ...page, redactedCategories: gate.redactedCategories };
}
