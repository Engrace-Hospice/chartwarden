// apps/web/src/modules/10-hope — the clinical sections of the recording dialog (I diagnosis, J health conditions, N medications) and the
// §2.1 payload built from them (split from the dialog, which is about the window, the author and the request). The values live in ONE
// object the dialog holds, so a reset is one assignment and the payload is a pure function of it.
import {
  CodeSearchInput,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
} from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import type { HopeData } from "./hope-api";
import { checkRow, lateBox, meta } from "./hope-dialog-styles";

/** The §2.1 CMS J2051 symptom roster + severities, both derived from the wire contract. */
type J2051Entry = NonNullable<NonNullable<HopeData["J"]>["J2051"]>["entries"][number];
type SymptomCode = J2051Entry["symptomCode"];
export type Severity = J2051Entry["severity"];

const SYMPTOMS: readonly SymptomCode[] = [
  "pain",
  "shortness_of_breath",
  "anxiety",
  "agitation",
  "nausea_vomiting",
  "constipation",
  "restlessness",
  "other",
];
const SEVERITIES: readonly Severity[] = ["none", "mild", "moderate", "severe"];
/** D4 — moderate or severe on ANY symptom creates the 2-calendar-day SFV obligation. */
const TRIGGER_SEVERITIES: ReadonlySet<string> = new Set(["moderate", "severe"]);

/** The server's own bounds on the free-text fields that are not otherwise limited (`J2051Entry`, `HopeData.N`). */
const OTHER_SYMPTOM_LABEL_MAX = 100;
const BOWEL_CONTRAINDICATION_MAX = 500;

/** "shortness_of_breath" → "Shortness Of Breath". */
export const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** What the clinician entered in the three sections: nothing screened, nothing prescribed. */
export interface SectionValues {
  readonly primaryDiagnosisIcd10: string;
  readonly painScreened: boolean;
  readonly painCharacteristics: string;
  readonly dyspneaScreened: boolean;
  readonly dyspneaCharacteristics: string;
  readonly severities: Readonly<Record<string, Severity>>;
  readonly otherSymptomLabel: string;
  readonly opioidPrescribed: boolean;
  readonly scheduledBowelRegimen: boolean;
  readonly bowelRegimenContraindication: string;
}

export const EMPTY_SECTIONS: SectionValues = {
  primaryDiagnosisIcd10: "",
  painScreened: false,
  painCharacteristics: "",
  dyspneaScreened: false,
  dyspneaCharacteristics: "",
  severities: {},
  otherSymptomLabel: "",
  opioidPrescribed: false,
  scheduledBowelRegimen: false,
  bowelRegimenContraindication: "",
};

/** The §2.1 payload for the four sections this codebase defines items for (Q only when the discharge needs it: D9). */
export function buildHopeData(values: SectionValues, needsQ: boolean): HopeData {
  const { severities } = values;
  const entries = SYMPTOMS.filter((s) => severities[s] !== undefined).map((symptomCode) => ({
    symptomCode,
    severity: severities[symptomCode] as Severity,
    ...(symptomCode === "other" && values.otherSymptomLabel.trim() !== ""
      ? { otherSymptomLabel: values.otherSymptomLabel.trim() }
      : {}),
  }));
  const data: Record<string, unknown> = {
    J: {
      J2030: {
        screened: values.painScreened ? ("yes" as const) : ("no" as const),
        ...(values.painScreened && values.painCharacteristics.trim() !== ""
          ? { characteristics: values.painCharacteristics.trim() }
          : {}),
      },
      J2050: {
        screened: values.dyspneaScreened ? ("yes" as const) : ("no" as const),
        ...(values.dyspneaScreened && values.dyspneaCharacteristics.trim() !== ""
          ? { characteristics: values.dyspneaCharacteristics.trim() }
          : {}),
      },
      ...(entries.length > 0 ? { J2051: { entries } } : {}),
    },
    N: {
      opioidPrescribed: values.opioidPrescribed,
      // The regimen and its contraindication are asked only for an opioid, and the contraindication only without a regimen.
      scheduledBowelRegimen: values.opioidPrescribed && values.scheduledBowelRegimen,
      ...(values.opioidPrescribed &&
      !values.scheduledBowelRegimen &&
      values.bowelRegimenContraindication.trim() !== ""
        ? { bowelRegimenContraindication: values.bowelRegimenContraindication.trim() }
        : {}),
    },
  };
  if (values.primaryDiagnosisIcd10.trim() !== "") {
    data.I = { primaryDiagnosisIcd10: values.primaryDiagnosisIcd10.trim().toUpperCase() };
  }
  // D9 — the record-time gate refuses a live discharge with NO Section Q key at all. The section has
  // no item definitions here, so the only truthful thing to write is the discharge participation
  // fact itself; the CMS rule then reports it as documented, which it is.
  if (needsQ) data.Q = { participation: "documented_at_discharge" };
  return data as HopeData;
}

export interface HopeRecordSectionsProps {
  readonly values: SectionValues;
  /** One change at a time: the dialog merges the patch into its values. */
  readonly onChange: (patch: Partial<SectionValues>) => void;
}

export function HopeRecordSections({ values, onChange }: HopeRecordSectionsProps): JSX.Element {
  const { severities } = values;
  const triggering = SYMPTOMS.filter((s) => TRIGGER_SEVERITIES.has(severities[s] ?? "none"));
  return (
    <>
      <h3 style={sectionTitle}>Section I — Active diagnoses</h3>
      <CodeSearchInput
        label="Primary terminal diagnosis (ICD-10-CM)"
        system="icd10cm"
        value={values.primaryDiagnosisIcd10}
        onChange={(code) => onChange({ primaryDiagnosisIcd10: code })}
        placeholder="Search ICD-10-CM, e.g. C34.90"
      />

      <h3 style={sectionTitle}>Section J — Health conditions</h3>
      <label style={checkRow}>
        <input
          type="checkbox"
          checked={values.painScreened}
          onChange={(e) => onChange({ painScreened: e.target.checked })}
        />
        <span>J2030 — screened for pain</span>
      </label>
      {values.painScreened ? (
        <TextAreaField
          label="Pain characteristics"
          value={values.painCharacteristics}
          onChange={(e) => onChange({ painCharacteristics: e.target.value })}
          rows={2}
        />
      ) : null}
      <label style={checkRow}>
        <input
          type="checkbox"
          checked={values.dyspneaScreened}
          onChange={(e) => onChange({ dyspneaScreened: e.target.checked })}
        />
        <span>J2050 — screened for shortness of breath</span>
      </label>
      {values.dyspneaScreened ? (
        <TextAreaField
          label="Dyspnea characteristics"
          value={values.dyspneaCharacteristics}
          onChange={(e) => onChange({ dyspneaCharacteristics: e.target.value })}
          rows={2}
        />
      ) : null}

      <p style={meta}>J2051 — symptom impact at this visit</p>
      <div style={symptomGrid}>
        {SYMPTOMS.map((symptom) => (
          <SelectField
            key={symptom}
            label={humanize(symptom)}
            value={severities[symptom] ?? ""}
            onChange={(e) => {
              const { [symptom]: _removed, ...rest } = severities;
              onChange({
                severities:
                  e.target.value === "" ? rest : { ...rest, [symptom]: e.target.value as Severity },
              });
            }}
            options={[
              { value: "", label: "Not screened" },
              ...SEVERITIES.map((s) => ({ value: s, label: humanize(s) })),
            ]}
          />
        ))}
      </div>
      {severities.other !== undefined ? (
        <TextField
          label="Other symptom — label"
          maxLength={OTHER_SYMPTOM_LABEL_MAX}
          value={values.otherSymptomLabel}
          onChange={(e) => onChange({ otherSymptomLabel: e.target.value })}
        />
      ) : null}
      {triggering.length > 0 ? (
        // Informational, never blocking — the clinician records what is clinically true and the SFV
        // is the consequence. The SERVER evaluates the trigger from the stored payload at sign (D4);
        // this is a preview of a decision it makes, not the decision.
        <output style={triggerBox}>
          <StatusPill label="Follow-up will be required" tone="warning" />
          <p style={meta}>
            {triggering.map(humanize).join(", ")} at moderate or severe will create a Symptom
            Follow-Up Visit obligation due within 2 calendar days once this timepoint is signed.
          </p>
        </output>
      ) : null}

      <h3 style={sectionTitle}>Section N — Medications</h3>
      <label style={checkRow}>
        <input
          type="checkbox"
          checked={values.opioidPrescribed}
          onChange={(e) => onChange({ opioidPrescribed: e.target.checked })}
        />
        <span>Opioid prescribed for pain</span>
      </label>
      {values.opioidPrescribed ? (
        <>
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={values.scheduledBowelRegimen}
              onChange={(e) => onChange({ scheduledBowelRegimen: e.target.checked })}
            />
            <span>Scheduled bowel regimen in place</span>
          </label>
          {!values.scheduledBowelRegimen ? (
            <TextField
              label="Bowel regimen contraindication"
              maxLength={BOWEL_CONTRAINDICATION_MAX}
              value={values.bowelRegimenContraindication}
              onChange={(e) => onChange({ bowelRegimenContraindication: e.target.value })}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

const sectionTitle: CSSProperties = {
  margin: "0.5rem 0 0",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
const triggerBox: CSSProperties = { ...lateBox };
const symptomGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.5rem",
};
