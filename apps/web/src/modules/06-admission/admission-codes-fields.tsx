import {
  ADMISSION_SOURCE_CODES,
  ADMISSION_SOURCE_LABELS,
  ADMISSION_TYPE_CODES,
  ADMISSION_TYPE_LABELS,
  type AdmissionSourceCode,
  type AdmissionTypeCode,
  isAdmissionSourceCode,
  isAdmissionTypeCode,
} from "@chartwarden/types";
// apps/web/src/modules/06-admission — the UB-04 Type of Admission (FL 14) and Point of Origin (FL 15) pickers. The
// codes are facts about the admission that M6 owns; M23 prints them on every claim (the claim is blocked without
// them), so they are asked wherever an admission is created or its details are completed.
import { SelectField } from "@chartwarden/ui";
import type { JSX } from "react";

export interface AdmissionCodesDraft {
  readonly admissionTypeCode: string;
  readonly admissionSourceCode: string;
}

export const EMPTY_ADMISSION_CODES: AdmissionCodesDraft = {
  admissionTypeCode: "",
  admissionSourceCode: "",
};

const NOT_CHOSEN = { value: "", label: "Select…" } as const;

const TYPE_OPTIONS = [
  NOT_CHOSEN,
  ...ADMISSION_TYPE_CODES.map((c) => ({ value: c, label: `${c} — ${ADMISSION_TYPE_LABELS[c]}` })),
];
const SOURCE_OPTIONS = [
  NOT_CHOSEN,
  ...ADMISSION_SOURCE_CODES.map((c) => ({
    value: c,
    label: `${c} — ${ADMISSION_SOURCE_LABELS[c]}`,
  })),
];

/** The request-body fragment for the chosen codes (a blank choice sends nothing — never a default). */
export function admissionCodesBody(draft: AdmissionCodesDraft): {
  admissionTypeCode?: AdmissionTypeCode;
  admissionSourceCode?: AdmissionSourceCode;
} {
  return {
    ...(isAdmissionTypeCode(draft.admissionTypeCode)
      ? { admissionTypeCode: draft.admissionTypeCode }
      : {}),
    ...(isAdmissionSourceCode(draft.admissionSourceCode)
      ? { admissionSourceCode: draft.admissionSourceCode }
      : {}),
  };
}

export function admissionCodesComplete(draft: AdmissionCodesDraft): boolean {
  return draft.admissionTypeCode !== "" && draft.admissionSourceCode !== "";
}

export function AdmissionCodesFields({
  draft,
  onChange,
  showErrors = false,
  required = false,
}: {
  draft: AdmissionCodesDraft;
  onChange: (next: AdmissionCodesDraft) => void;
  showErrors?: boolean;
  required?: boolean;
}): JSX.Element {
  return (
    <>
      <SelectField
        id="admission-type-code"
        label="Type of admission"
        hint="UB-04 FL 14 — printed on every claim."
        value={draft.admissionTypeCode}
        onChange={(event) => onChange({ ...draft, admissionTypeCode: event.target.value })}
        options={TYPE_OPTIONS}
        required={required}
        error={
          showErrors && required && !draft.admissionTypeCode
            ? "Choose the type of admission."
            : undefined
        }
      />
      <SelectField
        id="admission-source-code"
        label="Point of origin"
        hint="UB-04 FL 15 — where the patient came from."
        value={draft.admissionSourceCode}
        onChange={(event) => onChange({ ...draft, admissionSourceCode: event.target.value })}
        options={SOURCE_OPTIONS}
        required={required}
        error={
          showErrors && required && !draft.admissionSourceCode
            ? "Choose the point of origin."
            : undefined
        }
      />
    </>
  );
}
