# ChartWarden API — changes for integrators

Dated notes on API changes an integrator has to act on. The machine-readable contract is
[`openapi.json`](./openapi.json) (regenerated with `bun run openapi:emit`); every field named below carries
its full description there. Newest first.

---

## 2026-10-06 — Discharge details the Medicare claim needs (place of death, receiving care setting)

**Why.** A Medicare hospice claim must report the patient discharge status (UB-04 FL 17 / 837I CL103,
CMS Pub. 100-04 Ch. 11 §30.3). For a death that status depends on **where the patient died**; for a transfer
to another hospice it depends on **where the receiving hospice cares for the patient**. ChartWarden now records
both and derives the claim codes from them. Requests that do not send them are refused with a specific error,
and records created before this change can be completed afterwards.

| Value sent | Claim patient status |
|---|---|
| `placeOfDeath: "home"` | 40 — expired at home |
| `placeOfDeath: "facility"` | 41 — expired in a medical facility (hospital, SNF, ICF, hospice facility) |
| `placeOfDeath: "unknown"` | 42 — expired, place unknown |
| `receivingCareSetting: "home"` | 50 — discharged to hospice, home |
| `receivingCareSetting: "facility"` | 51 — discharged to hospice, medical facility |

### 1. `POST /api/v1/admissions/{id}/discharge` — `placeOfDeath` required on a death

Required when `reason` is `"death"`; refused for any other reason. HL7-reported deaths that carry no place are
recorded as `"unknown"` (status 42).

```json
{
  "reason": "death",
  "dischargeDate": "2026-10-05",
  "narrative": "Patient expired peacefully with family present.",
  "deathCertifierId": "55555555-5555-4555-8555-555555555555",
  "placeOfDeath": "home"
}
```

Missing or invalid on a death — `422`:

```json
{
  "error": {
    "code": "PLACE_OF_DEATH_REQUIRED",
    "message": "placeOfDeath is required when reason is \"death\". Send \"home\", \"facility\" or \"unknown\": it sets the Medicare claim's patient discharge status (40 expired at home, 41 expired in a medical facility, 42 expired, place unknown — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed. \"unknown\" is a valid answer when the place of death is not known.",
    "details": [{ "field": "placeOfDeath", "code": "PLACE_OF_DEATH_REQUIRED", "message": "…same text…" }],
    "correlationId": "…",
    "documentationUrl": "https://docs.chartwarden.app/errors/PLACE_OF_DEATH_REQUIRED"
  }
}
```

Sent with another reason — `422 PLACE_OF_DEATH_NOT_ALLOWED` ("placeOfDeath is only accepted when reason is
\"death\" (it sets claim patient status 40/41/42). Remove the field for any other discharge reason.").

### 2. `POST /api/v1/admissions/{id}/transfer-out` — `receivingCareSetting` required

```json
{
  "direction": "out",
  "effectiveDate": "2026-10-05",
  "otherHospiceName": "Desert Sun Hospice",
  "otherHospiceCcn": "031234",
  "receivingCareSetting": "facility",
  "narrative": "Family relocated; Desert Sun accepted the patient."
}
```

Missing or invalid — `422` (previously a generic `VALIDATION_FAILED`):

```json
{
  "error": {
    "code": "RECEIVING_CARE_SETTING_REQUIRED",
    "message": "receivingCareSetting is required on a transfer-out. Send \"home\" or \"facility\" — where the RECEIVING hospice will care for the patient: it sets the Medicare claim's patient discharge status (50 discharged to hospice, home; 51 discharged to hospice, medical facility — CMS Pub. 100-04 Ch. 11 §30.3). Without it the final claim cannot be billed.",
    "details": [{ "field": "receivingCareSetting", "code": "RECEIVING_CARE_SETTING_REQUIRED", "message": "…same text…" }]
  }
}
```

### 3. New — complete a death or transfer recorded without the detail

Deaths and transfer-outs recorded before this change have neither value, and their final claim is held by the
`bereavement_discharge_legitimacy` validation rule (defect `PLACE_OF_DEATH_MISSING` /
`RECEIVING_CARE_SETTING_MISSING`). Record the value on the existing record:

| Route | Permission | Body |
|---|---|---|
| `GET /api/v1/admissions/{id}/discharge-details` | `admission.read` + admission scope | — returns the completed discharge / transfer-out, their versions, and `missing` (`place_of_death`, `receiving_care_setting` or `null`) |
| `POST /api/v1/discharges/{dischargeEventId}/place-of-death` | `discharge.death` + scope on the owning admission | `{ "placeOfDeath": "facility", "ifVersion": 2 }` |
| `POST /api/v1/transfers/{transferEventId}/receiving-care-setting` | `transfer.out` + scope on the owning admission | `{ "receivingCareSetting": "home", "ifVersion": 0 }` |

Rules:

- `ifVersion` is the record version from the GET. A stale version → `409 VERSION_MISMATCH`.
- Filling a value that was never recorded needs nothing else. Replacing a recorded value needs
  `correctionReason` (20–2000 characters), stored with the change; without it →
  `409 DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED`. Sending the value already recorded is a no-op
  (`changed: false`).
- A place of death only on a **completed death** discharge; a care setting only on a transfer **out** —
  otherwise `422 DISCHARGE_DETAIL_NOT_APPLICABLE`.
- Success returns `{ id, admissionId, detail, value, previousValue, changed, version, claimPatientStatus }`.
  Each change publishes `m6.discharge.details_recorded`; billing re-validates the admission's open claims.

```json
POST /api/v1/discharges/cccccccc-cccc-4ccc-8ccc-cccccccccccc/place-of-death
{ "placeOfDeath": "home", "ifVersion": 3,
  "correctionReason": "Death certificate lists the residence, not the nursing facility." }
```

### 4. Claim reads and Type of Bill

- **Type of Bill.** A stay that ended by **revocation** or **transfer-out** now ends the claim cadence: the last
  claim is final **811/814**, no longer interim **812/813**. Re-validation updates unsubmitted claims
  automatically. Claims already **submitted** with 812/813 need a replacement (TOB 817,
  `POST /api/v1/billing/claims/{id}/replace`) once the MAC has accepted them; a claim in `partial_paid` or
  `denied` cannot be replaced in ChartWarden and must be adjusted with the MAC directly.
- `GET /api/v1/billing/claims` and `GET /api/v1/billing/claims/{id}` items carry an optional `attention` block:
  `stayEnd`, `typeOfBill { stored, derived, changed, remedy }` (`remedy`: `revalidate`,
  `await_acknowledgment`, `replace`, `manual`), `missingDischargeDetail` and `flags`.
- New list filter `?attention=missing_discharge_details` or `?attention=tob_changed` (scans up to 1,000 claims
  per request; follow `nextCursor`).
- Validation results' `remediation` is now stored flat (`summary`, `fixAction`, `fixDeepLink`, `observed`,
  `defects[]`) for both the initial and re-validation runs; older re-validation rows keep the nested
  `{ remediation, observed }` shape.
