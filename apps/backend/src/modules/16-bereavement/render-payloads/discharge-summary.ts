// apps/backend/src/modules/16-bereavement/render-payloads/discharge-summary.ts — ADR-0109 D9.
//
// The PURE assembly of `BereavementDischargeSummaryRenderPayload` from the rows a closure reads: what the program OFFERED and what it
// DELIVERED per contact and cadence mark, the assessment checkpoints done and missed, the contacts it could not reach, each contact's
// open opt-outs and mailing scope, the tier trajectory and the closure facts. The input row types name only the columns the summary may
// draw; there is deliberately NO column for a counselor's contact notes, a care goal, a risk-factor vector, a free-text reason or
// substance-use data, so no later edit can leak one without first widening these types (and the typed M22 schema).
import { inferLegacyMark } from "@chartwarden/bereavement";
import type {
  BereavementAnniversaryMark,
  BereavementDischargeSummaryRenderPayload,
  BereavementOutreachKind,
  BereavementPlanClosureReason,
  BereavementRiskTier,
  DischargeSummaryContact,
  DischargeSummaryTierPoint,
  DischargeSummaryTotals,
  DischargeSummaryTouchpoint,
} from "@chartwarden/types";

type ContactStatus = DischargeSummaryContact["status"];
type TouchpointStatus = DischargeSummaryTouchpoint["status"];
type OptOutKind = DischargeSummaryContact["optOuts"][number]["optOutKind"];

export interface DischargeSummaryRows {
  readonly deathDate: string;
  readonly closure: {
    readonly closedAt: Date;
    readonly reason: BereavementPlanClosureReason;
    readonly closeKind: "auto" | "manual" | "cascade";
  };
  readonly contacts: ReadonlyArray<{
    readonly id: string;
    readonly relationship: string;
    readonly status: ContactStatus;
    readonly unreachableAt: Date | null;
    readonly createdAt: Date;
  }>;
  readonly outreach: ReadonlyArray<{
    readonly contactId: string;
    readonly cadenceMark: string | null;
    readonly kind: BereavementOutreachKind;
    readonly anniversaryMark: BereavementAnniversaryMark | null;
    readonly deathAnchorAt: Date;
    readonly dueAt: Date;
    readonly status: TouchpointStatus;
    readonly completedAt: Date | null;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly contactId: string;
    readonly taskKind: "initial_assessment" | "midpoint_reassessment";
    readonly status: "scheduled" | "completed" | "missed" | "cancelled";
    readonly dueAt: Date;
    readonly completedAt: Date | null;
  }>;
  readonly optOuts: ReadonlyArray<{
    readonly contactId: string;
    readonly optOutKind: OptOutKind;
    readonly channelKinds: readonly string[];
    readonly optedOutAt: Date;
    readonly rescindedAt: Date | null;
  }>;
  /** The risk-score ledger, plan-level (`contactId` null) and per contact: only the instant and the tier. */
  readonly scores: ReadonlyArray<{
    readonly contactId: string | null;
    readonly assessedAt: Date;
    readonly tier: BereavementRiskTier;
  }>;
  /** Every unsuccessful contact attempt in the log (no response, voicemail, wrong number, returned undeliverable). */
  readonly failedAttempts: ReadonlyArray<{ readonly contactId: string; readonly contactAt: Date }>;
}

/** A status that counts as the program having delivered the item: completed, or answered with a decline by the family. */
const DELIVERED: ReadonlySet<TouchpointStatus> = new Set(["completed", "declined"]);
/** A status that counts as missed: not done, or attempted with no answer. */
const MISSED: ReadonlySet<TouchpointStatus> = new Set(["missed", "no_response"]);
const OUTSTANDING: ReadonlySet<TouchpointStatus> = new Set(["scheduled", "in_progress"]);

const iso = (d: Date): string => d.toISOString();
const isoN = (d: Date | null): string | null => (d === null ? null : iso(d));
const byInstant =
  <T>(at: (row: T) => Date) =>
  (a: T, b: T) =>
    at(a).getTime() - at(b).getTime();

/** The tier points of a ledger slice, oldest first, keeping only the rows where the tier CHANGED. */
function trajectory(
  scores: ReadonlyArray<{ assessedAt: Date; tier: BereavementRiskTier }>,
): DischargeSummaryTierPoint[] {
  const out: DischargeSummaryTierPoint[] = [];
  for (const row of [...scores].sort(byInstant((r) => r.assessedAt))) {
    if (out[out.length - 1]?.tier === row.tier) continue;
    out.push({ at: iso(row.assessedAt), tier: row.tier });
  }
  return out;
}

function markOf(row: DischargeSummaryRows["outreach"][number]): string {
  if (row.cadenceMark !== null) return row.cadenceMark;
  return (
    inferLegacyMark({
      kind: row.kind,
      anniversaryMark: row.anniversaryMark,
      deathAnchorAt: iso(row.deathAnchorAt),
      dueAt: iso(row.dueAt),
    }) ?? "unmarked"
  );
}

function totalsOf(touchpoints: readonly DischargeSummaryTouchpoint[]): DischargeSummaryTotals {
  const count = (pred: (s: TouchpointStatus) => boolean): number =>
    touchpoints.filter((t) => pred(t.status)).length;
  return {
    offered: touchpoints.length,
    delivered: count((s) => DELIVERED.has(s)),
    missed: count((s) => MISSED.has(s)),
    cancelled: count((s) => s === "cancelled"),
    outstanding: count((s) => OUTSTANDING.has(s)),
  };
}

/** Assemble the typed payload. Pure: the same rows always give the same payload. */
export function buildDischargeSummaryPayload(
  rows: DischargeSummaryRows,
): BereavementDischargeSummaryRenderPayload {
  const byCreated = byInstant((c: DischargeSummaryRows["contacts"][number]) => c.createdAt);
  const contacts: DischargeSummaryContact[] = [...rows.contacts]
    .sort((a, b) => byCreated(a, b) || a.id.localeCompare(b.id))
    .map((contact, index) => {
      const touchpoints: DischargeSummaryTouchpoint[] = rows.outreach
        .filter((o) => o.contactId === contact.id)
        .sort(byInstant((o) => o.dueAt))
        .map((o) => ({
          cadenceMark: markOf(o),
          kind: o.kind,
          dueAt: iso(o.dueAt),
          status: o.status,
          completedAt: isoN(o.completedAt),
        }));
      const optOuts = rows.optOuts
        .filter((o) => o.contactId === contact.id && o.rescindedAt === null)
        .sort(byInstant((o) => o.optedOutAt))
        .map((o) => ({
          optOutKind: o.optOutKind,
          channelKinds: [...o.channelKinds],
          optedOutAt: iso(o.optedOutAt),
        }));
      const attempts = rows.failedAttempts
        .filter((a) => a.contactId === contact.id)
        .sort(byInstant((a) => a.contactAt));
      return {
        label: `Contact ${index + 1}`,
        relationship: contact.relationship,
        status: contact.status,
        mailingsAllowed: !optOuts.some((o) => o.optOutKind === "no_mailings"),
        tierTrajectory: trajectory(rows.scores.filter((s) => s.contactId === contact.id)),
        touchpoints,
        assessmentTasks: rows.tasks
          .filter((t) => t.contactId === contact.id)
          .sort(byInstant((t) => t.dueAt))
          .map((t) => ({
            taskKind: t.taskKind,
            status: t.status,
            dueAt: iso(t.dueAt),
            completedAt: isoN(t.completedAt),
          })),
        optOuts,
        unreachable:
          contact.status === "unreachable"
            ? {
                attemptCount: attempts.length,
                lastAttemptAt: isoN(attempts[attempts.length - 1]?.contactAt ?? null),
                markedUnreachableAt: isoN(contact.unreachableAt),
              }
            : null,
      };
    });

  return {
    deathDate: rows.deathDate,
    closedAt: iso(rows.closure.closedAt),
    closureReason: rows.closure.reason,
    closeKind: rows.closure.closeKind,
    planTierTrajectory: trajectory(rows.scores.filter((s) => s.contactId === null)),
    contacts,
    totals: totalsOf(contacts.flatMap((c) => c.touchpoints)),
  };
}
