// apps/web/src/modules/23-billing-medicare — the pure model behind the Billing work queue: claims, NOE/NOTR notices and
// DDE items from their existing list endpoints become one list of work. Each source keeps its own status vocabulary
// (nothing is folded into a made-up universal lifecycle); a notice and the DDE item that files it are ONE row, because
// they are one task. Deadlines come from the server's own values (a notice's windowTargetAt, a DDE item's deadlineAt /
// deadlineStatus), never from a guess, and a source that failed or is still paged is never counted as a clean zero.
import type { StatusTone } from "@chartwarden/ui";
import { claimStateTone, noeNotrStateTone, statusLabel, tobLabel } from "./billing-status";
import type { DdeItem, DdeItemType, DdeState } from "./dde-queue-model";

export type WorkKind = "claim" | "noe" | "notr" | "dde";
export type Urgency = "overdue" | "at_risk" | "on_track" | "none";

/** The fields of a claim list row the queue reads (a subset of the claim workbench's ClaimSummary). */
export interface ClaimRow {
  claimId: string;
  patientId: string;
  state: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  claimControlNumber: string;
}

/** The fields of a NOE / NOTR list row the queue reads; the backend keys the id as `id`, `noeId` or `notrId`. */
export interface NoticeRow {
  id?: string;
  noeId?: string;
  notrId?: string;
  state: string;
  patientId?: string | null;
  windowTargetAt: string | null;
  windowBreachedAt: string | null;
}

export interface WorkItem {
  key: string;
  kind: WorkKind;
  patientId: string | null;
  what: string;
  statusLabel: string;
  statusTone: StatusTone;
  deadlineAt: string | null;
  urgency: Urgency;
  nextAction: string;
  /** Where the row's next step is done: the DDE item when one exists, else the notice or claim itself. */
  href: string;
  /** The notice or claim behind the row, when it is not what `href` opens. */
  subjectHref: string | null;
  dde: {
    id: string;
    stateLabel: string;
    /** true / false once a submission is recorded, null before: nothing is claimed about who filed it earlier. */
    viaProvider: boolean | null;
    inDoubt: boolean;
  } | null;
}

export type SourceState<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "denied" }
  | { status: "ok"; items: T[]; hasMore: boolean };

export interface QueueSources {
  claims: ClaimRow[];
  noe: NoticeRow[];
  notr: NoticeRow[];
  dde: DdeItem[];
}

const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, at_risk: 1, on_track: 2, none: 3 };
const AT_RISK_DAYS = 2;
const DAY_MS = 86_400_000;

/** The claim states that need a person, and what the person does next. */
const CLAIM_NEXT: Record<string, string> = {
  draft: "Complete the claim",
  ready: "Submit the claim",
  denied: "Review the denial",
  ack_partial: "Review the partial acknowledgment",
  ack_rejected: "Fix the rejection and resubmit",
};

/** Notice states that have left the filing window; a rejected notice is still work (it needs a correction). */
const NOTICE_DONE = new Set(["accepted", "ack_accepted", "cancelled"]);
const NOTICE_NEXT: Record<string, string> = {
  draft: "Review and submit",
  ready: "Submit the notice",
  submitted: "Waiting for the MAC's answer",
  ack_pending: "Waiting for the MAC's answer",
  rejected: "Correct and resubmit",
  ack_rejected: "Correct and resubmit",
};

const DDE_DONE = new Set<DdeState>(["accepted", "closed", "cancelled"]);
const DDE_NEXT: Partial<Record<DdeState, string>> = {
  queued: "Claim it and key it in DDE",
  assigned: "Key it in DDE",
  in_progress: "Record what you keyed",
  submitted: "Record the MAC answer",
  returned: "Correct and re-key",
};
const DDE_TYPE_LABEL: Record<DdeItemType, string> = {
  noe: "NOE",
  notr: "NOTR",
  claim_entry: "Claim entry",
  rtp_correction: "RTP correction",
  adjustment: "Adjustment",
  cancel: "Cancel",
  adr_response: "ADR response",
};

function noticeUrgency(row: NoticeRow, now: Date): Urgency {
  if (row.windowBreachedAt) return "overdue";
  if (!row.windowTargetAt) return "none";
  const left = new Date(row.windowTargetAt).getTime() - now.getTime();
  if (Number.isNaN(left)) return "none";
  if (left < 0) return "overdue";
  return left <= AT_RISK_DAYS * DAY_MS ? "at_risk" : "on_track";
}

function ddeUrgency(item: DdeItem): Urgency {
  switch (item.deadlineStatus) {
    case "overdue":
    case "missed":
      return "overdue";
    case "at_risk":
      return "at_risk";
    case "on_track":
      return "on_track";
    default:
      return "none";
  }
}

const moreUrgent = (a: Urgency, b: Urgency): Urgency =>
  URGENCY_RANK[a] <= URGENCY_RANK[b] ? a : b;

function ddeInfo(item: DdeItem): NonNullable<WorkItem["dde"]> {
  return {
    id: item.ddeWorkItemId,
    stateLabel: statusLabel(item.state),
    viaProvider:
      item.submissionMode === "provider" ? true : item.submissionMode === "manual" ? false : null,
    inDoubt: item.providerInDoubt === true,
  };
}

const ddeHref = (item: DdeItem): string =>
  `/billing/dde?item=${encodeURIComponent(item.ddeWorkItemId)}`;

/** Fold a DDE item into the row it files for: its step becomes the row's step, the more urgent deadline wins. */
function withDde(base: WorkItem, item: DdeItem): WorkItem {
  return {
    ...base,
    deadlineAt: base.deadlineAt ?? item.deadlineAt,
    urgency: moreUrgent(base.urgency, ddeUrgency(item)),
    nextAction: DDE_NEXT[item.state] ?? base.nextAction,
    subjectHref: base.href,
    href: ddeHref(item),
    dde: ddeInfo(item),
  };
}

function claimItem(row: ClaimRow): WorkItem | null {
  const nextAction = CLAIM_NEXT[row.state];
  if (!nextAction) return null;
  return {
    key: `claim:${row.claimId}`,
    kind: "claim",
    patientId: row.patientId,
    what: `${tobLabel(row.tob)} · ${row.serviceFrom} → ${row.serviceTo}`,
    statusLabel: statusLabel(row.state),
    statusTone: claimStateTone(row.state),
    deadlineAt: null,
    urgency: "none",
    nextAction,
    href: `/billing/claims/${encodeURIComponent(row.claimId)}`,
    subjectHref: null,
    dde: null,
  };
}

function noticeItem(kind: "noe" | "notr", row: NoticeRow, now: Date): WorkItem | null {
  const id = row.id ?? row.noeId ?? row.notrId;
  if (!id || NOTICE_DONE.has(row.state)) return null;
  return {
    key: `${kind}:${id}`,
    kind,
    patientId: row.patientId ?? null,
    what: kind === "noe" ? "Notice of Election" : "Notice of Termination / Revocation",
    statusLabel: statusLabel(row.state),
    statusTone: noeNotrStateTone(row.state),
    deadlineAt: row.windowTargetAt,
    urgency: noticeUrgency(row, now),
    nextAction: NOTICE_NEXT[row.state] ?? "Open the notice",
    href: `/billing/${kind}/${encodeURIComponent(id)}`,
    subjectHref: null,
    dde: null,
  };
}

function ddeOnlyItem(item: DdeItem): WorkItem {
  return {
    key: `dde:${item.ddeWorkItemId}`,
    kind: "dde",
    patientId: item.patientId,
    what: DDE_TYPE_LABEL[item.itemType],
    statusLabel: statusLabel(item.state),
    statusTone: "progress",
    deadlineAt: item.deadlineAt,
    urgency: ddeUrgency(item),
    nextAction: DDE_NEXT[item.state] ?? "Open the DDE item",
    href: ddeHref(item),
    subjectHref: null,
    dde: ddeInfo(item),
  };
}

/** The subject a DDE item files for, in the key space of the rows above (a claim or a notice). */
function ddeSubjectKey(item: DdeItem): string {
  const prefix =
    item.subjectKind === "claim" ? "claim" : item.subjectKind === "noe_record" ? "noe" : "notr";
  return `${prefix}:${item.subjectId}`;
}

function ddeBefore(a: DdeItem, b: DdeItem): boolean {
  const rank = URGENCY_RANK[ddeUrgency(a)] - URGENCY_RANK[ddeUrgency(b)];
  if (rank !== 0) return rank < 0;
  const at = Date.parse(a.deadlineAt ?? "");
  const bt = Date.parse(b.deadlineAt ?? "");
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at < bt;
  return a.ddeWorkItemId < b.ddeWorkItemId;
}

function byUrgency(a: WorkItem, b: WorkItem): number {
  const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (rank !== 0) return rank;
  const at = a.deadlineAt ? Date.parse(a.deadlineAt) : Number.NaN;
  const bt = b.deadlineAt ? Date.parse(b.deadlineAt) : Number.NaN;
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at - bt;
  if (Number.isNaN(at) !== Number.isNaN(bt)) return Number.isNaN(at) ? 1 : -1;
  return a.key < b.key ? -1 : 1;
}

export function buildWorkItems(sources: QueueSources, now: Date): WorkItem[] {
  const rows = new Map<string, WorkItem>();
  const add = (item: WorkItem | null) => {
    if (item) rows.set(item.key, item);
  };
  for (const c of sources.claims) add(claimItem(c));
  for (const n of sources.noe) add(noticeItem("noe", n, now));
  for (const n of sources.notr) add(noticeItem("notr", n, now));
  // One DDE item speaks for a subject (the most urgent, then the earliest deadline), so the row never depends on the
  // order the server listed them in.
  const lead = new Map<string, DdeItem>();
  for (const item of sources.dde) {
    if (DDE_DONE.has(item.state)) continue;
    const key = ddeSubjectKey(item);
    const held = lead.get(key);
    if (!held || ddeBefore(item, held)) lead.set(key, item);
  }
  for (const [key, item] of lead) {
    const base = rows.get(key);
    if (base) rows.set(key, withDde(base, item));
    else add(ddeOnlyItem(item));
  }
  return [...rows.values()].sort(byUrgency);
}

/** A source's count for a card: the number when whole, "N+" when more pages exist, an em dash when it is not known. */
export function countLabel<T>(source: SourceState<T>, n: number): string {
  if (source.status !== "ok") return "—";
  return source.hasMore ? `${n}+` : String(n);
}
