// apps/backend/src/modules/12-dosespot/tenant-config/audit-port.ts — the field-level audit row of a tenant's own DoseSpot
// registration change. The row-level write-audit trigger on `dosespot_clinic_registration` records THAT the row changed (and,
// in its context, that the sealed secret did); it cannot say WHICH fields the person chose to change or WHO in the tenant did
// it. This port adds that: field NAMES and codes, never a value, in the SAME transaction as the change. M12 may not write
// `audit_event` itself (only `@chartwarden/audit` may), so the composition root binds the port over the sanctioned helper.
import type { DbClient } from "@chartwarden/db";

export const CLINIC_AUDIT_EVENTS = {
  put: "m12.dosespot_clinic.changed",
  verified: "m12.dosespot_clinic.tested",
  activated: "m12.dosespot_clinic.activated",
  deactivated: "m12.dosespot_clinic.deactivated",
  prescriberEnrolled: "m12.dosespot_clinic.prescriber_enrolled",
} as const;
export type ClinicAuditEvent = (typeof CLINIC_AUDIT_EVENTS)[keyof typeof CLINIC_AUDIT_EVENTS];

export interface ClinicAuditEntry {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly eventType: ClinicAuditEvent;
  /** The registration's (or, for an enrolment, the roster row's) id. */
  readonly resourceId: string;
  readonly resourceKind: "dosespot_clinic_registration" | "dosespot_prescriber";
  /** Names of the fields the change touched (never values). */
  readonly changedFields: readonly string[];
  /** Non-sensitive facts (a code, a status, an outcome). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

export interface ClinicAuditPort {
  record(tx: DbClient, entry: ClinicAuditEntry): Promise<void>;
}
