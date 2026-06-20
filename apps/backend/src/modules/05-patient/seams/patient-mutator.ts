// apps/backend/src/modules/05-patient/seams/patient-mutator.ts — M5-T08 the PatientMutator seam
// (M5 spec §4.9, D12). CLOSES the M5/Wave-A boot-gate deny-stub. Applies a field-level diff from an
// M29 proposal acceptance (or amendment / admin correction): demographics on the `patient` row,
// address through the append-only D5 path, partner MRNs added to patient_identifier; the FORBIDDEN
// identifier set (mrn/mbi/ssn/state_id/status/merged_into_id/id/organization_id) is SILENTLY STRIPPED
// (W-M5-17 defense in depth — a chatty partner's PID-19 SSN is dropped, not persisted, never an
// error). Emits `m5.patient.updated` with the applied-field list; the audit captures applied vs
// stripped. Pure orchestration over an injected `PatientMutatorStore` (Drizzle in prod; in-memory slice).
import type {
  PatientMutationPatch,
  PatientMutator,
  PatientMutatorInput,
  PatientMutatorResult,
} from "@wardenx/types";

/** The §4.9.1 / D12 forbidden patch keys — present in the shape for caller convenience, stripped here. */
export const FORBIDDEN_PATCH_FIELDS = [
  "mrn",
  "mbi",
  "ssn",
  "stateId",
  "status",
  "mergedIntoId",
  "id",
  "organizationId",
] as const;
const FORBIDDEN = new Set<string>(FORBIDDEN_PATCH_FIELDS);

/** The demographic + contact fields the mutator may apply to the patient row / side tables (§4.9.1). */
const APPLIABLE_SCALAR_FIELDS = [
  "legalFirstName",
  "legalMiddleName",
  "legalLastName",
  "preferredName",
  "dateOfBirth",
  "administrativeSex",
  "maritalStatus",
  "preferredLanguage",
  "phoneHome",
  "phoneMobile",
  "email",
] as const;

/** The data port the mutator composes over (Drizzle writes under withOrgContext in prod). */
export interface PatientMutatorStore {
  /** Apply the appliable scalar demographic/contact fields to the patient + side tables. */
  applyFields(
    organizationId: string,
    patientId: string,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** Append a new address version (D5 append-only) — returns whether a row was created. */
  appendAddress(
    organizationId: string,
    patientId: string,
    address: NonNullable<PatientMutationPatch["address"]>,
  ): Promise<boolean>;
  /** Add partner MRNs to patient_identifier(kind='partner_mrn'); returns the count added. */
  addExternalMrns(
    organizationId: string,
    patientId: string,
    mrns: ReadonlyArray<{ assigningAuthority: string; value: string }>,
  ): Promise<number>;
  /** Emit `m5.patient.updated` with the applied-field list (§4.6). */
  emitPatientUpdated(
    organizationId: string,
    patientId: string,
    changed: readonly string[],
  ): Promise<void>;
}

/** Build the real {@link PatientMutator} over an injected store (slice in-memory; Drizzle in prod). */
export function createPatientMutator(store: PatientMutatorStore): PatientMutator {
  return {
    async apply(input: PatientMutatorInput): Promise<PatientMutatorResult> {
      const { organizationId, patientId, patch } = input;
      const stripped: string[] = [];
      const applied: string[] = [];
      const scalarFields: Record<string, unknown> = {};

      for (const key of Object.keys(patch)) {
        if (FORBIDDEN.has(key)) {
          stripped.push(key);
          continue;
        }
        // address + externalMrnsToAdd are handled via their dedicated cascades below.
        if (key === "address" || key === "externalMrnsToAdd") continue;
        if ((APPLIABLE_SCALAR_FIELDS as readonly string[]).includes(key)) {
          const value = (patch as Record<string, unknown>)[key];
          if (value !== undefined) {
            scalarFields[key] = value;
            applied.push(key);
          }
        }
      }

      if (applied.length > 0) await store.applyFields(organizationId, patientId, scalarFields);

      let addressVersionCreated = false;
      if (patch.address) {
        addressVersionCreated = await store.appendAddress(organizationId, patientId, patch.address);
        if (addressVersionCreated) applied.push("address");
      }

      let externalMrnsAddedCount = 0;
      if (patch.externalMrnsToAdd && patch.externalMrnsToAdd.length > 0) {
        externalMrnsAddedCount = await store.addExternalMrns(
          organizationId,
          patientId,
          patch.externalMrnsToAdd,
        );
        if (externalMrnsAddedCount > 0) applied.push("externalMrns");
      }

      // Emit `patient.updated` only when something actually changed (§4.6); a pure-stripped patch is a no-op.
      if (applied.length > 0) await store.emitPatientUpdated(organizationId, patientId, applied);

      return { patientId, appliedFields: applied, strippedFields: stripped, addressVersionCreated, externalMrnsAddedCount };
    },
  };
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────

/** A capturing in-memory {@link PatientMutatorStore} for the slice/tests. */
export function createInMemoryPatientMutatorStore(): {
  store: PatientMutatorStore;
  applied: Array<{ patientId: string; fields: Record<string, unknown> }>;
  events: Array<{ patientId: string; changed: readonly string[] }>;
} {
  const applied: Array<{ patientId: string; fields: Record<string, unknown> }> = [];
  const events: Array<{ patientId: string; changed: readonly string[] }> = [];
  return {
    applied,
    events,
    store: {
      async applyFields(_org, patientId, fields) {
        applied.push({ patientId, fields: { ...fields } });
      },
      async appendAddress() {
        return true;
      },
      async addExternalMrns(_org, _patientId, mrns) {
        return mrns.length;
      },
      async emitPatientUpdated(_org, patientId, changed) {
        events.push({ patientId, changed });
      },
    },
  };
}
