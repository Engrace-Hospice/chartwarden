// apps/backend/src/bootstrap/erasers/registry.ts — the M4 destruction-cert eraser
// registry. Every PHI data class must register a DataEraser or boot fails
// (validateErasers()), mirroring validateSeams(). This is decision D4 from the promoted
// boot.ts example: a missing eraser means a right-to-erasure request would silently
// no-op a data class, so we fail closed at startup instead.

import type { DataClass, DataEraser } from "../interfaces";

export class EraserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EraserError";
  }
}

const erasers = new Map<DataClass, DataEraser>();

/** Every PHI data class that must have a registered eraser before serving traffic. */
export const REQUIRED_ERASERS: readonly DataClass[] = [
  "audit_event",
  "clinical_record",
  "documents",
  // M36-T10: message bodies (D9 tenant offboarding). M36 registers the REAL eraser via the
  // composition-root hook over this deny-stub — tenant-offboarding cryptographically erases every
  // `message.body_cipher` by destroying the tenant DEK (§7.8), then deletes structural +
  // sole-tenant cross-tenant rows. Bodies are unreadable the instant the DEK is gone.
  "messages",
  "consent",
  "telehealth_recording",
  // M2-T10: identity credentials (two_factor/passkey + pending invitations). M2 registers
  // the REAL eraser via the composition root's registerModuleErasers hook (it runs AFTER
  // wireErasers(), standing over the Phase-0 deny-stub); see apps/backend/src/index.ts.
  "identity",
  // M38-T10: a tenant's `value_set_tenant_extension` rows (D8 offboarding). M38 registers the
  // REAL eraser via the same composition-root hook over this deny-stub; platform terminology
  // tables are reference data and stay untouched.
  "terminology_tenant_extensions",
  // M40-T10: a tenant's MDM overlay/provisional/baa rows (D7 offboarding). M40 registers the REAL
  // eraser via the composition-root hook over this deny-stub; the org-less CANONICAL entities
  // (physician/facility/payer) are shared reference data and stay untouched (§7.8).
  "mdm_tenant_overlays",
  // M6-T12: a patient's admission record (election/CTI/F2F/LOC/revocation/discharge/transfer/NOR/
  // compliance windows + referrals). M6 registers the REAL eraser via the composition-root hook over
  // this deny-stub — under an M4 destruction certificate it deletes the admission satellites and
  // tombstones the `admission` row for FK integrity (D8); the `subjectId` is the patient.
  "admission_record",
];

export function registerEraser(dataClass: DataClass, eraser: DataEraser): void {
  erasers.set(dataClass, eraser);
}

export function getEraser(dataClass: DataClass): DataEraser {
  const e = erasers.get(dataClass);
  if (e === undefined) throw new EraserError(`no eraser registered for data class '${dataClass}'`);
  return e;
}

/** Boot gate: throw listing every PHI data class with no registered eraser. */
export function validateErasers(): void {
  const missing = REQUIRED_ERASERS.filter((c) => !erasers.has(c));
  if (missing.length > 0) {
    throw new EraserError(
      `validateErasers: ${missing.length} data class(es) without an eraser — refusing to start: ${missing.join(", ")}`,
    );
  }
}

/** Test-only: clear the registry between cases. */
export function __resetErasersForTest(): void {
  erasers.clear();
}
