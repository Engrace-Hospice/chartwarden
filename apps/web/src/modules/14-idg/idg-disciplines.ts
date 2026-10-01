// apps/web/src/modules/14-idg — discipline vocabulary for the per-discipline meeting notes.
//
// Two vocabularies meet here. The packet content uses seven fixed DisciplineKeys (rn / msw / chaplain /
// aide / md_np / volunteer / medical_director); the attendance roster's `discipline` is free text
// (`rn_case_manager`, `hospice_physician`, …) and is what the server matches a non-coordinator's note
// write against (exact string, present/tardy/partial). So a note tab WRITES the roster's own string when
// the meeting has one, and otherwise the packet key — while both fold into one tab via `canonicalDiscipline`.

/** The seven packet DisciplineKeys, in display order. */
export const PACKET_DISCIPLINES = [
  "rn",
  "md_np",
  "msw",
  "chaplain",
  "aide",
  "volunteer",
  "medical_director",
] as const;

/** Roster / free-text discipline strings → the packet key they read as. Unknown strings stand alone. */
const ALIAS: Record<string, string> = {
  rn: "rn",
  rn_case_manager: "rn",
  registered_nurse: "rn",
  nurse: "rn",
  hospice_physician: "md_np",
  physician: "md_np",
  md: "md_np",
  np: "md_np",
  md_np: "md_np",
  social_worker: "msw",
  msw: "msw",
  chaplain: "chaplain",
  spiritual_care: "chaplain",
  aide: "aide",
  hha: "aide",
  cna: "aide",
  home_health_aide: "aide",
  hospice_aide: "aide",
  volunteer: "volunteer",
  volunteer_coordinator: "volunteer",
  medical_director: "medical_director",
};

const LABEL: Record<string, string> = {
  rn: "RN",
  md_np: "Physician / NP",
  msw: "MSW",
  chaplain: "Chaplain",
  aide: "Aide",
  volunteer: "Volunteer",
  medical_director: "Medical Director",
};

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The stable tab key for any discipline string (packet key when known, else the string itself). */
export function canonicalDiscipline(raw: string): string {
  const k = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ALIAS[k] ?? k;
}

/** Display label for any discipline string. */
export function disciplineNoteLabel(raw: string): string {
  const c = canonicalDiscipline(raw);
  return LABEL[c] ?? humanize(c);
}

export interface DisciplineTab {
  /** Canonical key (tab identity, and how notes are grouped). */
  readonly key: string;
  /** The exact string a note written from this tab carries. */
  readonly value: string;
  readonly label: string;
}

/**
 * The tab set: every roster discipline present in the meeting (roster order, the roster's own string as
 * the write value), plus any discipline already carried by a note, plus the packet keys not yet covered.
 */
export function disciplineTabs(
  rosterDisciplines: readonly string[],
  noteDisciplines: readonly string[],
): DisciplineTab[] {
  const tabs = new Map<string, DisciplineTab>();
  const add = (raw: string): void => {
    const key = canonicalDiscipline(raw);
    if (!key || tabs.has(key)) return;
    tabs.set(key, { key, value: raw.trim(), label: disciplineNoteLabel(raw) });
  };
  for (const d of rosterDisciplines) add(d);
  for (const d of noteDisciplines) add(d);
  for (const d of PACKET_DISCIPLINES) add(d);
  return [...tabs.values()];
}

/**
 * Mirror of `DISCIPLINE_NOTE_ADDENDUM_WINDOW_DAYS` (packages/idg/src/policy.ts): days after adjournment in which a
 * late addendum may still be added. Display only — the server owns the rule (422 ADDENDUM_WINDOW_CLOSED).
 */
export const ADDENDUM_WINDOW_DAYS = 14;
/** Max length of the required addendum reason (mirrors `DISCIPLINE_NOTE_ADDENDUM_REASON_MAX`). */
export const ADDENDUM_REASON_MAX = 500;

/** When the addendum window closes for a meeting adjourned at `adjournedAt` (null when unknown). */
export function addendumWindowEnd(adjournedAt: string | null | undefined): Date | null {
  if (!adjournedAt) return null;
  const t = new Date(adjournedAt).getTime();
  return Number.isNaN(t) ? null : new Date(t + ADDENDUM_WINDOW_DAYS * 86_400_000);
}

/** Display labels for the closed ATTENDANCE vocabulary the server validates (`IDG_ATTENDANCE_DISCIPLINES`). */
const ATTENDANCE_LABEL: Record<string, string> = {
  rn_case_manager: "RN case manager",
  hospice_physician: "Hospice physician",
  medical_director: "Medical director",
  msw: "MSW",
  chaplain: "Chaplain",
  np: "Nurse practitioner",
  lpn: "LPN",
  hospice_aide: "Hospice aide",
  volunteer: "Volunteer",
  volunteer_coordinator: "Volunteer coordinator",
  bereavement_coordinator: "Bereavement coordinator",
  administrator: "Administrator (does not count toward quorum)",
};

/** Label for an attendance discipline string as the check-in offers it. */
export function attendanceDisciplineLabel(raw: string): string {
  return ATTENDANCE_LABEL[raw] ?? humanize(raw);
}
