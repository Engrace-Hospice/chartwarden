# ChartWarden

Multi-tenant hospice EHR. This file holds the shared language for the domain; terms are added as they are resolved.

## Language

### Visit documentation

**Visit note**:
The signed clinical document a clinician writes about one visit.
_Avoid_: clinical note, encounter note

**Encounter**:
The record that holds a visit note from first entry through signing and any later amendment. Code, API and events use this name.
_Avoid_: using it for the scheduled appointment

**Visit**:
A scheduled appointment with a patient. An ad-hoc clinical contact has an encounter but no visit.
_Avoid_: encounter

**Assessment**:
The RN's clinical assessment of the patient, recorded in a visit note. Used alone, it means only this.
_Avoid_: using it for scale readings, discipline assessment forms or HOPE data

**Scale reading**:
A scored measurement of a patient at a point in time, such as PPS or ESAS. Code and API names still call these "assessments" (module 9).
_Avoid_: assessment (alone), score

**Discipline assessment form**:
A structured form completed by a non-nursing discipline such as social work, chaplaincy, aide or volunteer.
_Avoid_: assessment (alone)

**HOPE assessment**:
The federally required hospice outcome and patient evaluation data collection.
_Avoid_: assessment (alone)

**Section**:
The unit of a visit note that a clinician reviews and confirms, such as chief concern or plan.
_Avoid_: block

**Draft**:
The system-built pre-population of a visit note from the patient's records, awaiting the clinician's confirmation. Not the encounter's `draft` status, which every visit note holds until it is finalized.
_Avoid_: auto-generated note, AI note

**Confirmation**:
The clinician's review of one drafted section before signing: confirmed as is, edited, or deselected. It covers only the content the clinician saw.
_Avoid_: approval, sign-off

**Amendment**:
A dated, attributed change to a signed visit note, made through the addendum path. The signed text is preserved and never overwritten.
_Avoid_: edit (of a signed note), revision

**Time-to-sign**:
The elapsed time from the clinician's arrival at a visit to the visit note being signed (from draft creation where arrival is not recorded).
_Avoid_: documentation time

**Benefit period**:
One certification period of a hospice election: two of 90 days, then 60 days each. Code and API call it an election period (module 6).
_Avoid_: election period (in prose), certification period

**Recertification visit**:
The RN's visit that reassesses the patient at the start of a new benefit period. Its note documents the patient's current status for the physician's recertification; it is not the certification itself.
_Avoid_: recert note (for the physician's certification of terminal illness)

**Face-to-face encounter (F2F)**:
The physician's or nurse practitioner's own visit that precedes the third and every later benefit period. Module 6 holds its attestation; the visit note of an F2F is a separate document.
_Avoid_: F2F visit note (for the attestation)

**Decline evidence**:
The recorded, structured facts a recertification visit note sets beside each other: scale readings and their change over the benefit period, weight change, level of care, and the F2F's date. A fact, never a conclusion about prognosis or eligibility.
_Avoid_: prognosis, terminal indicators
