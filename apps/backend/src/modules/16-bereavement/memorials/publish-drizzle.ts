// apps/backend/src/modules/16-bereavement/memorials/publish-drizzle.ts — ADR-0109 D10 (PR 3): who a memorial service invites, SET-BASED.
//
// Runs inside the publishing transaction. The invitees are the PROGRAM FAMILIES (`program/program-contacts.ts`: active contact, active plan, no full /
// pause opt-out) whose decedent died within `invite_window_months` before the service day and not after it. Each is sorted into a delivery with the
// SAME rule the mailing program uses (`decideMailingEligibility`): a contact who can receive the letter is `mailing`, anyone else (a no-mailings
// opt-out, no address on file, a channel opt-out) is `portal_only` (the portal and a staff call still reach them). When anyone is `mailing`, ONE
// `memorial_invitation` mailing run is drafted for the service (occurrence `memorial_invitation:<serviceId>`, no wording: no default ships), and
// `generate` later selects exactly those invitees again, re-checking eligibility as for every run.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { decideMailingEligibility } from "../mailings/eligibility";
import { loadMailingCandidates } from "../mailings/facts-drizzle";

const INSERT_CHUNK = 500;

/** The ids of the contacts a memorial invites (program families, deaths in the window). */
async function inviteeIds(
  tx: DbClient,
  service: { readonly startsAt: Date; readonly inviteWindowMonths: number },
): Promise<string[]> {
  const day = service.startsAt.toISOString().slice(0, 10);
  const rows = await tx.execute(sql`
    SELECT c.id
      FROM bereaved_contact c
      JOIN bereavement_plan p ON p.id = c.plan_id
     WHERE c.status = 'active' AND p.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM bereavement_opt_out o
                        WHERE o.bereaved_contact_id = c.id AND o.rescinded_at IS NULL
                          AND o.opt_out_kind IN ('full', 'pause_temporarily'))
       AND p.death_date <= ${day}::date
       AND p.death_date > (${day}::date - make_interval(months => ${service.inviteWindowMonths}))::date
     ORDER BY c.id`);
  return (rows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
}

/** Invite every eligible family; returns how many were invited and the drafted run (null when nobody can receive post). */
export async function inviteForMemorial(
  tx: DbClient,
  service: {
    readonly id: string;
    readonly organizationId: string;
    readonly startsAt: Date;
    readonly inviteWindowMonths: number;
  },
  at: Date,
): Promise<{ readonly invited: number; readonly mailingRunId: string | null }> {
  const INV = schema.bereavementMemorialInvitation;
  const RUN = schema.bereavementMailingRun;
  const ids = await inviteeIds(tx, service);
  if (ids.length === 0) return { invited: 0, mailingRunId: null };
  const candidates = await loadMailingCandidates(
    tx,
    { kind: "contacts", contactIds: ids },
    { audience: null, emailChannelAvailable: false },
  );
  const rows = candidates.map((c) => ({
    organizationId: service.organizationId,
    providerEntityId: c.providerEntityId,
    locationId: c.locationId,
    serviceId: service.id,
    planId: c.planId,
    bereavedContactId: c.contactId,
    delivery: decideMailingEligibility(c.facts).eligible
      ? ("mailing" as const)
      : ("portal_only" as const),
    version: 1,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await tx
      .insert(INV)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing();
  }
  if (!rows.some((r) => r.delivery === "mailing")) {
    return { invited: rows.length, mailingRunId: null };
  }
  const occurrenceKey = `memorial_invitation:${service.id}`;
  await tx
    .insert(RUN)
    .values({
      organizationId: service.organizationId,
      runKind: "memorial_invitation",
      mailingKey: null,
      occurrenceKey,
      sourceRefId: service.id,
      scheduledFor: at.toISOString().slice(0, 10),
      status: "draft",
      contentJsonb: {},
      version: 1,
    })
    .onConflictDoNothing();
  const [run] = await tx
    .select({ id: RUN.id })
    .from(RUN)
    .where(eq(RUN.occurrenceKey, occurrenceKey))
    .limit(1);
  return { invited: rows.length, mailingRunId: run?.id ?? null };
}

/**
 * The contacts a `memorial_invitation` run selects at `generate`: the service's `mailing` invitees who have not declined or been withdrawn. The
 * mailing rule then decides each one again (a family that opted out since publish is excluded with its reason).
 */
export async function memorialMailingInviteeIds(
  tx: DbClient,
  serviceId: string,
): Promise<string[]> {
  const INV = schema.bereavementMemorialInvitation;
  const rows = await tx
    .select({ contactId: INV.bereavedContactId })
    .from(INV)
    .where(
      and(
        eq(INV.serviceId, serviceId),
        eq(INV.delivery, "mailing"),
        notInArray(INV.status, ["rsvp_no", "withdrawn"]),
      ),
    );
  return rows.map((r) => r.contactId);
}

/** Cancel a service's invitation run while it has not gone out (draft | ready | failed). Returns true when one was cancelled. */
export async function cancelUnmailedMemorialRun(
  tx: DbClient,
  runId: string | null,
  at: Date,
): Promise<boolean> {
  if (runId === null) return false;
  const RUN = schema.bereavementMailingRun;
  const rows = await tx
    .update(RUN)
    .set({ status: "cancelled", version: sql`${RUN.version} + 1`, updatedAt: at })
    .where(and(eq(RUN.id, runId), inArray(RUN.status, ["draft", "ready", "failed"])))
    .returning({ id: RUN.id });
  return rows.length > 0;
}
