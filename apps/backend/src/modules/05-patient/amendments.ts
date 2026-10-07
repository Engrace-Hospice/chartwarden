// apps/backend/src/modules/05-patient/amendments.ts — the structured change an amendment request carries and
// the rule for applying it (GAP-118; HIPAA 45 CFR 164.526).
//
// The request used to store `requested_changes = {}` whatever the clinician asked for, so an ACCEPTED amendment
// changed nothing and the record kept the very value the patient disputed. A request now names ONE field and the
// value it should hold:
//   - DEMOGRAPHIC scope: the field must be in {@link AMENDABLE_DEMOGRAPHIC_FIELDS} (a closed allowlist — an
//     amendment is never a generic UPDATE-by-column-name). The current value is captured at submit time so the
//     reviewer sees what is being replaced, and the accepted change is applied to the patient in the same
//     transaction as the decision.
//   - CLINICAL / NARRATIVE scope: the request is recorded as given; accepting it does NOT rewrite the source
//     note (164.526(c)(1): the covered entity identifies the affected record and APPENDS or links the amendment,
//     it does not overwrite the original). The accepted request row IS that appended, linked record.
import { ValidationError } from "@wardenx/types";

/** The patient columns a demographic amendment may change, keyed by the public `fieldPath`. */
export const AMENDABLE_DEMOGRAPHIC_FIELDS = {
  legalFirstName: { kind: "text", required: true },
  legalMiddleName: { kind: "text", required: false },
  legalLastName: { kind: "text", required: true },
  legalNameSuffix: { kind: "text", required: false },
  dob: { kind: "date", required: true },
  genderIdentityCode: { kind: "text", required: false },
  sexualOrientationCode: { kind: "text", required: false },
  pronounsCode: { kind: "text", required: false },
  maritalStatusCode: { kind: "text", required: false },
} as const;

export type AmendableField = keyof typeof AMENDABLE_DEMOGRAPHIC_FIELDS;

export interface RequestedChangeInput {
  readonly fieldPath: string;
  readonly requestedValue: string | null;
}

/** What is persisted in `patient_amendment_request.requested_changes`. */
export interface StoredRequestedChange {
  readonly fieldPath: string;
  readonly currentValue: string | null;
  readonly requestedValue: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isAmendableField = (path: string): path is AmendableField =>
  Object.hasOwn(AMENDABLE_DEMOGRAPHIC_FIELDS, path);

function fail(field: string, message: string): never {
  throw new ValidationError(message, [{ field, code: "INVALID", message }]);
}

/**
 * Validate a requested change against the scope. Returns the normalized change, or `null` when none was
 * supplied (allowed only for clinical/narrative, where the rationale is the request). Throws a 422 when a
 * demographic request names a field outside the allowlist or an unusable value.
 */
export function normalizeRequestedChange(
  scope: string,
  change: RequestedChangeInput | undefined,
  today: string,
): RequestedChangeInput | null {
  if (scope === "demographic") {
    if (!change) fail("requestedChange", "A demographic amendment must name the field to change.");
    if (!isAmendableField(change.fieldPath))
      fail(
        "requestedChange.fieldPath",
        `'${change.fieldPath}' is not an amendable demographic field.`,
      );
    const def = AMENDABLE_DEMOGRAPHIC_FIELDS[change.fieldPath];
    const raw = change.requestedValue === null ? null : change.requestedValue.trim();
    if (raw === null || raw === "") {
      if (def.required)
        fail("requestedChange.requestedValue", `${change.fieldPath} cannot be cleared.`);
      return { fieldPath: change.fieldPath, requestedValue: null };
    }
    if (def.kind === "date") {
      if (!ISO_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`)))
        fail("requestedChange.requestedValue", "A date must be YYYY-MM-DD.");
      if (raw > today)
        fail("requestedChange.requestedValue", "A date of birth cannot be in the future.");
    }
    return { fieldPath: change.fieldPath, requestedValue: raw };
  }
  return change ? { fieldPath: change.fieldPath, requestedValue: change.requestedValue } : null;
}

/** The change an ACCEPTED amendment applies to the patient row, or `null` (nothing to apply). */
export function changeToApply(
  scope: string,
  stored: unknown,
): { column: AmendableField; value: string | null } | null {
  if (scope !== "demographic" || typeof stored !== "object" || stored === null) return null;
  const s = stored as Partial<StoredRequestedChange>;
  if (typeof s.fieldPath !== "string" || !isAmendableField(s.fieldPath)) return null;
  const value = s.requestedValue ?? null;
  if (value === null && AMENDABLE_DEMOGRAPHIC_FIELDS[s.fieldPath].required) return null;
  return { column: s.fieldPath, value };
}
