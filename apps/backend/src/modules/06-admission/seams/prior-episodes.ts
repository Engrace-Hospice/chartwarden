// apps/backend/src/modules/06-admission/seams/prior-episodes.ts — a patient's EARLIER admissions with us and how each
// one ended, the facts the readmission workflow decides over (intake/benefit-period.ts): the suggested benefit period,
// the two-tier RHC carry-over, and which prior election must be closed out (NOTR / final claim) before the next NOE.
//
// "Earlier" = discharged / bereavement / closed (an open admission is the current one). The ending is read from the
// stay-ending records, in this order: a revocation_event, a transfer_event (direction out), a COMPLETED discharge_event
// (death, or any other reason = a live discharge — including a move out of the service area, condition code 52);
// with none on file the episode ends `unknown`. A benefit period "ran" when it was active or completed (a pending
// recert shell that never started does not count). Four set-based reads; RLS scopes them to the caller's org.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { PriorEpisodeEndKind, PriorEpisodeFacts } from "../intake/benefit-period";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const DE = schema.dischargeEvents;
const RE = schema.revocationEvents;
const TE = schema.transferEvents;

const ENDED_STATES = ["discharged", "bereavement", "closed"] as const;
/** A patient with more earlier admissions than this is beyond any realistic history; bounds the `IN (...)`. */
const MAX_PRIOR_ADMISSIONS = 100;

/**
 * The SENDING hospice's part of a transfer-in's inherited benefit period (CMS Pub. 100-04 ch. 11 §20.1.3): the
 * beneficiary was in hospice care at the other hospice from the inherited period's start up to and including the
 * transfer date (the transferring hospice bills through it). Those are hospice days of the SAME election, so they
 * carry into the two-tier RHC day count (§30.2 — CWF counts per beneficiary, not per provider). A lower bound:
 * days at the sending hospice before the inherited period are only known from HETS.
 */
export interface TransferInSource {
  readonly transferEventId: string;
  /** The inherited period's `effective_at` (the transfer-in's `priorElectionStartDate`); null on legacy rows. */
  readonly sendingStartedOn: string | null;
  /** `transfer_event.effective_at` — the change-of-hospice date. */
  readonly transferOn: string | null;
  /** `transfer_event.receiving_or_sending_npi` (migration 0375), when captured. */
  readonly sendingNpi: string | null;
}

export interface PriorEpisode extends PriorEpisodeFacts {
  readonly admissionState: string;
  readonly patientId: string;
  /** Completed discharge_event / revocation_event / transfer_event id that ended the stay, if any. */
  readonly endingEventId: string | null;
  /** The admission began as a transfer-in: the sending hospice's part of the inherited period. */
  readonly transferredIn: TransferInSource | null;
}

/** One stay the two-tier RHC carry-over counts (M23's `PriorStayFact`): ours, or the sending hospice's. */
export interface RhcPriorStayFact {
  readonly admissionId: string;
  readonly startedOn: string | null;
  readonly endedOn: string | null;
  /** Set when the days were spent at ANOTHER hospice (a transfer-in's sending hospice), with its NPI. */
  readonly otherHospice?: { readonly npi: string | null };
}

const day = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

const minDay = (xs: readonly (string | null)[]): string | null =>
  xs.filter((x): x is string => !!x).sort()[0] ?? null;

/** The patient's earlier admissions (RLS-scoped `tx`), newest ending first. */
export async function loadPriorEpisodes(
  tx: DbClient,
  organizationId: string,
  patientId: string,
  excludeAdmissionId?: string,
): Promise<readonly PriorEpisode[]> {
  const adms = await tx
    .select({
      id: ADM.id,
      status: ADM.status,
      admissionAt: ADM.admissionAt,
      dischargedAt: ADM.dischargedAt,
    })
    .from(ADM)
    .where(
      and(
        // Explicit org predicate — the second wall behind RLS, so a system / superuser connection (which bypasses
        // RLS) can never pull another tenant's stays into a suggestion or accept one as a readmission source.
        eq(ADM.organizationId, organizationId),
        eq(ADM.patientId, patientId),
        inArray(ADM.status, [...ENDED_STATES]),
        ...(excludeAdmissionId ? [ne(ADM.id, excludeAdmissionId)] : []),
      ),
    )
    .limit(MAX_PRIOR_ADMISSIONS);
  const ids = adms.map((a) => a.id);
  if (ids.length === 0) return [];
  // Sequential on purpose: one transaction = one connection.
  const periods = await tx
    .select({
      admissionId: EP.admissionId,
      sequence: EP.sequenceNumber,
      status: EP.status,
      effectiveAt: EP.effectiveAt,
    })
    .from(EP)
    .where(and(eq(EP.organizationId, organizationId), inArray(EP.admissionId, ids)));
  const discharges = await tx
    .select({
      id: DE.id,
      admissionId: DE.admissionId,
      type: DE.dischargeType,
      effectiveAt: DE.effectiveAt,
    })
    .from(DE)
    .where(
      and(
        eq(DE.organizationId, organizationId),
        inArray(DE.admissionId, ids),
        eq(DE.status, "completed"),
      ),
    );
  const revocations = await tx
    .select({ id: RE.id, admissionId: RE.admissionId, effectiveAt: RE.effectiveAt })
    .from(RE)
    .where(and(eq(RE.organizationId, organizationId), inArray(RE.admissionId, ids)));
  const transfersIn = await loadTransferInSources(tx, organizationId, ids);
  const transfers = await tx
    .select({ id: TE.id, admissionId: TE.admissionId, effectiveAt: TE.effectiveAt })
    .from(TE)
    .where(
      and(
        eq(TE.organizationId, organizationId),
        inArray(TE.admissionId, ids),
        eq(TE.direction, "out"),
      ),
    );
  return adms
    .map((a): PriorEpisode => {
      const ran = periods.filter(
        (p) => p.admissionId === a.id && (p.status === "active" || p.status === "completed"),
      );
      const rev = revocations.find((r) => r.admissionId === a.id);
      const xfer = transfers
        .filter((t) => t.admissionId === a.id)
        .sort((x, y) => String(y.effectiveAt).localeCompare(String(x.effectiveAt)))[0];
      const dis = discharges.find((d) => d.admissionId === a.id);
      const ending: { kind: PriorEpisodeEndKind; on: string | null; id: string | null } = rev
        ? { kind: "revocation", on: day(rev.effectiveAt), id: rev.id }
        : xfer
          ? { kind: "transfer_out", on: day(xfer.effectiveAt), id: xfer.id }
          : dis
            ? {
                kind: dis.type === "death" ? "death" : "live_discharge",
                on: day(dis.effectiveAt),
                id: dis.id,
              }
            : { kind: "unknown", on: day(a.dischargedAt), id: null };
      const lastRan = ran.length > 0 ? Math.max(...ran.map((p) => Number(p.sequence))) : null;
      return {
        admissionId: a.id,
        patientId,
        admissionState: String(a.status),
        // The admission date (what claims anchor the stay's day 1 on, `claimAssemblyRangeContextForOrg`), else
        // the earliest ran period's effective date.
        startedOn: day(a.admissionAt) ?? minDay(ran.map((p) => day(p.effectiveAt))),
        endedOn: ending.on,
        endKind: ending.kind,
        dischargeType: dis ? String(dis.type) : null,
        lastRanSequence: lastRan,
        endingEventId: ending.id,
        transferredIn: transfersIn.get(a.id) ?? null,
      };
    })
    .sort((x, y) => (y.endedOn ?? "").localeCompare(x.endedOn ?? ""));
}

/**
 * The transfer-in (direction `in`) that opened each of `admissionIds`, with the inherited period's start — RLS-scoped
 * `tx`, explicit org predicate. An admission opens with at most one transfer-in (R-XFR-01); the earliest is taken.
 */
export async function loadTransferInSources(
  tx: DbClient,
  organizationId: string,
  admissionIds: readonly string[],
): Promise<ReadonlyMap<string, TransferInSource>> {
  if (admissionIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: TE.id,
      admissionId: TE.admissionId,
      effectiveAt: TE.effectiveAt,
      sequence: TE.periodSequenceAtTransfer,
      npi: TE.receivingOrSendingNpi,
      periodStart: EP.effectiveAt,
    })
    .from(TE)
    .leftJoin(
      EP,
      and(
        eq(EP.admissionId, TE.admissionId),
        eq(EP.sequenceNumber, TE.periodSequenceAtTransfer),
        eq(EP.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(TE.organizationId, organizationId),
        inArray(TE.admissionId, [...admissionIds]),
        eq(TE.direction, "in"),
      ),
    );
  const out = new Map<string, TransferInSource>();
  for (const r of [...rows].sort((x, y) =>
    String(x.effectiveAt).localeCompare(String(y.effectiveAt)),
  )) {
    if (out.has(r.admissionId)) continue;
    out.set(r.admissionId, {
      transferEventId: r.id,
      sendingStartedOn: day(r.periodStart),
      transferOn: day(r.effectiveAt),
      sendingNpi: r.npi ?? null,
    });
  }
  return out;
}

/** The sending hospice's span of a transfer-in, as an RHC prior-stay fact (null when its start is unknown). */
function sendingHospiceStay(
  admissionId: string,
  source: TransferInSource | null,
): RhcPriorStayFact | null {
  if (!source?.sendingStartedOn || !source.transferOn) return null;
  if (source.sendingStartedOn > source.transferOn) return null;
  return {
    admissionId,
    startedOn: source.sendingStartedOn,
    endedOn: source.transferOn,
    otherHospice: { npi: source.sendingNpi },
  };
}

/**
 * The stays the two-tier RHC carry-over counts: each earlier stay with us, preceded by its sending hospice's span
 * when it began as a transfer-in; plus, when the stay being priced is itself a transfer-in (`current`), the sending
 * hospice's days of the inherited period (the new stay's day 1 is the transfer date — the shared hand-off day is
 * clipped by `computeRhcCarryOver`).
 */
export function rhcPriorStayFacts(
  episodes: readonly PriorEpisode[],
  current?: { readonly admissionId: string; readonly transferredIn: TransferInSource | null },
): readonly RhcPriorStayFact[] {
  const facts: RhcPriorStayFact[] = [];
  for (const e of episodes) {
    facts.push({ admissionId: e.admissionId, startedOn: e.startedOn, endedOn: e.endedOn });
    const sending = sendingHospiceStay(e.admissionId, e.transferredIn);
    if (sending) facts.push(sending);
  }
  const currentSending = current
    ? sendingHospiceStay(current.admissionId, current.transferredIn)
    : null;
  if (currentSending) facts.push(currentSending);
  return facts;
}

/** Org-explicit variant for workers / other modules' ports (no request context). */
export async function priorEpisodesForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  excludeAdmissionId?: string,
): Promise<readonly PriorEpisode[]> {
  return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
    loadPriorEpisodes(tx as DbClient, organizationId, patientId, excludeAdmissionId),
  );
}

/** The latest earlier stay that ended ALIVE (live discharge, revocation, transfer-out) — the election a NEW NOE
 *  cannot follow until its NOTR / final claim is on file (Claims Processing Manual ch. 11 §20.1.6). */
export function latestLiveEndedEpisode(episodes: readonly PriorEpisode[]): PriorEpisode | null {
  return (
    episodes.find(
      (e) =>
        e.endKind === "live_discharge" ||
        e.endKind === "revocation" ||
        e.endKind === "transfer_out",
    ) ?? null
  );
}
