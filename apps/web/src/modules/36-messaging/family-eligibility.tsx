// M36 WP 6.7 (ADR-0099 D2, D10) - who can be invited for one patient: each caregiver on record, and for one who cannot be invited the reason in plain words
// (closed set FAMILY_ELIGIBILITY_REASONS). What staff are told and what the contact may do come from the same backend expression, so they cannot disagree.
import type { FamilyEligibleCaregiverDto } from "@chartwarden/types";
import type { JSX } from "react";
import { ft } from "./family-text";

export function FamilyEligibilityList({
  caregivers,
  chosen,
  error,
  onChoose,
}: {
  readonly caregivers: readonly FamilyEligibleCaregiverDto[];
  readonly chosen: string;
  readonly error: string | undefined;
  readonly onChoose: (patientCaregiverId: string) => void;
}): JSX.Element {
  if (caregivers.length === 0)
    return <p className="wx-export-detail">{ft("family.invite.none")}</p>;
  return (
    <fieldset className="wx-export-choice">
      <legend>{ft("family.invite.pick")}</legend>
      {caregivers.map((c) => {
        const id = `family-caregiver-${c.patientCaregiverId}`;
        return (
          <div key={c.patientCaregiverId}>
            <label htmlFor={id}>
              <input
                id={id}
                type="radio"
                name="family-caregiver"
                value={c.patientCaregiverId}
                checked={chosen === c.patientCaregiverId}
                disabled={!c.eligible}
                aria-describedby={`${id}-reason`}
                onChange={() => onChoose(c.patientCaregiverId)}
              />{" "}
              {c.displayName} ({c.relationship}
              {c.isLegalRepresentative ? `, ${ft("family.invite.legalRep")}` : ""})
            </label>
            <p id={`${id}-reason`} className="wx-export-detail">
              {ft(`family.eligibility.${c.reason}`)}
            </p>
          </div>
        );
      })}
      {error ? (
        <p className="wx-export-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
