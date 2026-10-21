// apps/backend/src/modules/19-oncall/consumers/trigger-ports-drizzle.ts — the production
// {@link InboundTriggerPorts} (F-043 / #103).
//
// `./trigger-context` declares these three reads as an INJECTED PORT rather than a seam, and says why:
// they read M19's OWN `triage_call` and `on_call_shift` rows, so there is no module boundary to cross, and
// "the Drizzle implementation belongs to the M19-T07 service layer". It never landed. The §9 tests
// implement the port in memory, `decideNoShowTrigger` / `decideLateCheckoutTrigger` were called by nothing
// else, and the result was that NO PROACTIVE TRIAGE CALL HAS EVER BEEN OPENED: `triage_call.source` has six
// enum values and the two live insert paths hardcode `manual` and `paper_origin`, so `no_show`,
// `late_checkout`, `m36_delivery_failure` and `geofence_anomaly` were unreachable, and
// `source_outbox_event_id` — the D10 redelivery guard `triage_call_source_dedupe_uq` is built on — had
// never been written by anything.
//
// EVERY READ OPENS ITS OWN `withOrgContext`, AND THE FIRST DRAFT DID NOT — WHICH IS HOW THIS COMMENT GOT
// LONGER THAN THE FILE DESERVES. `binding.handle` runs with no ambient org context, so a port reading on
// the bare pool has `app.org_id` unset. That does NOT fail closed to "no rows": once ANY transaction on
// that pooled connection has run `set_config('app.org_id', …, true)`, the GUC reverts after commit to the
// SESSION value — which for a custom GUC never set at session level is the EMPTY STRING, not NULL. So
// `current_setting('app.org_id', true)::uuid` in the RLS predicate becomes `''::uuid` and the read throws
// `22P02 invalid input syntax for type uuid: ""`. In a fresh process it would instead have matched
// nothing, silently: `findCallBySourceEvent` answering null for a call that exists is a DUPLICATE welfare
// call on every redelivery, which is precisely the failure D10's guard exists to prevent. Scoping each
// read is the fix; the symptom being loud on a busy connection and silent on an idle one is why it is
// written down.
//
// EVERY READ IS ALSO SCOPED BY `organization_id` IN THE PREDICATE. That is the ADR-0010 D3 belt-and-braces
// the rest of the module writes, and it matters most for `findCallBySourceEvent`: that read is keyed on an
// outbox event id, which is unique across the whole DEPLOYMENT rather than within a tenant, so it is the
// one query here that could address another tenant's row at all.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, OnCallShiftId, ProviderEntityId, TriageCallId } from "@chartwarden/types";
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { CoveringShiftCandidate } from "./inbound-trigger";
import type { DeliveryFailureTriggerPorts, InboundTriggerPorts } from "./trigger-context";

const CALL = schema.triageCall;
const SHIFT = schema.onCallShift;

/** §3.3 — a consumer-driven read names no acting membership (the dispatcher's own convention). */
const PORT_USER_ID = "";

/**
 * The call states that mean "this welfare check is still live", for the §2.6 coalesce grain.
 *
 * The same set `triage_call_open_pe_idx` (a plain partial index, not unique) uses: a call in ANY of them is one a nurse is
 * still working, so a second machine-opened call about the same patient would be a second page about a
 * problem somebody is already on. `documented` and `closed` are absent because a closed call is history —
 * a NEW no-show an hour later is a new problem and deserves its own row.
 */
const OPEN_CALL_STATES = [
  "open",
  "protocol_in_progress",
  "awaiting_callback",
  "disposition_pending",
  "documented_pending_encounter",
  "escalated_unresolved",
] as const;

/**
 * Shifts whose window could contain the trigger instant, for `resolveCoveringShift` to rank.
 *
 * The window test itself is `shiftCoversInstant`'s (pure, in `../roster/shift-machine`) — this only
 * narrows the candidate set, and it narrows it WIDER than the final test on purpose: it includes shifts
 * that merely overlap the §4.8 lookahead so `resolveGapWindow` can report the gap as running to the next
 * shift that starts rather than to the end of a 24-hour window. A candidate list narrowed to exactly the
 * covering shifts would make every gap report the maximum length.
 */
const LOOKAHEAD_HOURS = 24;

/** The production {@link InboundTriggerPorts} over M19's own tables. */
export function createDrizzleInboundTriggerPorts(
  db: DbClient,
): InboundTriggerPorts & DeliveryFailureTriggerPorts {
  return {
    async findCallBySourceEvent(organizationId, sourceOutboxEventId) {
      return withOrgContext(db, { organizationId, userId: PORT_USER_ID }, async (tx) => {
        const [row] = await (tx as DbClient)
          .select({ id: CALL.id })
          .from(CALL)
          .where(
            and(
              eq(CALL.organizationId, organizationId),
              eq(CALL.sourceOutboxEventId, sourceOutboxEventId),
            ),
          )
          .limit(1);
        return (row?.id as TriageCallId | undefined) ?? null;
      });
    },

    async findOpenMachineCallForPatient(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: PORT_USER_ID }, async (tx) => {
        const [row] = await (tx as DbClient)
          .select({ id: CALL.id })
          .from(CALL)
          .where(
            and(
              eq(CALL.organizationId, organizationId),
              eq(CALL.patientId, patientId),
              inArray(CALL.state, [...OPEN_CALL_STATES] as never),
              // MACHINE-opened only. A caregiver who rang in about the same patient an hour ago is not a
              // reason to swallow the system's own welfare check: the nurse on that call does not know a
              // clinician has since failed to arrive, and `./inbound-trigger` sets the grain at "an open
              // call a MACHINE opened" for exactly that reason.
              sql`${CALL.sourceOutboxEventId} IS NOT NULL`,
            ),
          )
          .orderBy(CALL.openedAt)
          .limit(1);
        return (row?.id as TriageCallId | undefined) ?? null;
      });
    },

    async candidateShiftsForProviderEntity(organizationId, providerEntityId, at) {
      const from = new Date(at);
      const to = new Date(from.getTime() + LOOKAHEAD_HOURS * 3_600_000);
      const rows = await withOrgContext(db, { organizationId, userId: PORT_USER_ID }, (tx) =>
        (tx as DbClient)
          .select({
            shiftId: SHIFT.id,
            providerEntityId: SHIFT.providerEntityId,
            version: SHIFT.version,
            discipline: SHIFT.discipline,
            status: SHIFT.status,
            shiftStartsAt: SHIFT.shiftStartsAt,
            shiftEndsAt: SHIFT.shiftEndsAt,
            primaryOnCallMembershipId: SHIFT.primaryOnCallMembershipId,
            externalActorId: SHIFT.externalActorId,
            openedAt: SHIFT.openedAt,
            closedAt: SHIFT.closedAt,
          })
          .from(SHIFT)
          .where(
            and(
              eq(SHIFT.organizationId, organizationId),
              eq(SHIFT.providerEntityId, providerEntityId),
              inArray(SHIFT.status, ["scheduled", "active"] as never),
              // Overlaps [at, at + lookahead): starts before the window ends AND ends after it begins. A
              // shift already running when the trigger fires is the common case and is caught by the second
              // conjunct; the first is what admits the NEXT shift, which the gap window needs.
              lte(SHIFT.shiftStartsAt, to),
              or(gte(SHIFT.shiftEndsAt, from), eq(SHIFT.shiftEndsAt, from)),
            ),
          )
          .orderBy(SHIFT.shiftStartsAt),
      );

      return rows.map(
        (row): CoveringShiftCandidate => ({
          shiftId: row.shiftId as OnCallShiftId,
          providerEntityId: row.providerEntityId as ProviderEntityId,
          version: row.version,
          discipline: row.discipline as CoveringShiftCandidate["discipline"],
          status: row.status as CoveringShiftCandidate["status"],
          shiftStartsAt: row.shiftStartsAt.toISOString() as IsoInstant,
          shiftEndsAt: row.shiftEndsAt.toISOString() as IsoInstant,
          primaryOnCallMembershipId:
            row.primaryOnCallMembershipId as CoveringShiftCandidate["primaryOnCallMembershipId"],
          externalActorId: row.externalActorId as CoveringShiftCandidate["externalActorId"],
          openedAt: row.openedAt === null ? null : (row.openedAt.toISOString() as IsoInstant),
          closedAt: row.closedAt === null ? null : (row.closedAt.toISOString() as IsoInstant),
        }),
      );
    },

    async isCallOpen(organizationId, triageCallId) {
      return withOrgContext(db, { organizationId, userId: PORT_USER_ID }, async (tx) => {
        const [row] = await (tx as DbClient)
          .select({ state: CALL.state })
          .from(CALL)
          .where(and(eq(CALL.organizationId, organizationId), eq(CALL.id, triageCallId)))
          .limit(1);
        return row !== undefined && (OPEN_CALL_STATES as readonly string[]).includes(row.state);
      });
    },
  };
}
