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

/** The inpatient-day-line write the m23 line_finalized consumer produces (rev 0655/0656 only). */
export interface InpatientDayToRecord {
  readonly organizationId: string;
  readonly patientId: string;
  readonly sourceId: string;
  readonly revCode: "0655" | "0656";
  readonly days: number;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly postedAt: string;
}

/** The store the consumers drive (the Drizzle binding records lines for the active cap period under RLS). */
export interface CapConsumerStore {
  recordAccrualLine(line: AccrualLineToRecord): Promise<{ recorded: boolean }>;
  recordInpatientDay(day: InpatientDayToRecord): Promise<{ recorded: boolean }>;
  freezePatient(organizationId: string, patientId: string, frozenAt: string): Promise<{ frozen: boolean }>;
  setProportionalWeight(organizationId: string, patientId: string, weight: number): Promise<{ updated: boolean }>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const cents = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

/** m25.remittance.advice_posted → record a paid accrual line (D4: paid amount is the accrual basis). */
export async function handleRemittancePosted(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ recorded: boolean }> {
  const patientId = str(p.patientId);
  const sourceId = str(p.remittanceLineId ?? p.remittanceAdviceId);
  if (!patientId || !sourceId) return { recorded: false };
  return store.recordAccrualLine({
    organizationId: str(p.organizationId),
    patientId,
    sourceKind: "remittance",
    sourceId,
    amountCents: cents(p.paidAmountCents ?? p.totalPaymentAmountCents),
    serviceFrom: str(p.serviceFrom ?? p.serviceFromDate),
    serviceTo: str(p.serviceTo ?? p.serviceThruDate),
    postedAt: str(p.postedAt ?? p.productionDate ?? new Date(0).toISOString()),
  });
}

/** m23.claim.replaced / m23.claim.voided → record a negative reversal accrual line. */
export async function handleClaimReversed(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ recorded: boolean }> {
  const patientId = str(p.patientId);
  const sourceId = str(p.claimId);
  if (!patientId || !sourceId) return { recorded: false };
  return store.recordAccrualLine({
    organizationId: str(p.organizationId),
    patientId,
    sourceKind: "reversal",
    sourceId,
    amountCents: -Math.abs(cents(p.priorPaidAmountCents ?? p.paidAmountCents)),
    serviceFrom: str(p.serviceFrom),
    serviceTo: str(p.serviceTo),
    postedAt: str(p.postedAt ?? new Date(0).toISOString()),
  });
}

/** m23.claim.line_finalized (rev 0655/0656) → record an inpatient day line for the 20% cap. */
export async function handleInpatientDay(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ recorded: boolean }> {
  const revCode = str(p.revCode);
  if (revCode !== "0655" && revCode !== "0656") return { recorded: false };
  const patientId = str(p.patientId);
  const sourceId = str(p.claimLineId ?? p.claimId);
  if (!patientId || !sourceId) return { recorded: false };
  return store.recordInpatientDay({
    organizationId: str(p.organizationId),
    patientId,
    sourceId,
    revCode,
    days: cents(p.days),
    serviceFrom: str(p.serviceFrom),
    serviceTo: str(p.serviceTo),
    postedAt: str(p.postedAt ?? new Date(0).toISOString()),
  });
}

/** m5.patient.deceased / m6.revocation.created → freeze the per-patient extrapolation denominator. */
export async function handleFreeze(
  store: CapConsumerStore,
  p: Record<string, unknown>,
): Promise<{ frozen: boolean }> {
  const patientId = str(p.patientId);
  if (!patientId) return { frozen: false };
  return store.freezePatient(str(p.organizationId), patientId, str(p.occurredAt ?? p.deceasedAt ?? p.revokedAt ?? new Date(0).toISOString()));
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
