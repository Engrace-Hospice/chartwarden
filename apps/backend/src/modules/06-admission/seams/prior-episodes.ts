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

export interface PriorEpisode extends PriorEpisodeFacts {
  readonly admissionState: string;
  readonly patientId: string;
  /** Completed discharge_event / revocation_event / transfer_event id that ended the stay, if any. */
  readonly endingEventId: string | null;
}

const day = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

const minDay = (xs: readonly (string | null)[]): string | null =>
  xs.filter((x): x is string => !!x).sort()[0] ?? null;

/** The patient's earlier admissions (RLS-scoped `tx`), newest ending first. */
export async function loadPriorEpisodes(
  tx: DbClient,
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
    .where(inArray(EP.admissionId, ids));
  const discharges = await tx
    .select({
      id: DE.id,
      admissionId: DE.admissionId,
      type: DE.dischargeType,
      effectiveAt: DE.effectiveAt,
    })
    .from(DE)
    .where(and(inArray(DE.admissionId, ids), eq(DE.status, "completed")));
  const revocations = await tx
    .select({ id: RE.id, admissionId: RE.admissionId, effectiveAt: RE.effectiveAt })
    .from(RE)
    .where(inArray(RE.admissionId, ids));
  const transfers = await tx
    .select({ id: TE.id, admissionId: TE.admissionId, effectiveAt: TE.effectiveAt })
    .from(TE)
    .where(and(inArray(TE.admissionId, ids), eq(TE.direction, "out")));
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
      };
    })
    .sort((x, y) => (y.endedOn ?? "").localeCompare(x.endedOn ?? ""));
}

/** Org-explicit variant for workers / other modules' ports (no request context). */
export async function priorEpisodesForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
  excludeAdmissionId?: string,
): Promise<readonly PriorEpisode[]> {
  return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
    loadPriorEpisodes(tx as DbClient, patientId, excludeAdmissionId),
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
