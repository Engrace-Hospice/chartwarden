// apps/backend/src/modules/06-admission/seams/transfer-in-notice-context.ts — M6's org-explicit read of the
// facts the RECEIVING hospice's Medicare transfer notice (TOB 8xC, CMS Pub. 100-04 ch. 11 §20.1.3) needs about
// one transfer-in: the transfer's effective date and the sending hospice (name / CCN / NPI), the inherited
// benefit period (sequence + start, for the occurrence-code-27 boundary), the admission's siting, its OWN
// admission date ("the receiving hospice should use their own admission date") and the attending / certifying
// physicians.
//
// Worker-callable (an M23 outbox consumer runs on a relay tick, not a request), so it opens its own
// `withOrgContext` with an explicit organization predicate as the second wall behind RLS — the
// `admissionSchedulingContextForOrg` precedent. `null` when the transfer event is unknown in the org.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const ADM = schema.admissions;
const EP = schema.electionPeriods;
const TE = schema.transferEvents;

export interface TransferInNoticeContext {
  readonly transferEventId: string;
  readonly direction: "in" | "out";
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  /** `transfer_event.effective_at` — the 8xC Statement From date. */
  readonly effectiveAt: string;
  readonly counterpartyName: string | null;
  readonly counterpartyCcn: string | null;
  readonly counterpartyNpi: string | null;
  readonly periodSequenceAtTransfer: number;
  /** The inherited election period (sequence = `periodSequenceAtTransfer` on this admission), when found. */
  readonly inheritedElectionPeriodId: string | null;
  readonly inheritedPeriodStart: string | null;
  /** `admission_at`, else `activated_at` (the M6 seam idiom); null before the admission is dated. */
  readonly admissionDate: string | null;
  readonly attendingPhysicianId: string | null;
  readonly hospicePhysicianId: string | null;
}

const day = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : d.slice(0, 10);

export function transferInNoticeContextForOrg(
  db: DbClient,
  organizationId: string,
  transferEventId: string,
): Promise<TransferInNoticeContext | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [row] = await tx
      .select({
        id: TE.id,
        direction: TE.direction,
        admissionId: TE.admissionId,
        effectiveAt: TE.effectiveAt,
        name: TE.receivingOrSendingName,
        ccn: TE.receivingOrSendingCcn,
        npi: TE.receivingOrSendingNpi,
        sequence: TE.periodSequenceAtTransfer,
        patientId: ADM.patientId,
        providerEntityId: ADM.providerEntityId,
        locationId: ADM.locationId,
        admissionAt: ADM.admissionAt,
        activatedAt: ADM.activatedAt,
        attendingPhysicianId: ADM.attendingPhysicianId,
        hospicePhysicianId: ADM.hospicePhysicianId,
      })
      .from(TE)
      .innerJoin(ADM, eq(ADM.id, TE.admissionId))
      .where(and(eq(TE.organizationId, organizationId), eq(TE.id, transferEventId)))
      .limit(1);
    if (!row) return null;
    const [period] = await tx
      .select({ id: EP.id, effectiveAt: EP.effectiveAt })
      .from(EP)
      .where(
        and(
          eq(EP.organizationId, organizationId),
          eq(EP.admissionId, row.admissionId),
          eq(EP.sequenceNumber, Number(row.sequence)),
        ),
      )
      .limit(1);
    return {
      transferEventId: row.id,
      direction: row.direction === "in" ? "in" : "out",
      admissionId: row.admissionId,
      patientId: row.patientId,
      providerEntityId: row.providerEntityId,
      locationId: row.locationId,
      effectiveAt: day(row.effectiveAt) ?? "",
      counterpartyName: row.name,
      counterpartyCcn: row.ccn,
      counterpartyNpi: row.npi,
      periodSequenceAtTransfer: Number(row.sequence),
      inheritedElectionPeriodId: period?.id ?? null,
      inheritedPeriodStart: day(period?.effectiveAt ?? null),
      admissionDate: day(row.admissionAt ?? row.activatedAt),
      attendingPhysicianId: row.attendingPhysicianId,
      hospicePhysicianId: row.hospicePhysicianId,
    };
  });
}
