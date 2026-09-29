// apps/backend/src/modules/05-patient/merges.ts — the §2.3/§2.4 direct patient-merge decision core
// (F-171, #248). `POST /api/v1/patients/:id/merge` (spec route table, §4.3 "direct merge,
// admin-initiated, outside queue") folds a duplicate chart (`source`) into a surviving chart
// (`target`): the source flips to `status='merged'` with `merged_into_id` set, the target optionally
// absorbs a per-field resolution the reviewer chose, and `patient_merge` records the audit trail
// (`merged_field_diff` — "what we kept, what we dropped", §3.5 ERD). This is the mechanism the spec's
// D8 decision names for downstream consumers — "re-points all FK references through an indexed
// `patient_id_redirect` view (no destructive UPDATE on satellite tables)" — applied here to the ONE
// row the merge itself touches for real (the target's own demographic columns); every OTHER table's
// `patient_id` FK stays pointed at the source forever, resolved transparently by whoever reads it
// (M40's `followMerge`/`resolveRedirect` is the same chase for MDM canonical rows; M22's own
// `lifecycle/merge-redirect.ts` is the identical design already written, unwired, for documents — see
// that file's header). This module owns none of that downstream resolution; it owns only the ONE
// transition that makes `patient.merged_into_id` a fact worth resolving in the first place.
//
// Pure orchestration over the two patient rows' current field values — no Drizzle, no clock, no I/O.
// `merges-db.ts` is the real transactional caller (the `deceased.ts` / `deceased-db.ts` split).

/**
 * The `patient` table's own mutable demographic columns eligible for a merge field-resolution
 * (§4.3 "choose target, field-resolution UI"). Deliberately scoped to THIS table's columns only —
 * `mrn` is immutable-after-create (§2.2, resolved by merge itself, never by a field resolution),
 * `id`/`organizationId`/`status`/`mergedIntoId` are structural and never resolvable, and satellite-
 * table conflicts (addresses, payers, identifiers, caregivers) are a separate, unbuilt UI concern the
 * spec does not enumerate a resolution contract for here — attempting to guess one would be exactly
 * the kind of unspecified merge semantics this task is instructed not to invent.
 */
export const MERGEABLE_PATIENT_FIELDS = [
  "legalFirstName",
  "legalMiddleName",
  "legalLastName",
  "legalNameSuffix",
  "dob",
  "sexAssignedAtBirth",
  "genderIdentityCode",
  "sexualOrientationCode",
  "pronounsCode",
  "maritalStatusCode",
  "raceCodes",
  "ethnicityCodes",
] as const;

export type MergeablePatientField = (typeof MERGEABLE_PATIENT_FIELDS)[number];

const MERGEABLE_FIELD_SET: ReadonlySet<string> = new Set(MERGEABLE_PATIENT_FIELDS);

/** §2.4.1 — the source states the state diagram actually draws an edge to `merged` from. `deceased`
 *  and `merged` itself are deliberately excluded: no transition exists for either in the spec's own
 *  stateDiagram, and merging away a decedent's chart would sever the M16 bereavement workflow's
 *  anchor mid-13-month-clock — a destructive ambiguity this module refuses rather than guesses at. */
export const MERGEABLE_SOURCE_STATUSES: ReadonlySet<string> = new Set([
  "prospective",
  "active",
  "on_hold",
  "discharged",
]);

export type FieldResolutionKeep = "source" | "target" | "custom";

export interface FieldResolution {
  readonly keep: FieldResolutionKeep;
  readonly customValue?: unknown;
}

export type FieldResolutions = Readonly<Record<string, FieldResolution>>;

/** The two rows' current demographic column values — only the {@link MERGEABLE_PATIENT_FIELDS} keys
 *  are read; extra keys on the row are ignored (the DB wrapper may pass the full column set). */
export type PatientFieldValues = Readonly<Record<string, unknown>>;

export interface PatientMergeSubject {
  readonly id: string;
  readonly status: string;
  readonly fields: PatientFieldValues;
}

export interface PlanMergeInput {
  readonly source: PatientMergeSubject;
  readonly target: PatientMergeSubject;
  readonly fieldResolutions: FieldResolutions;
  readonly reason: string;
}

/** One field's recorded resolution — the `patient_merge.merged_field_diff` shape (§3.5). */
export interface MergedFieldDiffEntry {
  readonly kept: FieldResolutionKeep;
  readonly sourceValue: unknown;
  readonly targetValue: unknown;
  readonly appliedValue: unknown;
}

export interface PlannedMerge {
  /** Column → value writes to apply to the TARGET row (empty keys where `keep==='target'`, a no-op). */
  readonly targetFieldUpdates: Readonly<Record<string, unknown>>;
  /** The full audit record for `patient_merge.merged_field_diff` — every resolved field, even a no-op. */
  readonly mergedFieldDiff: Readonly<Record<string, MergedFieldDiffEntry>>;
}

export class SelfMergeError extends Error {
  constructor(readonly patientId: string) {
    super(`cannot merge patient '${patientId}' into itself`);
    this.name = "SelfMergeError";
  }
}

/** 409 ALREADY_MERGED (spec's own error code for this exact condition). */
export class SourceAlreadyMergedError extends Error {
  constructor(readonly patientId: string) {
    super(`patient '${patientId}' is already merged elsewhere`);
    this.name = "SourceAlreadyMergedError";
  }
}

/** Merging INTO an already-merged row would create a redirect CHAIN — no `patient_resolver` seam
 *  chases one for patients today (unlike M40's `followMerge`), so refusing it is the conservative
 *  reading rather than creating a state nothing can resolve. Reported as its own condition, not
 *  folded into {@link SourceAlreadyMergedError}, so a caller can distinguish "pick a different chart
 *  to keep" from "this chart no longer exists to merge". */
export class TargetAlreadyMergedError extends Error {
  constructor(readonly patientId: string) {
    super(`cannot merge into patient '${patientId}': it is itself already merged`);
    this.name = "TargetAlreadyMergedError";
  }
}

/** The source is in a status the §2.4.1 state diagram draws no `→ merged` edge from. */
export class UnmergeableSourceStatusError extends Error {
  constructor(
    readonly patientId: string,
    readonly status: string,
  ) {
    super(`patient '${patientId}' cannot be merged from status '${status}'`);
    this.name = "UnmergeableSourceStatusError";
  }
}

/** A `fieldResolutions` key names a column outside {@link MERGEABLE_PATIENT_FIELDS} — refused rather
 *  than silently ignored, so a caller never believes a field was reconciled when it was not. */
export class UnknownMergeFieldError extends Error {
  constructor(readonly field: string) {
    super(`'${field}' is not a mergeable patient field`);
    this.name = "UnknownMergeFieldError";
  }
}

/**
 * Plan a direct patient merge (§2.4): validates the source/target pair and status preconditions, then
 * resolves each declared `fieldResolutions` entry into a concrete value (source/target/custom) —
 * producing both the TARGET row's field updates and the full `merged_field_diff` audit record. Pure;
 * throws a typed error on any precondition violation rather than guessing past it.
 */
export function planMerge(input: PlanMergeInput): PlannedMerge {
  const { source, target, fieldResolutions } = input;

  if (source.id === target.id) throw new SelfMergeError(source.id);
  if (source.status === "merged") throw new SourceAlreadyMergedError(source.id);
  if (target.status === "merged") throw new TargetAlreadyMergedError(target.id);
  if (!MERGEABLE_SOURCE_STATUSES.has(source.status)) {
    throw new UnmergeableSourceStatusError(source.id, source.status);
  }

  const targetFieldUpdates: Record<string, unknown> = {};
  const mergedFieldDiff: Record<string, MergedFieldDiffEntry> = {};

  for (const [field, resolution] of Object.entries(fieldResolutions)) {
    if (!MERGEABLE_FIELD_SET.has(field)) throw new UnknownMergeFieldError(field);
    const sourceValue = source.fields[field];
    const targetValue = target.fields[field];
    const appliedValue =
      resolution.keep === "source"
        ? sourceValue
        : resolution.keep === "target"
          ? targetValue
          : resolution.customValue;
    mergedFieldDiff[field] = { kept: resolution.keep, sourceValue, targetValue, appliedValue };
    if (resolution.keep !== "target") targetFieldUpdates[field] = appliedValue;
  }

  return { targetFieldUpdates, mergedFieldDiff };
}
