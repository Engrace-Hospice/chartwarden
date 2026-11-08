// apps/web/src/modules/16-bereavement — the vocabulary of the three family programs (ADR-0109 D10, PR 3): the permission keys each surface
// is gated on (the server enforces every one; the web only decides what to OFFER), the tone of each status, plain-language labels, and the
// small pure rules the screens share (which transitions a status allows, local date-time input <-> ISO instant).
import type { StatusTone } from "@chartwarden/ui";
import type {
  GroupSession,
  GroupStatus,
  LibraryCategory,
  LibraryStatus,
  MemorialStatus,
} from "./programs-api";

export const GROUP_READ_PERMISSION = "bereavement.group.read";
export const GROUP_MANAGE_PERMISSION = "bereavement.group.manage";
export const GROUP_ENROLL_PERMISSION = "bereavement.group.enroll";
export const GROUP_RUN_PERMISSION = "bereavement.group.run";
export const MEMORIAL_MANAGE_PERMISSION = "bereavement.memorial.manage";
export const MEMORIAL_RSVP_PERMISSION = "bereavement.memorial.rsvp";
export const LIBRARY_READ_PERMISSION = "bereavement.library.read";
export const LIBRARY_MANAGE_PERMISSION = "bereavement.library.manage";

/** Does the session hold `key`? The nav and the action buttons ask; the server decides. */
export const holds = (permissions: readonly string[] | undefined, key: string): boolean =>
  permissions?.includes(key) ?? false;

export const GROUP_STATUSES: readonly GroupStatus[] = ["draft", "open", "completed", "cancelled"];
export const GROUP_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  open: "success",
  completed: "progress",
  cancelled: "error",
};
export const SESSION_STATUS_TONE: Record<string, StatusTone> = {
  scheduled: "neutral",
  held: "success",
  cancelled: "error",
};

export const MEMORIAL_STATUSES: readonly MemorialStatus[] = [
  "draft",
  "published",
  "held",
  "cancelled",
];
export const MEMORIAL_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  published: "progress",
  held: "success",
  cancelled: "error",
};
export const INVITATION_STATUS_TONE: Record<string, StatusTone> = {
  invited: "neutral",
  rsvp_yes: "success",
  rsvp_no: "neutral",
  rsvp_maybe: "warning",
  attended: "success",
  no_show: "warning",
  withdrawn: "neutral",
};
const INVITATION_LABEL: Record<string, string> = {
  invited: "Invited, no answer yet",
  rsvp_yes: "Coming",
  rsvp_no: "Not coming",
  rsvp_maybe: "Maybe",
  attended: "Attended",
  no_show: "Did not attend",
  withdrawn: "Withdrawn",
};
export const invitationLabel = (status: string): string => INVITATION_LABEL[status] ?? status;

export const LIBRARY_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  published: "success",
  archived: "warning",
};
export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = [
  "understanding_grief",
  "coping",
  "children_and_teens",
  "holidays_and_anniversaries",
  "practical_matters",
  "other",
];
const CATEGORY_LABEL: Record<string, string> = {
  understanding_grief: "Understanding grief",
  coping: "Coping",
  children_and_teens: "Children and teens",
  holidays_and_anniversaries: "Holidays and anniversaries",
  practical_matters: "Practical matters",
  other: "Other",
};
export const categoryLabel = (category: string): string => CATEGORY_LABEL[category] ?? category;

/** The status a library item may move to from where it is (draft -> published -> archived -> published). */
export const libraryNextStatuses = (status: LibraryStatus): LibraryStatus[] =>
  status === "draft" ? ["published"] : status === "published" ? ["archived"] : ["published"];

export const canEditGroup = (status: GroupStatus): boolean =>
  status === "draft" || status === "open";
export const canEditMemorial = (status: MemorialStatus): boolean =>
  status === "draft" || status === "published";

/** A session has started once its start time passed and it was not cancelled: only then can attendance be recorded. */
export const sessionStarted = (session: GroupSession, now = Date.now()): boolean =>
  session.status !== "cancelled" && Date.parse(session.startsAt) <= now;

/** `<input type="datetime-local">` value (browser local time) -> ISO instant; null when blank or unparseable. */
export function localToIso(local: string): string | null {
  if (!local) return null;
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** ISO instant -> `<input type="datetime-local">` value in browser local time. */
export function isoToLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A join link must be https (the server refuses anything else too). */
export const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id field the server validates as a uuid: checked before any request so the reader is told which field is wrong. */
export const isUuid = (value: string): boolean => UUID_RE.test(value.trim());

/** A blank string means "no value" on the wire. */
export const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** A non-negative whole number from a text input, or null when blank / not a number. */
export const intOrNull = (value: string): number | null => {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};
