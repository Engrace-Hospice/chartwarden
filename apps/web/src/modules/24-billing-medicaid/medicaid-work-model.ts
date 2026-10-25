// apps/web/src/modules/24-billing-medicaid — the pure model behind the Medicaid work queue. Claims in the states that need
// a person (the claim list) and the org-wide validation worklist become one list, each row with the next step for its
// state. Medicaid carries no server deadline, so nothing here invents one: rows are ranked by what is stuck (state) and
// then by how long they have waited, and the "urgent" set is the stuck states, never "at risk" or "overdue". A claim in
// both sources is one row. A source that failed is handled by the caller (SourceState), never counted as zero here.
import type { StatusTone } from "@chartwarden/ui";
import { CLAIM_STATE_TONE, humanize, tobLabel, toneOf } from "./medicaid-status";

/** The fields of a Medicaid claim list row the queue reads (a subset of the claim workbench's ClaimRow). */
export interface MedicaidClaimRow {
  id: string;
  patientId: string;
  state: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  medicaidClaimControlNumber: string;
  updatedAt: string;
}

/** A claim on the org-wide validation worklist (GET /medicaid-validation-worklist, flattened from its rule groups). */
export interface BlockedClaim {
  claimId: string;
  patientId: string;
  state: string;
  medicaidClaimControlNumber: string;
  updatedAt: string;
}

export interface MedicaidWorkItem {
  key: string;
  patientId: string | null;
  what: string;
  statusLabel: string;
  statusTone: StatusTone;
  nextAction: string;
  href: string;
  blocked: boolean;
  updatedAt: string;
  /** Lower is more stuck; READY and DRAFT are ordinary work, not stuck. */
  rank: number;
}

/** The claim states that need a person, most stuck first, and what the person does next. */
const STATE_WORK: Record<string, { rank: number; next: string }> = {
  FAILED_VALIDATION: { rank: 0, next: "Fix the validation failures" },
  ACK_TIMEOUT: { rank: 1, next: "Check the acknowledgment" },
  ACK_REJECTED: { rank: 2, next: "Fix the rejection and resubmit" },
  DENIED: { rank: 3, next: "Review the denial" },
  FAILED_MEDICARE_PRIMARY: { rank: 4, next: "Resolve the Medicare primary" },
  ACK_PARTIAL: { rank: 5, next: "Review the partial acknowledgment" },
  READY: { rank: 6, next: "Submit the claim" },
  DRAFT: { rank: 7, next: "Complete the claim" },
};
const FIRST_ORDINARY_RANK = 6;
const BLOCKED_NEXT = "Fix the blocking rules";

/** The states the work queue reads, one list read each (the claim list filters on a single state). */
export const MEDICAID_WORK_STATES = Object.keys(STATE_WORK);

export const isUrgentMedicaid = (i: MedicaidWorkItem): boolean => i.rank < FIRST_ORDINARY_RANK;

const claimHref = (id: string) => `/medicaid/billing/claims/${encodeURIComponent(id)}`;

function fromClaim(row: MedicaidClaimRow, isBlocked: boolean): MedicaidWorkItem | null {
  const work = STATE_WORK[row.state];
  if (!work) return null;
  return {
    key: `claim:${row.id}`,
    patientId: row.patientId,
    what: `${tobLabel(row.tob)} · ${row.serviceFrom} → ${row.serviceTo}`,
    statusLabel: humanize(row.state),
    statusTone: toneOf(CLAIM_STATE_TONE, row.state),
    nextAction: work.next,
    href: isBlocked ? `${claimHref(row.id)}/validation` : claimHref(row.id),
    blocked: isBlocked,
    updatedAt: row.updatedAt,
    rank: work.rank,
  };
}

function fromBlocked(row: BlockedClaim): MedicaidWorkItem {
  return {
    key: `claim:${row.claimId}`,
    patientId: row.patientId,
    what: `Claim ${row.medicaidClaimControlNumber}`,
    statusLabel: humanize(row.state),
    statusTone: toneOf(CLAIM_STATE_TONE, row.state),
    nextAction: BLOCKED_NEXT,
    href: `${claimHref(row.claimId)}/validation`,
    blocked: true,
    updatedAt: row.updatedAt,
    rank: STATE_WORK[row.state]?.rank ?? 0,
  };
}

function byWork(a: MedicaidWorkItem, b: MedicaidWorkItem): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at - bt;
  if (Number.isNaN(at) !== Number.isNaN(bt)) return Number.isNaN(at) ? 1 : -1;
  return a.key < b.key ? -1 : 1;
}

export function buildMedicaidWork(sources: {
  claims: MedicaidClaimRow[];
  blocked: BlockedClaim[];
}): MedicaidWorkItem[] {
  const blockedIds = new Set(sources.blocked.map((b) => b.claimId));
  const rows = new Map<string, MedicaidWorkItem>();
  for (const c of sources.claims) {
    const item = fromClaim(c, blockedIds.has(c.id));
    if (item) rows.set(item.key, item);
  }
  for (const b of sources.blocked) {
    const key = `claim:${b.claimId}`;
    if (!rows.has(key)) rows.set(key, fromBlocked(b));
  }
  return [...rows.values()].sort(byWork);
}
