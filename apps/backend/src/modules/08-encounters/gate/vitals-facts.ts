// apps/backend/src/modules/08-encounters/gate/vitals-facts.ts — §2.6 check 2's fact derivation (#125).
//
// Pure (no IO, matching the gate's own rule): turns the raw `vitals` rows an encounter carries into the
// two `EncounterGateFacts` sets the gate reads. An encounter can carry more than one `vitals` row ("most
// encounters have one set; some have multiple over the visit" — §2.2), so this is a UNION across every
// row, not a read of the latest one — a field captured on an earlier set in the same visit still counts.
import type { VitalField } from "@wardenx/hearthnote";

/** One `vitals` row's fields, exactly as the service reads them off the table. */
export interface VitalsRowFacts {
  readonly bpSystolic: number | null;
  readonly bpDiastolic: number | null;
  readonly heartRate: number | null;
  readonly respiratoryRate: number | null;
  readonly temperature: string | null;
  readonly spo2: number | null;
  readonly painScore: number | null;
  readonly clinicallyNotIndicatedFields: readonly string[] | null;
}

const VITAL_FIELDS: readonly VitalField[] = [
  "bp",
  "heartRate",
  "respiratoryRate",
  "temperature",
  "spo2",
  "pain",
];

function isVitalField(s: string): s is VitalField {
  return (VITAL_FIELDS as readonly string[]).includes(s);
}

/**
 * §2.6 check 2's two sets, unioned across every row. `bp` needs BOTH `bpSystolic`/`bpDiastolic`
 * non-null on the SAME row — a pair captured across two different sets is not one reading. An entry in
 * `clinicallyNotIndicatedFields` that is not exactly one of the six {@link VitalField} spellings is
 * ignored (not a capture, not a valid escape) rather than treated as a match or a crash — the column is
 * unconstrained free text at the DB and this is the first reader to give it a vocabulary.
 */
export function deriveVitalsGateFacts(rows: readonly VitalsRowFacts[]): {
  readonly captured: ReadonlySet<VitalField>;
  readonly clinicallyNotIndicated: ReadonlySet<VitalField>;
} {
  const captured = new Set<VitalField>();
  const clinicallyNotIndicated = new Set<VitalField>();
  for (const r of rows) {
    if (r.bpSystolic !== null && r.bpDiastolic !== null) captured.add("bp");
    if (r.heartRate !== null) captured.add("heartRate");
    if (r.respiratoryRate !== null) captured.add("respiratoryRate");
    if (r.temperature !== null) captured.add("temperature");
    if (r.spo2 !== null) captured.add("spo2");
    if (r.painScore !== null) captured.add("pain");
    for (const f of r.clinicallyNotIndicatedFields ?? []) {
      if (isVitalField(f)) clinicallyNotIndicated.add(f);
    }
  }
  return { captured, clinicallyNotIndicated };
}
