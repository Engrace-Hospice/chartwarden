// apps/backend/src/modules/22-documents/domain/patient-redirect.ts — M22-T03 (§2.3, §2.4 patient-merge redirect).
//
// The PURE `patient.merged` redirect resolver (M22's `PatientDocumentRedirect` helper, §2.4). A `document` row
// keeps the `patient_id` it was created against; the M5 patient-merge cascade is the ONLY thing that changes a
// document's patient binding, and it always resolves to the surviving `merged_into_id` (§2.3). Rather than
// rewrite every historical row on a merge, M22 resolves the binding on every READ by walking the M5 merge chain
// to its terminal survivor. This module is that walk — clock-/DB-free; the service layer (M22-T07) supplies the
// `mergedInto` lookup backed by the M5 `patient.merged` consumer state, and uses the result to scope the fetch.
import { DocumentStateError, require_ } from "./errors";

/** A guard so a corrupt M5 merge chain (a cycle) cannot spin forever; far above any real merge depth. */
const MAX_MERGE_DEPTH = 64;

/**
 * §2.4 — resolve a document's effective patient id by following the M5 `merged_into_id` chain to its terminal
 * survivor. `mergedInto(id)` returns the id the given patient was merged INTO, or `null` if that patient is a
 * live survivor (the chain end). A patient never-merged returns its own id unchanged. Throws
 * `DOCUMENT_MERGE_CHAIN_UNRESOLVED` if the chain cycles or exceeds the depth guard (a corrupt merge graph).
 */
export function resolveEffectivePatientId(
  storedPatientId: string,
  mergedInto: (patientId: string) => string | null,
): string {
  let current = storedPatientId;
  const seen = new Set<string>([current]);
  for (let hops = 0; hops < MAX_MERGE_DEPTH; hops += 1) {
    const next = mergedInto(current);
    if (next === null) return current;
    require_(!seen.has(next), "DOCUMENT_MERGE_CHAIN_UNRESOLVED", "The M5 patient-merge chain contains a cycle.");
    seen.add(next);
    current = next;
  }
  throw new DocumentStateError(
    "DOCUMENT_MERGE_CHAIN_UNRESOLVED",
    `The M5 patient-merge chain exceeded the ${MAX_MERGE_DEPTH}-hop depth guard.`,
  );
}

/**
 * §2.3 — assert that a proposed `document.patient_id` change is legal: the ONLY permitted change is the
 * `patient.merged` cascade, and it must re-point to the resolved terminal survivor (not some arbitrary id). A
 * no-op (`from === to`) is allowed. Any other change is refused (`DOCUMENT_PATIENT_BINDING_IMMUTABLE`).
 */
export function assertPatientBindingChange(args: {
  readonly from: string;
  readonly to: string;
  readonly viaMerge: boolean;
  readonly resolvedSurvivorId: string;
}): void {
  if (args.from === args.to) return;
  require_(
    args.viaMerge,
    "DOCUMENT_PATIENT_BINDING_IMMUTABLE",
    "document.patient_id may only change via the patient.merged cascade.",
  );
  require_(
    args.to === args.resolvedSurvivorId,
    "DOCUMENT_PATIENT_BINDING_IMMUTABLE",
    "a merge re-point must target the resolved merged_into survivor, never an arbitrary patient.",
  );
}
