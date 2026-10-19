# PR G.1-B — Mobile contract handoff

All endpoints keep their paths, input shapes and `id`/`state`/`version` fields. Regenerate the mobile client from `docs/api/openapi.json` after this backend release. Deploy migration `1122_m6_admission_contract_details.sql` before the backend.

| Flow | Write | Read |
|---|---|---|
| NOR | `POST /api/v1/admissions/{id}/nor`: continue sending `acknowledgedAt` as an ISO instant and `acknowledgedByName`. | `GET /api/v1/admissions/{id}/nor`: `acknowledgedAt` is the historical server date; `acknowledgedAtInstant` is the submitted instant; `acknowledgedByName` may be `null` for old records. |
| Election | `POST /api/v1/admissions/{id}/election-statements`: send `effectiveDate` and `primaryDiagnosisIcd10`. | `GET /api/v1/election-statements/{id}` returns those declaration facts, nullable for old records. They do not state the activated period date or the current patient diagnosis. |
| CTI | `POST /api/v1/election-periods/{id}/cti`: send `prognosisStatement`, `clinicalFindings`, and optional `attendingPhysicianId`. | `GET /api/v1/cti/{id}` returns those fields; old prognosis/findings can be `null`. The hospice physician must match the selected admission physician. |
| F2F | `POST /api/v1/admissions/{id}/face-to-face`: continue sending the existing requested bounds, date, role and clinician ID. | `GET /api/v1/face-to-face/{id}` distinguishes `requestedWindowStart/End` from `authoritativeWindowStart/End`. Show the latter for clinical scheduling. They can be `null` when the period start is not yet derivable. |

`GET /api/v1/admissions/{id}/election-periods` now includes sequence and date fields. The patient Election & Certification aggregate also types its top-level period calendar/status fields. Use null-aware UI labels for older data; never display unknown as a fabricated acknowledgment, diagnosis or prognosis.

The backend derives the F2F clinician's actual MD/NP role from live organization grants at scheduling. A client-selected `clinicianRole` is only a claim. Scheduling remains possible for the signed-in eligible clinician; there is no new candidate-directory endpoint in this PR. If mobile adds a clinician picker, its candidates need a separate organization- and permission-scoped API, and the final POST must still revalidate the selected clinician.

The backend continues to enforce signing, recertification, readiness, activation, tenant isolation and `ifVersion` conflict rules. Mobile should surface backend validation errors rather than guessing benefit-period dates or authorization from local state.
