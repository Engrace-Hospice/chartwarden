// apps/backend/src/modules/14-idg/minutes-render-context.ts — the display CONTEXT the M22 `idg_minutes`
// PDF needs beyond the frozen snapshots: the meeting's own dates, membership display names, patient labels
// ("First L." from the meeting's packet covers) and the amended flag. Snapshots stay ids-only (they are the
// immutable §3.3 record and the eraser walks them); this rides ONLY the outbox `renderPayload`, is re-derived
// at every emit, and is never stored. Org-scoped reads inside the caller's tenant transaction.
//
// PHI: names/labels are document CONTENT (rendered into the PHI-bearing minutes PDF) — never object keys.
// Part 2: a patient label is display metadata of the meeting's own packet; the PDF builder never prints a
// label for an entry whose text is withheld.
import { type DbClient, schema } from "@wardenx/db";
import { eq } from "drizzle-orm";

const MTG = schema.idgMeeting;
const ATT = schema.idgAttendance;
const DEC = schema.idgDecision;
const ACT = schema.idgActionItem;
const NOTE = schema.idgDisciplineNote;
const PKT = schema.idgPatientPacket;
const AMD = schema.idgMinutesAmendment;

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
  };
  readonly memberNames: Record<string, string>;
  readonly patientLabels: Record<string, string>;
  readonly minutesStatus: "final" | "amended";
  readonly amendmentCount: number;
}

/** The context block spread into `renderPayload` at `.signed`, `.amended` and `.addendum_recorded`. */
export async function loadMinutesRenderContext(
  tx: DbClient,
  args: {
    readonly meetingId: string;
    readonly minutesId: string;
    readonly names: ReadonlyMap<string, string | null>;
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
  const memberNames: Record<string, string> = {};
  for (const [id, name] of args.names) if (name) memberNames[id] = name;
  return {
    meeting: {
      meetingId: args.meetingId,
      locationId: m?.locationId ?? "",
      scheduledStart: iso(m?.scheduledStart ?? null),
      actualStart: iso(m?.actualStart ?? null),
      actualEnd: iso(m?.actualEnd ?? null),
    },
    memberNames,
    patientLabels,
    minutesStatus: amendments.length > 0 ? "amended" : "final",
    amendmentCount: amendments.length,
  };
}
