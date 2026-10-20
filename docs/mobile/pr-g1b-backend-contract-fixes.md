# PR G.1-B — Admission compliance backend contracts

## Audit before change

`apps/web/src/modules/06-admission/admission-detail.tsx` sends the acknowledged instant/name for NOR, the declared effective date/diagnosis for Election, and the CTI prognosis/findings. The F2F scheduling rail sends requested window bounds. The M6 TypeBox request schemas accepted these values, but the route dropped NOR and Election fields, and the database service dropped CTI fields and F2F window bounds. Individual GETs exposed only `id`, `state`, `version`. The period list was also a summary.

The pre-change web Admission Detail, Election & Certification and physician authority tests passed (34/34); M6 non-live certification/F2F tests passed (78/78). The existing web payloads, paths, `id`, `state`, `version`, guards and state transitions were used as the compatibility baseline.

## Changes

| Record | Additive persistence | Read contract |
|---|---|---|
| NOR | `acknowledged_at_instant timestamptz`, `acknowledged_by_name text` | Historical `acknowledgedAt` date plus nullable instant/name, role and delivery method. Historical date remains the server-recorded day. |
| Election Statement | `declared_effective_date date`, `primary_diagnosis_icd10_at_election text` | `effectiveDate` and `primaryDiagnosisIcd10` describe the statement as submitted. They do not change `election_period` or patient diagnosis. |
| CTI | `prognosis_statement text`, `clinical_findings jsonb`; existing `attending_md_id` is now populated from the draft | Clinical details, physicians, signatures and period dates are returned. Hospice physician match, signature and recertification rules remain in place. |
| F2F | Requested and server-calculated window start/end dates, each nullable | GET calculates the current authoritative window from the period and returns it beside the original request bounds. The scheduling service still resolves clinician role from active organization grants; completion revalidates the actual encounter date against the server window. |

Migration `1122_m6_admission_contract_details.sql` adds only nullable columns. Legacy missing values remain `NULL`; there is no synthetic name, instant, prognosis or diagnosis. Its audit-trigger replacements add the new name, diagnosis, prognosis and findings fields to PHI scrubbing. RLS policies and tenant columns are unchanged.

The new detail DTOs retain the historical optional `patientId` field in OpenAPI as well as `id`, `state`, `version`. The period list and the core calendar/status of the patient Election & Certification aggregate are typed. The aggregate's deep evidence bundles stay `unknown` in the generated client to avoid the existing TypeScript instantiation limit; the service view supplies their internal type.

No endpoint was removed or renamed. No write payload was tightened. No frontend file was edited. The optional eligible-clinician directory was not added: the current web and mobile self-scheduling path can send the signed-in clinician ID, and the scheduling service checks that clinician's live role grants in the organization. A future clinician picker must use an organization-scoped directory and must keep this final scheduling check.

## Migration and rollout

Apply the migration before deploying the backend code, then regenerate the OpenAPI client. Existing rows need no backfill. The four tables retain their existing RLS and audit triggers. The new requested F2F bounds are historical claims, never the authority for clinical window validation; the authoritative bounds in GET are recalculated from the current period schedule.

See [web regression report](./pr-g1b-web-regression-report.md) for exact validation and remaining gates.
