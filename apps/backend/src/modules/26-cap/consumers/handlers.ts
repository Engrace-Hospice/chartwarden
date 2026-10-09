// apps/backend/src/modules/26-cap/consumers/handlers.ts — the M26 §4.4 consumer handlers. Each is a PURE
// function over an injected store (the accrual writer + the freeze writer); the live inbound dispatcher binds
// the Drizzle store when the relay lands. Every accrual line is idempotent by (source_kind, source_id,
// line_seq) — replaying the same remittance line is a no-op (ON CONFLICT DO NOTHING, §2.6). No MBI/PHI is
// logged; the patient_id is a pointer and the MBI is a canonical join key only.

/** The accrual-line write the m25/m23 consumers produce (recorded idempotently by the store). */
export interface AccrualLineToRecord {
  readonly organizationId: string;
  readonly patientId: string;
  readonly sourceKind: "remittance" | "adjustment" | "reversal";
  readonly sourceId: string;
  readonly amountCents: number; // signed; reversal/void is negative
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly postedAt: string;
}

/** The level-of-care day-line write the m23 line_finalized consumer produces (rev 0651/0652/0655/0656). */
export interface InpatientDayToRecord {
  readonly organizationId: string;
  /** The M23 claim the line belongs to - the ledger identity a later replace/void/recoup reverses by. */
  readonly claimId: string;
  readonly patientId: string;
  readonly sourceId: string;
  readonly revCode: "0651" | "0652" | "0655" | "0656";
  readonly days: number;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly postedAt: string;
}

/** A claim whose payment was taken back (replaced / voided / recouped): its ledger days stop counting. */
export interface InpatientDaysReversal {
  readonly organizationId: string;
  readonly claimId: string;
  /**
   * The claim's claim_line ids, when the caller has them (the platform-ops backfill). A ledger row written before
   * the ledger carried a claim id is found by these (`source_id`) and gets the claim identity stamped.
   */
  readonly claimLineIds?: readonly string[];
  /** When the payment was taken back; defaults to the store's clock when the event carries no instant. */
  readonly reversedAt?: string;
}

/** The store the consumers drive (the Drizzle binding records lines for the active cap period under RLS). */
export interface CapConsumerStore {
  recordAccrualLine(line: AccrualLineToRecord): Promise<{ recorded: boolean }>;
  recordInpatientDay(day: InpatientDayToRecord): Promise<{ recorded: boolean }>;
  /** GAP-038 - annotate the claim's live day lines reversed and rebuild the roll-up; `reversed` = lines hit. */
  reverseInpatientDays(reversal: InpatientDaysReversal): Promise<{ reversed: number }>;
  freezePatient(
    organizationId: string,
    patientId: string,
    frozenAt: string,
  ): Promise<{ frozen: boolean }>;
  setProportionalWeight(
    organizationId: string,
    patientId: string,
    weight: number,
  ): Promise<{ updated: boolean }>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const cents = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

/**
 * m25.remittance.claim_paid / claim_partial_paid → record a paid accrual line (D4: paid amount is the
 * accrual basis). GAP-075: the advice-level `advice_posted` event carries no patient and no per-claim
 * amount, so this reads the per-line posting events, which M25 emits with `patientId`, integer
 * `paidAmountCents` and the 835's service dates. `cap_beneficiary_accrual_line.service_from`/`.service_to`
 * are NOT NULL, so a line whose payer omitted the optional DTM dates is refused rather than fabricated
 * (the `handleClaimReversed` posture). The tenant comes from the dispatcher envelope, merged into `p` by
 * the binding (`outbox-binding.ts`) — never from a payload that does not carry it.
 */
export async function handleRemittancePosted(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ recorded: boolean }> {
  const organizationId = str(p.organizationId);
  const patientId = str(p.patientId);
  const sourceId = str(p.remittanceLineId);
  const serviceFrom = str(p.serviceFrom);
  const serviceTo = str(p.serviceTo);
  const postedAt = str(p.postedAt);
  if (!organizationId || !patientId || !sourceId || !serviceFrom || !serviceTo || !postedAt) {
    return { recorded: false };
  }
  return store.recordAccrualLine({
    organizationId,
    patientId,
    sourceKind: "remittance",
    sourceId,
    amountCents: cents(p.paidAmountCents),
    serviceFrom,
    serviceTo,
    postedAt,
  });
}

/**
 * m23.claim.replaced / m23.claim.voided / m25.remittance.claim_recouped → record a negative reversal
 * accrual line. `cap_beneficiary_accrual_line.service_from`/`.service_to` are NOT NULL (a real DB
 * constraint, not merely an unread field) — a payload that cannot honestly supply them (the 835's DTM
 * claim-service-period segments are optional; F-163, #248) is refused rather than fabricated, the same
 * `ensureAccrualRow` "no MBI on file" posture one file over. `priorPaidAmountCents`/`paidAmountCents`/
 * `recoupedAmountCents` are read as already-converted integer cents (`cents()` is a passthrough for a
 * number, never a dollars→cents conversion) — every producer of this fact must supply cents under one of
 * those three names, never a `money` decimal-string field directly.
 */
export async function handleClaimReversed(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ recorded: boolean }> {
  const patientId = str(p.patientId);
  const sourceId = str(p.claimId);
  const serviceFrom = str(p.serviceFrom);
  const serviceTo = str(p.serviceTo);
  if (!patientId || !sourceId || !serviceFrom || !serviceTo) return { recorded: false };
  return store.recordAccrualLine({
    organizationId: str(p.organizationId),
    patientId,
    sourceKind: "reversal",
    sourceId,
    amountCents: -Math.abs(
      cents(p.recoupedAmountCents ?? p.priorPaidAmountCents ?? p.paidAmountCents),
    ),
    serviceFrom,
    serviceTo,
    postedAt: str(p.postedAt ?? new Date(0).toISOString()),
  });
}

/**
 * m23.claim.line_finalized (hospice LOC rev 0651/0652/0655/0656) → record a level-of-care day line for the 20%
 * cap: 0655/0656 days are its numerator, every code's days its denominator (GAP-038). GAP-077: the
 * catalogued payload is `{claimId, claimLineId, revenueCode, patientId, serviceFrom, serviceTo, days,
 * finalizedAt}` (M23 emits it when a paid/partially-paid claim's 835 posts); the tenant comes from the
 * dispatcher envelope. A payload without a service period or a positive day count is refused.
 */
export async function handleInpatientDay(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ recorded: boolean }> {
  const revCode = str(p.revenueCode);
  if (revCode !== "0651" && revCode !== "0652" && revCode !== "0655" && revCode !== "0656")
    return { recorded: false };
  const organizationId = str(p.organizationId);
  const claimId = str(p.claimId);
  const patientId = str(p.patientId);
  const sourceId = str(p.claimLineId);
  const serviceFrom = str(p.serviceFrom);
  const serviceTo = str(p.serviceTo);
  const postedAt = str(p.finalizedAt);
  const days = cents(p.days);
  if (
    !organizationId ||
    !claimId ||
    !patientId ||
    !sourceId ||
    !serviceFrom ||
    !serviceTo ||
    !postedAt ||
    days <= 0
  ) {
    return { recorded: false };
  }
  return store.recordInpatientDay({
    organizationId,
    claimId,
    patientId,
    sourceId,
    revCode,
    days,
    serviceFrom,
    serviceTo,
    postedAt,
  });
}

/**
 * GAP-038 - m23.claim.replaced / m23.claim.voided / m25.remittance.claim_recouped → the claim's inpatient day
 * lines stop counting toward the cap's numerator and denominator. The three payloads name the affected claim
 * differently: replaced/voided carry `originalClaimId` (the PAID claim being corrected - NEVER the
 * replacement/void claim, which has no paid lines yet) and no patient or period; the recoup carries `claimId`
 * (its nullable patientId/service dates are irrelevant here). The caller passes the payload field to read.
 * Unlike the money-side `handleClaimReversed` this needs nothing but the claim id, so it never no-ops on the
 * replaced/voided payloads.
 */
export async function handleClaimDaysReversed(
  store: CapConsumerStore,
  p: Record<string, unknown>,
  claimIdField: "originalClaimId" | "claimId",
): Promise<{ reversed: number }> {
  const organizationId = str(p.organizationId);
  const claimId = str(p[claimIdField]);
  if (!organizationId || !claimId) return { reversed: 0 };
  const postedAt = str(p.postedAt);
  return store.reverseInpatientDays({
    organizationId,
    claimId,
    ...(postedAt ? { reversedAt: postedAt } : {}),
  });
}

/** m5.patient.deceased / m6.revocation.created → freeze the per-patient extrapolation denominator. */
export async function handleFreeze(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ frozen: boolean }> {
  const patientId = str(p.patientId);
  if (!patientId) return { frozen: false };
  return store.freezePatient(
    str(p.organizationId),
    patientId,
    str(p.occurredAt ?? p.deceasedAt ?? p.revokedAt ?? new Date(0).toISOString()),
  );
}

/** m6.transfer.created → initialize the proportional methodology weight from the election-day share (D10). */
export async function handleTransfer(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ updated: boolean }> {
  const patientId = str(p.patientId);
  if (!patientId) return { updated: false };
  const providerDays = cents(p.providerElectionDays);
  const totalDays = cents(p.totalElectionDays);
  const weight = totalDays > 0 ? Math.min(1, providerDays / totalDays) : 1;
  return store.setProportionalWeight(str(p.organizationId), patientId, weight);
}
