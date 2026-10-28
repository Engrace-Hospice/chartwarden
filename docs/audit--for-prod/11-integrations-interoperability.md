# 11 — Integrations and interoperability

The repository contains implemented surfaces for FHIR, HL7/external interfaces, DoseSpot,
clearinghouse/EDI, Medicaid aggregators, Stripe, messaging vendors, AI vendors, telehealth, MinIO,
and Docling. Architecture adapter-boundary checks passed, and queue/outbox catalog gates passed.

| Integration | Static implementation | Runtime in this audit | Principal limitation |
|---|---|---|---|
| FHIR gateway | Present | Not run | external conformance/auth/version compatibility unverified |
| HL7/lab/external interfaces | Present | Not run | partner schemas, retry/correlation unverified |
| DoseSpot | Present, config fail-closed | Not run | sandbox field names/credentials unavailable |
| Medicare/Medicaid clearinghouse | Adapters/queues present | Local suites only | no 837/999/277/TA1/835 partner exchange |
| Stripe subscription billing | Present | Not run | webhook/vendor account unavailable |
| Messaging vendors | Present | Not run | delivery receipts/failure alerts unavailable |
| Portal/telehealth | Present | Not run | browser/vendor runtime unavailable |
| Docling/OCR | Present | Image not rebuilt | CW-QA-0009 and CW-QA-0010 |
| MinIO | Present | Demo restore artifact reviewed | production backup gap CW-QA-0013 |

No external acknowledgment was represented as adjudication. Authentication, tenant routing,
message correlation, duplicate delivery, retries, and PHI protection are **NOT_VERIFIED** against
real partners. Test fixtures and adapter presence prove local behavior only.
