// apps/backend/src/modules/14-idg/minutes-render-context.ts — the display CONTEXT the M22 `idg_minutes`
// PDF needs beyond the frozen snapshots: the meeting's own dates, membership display names, patient labels
// ("First L." from the meeting's packet covers) and the amended flag. Snapshots stay ids-only (they are the
// immutable §3.3 record and the eraser walks them); this rides ONLY the outbox `renderPayload`, is re-derived
// at every emit, and is never stored. Org-scoped reads inside the caller's tenant transaction.
//
// PHI: names/labels are document CONTENT (rendered into the PHI-bearing minutes PDF) — never object keys.
// Part 2: a patient label is display metadata of the meeting's own packet; the PDF builder never prints a
// label for an entry whose text is withheld.
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type DecisionRenderEntry, buildDecisionContent } from "./minutes-decision-content";

const MTG = schema.idgMeeting;
const ATT = schema.idgAttendance;
const DEC = schema.idgDecision;
const ACT = schema.idgActionItem;
const NOTE = schema.idgDisciplineNote;
const PKT = schema.idgPatientPacket;
const AMD = schema.idgMinutesAmendment;

/**
 * W-SUD-01 fact for a set of patients on ONE meeting: which of them a note's / decision's text may be shown for
 * WITHOUT a Part 2 release. The SUD flag lives on the patient's packet snapshot (`patientCover.activeSudFlag`,
 * the same signal `mapPacketContent` reads). A patient with no readable packet is UNDETERMINABLE and is
 * treated as needing a release (fail-closed) — never assumed clear.
 */
export async function patientsNeedingRelease(
  tx: DbClient,
  meetingId: string,
  patientIds: readonly string[],
): Promise<Set<string>> {
  const needs = new Set<string>(patientIds);
  if (patientIds.length === 0) return needs;
  const pkts = await tx
    .select({ patientId: PKT.patientId, builtSnapshot: PKT.builtSnapshot })
    .from(PKT)
    .where(and(eq(PKT.idgMeetingId, meetingId), inArray(PKT.patientId, [...patientIds])));
  for (const p of pkts) {
    const cover = (p.builtSnapshot as { patientCover?: { activeSudFlag?: unknown } } | null)
      ?.patientCover;
    if (cover?.activeSudFlag === false) needs.delete(p.patientId);
  }
  return needs;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Every membership a minutes render may need to name (attendees, recorders, assignees, note authors). */
export async function loadMinutesMemberIds(tx: DbClient, meetingId: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (v: string | null | undefined): void => {
    if (v) ids.add(v);
  };
  for (const r of await tx
    .select({ m: ATT.membershipId })
    .from(ATT)
    .where(eq(ATT.idgMeetingId, meetingId)))
    add(r.m);
  for (const r of await tx
    .select({ m: DEC.recordedByMembershipId })
    .from(DEC)
    .where(eq(DEC.idgMeetingId, meetingId)))
    add(r.m);
  for (const r of await tx
    .select({ m: ACT.assignedToMembershipId })
    .from(ACT)
    .where(eq(ACT.idgMeetingId, meetingId)))
    add(r.m);
  for (const r of await tx
    .select({ m: NOTE.authorMembershipId })
    .from(NOTE)
    .where(eq(NOTE.idgMeetingId, meetingId)))
    add(r.m);
  return [...ids];
}

export interface MinutesRenderContext {
  readonly meeting: {
    readonly meetingId: string;
    readonly locationId: string;
    readonly scheduledStart: string | null;
    readonly actualStart: string | null;
    readonly actualEnd: string | null;
    /** PDF header: the organization's display name. Omitted when the site-display port is unbound / failed. */
    readonly organizationName?: string;
    /** PDF header: the meeting location's name. Omitted when the site-display port is unbound / failed. */
    readonly locationName?: string;
  };
  readonly memberNames: Record<string, string>;
  readonly patientLabels: Record<string, string>;
  readonly minutesStatus: "final" | "amended";
  readonly amendmentCount: number;
  /**
   * Decision CONTENT (kind-specific summary lines), re-derived from the live `idg_decision` rows at every emit —
   * the frozen `decision_list_snapshot` is never touched. 42 CFR Part 2: metadata-only + `withheld` for a patient
   * who needs a release. See `./minutes-decision-content`.
   */
  readonly decisionContent: readonly DecisionRenderEntry[];
}

/** The org/location display names resolved (before the tx) through the M1 site-display port. */
export interface MinutesSiteNames {
  readonly organizationName: string | null;
  readonly locationName: string | null;
}

/** The context block spread into `renderPayload` at `.signed`, `.amended` and `.addendum_recorded`. */
export async function loadMinutesRenderContext(
  tx: DbClient,
  args: {
    readonly meetingId: string;
    readonly minutesId: string;
    readonly names: ReadonlyMap<string, string | null>;
    readonly site?: MinutesSiteNames;
  },
): Promise<MinutesRenderContext> {
  const [m] = await tx
    .select({
      id: MTG.id,
      locationId: MTG.locationId,
      scheduledStart: MTG.scheduledStart,
      actualStart: MTG.actualStart,
      actualEnd: MTG.actualEnd,
    })
    .from(MTG)
    .where(eq(MTG.id, args.meetingId))
    .limit(1);
  const amendments = await tx
    .select({ id: AMD.id })
    .from(AMD)
    .where(eq(AMD.idgMinutesId, args.minutesId));
  const packets = await tx
    .select({ patientId: PKT.patientId, builtSnapshot: PKT.builtSnapshot })
    .from(PKT)
    .where(eq(PKT.idgMeetingId, args.meetingId));
  const patientLabels: Record<string, string> = {};
  for (const p of packets) {
    const label = (p.builtSnapshot as { patientCover?: { fullNameRedacted?: unknown } } | null)
      ?.patientCover?.fullNameRedacted;
    if (typeof label === "string" && label.length > 0) patientLabels[p.patientId] = label;
  }
  const decisionRows = await tx
    .select({
      id: DEC.id,
      patientId: DEC.patientId,
      decisionKind: DEC.decisionKind,
      status: DEC.status,
      recordedAt: DEC.recordedAt,
      supersededByDecisionId: DEC.supersededByDecisionId,
      payload: DEC.payload,
    })
    .from(DEC)
    .where(eq(DEC.idgMeetingId, args.meetingId))
    .orderBy(asc(DEC.recordedAt));
  const releaseNeeded = await patientsNeedingRelease(tx, args.meetingId, [
    ...new Set(decisionRows.map((d) => d.patientId).filter((p): p is string => p !== null)),
  ]);
  const decisionContent = buildDecisionContent(decisionRows, releaseNeeded);
  const memberNames: Record<string, string> = {};
  for (const [id, name] of args.names) if (name) memberNames[id] = name;
  return {
    meeting: {
      meetingId: args.meetingId,
      locationId: m?.locationId ?? "",
      scheduledStart: iso(m?.scheduledStart ?? null),
      actualStart: iso(m?.actualStart ?? null),
      actualEnd: iso(m?.actualEnd ?? null),
      ...(args.site?.organizationName ? { organizationName: args.site.organizationName } : {}),
      ...(args.site?.locationName ? { locationName: args.site.locationName } : {}),
    },
    memberNames,
    patientLabels,
    minutesStatus: amendments.length > 0 ? "amended" : "final",
    amendmentCount: amendments.length,
    decisionContent,
  };
}
