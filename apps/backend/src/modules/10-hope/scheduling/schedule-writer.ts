// apps/backend/src/modules/10-hope/scheduling/schedule-writer.ts — #48, the `hope_timepoint_schedule`
// WRITE path.
//
// `hope_timepoint_schedule` is M10's §2.2.1 window ledger: the table the CMS capture windows, the
// `hope-window-watchdog` cron, the late-deadline math, the timepoint worklist and the on-time compliance
// rate are all built on. Until this file NOTHING in the repo ever inserted a row into it. The pure
// planners shipped in M10-T03 (`planAdmissionTimepoints` / `planDischargeTimepoint`) and the
// `m10.hope.timepoint_scheduled` catalog entry that describes exactly this handshake both existed; the
// code that would call them did not. The observable result was a compliance dashboard reporting a
// perfect on-time rate over an empty denominator (#48).
//
// Two callers share it: the `m6.admission.activated` / `m6.admission.discharged` outbox consumer
// (../outbox-consumers/m6-admission-scheduling.ts — the normal path), and the §4.1 route 20 admin
// regenerate, which is how an operator materializes windows for an admission that was activated before
// this shipped or whose dates were corrected after the fact.
//
// FAILS CLOSED — an admission the M6 seam cannot project, or one still missing its provider entity /
// location, throws. `hope_timepoint_schedule.provider_entity_id` / `.location_id` are NOT NULL precisely
// so a schedule cannot be sited at a guessed place; the consumer dead-letters and the route 422s.
import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_ORG_TIME_ZONE,
  HopeStateError,
  type TimepointScheduleDescriptor,
  orgLocalDate,
  planAdmissionTimepoints,
  planDischargeTimepoint,
} from "@wardenx/hope";
import { withOrgContext } from "@wardenx/tenancy";
import type { HopeRfaKind, LocalDate } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { HopeWriteOutboxPort } from "../hope-route-service-db";

const SCHED = schema.hopeTimepointSchedules;

/** Where the org-local calendar-day math gets its timezone. No per-org timezone seam exists yet, so this
 * is the same platform constant M10's own watchdog cron-store and M6/M7/M15 all fall back to. */
export const HOPE_SCHEDULE_TIME_ZONE = DEFAULT_ORG_TIME_ZONE;

/** The admission facts a schedule row is sited by — every one read through M6's published §4.7 seam, so
 * M10 gains no schema edge on M6 (§11). */
export interface SchedulingSiting {
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  /** Org-local `yyyy-mm-dd` the admission-anchored CMS windows count from (SOC = day 1). */
  readonly anchorDate: LocalDate | null;
  /** Org-local `yyyy-mm-dd` the 7-day Discharge RFA window counts from, when the admission is closed. */
  readonly dischargeDate: LocalDate | null;
}

/** Raise the M10 §4.4-shaped refusal (422) rather than a bare Error, so a route surfaces a typed code
 * and a dispatcher delivery still dead-letters on the throw. */
function gap(message: string): never {
  throw new HopeStateError("M10_ADMISSION_PROJECTION_GAP", message);
}

/**
 * The raw admission projection this module sites a schedule from, BEFORE the non-null demands below.
 * Nullable throughout: whoever resolves it does not decide what a missing fact means.
 */
export interface AdmissionSitingFacts {
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly admissionAt: string | null;
  readonly activatedAt: string | null;
  readonly dischargedAt: string | null;
}

/**
 * How this module learns about an admission. Injected rather than fixed, because the two callers stand
 * in different places:
 *
 *   · the §4.1 route-20 regenerate runs inside a REQUEST, so the default below — M6's published §4.7
 *     `AdmissionStatusReader` seam — is exactly right and pins the tenant from the ambient scope;
 *   · the outbox consumer runs in the RELAY, which is not a request. The seam's id-keyed reads open
 *     `withOrgContextFromRequest` and throw `no ambient request context (call inside
 *     runWithRequestContext)` there — found by running the dispatcher for real, after the live tests
 *     (which register a seam double) passed. The composition root binds it to M6's org-explicit
 *     `admissionSchedulingContextForOrg` instead, the same shape `activeAdmissionDraftContextForPatient`
 *     and `admissionIsActiveForOrg` already take for background consumers.
 *
 * Either way M10 holds no M6 schema edge: one is a seam, the other an M6-exported function the
 * composition root injects.
 */
export type AdmissionSitingResolver = (
  organizationId: string,
  admissionId: string,
) => Promise<AdmissionSitingFacts | null>;

/** The default resolver: M6's §4.7 seam. Request-scoped — see {@link AdmissionSitingResolver}. */
export const seamAdmissionSitingResolver: AdmissionSitingResolver = async (
  organizationId,
  admissionId,
) => {
  const summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(admissionId);
  if (summary.organizationId !== organizationId) return null;
  return {
    patientId: summary.patientId,
    providerEntityId: summary.providerEntityId,
    locationId: summary.locationId ?? null,
    admissionAt: summary.admissionAt,
    activatedAt: summary.activatedAt,
    dischargedAt: summary.dischargedAt,
  };
};

/**
 * Project the admission, then demand every field a schedule row needs non-null. Refusing is the whole
 * point: a window sited at a guessed provider entity is worse than no window, because the watchdog
 * would then expire it against the wrong org's clock.
 */
export async function schedulingSitingFor(
  organizationId: string,
  admissionId: string,
  resolve: AdmissionSitingResolver = seamAdmissionSitingResolver,
): Promise<SchedulingSiting> {
  const facts = await resolve(organizationId, admissionId);
  if (!facts) {
    gap(`Admission ${admissionId} is not visible in this organization.`);
  }
  const { patientId, providerEntityId, locationId } = facts;
  if (!providerEntityId || !locationId) {
    gap(
      `Admission ${admissionId} is not sited (provider_entity_id=${providerEntityId ?? "null"}, location_id=${locationId ?? "null"}) — refusing to create a HOPE timepoint schedule with a guessed provider entity or location.`,
    );
  }
  return {
    patientId,
    providerEntityId,
    locationId,
    anchorDate: facts.activatedAt ?? facts.admissionAt ?? null,
    dischargeDate: facts.dischargedAt ?? null,
  };
}

/**
 * The CMS windows count in org-LOCAL calendar days, so an anchor has to be a `yyyy-mm-dd`. M6 sends
 * `activatedAt` as an instant and `dischargeDate` as whatever the caller's `effectiveAt` was, which is
 * sometimes already a date. Both shapes are accepted; anything else throws rather than silently
 * anchoring a federal window on a misparsed value.
 */
export function anchorDateOf(value: string, timeZone: string, label: string): LocalDate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value as LocalDate;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) gap(`Malformed ${label} '${value}' on a HOPE scheduling event.`);
  return orgLocalDate(new Date(parsed).toISOString(), timeZone);
}

/**
 * Persist the planned descriptors, skipping any RFA that already has a schedule row on this admission
 * IN ANY STATUS, and emit `m10.hope.timepoint_scheduled` for each row actually created.
 *
 * The schema's `uniq_hope_sched_admission_rfa_open` partial index only covers `status='open'`, so it
 * alone would let a redelivery mint a SECOND window for an RFA whose first one was already completed or
 * expired — a duplicate obligation the watchdog would then expire. The explicit pre-check is the real
 * idempotency; `onConflictDoNothing` stays as the race backstop between two concurrent deliveries.
 *
 * Returns the ids created (empty when everything was already scheduled).
 */
export async function writeSchedules(
  db: DbClient,
  outbox: HopeWriteOutboxPort,
  input: {
    readonly organizationId: string;
    readonly admissionId: string;
    readonly siting: SchedulingSiting;
    readonly descriptors: readonly TimepointScheduleDescriptor[];
  },
): Promise<readonly string[]> {
  if (input.descriptors.length === 0) return [];
  const wanted = input.descriptors.map((d) => d.rfaKind);
  return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
    const t = tx as unknown as DbClient;
    const existing = (await t
      .select({ rfaKind: SCHED.rfaKind })
      .from(SCHED)
      .where(
        and(
          eq(SCHED.organizationId, input.organizationId),
          eq(SCHED.admissionId, input.admissionId),
          inArray(SCHED.rfaKind, wanted as HopeRfaKind[]),
        ),
      )) as { rfaKind: HopeRfaKind }[];
    const already = new Set(existing.map((r) => r.rfaKind));
    const todo = input.descriptors.filter((d) => !already.has(d.rfaKind));
    if (todo.length === 0) return [];

    const rows = (await t
      .insert(SCHED)
      .values(
        todo.map((d) => ({
          organizationId: input.organizationId,
          providerEntityId: input.siting.providerEntityId,
          locationId: input.siting.locationId,
          patientId: input.siting.patientId,
          admissionId: input.admissionId,
          rfaKind: d.rfaKind,
          windowOpensAt: new Date(d.window.windowOpensAt),
          windowClosesAt: new Date(d.window.windowClosesAt),
          lateDeadlineAt: new Date(d.window.lateDeadlineAt),
          alertCadence: d.alertCadence as unknown as Record<string, unknown>,
          generatedBy: d.generatedBy,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: SCHED.id,
        rfaKind: SCHED.rfaKind,
        windowOpensAt: SCHED.windowOpensAt,
        windowClosesAt: SCHED.windowClosesAt,
        lateDeadlineAt: SCHED.lateDeadlineAt,
      })) as {
      id: string;
      rfaKind: HopeRfaKind;
      windowOpensAt: Date;
      windowClosesAt: Date;
      lateDeadlineAt: Date;
    }[];

    // §2.4 — `m10.hope.timepoint_scheduled` was declared in the catalog and never once emitted, for the
    // same reason the table was never written: this handshake did not exist. M14 surfaces open windows.
    for (const row of rows) {
      await outbox.publish(t, {
        eventName: "m10.hope.timepoint_scheduled",
        organizationId: input.organizationId,
        aggregateKind: "hope_timepoint_schedule",
        aggregateId: row.id,
        payload: {
          scheduleId: row.id,
          rfaKind: row.rfaKind,
          windowOpensAt: row.windowOpensAt.toISOString(),
          windowClosesAt: row.windowClosesAt.toISOString(),
          lateDeadlineAt: row.lateDeadlineAt.toISOString(),
        },
      });
    }
    return rows.map((r) => r.id);
  });
}

/**
 * Materialize every window an admission is currently entitled to, from its own state — the §4.1 route 20
 * admin regenerate. Idempotent, so an operator can run it on an admission that already has some windows
 * (a post-hoc date correction, or a backfill for an admission activated before #48 shipped) and only the
 * missing ones are created.
 *
 * An admission with no activation date yet has no anchor and gets nothing: the CMS windows count from
 * SOC, and there is no honest window before there is a start of care.
 */
export async function regenerateSchedulesForAdmission(
  db: DbClient,
  outbox: HopeWriteOutboxPort,
  input: {
    readonly organizationId: string;
    readonly admissionId: string;
    readonly timeZone?: string;
    readonly resolveSiting?: AdmissionSitingResolver;
  },
): Promise<readonly string[]> {
  const timeZone = input.timeZone ?? HOPE_SCHEDULE_TIME_ZONE;
  const siting = await schedulingSitingFor(
    input.organizationId,
    input.admissionId,
    input.resolveSiting,
  );
  const descriptors: TimepointScheduleDescriptor[] = [];
  if (siting.anchorDate !== null) {
    descriptors.push(...planAdmissionTimepoints({ anchorDate: siting.anchorDate, timeZone }));
  }
  if (siting.dischargeDate !== null) {
    descriptors.push(planDischargeTimepoint({ dischargeDate: siting.dischargeDate, timeZone }));
  }
  return writeSchedules(db, outbox, {
    organizationId: input.organizationId,
    admissionId: input.admissionId,
    siting,
    descriptors,
  });
}
