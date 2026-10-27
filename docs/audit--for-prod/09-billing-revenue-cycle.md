# 09 — Billing and revenue cycle

## Medicare

The implementation includes coverage resolution, elections, NOE/NOTR/transfer/DDE work queues,
claim assembly and validation, rate/wage/SIA/sequestration logic, submission workers, and audit
controls. Targeted live suites passed 129 Medicare tests spanning assembly, validation overview,
overrides, rate tables, submission worker, and DDE. This does not prove MAC acceptance.

`CW-QA-0001` is the critical failure: an M5 same-day payer replacement creates two effective rank-1
rows and M23 can resolve Medicare as primary without comparing the commercial row. The isolated
runtime harness exercised actual repositories/seams under `chartwarden_app`.

`CW-QA-0007` answers the requested wizard question: payer data is already available from the patient
payer API, so earlier non-mutating guidance is feasible without a new backend business rule. The
final server call remains necessary to close the race. The current inline error is actionable and
the draft remains in memory; lost input was not confirmed.

## Remittance and other payers

Selected 835 golden, ingestion, manual match, payer guard, and commercial remittance live suites
passed 83 tests. Medicaid and commercial modules are structurally implemented, not mere route
stubs, but state-specific Medicaid rules, commercial payer contracts, external 837/835 transport,
999/277/TA1 exchange, and payer adjudication were not exercised.

## Integrity distinctions

- A locally assembled/submitted record is not clearinghouse acceptance.
- A 999/TA1 acceptance is not payer adjudication.
- DDE work completion is not MAC acceptance.
- A passing rate fixture is not proof every current CMS locality/date table is deployed.

Primary CMS references consulted: [Hospice Information Center](https://www.cms.gov/hospice-information-center)
and [CMS transmittal R12847CP](https://www.cms.gov/files/document/r12847cp.pdf). No live CMS/MAC or
clearinghouse transaction was sent.
