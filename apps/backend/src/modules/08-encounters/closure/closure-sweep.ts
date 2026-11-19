// apps/backend/src/modules/08-encounters/closure/closure-sweep.ts — the visit-note closure ALERT sweep (ADR-0113 D5).
//
// The body of the `encounter.attention` cron (every 15 minutes; it REPLACES the old age-less `m8.encounter.unsigned` /
// `m8.encounter.documentation_late` sweep, so there is one alert stream). Per active organization it reads the tenant policy and the
// CLOCKED OPEN notes, lets the pure clock (note-clock.ts) decide each note's TRUE stage (`enforceFrom` only delays blocking, never an
// alert), and emits `m8.encounter.closure_at_risk | closure_overdue | closure_escalated` for each note's CURRENT stage that has not
// been alerted yet. There is NO time window: a stage is emitted whenever it is due and its alert does not exist, so a late EVV
// instant, a lowered threshold or a worker outage never skips an alert that the request-time gate can still block on. "Not alerted
// yet" is one batched read of the alert table's `(organization, correlation id)` keys per organization (injected, because the alert
// table belongs to M36), which also spares the emitter the recipient resolution it does BEFORE it de-duplicates; the emitter's own
// unique `(organization, correlation id)` stays the backstop for a race between two ticks. There is no overdue predicate in the SQL:
// it only finds the open clocked notes; the pure function decides.
//
// A legacy draft with no clock is never selected, so it never alerts. Mode `off` skips the organization; `warn` and `block` both
// alert (the block is the request-time gate's concern). An author who is no longer an ACTIVE member cannot be told anything: the
// author-only stages are skipped for them, and the escalation still goes to the supervisors, with no author on the payload. Payloads
// are ids and instants only: no patient, no note text.
import { type DbClient, schema } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { M8ClosureAlertPayload, M8ClosureAlertPayloadType } from "@chartwarden/types";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type NoteClosureAlertStage, decideNoteClosure } from "./note-clock";
import { OPEN_NOTE_STATUS_LIST_SQL } from "./open-status";
import { type ClosurePolicy, readClosurePolicy } from "./policy-service";

const MS_PER_HOUR = 3_600_000;

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
  /**
   * The author's USER id (the alert recipient; `membership.user_id`), not the membership id; null when the author is no longer an
   * ACTIVE member (the recipient resolver only accepts active members' ids), so there is no author to tell.
   */
  readonly authorUserId: string | null;
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
 * PURE: the alerts due for `notes` at `now`: one per note whose true stage is not `ok`, for that CURRENT stage only (an earlier stage
 * a note already passed is never emitted retroactively). Mode `off` yields none. A note whose author is no longer an active member
 * yields only its escalation (the supervisors still need it), with a null `authorUserId`. Throws RangeError when the pure clock
 * rejects the threshold.
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
    // `at_risk` and `overdue` go to the author alone: with no active author there is nobody to tell.
    if (note.authorUserId === null && stage !== "escalated") return [];
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
 * author's user id comes from the membership, and is null for an author who is no longer an active member.
 *
 * ponytail: deliberately UNBOUNDED in time and in rows. The partial index holds only open clocked notes, so the read is bounded by
 * the organization's unsigned backlog, and an age ceiling would be wrong now that the alert lookback is gone: a note whose
 * escalation was never sent must still be found however old it is. A LIMIT would starve the YOUNGEST notes (oldest-first order),
 * and the freshest crossings are exactly the ones that need an alert. A floor on `clock_started_at` (skip notes younger than
 * `T - 6h`) would only skip not-yet-alertable notes, at the price of restating a stage boundary in SQL, where the pure clock owns
 * it; add that floor only if a tenant ever carries tens of thousands of open notes.
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
        authorStatus: M.status,
        providerEntityId: E.providerEntityId,
      })
      .from(E)
      .innerJoin(M, and(eq(M.id, E.authoredByMembershipId), eq(M.organizationId, organizationId)))
      .where(
        and(
          eq(E.organizationId, organizationId),
          // A literal list (not bind parameters) so the planner can prove the partial-index predicate.
          sql`${E.status} IN ${OPEN_NOTE_STATUS_LIST_SQL}`,
          isNotNull(E.clockStartedAt),
        ),
      )
      .orderBy(asc(E.clockStartedAt), asc(E.id));
    const notes = rows.flatMap(({ clockStartedAt, authorStatus, authorUserId, ...rest }) =>
      clockStartedAt === null
        ? []
        : [
            {
              ...rest,
              clockStartedAt,
              authorUserId: authorStatus === "active" ? authorUserId : null,
            },
          ],
    );
    return { policy, notes };
  });
}

/** Which of `correlationIds` already have an alert in the organization (M36 owns the alert table, so the composition root injects this). */
export type ExistingAlertCorrelations = (
  organizationId: string,
  correlationIds: readonly string[],
) => Promise<ReadonlySet<string>>;

export interface NoteClosureSweepDeps {
  readonly listActiveOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly scanOrg: (organizationId: string) => Promise<OrgClosureScan>;
  readonly emit: AlertEmitter["emit"];
  /**
   * The batched "already alerted?" read. Absent means "assume none": every due alert is emitted and the emitter's unique
   * `(organization, correlation id)` de-duplicates (correct, only slower, since recipients are resolved first).
   */
  readonly existingCorrelations?: ExistingAlertCorrelations;
  readonly now: () => Date;
}

export interface NoteClosureSweepSummary {
  readonly orgs: number;
  readonly emitted: number;
}

const NO_CORRELATIONS: ReadonlySet<string> = new Set();

/** The alerts due for one organization that have not been emitted yet (the pure plan minus the alert table's existing keys). */
async function missingAlerts(
  deps: NoteClosureSweepDeps,
  organizationId: string,
  scan: OrgClosureScan,
  now: Date,
): Promise<readonly ClosureAlert[]> {
  const planned = planClosureAlerts(scan.notes, scan.policy, now);
  if (planned.length === 0 || deps.existingCorrelations === undefined) return planned;
  const existing =
    (await deps.existingCorrelations(
      organizationId,
      planned.map((alert) => alert.correlationId),
    )) ?? NO_CORRELATIONS;
  return planned.filter((alert) => !existing.has(alert.correlationId));
}

/**
 * Emit every alert in `alerts` for one organization. A failing emit never stops the rest of the organization's alerts (one
 * deterministically failing note must not shadow the younger ones behind it); the failures are collected and rethrown together
 * after the last. Returns how many were emitted.
 */
async function emitAll(
  deps: NoteClosureSweepDeps,
  organizationId: string,
  alerts: readonly ClosureAlert[],
): Promise<number> {
  const failures: unknown[] = [];
  let emitted = 0;
  for (const alert of alerts) {
    try {
      await deps.emit(organizationId, alert);
      emitted += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${alerts.length} alert emit(s) failed`,
    );
  }
  return emitted;
}

/**
 * One pass over every active organization. A failure in one organization (including a RangeError from a bad threshold) never stops
 * the others, and a failing emit never stops the rest of its own organization; after the last one the failures are rethrown
 * together, so the job still shows as failed. The message names organization ids only (never a note, a patient or a user).
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
      const scan = await deps.scanOrg(organizationId);
      emitted += await emitAll(
        deps,
        organizationId,
        await missingAlerts(deps, organizationId, scan, now),
      );
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
