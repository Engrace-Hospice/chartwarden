// apps/backend/src/modules/08-encounters/seams/readers.ts — M8-T08 the §4.7 owned-seam implementations:
// pure orchestration over an injected {@link EncounterReaderStore}. Each factory returns the leaf-typed
// seam interface (@wardenx/types) the M1 registry validates and downstream modules resolve. The impls
// add NO tenant logic — RLS scopes every store read/write by the consumer's `app.org_id`; they only
// project store DTOs and apply the one derived rule with a single home: the §2.4/D3/D4/D12 billability
// verdict (`deriveBillability`).
import type {
  BillableEncounterReader,
  EncounterBillability,
  EncounterCreator,
  EncounterId,
  MileagePayrollReader,
  SignedEncountersReader,
} from "@wardenx/types";
import { COSIGN_REQUIRED_DISCIPLINES } from "../lifecycle/index";
import type { EncounterReaderStore, StoredEncounterFacts } from "./store";

/** Thrown when a render-payload read targets an encounter id that does not exist / is not visible. */
export class EncounterNotFoundError extends Error {
  constructor(encounterId: EncounterId) {
    super(`encounter '${encounterId}' not found`);
    this.name = "EncounterNotFoundError";
  }
}

/**
 * §4.7 / §2.4 — the single billability rule. An encounter is NOT billable when it is voided (§3.6), a
 * volunteer visit (D12), still awaiting its routed RN cosignature (D3 — `billable:false` from primary
 * sign through transition to `cosigned`), or a ≥significant late entry whose override is not attested
 * (D4). Otherwise it is billable. The caller (M23/M24) queries this over signed encounters.
 */
export function deriveBillability(f: StoredEncounterFacts): EncounterBillability {
  if (f.status === "voided") return { encounterId: f.encounterId, billable: false, reason: "voided" };
  if (f.discipline === "volunteer" || f.encounterType === "volunteer_visit") {
    return { encounterId: f.encounterId, billable: false, reason: "volunteer_non_billable" };
  }
  if (COSIGN_REQUIRED_DISCIPLINES.includes(f.discipline) && f.status !== "cosigned") {
    return { encounterId: f.encounterId, billable: false, reason: "awaiting_cosignature" };
  }
  if (
    (f.lateEntryTier === "significant_late_entry" || f.lateEntryTier === "administrative_override") &&
    !f.lateEntryAttested
  ) {
    return { encounterId: f.encounterId, billable: false, reason: "late_entry_unattested" };
  }
  return { encounterId: f.encounterId, billable: true };
}

/** §4.7 BillableEncounterReader — per-encounter claim-line eligibility for M23/M24. */
export function createBillableEncounterReader(store: EncounterReaderStore): BillableEncounterReader {
  return {
    async billability(encounterIds) {
      const facts = await store.encounterFacts(encounterIds);
      return facts.map(deriveBillability);
    },
  };
}

/** §4.7 SignedEncountersReader — signed-encounter digests (M14 IDG) + render payload (M22 PDF). */
export function createSignedEncountersReader(store: EncounterReaderStore): SignedEncountersReader {
  return {
    async signedEncountersForPatientSince(patientId, since) {
      return store.signedEncountersForPatientSince(patientId, since);
    },
    async renderPayloadFor(encounterId) {
      const payload = await store.renderPayload(encounterId);
      if (payload === null) throw new EncounterNotFoundError(encounterId);
      return payload;
    },
  };
}

/** §4.7 MileagePayrollReader — authoritative per-clinician mileage for payroll/AP (M27, §4.5 D10). */
export function createMileagePayrollReader(store: EncounterReaderStore): MileagePayrollReader {
  return {
    async mileageForPayrollPeriod(clinicianMembershipId, range) {
      return store.mileageForClinician(clinicianMembershipId, range);
    },
  };
}

/** §4.7 EncounterCreator — open a draft encounter for an upstream reuser (M16 bereavement, M17 seeding). */
export function createEncounterCreator(store: EncounterReaderStore): EncounterCreator {
  return {
    async createDraftEncounter(input) {
      return store.insertDraftEncounter(input);
    },
  };
}
