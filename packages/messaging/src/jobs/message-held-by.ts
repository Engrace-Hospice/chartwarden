// ADR-0086 D5 (proposed) — which messages an M4 legal hold's criteria hold. PURE: the backend scan holds a SQL mirror of this
// (apps/backend/.../jobs/retention-hold-sql.ts) and a live suite proves the two agree.
//
// Selectors: patientIds / channelIds / userIds are UNIONED (a message matching any one is held); dateRange (on created_at,
// inclusive) then NARROWS. No patient/channel/user selector at all (legacy org-wide hold, or resourceKinds-only, which is
// ignored for messages) holds everything: over-holding is the safe error, as in M4's legalHoldScopeOf.
//
// patient: a care_team channel whose subject is the patient, OR a message carrying a patient entity reference to them, OR any
// bereavement channel (deliberately conservative: the bereavement subject is a plan reference, not reliably the patient).
// user: messages the user authored plus every message in a channel they hold a channel_member row in. channel_member rows are
// SOFT-deleted (removed_at) and never hard-deleted by production code, so ended memberships ARE retained and are included:
// the user scope therefore also holds messages posted before they joined and after they left (a documented over-hold).

/** The selectors this reader honours; extra keys (resourceKinds) are ignored. */
export interface MessageHoldCriteria {
  readonly patientIds?: readonly string[];
  readonly channelIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly dateRange?: { readonly from: string; readonly to: string };
}

export interface MessageHoldFacts {
  readonly createdAt: string | Date;
  readonly authorUserId: string | null;
  readonly channelId: string;
  readonly channelKind: string;
  readonly channelSubjectId: string | null;
  /** Patients named by `message_entity_reference` rows (reference_kind = 'patient') on this message. */
  readonly referencedPatientIds: readonly string[];
  /** Users with ANY channel_member row (active or ended) in this message's channel. */
  readonly memberUserIds: readonly string[];
}

const has = (a: readonly string[] | undefined): a is readonly string[] => (a?.length ?? 0) > 0;

export function messageHeldBy(rawCriteria: unknown, f: MessageHoldFacts): boolean {
  const c = (rawCriteria ?? {}) as MessageHoldCriteria;
  const { patientIds, channelIds, userIds } = c;
  const selected = has(patientIds) || has(channelIds) || has(userIds);
  const bySelector =
    !selected ||
    (has(patientIds) &&
      (((f.channelKind === "care_team" || f.channelKind === "family") &&
        f.channelSubjectId !== null &&
        patientIds.includes(f.channelSubjectId)) ||
        f.channelKind === "bereavement" ||
        f.referencedPatientIds.some((p) => patientIds.includes(p)))) ||
    (has(channelIds) && channelIds.includes(f.channelId)) ||
    (has(userIds) &&
      ((f.authorUserId !== null && userIds.includes(f.authorUserId)) ||
        f.memberUserIds.some((u) => userIds.includes(u))));
  if (!bySelector) return false;
  if (!c.dateRange) return true;
  const at = new Date(f.createdAt).getTime();
  return at >= Date.parse(c.dateRange.from) && at <= Date.parse(c.dateRange.to);
}
