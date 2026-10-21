// apps/backend/src/modules/22-documents/lifecycle/merge-redirect.ts — M22-T03 (§2.4 / D18, M5 `patient.merged`).
//
// The §2.4 `patient.merged` redirect-on-fetch: a document attached to a patient who was later merged into
// a survivor must stay reachable post-merge. M22 does NOT mutate `document.patient_id` eagerly on the
// merge event in the read path — on every fetch it resolves the document's stored `patient_id` through the
// merge chain to the surviving patient (always to `merged_into_id`, ≤ a hop bound), exactly like M5's
// `PatientReader` and M40's `followMerge`. This is the M22 `PatientDocumentRedirect` helper (§2.4 row
// "patient.merged"). Pure: the merge facts (source → survivor) are injected as data; no DB. The §2.3
// patient-binding-stability rule is enforced here — the only legal patient_id change is this cascade.
import type { PatientId } from "@chartwarden/types";
import { DocumentStateError } from "./errors";

/** Match M5's `MAX_MERGE_HOPS` chain bound — a broken/over-long chain fails safe to the last resolvable id. */
export const MAX_MERGE_HOPS = 3;

/** The injected merge facts: a source patient id → its direct `merged_into_id` survivor. A patient absent
 * from the map (or mapped to itself) is not merged. Modeled as a plain lookup so the resolver is pure. */
export interface MergeFacts {
  /** The survivor a source patient was merged into, or null when the patient was never merged. */
  survivorOf(patientId: PatientId): PatientId | null;
}

/** The outcome of resolving a document's patient through the merge chain. `redirected` is true when the
 * stored `patient_id` differed from the resolved survivor — the caller responds with the redirect. */
export interface PatientRedirectResult {
  readonly storedPatientId: PatientId;
  readonly survivingPatientId: PatientId;
  readonly redirected: boolean;
  readonly hops: number;
}

/**
 * Resolve a document's stored `patient_id` to the surviving patient through the merge chain (§2.4). Follows
 * `merged_into_id` (always to the survivor) up to {@link MAX_MERGE_HOPS}; a cycle or an over-long chain
 * fails safe to the last resolvable id (never throws on a malformed chain — a fetch must not 500 because a
 * historical merge graph is odd). A document whose patient was never merged resolves to itself
 * (`redirected: false`).
 */
export function resolvePatientRedirect(
  storedPatientId: PatientId,
  facts: MergeFacts,
): PatientRedirectResult {
  let current = storedPatientId;
  let hops = 0;
  const seen = new Set<PatientId>([current]);
  while (hops < MAX_MERGE_HOPS) {
    const survivor = facts.survivorOf(current);
    if (survivor === null || survivor === current) break;
    if (seen.has(survivor)) break; // cycle guard — fail safe to the last resolvable id.
    current = survivor;
    seen.add(current);
    hops += 1;
  }
  return {
    storedPatientId,
    survivingPatientId: current,
    redirected: current !== storedPatientId,
    hops,
  };
}

/**
 * Plan the §2.4 `patient.merged` cascade write: re-point `document.patient_id` to the survivor. This is the
 * ONLY legal mutation of `document.patient_id` (§2.3 patient-binding-stability). `requested` MUST equal the
 * resolved survivor — a re-point to any other patient is refused with `PATIENT_BINDING_IMMUTABLE`. Returns
 * the resolved survivor id the service writes; a no-op (idempotent) when already on the survivor.
 */
export function applyPatientMergeCascade(args: {
  readonly current: PatientId;
  readonly requested: PatientId;
  readonly facts: MergeFacts;
}): PatientId {
  const resolved = resolvePatientRedirect(args.current, args.facts);
  if (args.requested !== resolved.survivingPatientId) {
    throw new DocumentStateError(
      "PATIENT_BINDING_IMMUTABLE",
      "document.patient_id may only change via the patient.merged cascade, always to the resolved survivor",
    );
  }
  return resolved.survivingPatientId;
}
