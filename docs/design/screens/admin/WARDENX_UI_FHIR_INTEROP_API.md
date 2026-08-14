# WARDENX_UI_FHIR_INTEROP_API

Version: 1.0
Status: Screen Specification
Module: FHIR / Interoperability & API Access (M28)

---

## Purpose

The FHIR / Interoperability screen administers the FHIR R4 API: registering API clients and
their SMART scopes, tracking bulk-export jobs, reviewing inbound resource proposals, and
auditing §164.528 disclosures.

---

## Primary Users

- Integration Admin (client registry, credential rotation)
- Compliance Officer (dual-approval, disclosure logs)
- Security Officer (capability, key rotation)
- Operator (export jobs, inbound proposal review)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Clients · Export Jobs · Access Logs · Inbound · Catalog)
KPI Strip
Table / Queue  |  Right: Detail / Actions
```

---

## Resources Exposed

Patient, Encounter, Observation, MedicationRequest, MedicationAdministration, Condition,
CarePlan, Goal, DiagnosticReport, Coverage, RelatedPerson, Consent, Practitioner /
Organization, plus CodeSystem / ValueSet. (Phase-2 resources advertised as stubs.)

---

## Clients

- Type: `smart_backend_services` / `api_key`; tier `tier-1` / `tier-2` / `tier-3`
  (rate floors 100 / 10 / 1 rps).
- Allowed scopes (`system/Patient.read`, …), JWKS URI, IP allowlist, BAA contract reference.
- Status: `pending_approval`, `active`, `suspended`, `revoked`, `rejected` (the shipped `fhir_client_status` enum — there is no `proposed`) —
  activation is dual-approved (Org Admin + Compliance Officer, rationale required).
- Credentials: `Active` / `Retired` (rotation with 30-day overlap; fingerprint shown,
  secret never re-displayed).

---

## Export Jobs

Bulk export to NDJSON. Status: `Accepted`, `In Progress`, `Completed`, `Failed`,
`Cancelled`, `Expired` (24h artifact TTL). Show resource types, counts, per-type artifacts
with presigned download URLs, initiator, and a cancel action.

---

## Inbound Proposals

Externally-submitted resources stage for owner-module review (owner `m5` Patient / `m12`
MedicationStatement). Status: `Pending`, `Accepted`, `Rejected` (rationale ≥ 40 chars),
`Expired` (review SLA). Show raw payload, checksum, validation errors.

---

## Access Logs & Consent

- §164.528 disclosure accounting: filter by date, patient, client, resource type; CSV export;
  cursor pagination.
- Consent-gated: 42 CFR Part 2 SUD redaction is default-on; show which clients hold an
  explicit `42_cfr_part_2_release` consent vs. default redaction.

---

## Empty State

"No API clients registered." → Register Client. Per-tab empties for jobs / proposals / logs.

---

## Actions

- Register client · manage scopes / rate limit / IP allowlist
- Approve (dual) · suspend · revoke
- Rotate credential
- Initiate / cancel export · download artifacts
- Review inbound proposal (accept / reject)
- View access logs · capability statement

---

## Pencil Notes

Create versions for:

- Client registry (statuses)
- Client registration + scope selection
- Dual-approval flow
- Export job tracking (artifacts)
- Access-log / disclosure viewer
- Inbound proposal review
