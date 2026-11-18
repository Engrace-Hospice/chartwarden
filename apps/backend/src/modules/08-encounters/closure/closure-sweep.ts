// apps/backend/src/modules/08-encounters/closure/closure-sweep.ts — the visit-note closure ALERT sweep (ADR-0113 D5).
//
// The body of the `encounter.attention` cron (every 15 minutes; it REPLACES the old age-less `m8.encounter.unsigned` /
// `m8.encounter.documentation_late` sweep, so there is one alert stream). Per active organization it reads the tenant policy and the
// CLOCKED OPEN notes, lets the pure clock (note-clock.ts) decide each note's TRUE stage (`enforceFrom` only delays blocking, never an
// alert), and emits `m8.encounter.closure_at_risk | closure_overdue | closure_escalated` for the notes whose CURRENT stage began
// within the lookback. There is no overdue predicate in the SQL: it only finds the open clocked notes; the pure function decides.
//
// A legacy draft with no clock is never selected, so it never alerts. Mode `off` skips the organization; `warn` and `block` both
// alert (the block is the request-time gate's concern). Payloads are ids and instants only: no patient, no note text.
import { type DbClient, schema } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { M8ClosureAlertPayload, M8ClosureAlertPayloadType } from "@chartwarden/types";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type NoteClosureAlertStage, decideNoteClosure, stageBeginsAt } from "./note-clock";
import { type ClosurePolicy, readClosurePolicy } from "./policy-service";

const MS_PER_HOUR = 3_600_000;

/**
 * Only a note whose CURRENT stage began within this long of the tick is emitted. The cron runs every 15 minutes and the emitter
 * de-duplicates on (organization, correlationId) but resolves rules and recipients BEFORE it de-duplicates, so re-emitting every
 * open note every tick would pay that resolution thousands of times for nothing. Two hours keeps eight ticks of retry headroom.
 * ponytail: a worker outage longer than this skips a stage crossing (that stage is never alerted); upgrade = a larger lookback, at
 * the cost of more de-duplicated re-emits per tick.
 */
export const CLOSURE_ALERT_LOOKBACK_MS = 2 * MS_PER_HOUR;

/** Slice 1 alerts one obligation kind. */
const OBLIGATION_KIND = "visit_note";

/** In-app link on every closure alert: the author's open-notes work surface (`encounter.my-drafts`, apps/web 08-encounters). */
export const CLOSURE_ALERT_DEEP_LINK = "/work/drafts";

/** The alert severity per stage (ADR-0113 D5: info, warn, warn; never critical). */
const STAGE_SEVERITY: Readonly<Record<NoteClosureAlertStage, "info" | "warn">> = {
  at_risk: "info",
  overdue: "warn",
  escalated: "warn",
};

const E = schema.encounters;
const M = schema.memberships;

/** One clocked open note as the sweep reads it: ids and the clock instant, nothing clinical. */
export interface ClosureSweepNote {
  readonly encounterId: string;
  readonly clockStartedAt: Date;
  /** The author's USER id (the alert recipient; `membership.user_id`), not the membership id. */
  readonly authorUserId: string;
  /** The encounter's provider entity, or null for a draft with no site (escalation then falls back org-wide). */
  readonly providerEntityId: string | null;
}

/** What the sweep needs from one organization: its policy and its clocked open notes (none when the mode is `off`). */
export interface OrgClosureScan {
  readonly policy: ClosurePolicy;
  readonly notes: readonly ClosureSweepNote[];
}

/** One alert the sweep will hand to `AlertEmitter.emit`. */
export interface ClosureAlert {
  readonly eventType: M8ClosureAlertPayloadType;
  readonly severity: "info" | "warn";
  readonly correlationId: string;
  readonly payload: M8ClosureAlertPayload;
}

/** `m8:closure:visit_note:<encounterId>:<stage>`: one page per note per stage, de-duplicated by the emitter. */
export function closureAlertCorrelationId(
  encounterId: string,
  stage: NoteClosureAlertStage,
): string {
  return `m8:closure:${OBLIGATION_KIND}:${encounterId}:${stage}`;
}

/**
 * PURE: the alerts due for `notes` at `now`. A note yields one only when its true stage is not `ok` and that stage began within
 * {@link CLOSURE_ALERT_LOOKBACK_MS}. Mode `off` yields none. Throws RangeError when the pure clock rejects the threshold.
 */
export function planClosureAlerts(
  notes: readonly ClosureSweepNote[],
  policy: ClosurePolicy,
  now: Date,
): readonly ClosureAlert[] {
  if (policy.mode === "off") return [];
  return notes.flatMap((note) => {
    const decision = decideNoteClosure({
      clockStartedAt: note.clockStartedAt,
      asOf: now,
      thresholdHours: policy.thresholdHours,
      // The alert stage is the true stage; enforceFrom is only the blocking grace window.
      enforceFrom: null,
    });
    const { stage, deadlineAt } = decision;
    if (stage === "ok" || deadlineAt === null) return [];
    const stageAgeMs =
      now.getTime() - stageBeginsAt(note.clockStartedAt, policy.thresholdHours, stage).getTime();
    if (stageAgeMs < 0 || stageAgeMs > CLOSURE_ALERT_LOOKBACK_MS) return [];
    return [
      {
        eventType: `m8.encounter.closure_${stage}` as const,
        severity: STAGE_SEVERITY[stage],
        correlationId: closureAlertCorrelationId(note.encounterId, stage),
        payload: {
          obligationKind: OBLIGATION_KIND,
          encounterId: note.encounterId,
          authorUserId: note.authorUserId,
          providerEntityId: note.providerEntityId,
          stage,
          deadlineAt: deadlineAt.toISOString(),
          hoursOverdue: Math.floor(decision.hoursOverdue),
          deepLink: CLOSURE_ALERT_DEEP_LINK,
        },
      },
    ];
  });
}

/**
 * One organization's policy and clocked open notes, under that organization's RLS context (a cron is not a request, so the context
 * is org-explicit). Mode `off` reads no notes. The note query is the partial index `encounter_open_clock_idx`'s predicate; the
 * author's user id comes from the membership.
 * ponytail: no row cap and no coarse `clock_started_at` prefilter, because the partial index already bounds the read to the
 * organization's open clocked notes; add a prefilter on `clock_started_at` if a tenant ever carries tens of thousands of them.
 */
export async function scanOrgClosureState(
  db: DbClient,
  organizationId: string,
): Promise<OrgClosureScan> {
  return withOrgContext(db, systemOrgContext(organizationId), async (txRaw) => {
    const tx = txRaw as DbClient;
    const policy = await readClosurePolicy(tx, organizationId, OBLIGATION_KIND);
    if (policy.mode === "off") return { policy, notes: [] };
    const rows = await tx
      .select({
        encounterId: E.id,
        clockStartedAt: E.clockStartedAt,
        authorUserId: M.userId,
        providerEntityId: E.providerEntityId,
      })
      .from(E)
      .innerJoin(M, and(eq(M.id, E.authoredByMembershipId), eq(M.organizationId, organizationId)))
      .where(
        and(
          eq(E.organizationId, organizationId),
          // A literal list (not bind parameters) so the planner can prove the partial-index predicate.
          sql`${E.status} IN ('draft', 'finalized')`,
          isNotNull(E.clockStartedAt),
        ),
      )
      .orderBy(asc(E.clockStartedAt), asc(E.id));
    const notes = rows.flatMap(({ clockStartedAt, ...rest }) =>
      clockStartedAt === null ? [] : [{ ...rest, clockStartedAt }],
    );
    return { policy, notes };
  });
}

export interface NoteClosureSweepDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly scanOrg: (organizationId: string) => Promise<OrgClosureScan>;
  readonly emit: AlertEmitter["emit"];
  readonly now: () => Date;
}

export interface NoteClosureSweepSummary {
  readonly orgs: number;
  readonly emitted: number;
}

/**
 * One pass over every active organization. A failure in one organization (including a RangeError from a bad threshold) never stops
 * the others; after the last one the failures are rethrown together, so the job still shows as failed. The message names organization
 * ids only (never a note, a patient or a user).
 */
export async function runNoteClosureSweep(
  deps: NoteClosureSweepDeps,
): Promise<NoteClosureSweepSummary> {
  const now = deps.now();
  const orgs = await deps.listActiveOrgs();
  const failures: { readonly organizationId: string; readonly error: unknown }[] = [];
  let emitted = 0;
  for (const { organizationId } of orgs) {
    try {
      const { policy, notes } = await deps.scanOrg(organizationId);
      for (const alert of planClosureAlerts(notes, policy, now)) {
        await deps.emit(organizationId, alert);
        emitted += 1;
      }
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `M8_CLOSURE_SWEEP: ${failures.length} of ${orgs.length} org(s) failed: ${failures
        .map((f) => f.organizationId)
        .join(", ")}`,
    );
  }
  return { orgs: orgs.length, emitted };
}
