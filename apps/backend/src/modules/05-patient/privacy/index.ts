// apps/backend/src/modules/05-patient/privacy — the privacy-flag snapshot recompute + SUD read
// enforcement (M5-T10, §7.6, D10). The `patient_privacy_flag_snapshot` is a denormalized cache of a
// patient's active privacy flags, recomputed from M39 `m39.consent.*` events (the consumer here is a
// FORWARD-SEAM / DENY-STUB — inert until M39 lands). §7.6 SUD enforcement: a read of a SUD-flagged
// patient requires a §2.31 Part-2 consent on file (`sud_consent_present`); without it the SUD-tagged
// records are denied. All pure — the engine decides, the service/route applies.

/** The privacy flags a snapshot may carry (§3.5). `sud` is the 42 CFR Part 2 flag. */
export type PrivacyFlag =
  | "sud"
  | "hiv"
  | "mental_health"
  | "genetic"
  | "minor_restricted"
  | "abuse_victim";

/** A consent record the recompute reads (the M39 shape M5 consumes; minimal projection). */
export interface ConsentSignal {
  /** The privacy category this consent governs. */
  readonly flag: PrivacyFlag;
  /** True when an active §2.31 consent is on file for the category (false = restricted). */
  readonly active: boolean;
}

/**
 * Recompute a patient's active privacy-flag set from its consent signals (D10). A flag is PRESENT
 * (restricted) when the category applies AND no active consent removes the restriction — i.e. the
 * flag is set when `active === false`. Deterministic; sorted for a stable snapshot.
 */
export function recomputePrivacyFlags(signals: readonly ConsentSignal[]): PrivacyFlag[] {
  const flags = new Set<PrivacyFlag>();
  for (const s of signals) if (!s.active) flags.add(s.flag);
  return [...flags].sort();
}

/** Error thrown when a SUD-flagged read is attempted without a Part-2 consent (§7.6). */
export class SudConsentRequiredError extends Error {
  constructor(readonly patientId: string) {
    super(`patient ${patientId}: SUD-categorized records require a 42 CFR Part 2 consent (§7.6)`);
    this.name = "SudConsentRequiredError";
  }
}

/**
 * The §7.6 SUD read gate. When the patient's snapshot carries the `sud` flag, a read of SUD-tagged
 * records is permitted ONLY when an active §2.31 consent is present (`sudConsentPresent`). Non-SUD
 * patients and consented SUD patients pass. The ABAC predicate `sud_consent_present` resolves through
 * this same decision (registered when M39 lands; until then the snapshot's flag is the source).
 */
export function isSudReadAllowed(flags: readonly PrivacyFlag[], sudConsentPresent: boolean): boolean {
  if (!flags.includes("sud")) return true; // not SUD-restricted → no gate
  return sudConsentPresent;
}

/** Assert the §7.6 SUD gate — throws {@link SudConsentRequiredError} when the read is not allowed. */
export function assertSudReadAllowed(
  patientId: string,
  flags: readonly PrivacyFlag[],
  sudConsentPresent: boolean,
): void {
  if (!isSudReadAllowed(flags, sudConsentPresent)) throw new SudConsentRequiredError(patientId);
}

// ── M39 consent-event recompute consumer (FORWARD-SEAM / DENY-STUB — inert until M39, Wave C T02+) ──

/** The `m39.consent.*` event payload M5's recompute consumer reads (minimal; M39 owns the catalog). */
export interface M39ConsentChangedPayload {
  readonly organizationId: string;
  readonly patientId: string;
  readonly signals: readonly ConsentSignal[];
}

/** Ports the recompute consumer binds (Drizzle snapshot write + outbox emit) when M39 wires it. */
export interface PrivacySnapshotPorts {
  writeSnapshot(organizationId: string, patientId: string, flags: readonly PrivacyFlag[]): Promise<void>;
  emitPrivacyFlagChanged(organizationId: string, patientId: string, flags: readonly PrivacyFlag[]): Promise<void>;
}

/** Apply an `m39.consent.changed` event: recompute the snapshot + emit `m5.patient.privacy_flag_changed`
 *  (§7.6, within 5s). Pure-over-ports; wired live when M39 publishes (deny-stubbed now). */
export async function applyConsentChanged(
  payload: M39ConsentChangedPayload,
  ports: PrivacySnapshotPorts,
): Promise<readonly PrivacyFlag[]> {
  const flags = recomputePrivacyFlags(payload.signals);
  await ports.writeSnapshot(payload.organizationId, payload.patientId, flags);
  await ports.emitPrivacyFlagChanged(payload.organizationId, payload.patientId, flags);
  return flags;
}

/** True in Phase 1 (Wave C): M39 ships in the same wave; until its consumer is wired live the
 *  snapshot is seeded by admit/admin resync, not the event. */
export const M39_CONSENT_CONSUMER_DEFERRED = true;
