# WardenX DDE Work Queue and Stedi Integration Assessment

**Date:** 2026-10-08  
**Scope:** Medicare hospice DDE work queue, eligibility, institutional claims, NOE/NOTR submission, acknowledgments, and 835 remittance through Stedi.

## Executive Summary

The reviewed assessment is directionally accurate, but it is not current enough to serve as the implementation plan.

The main conclusion is correct:

> WardenX cannot currently submit a production claim, NOE, or NOTR through Stedi, and the existing claim payload does not contain enough information to produce a compliant 837I.

However, several statements are outdated or incomplete:

- WardenX can now unlock the patient's MBI for eligibility checks.
- A configurable HTTP transmission gateway exists, although no production Stedi or MAC adapter is configured.
- The validation registry contains 22 rules, not 21.
- Some previously missing claim fields now exist in the database.
- Stedi cannot necessarily be inserted behind the existing interfaces without changing acknowledgment processing.
- A real DDE work queue has not yet been implemented.
- Stedi support for the exact MAC and hospice transaction types must be confirmed before development.

## Assessment of the Original Findings

| Original finding | Verdict | Updated assessment |
|---|---|---|
| WardenX cannot currently send a production claim, NOE, or eligibility request | Mostly accurate | Claims, NOEs, and NOTRs cannot be sent through a configured production connection. Eligibility code exists, but it remains unavailable without a configured transport. |
| No transmission layer exists | Partly inaccurate | A generic HTTP gateway transport exists. The missing component is the external gateway or Stedi implementation and its configuration. |
| Billing cannot read the MBI | Inaccurate | The real MBI unlock reader is registered, and eligibility processing uses it. |
| Claims contain no visit lines | Accurate | Claim assembly does not generate the nursing, aide, social-work, or therapy visit lines required for hospice reporting. |
| CHC lines use incorrect units | Accurate | Revenue code `0652` is currently assembled using days instead of 15-minute units. |
| Nothing turns a claim into a complete 837I | Accurate | The outbound claim document is too limited to construct a compliant institutional claim. |
| Condition, occurrence, and discharge fields do not exist | Partly outdated | These fields now exist in the claim schema, but the overall claim model and outbound document are still incomplete. |
| The hospice HIPPS code is fabricated | Accurate with qualification | The generated `R1000`-style value is internal and is not currently transmitted. It must never be mapped into Stedi's HIPPS field. |
| Stedi can plug directly into the existing interfaces | Overstated | The interfaces are useful, but the claim acknowledgment state machine and asynchronous report workflow must also change. |
| Stedi webhooks can replace polling | Incomplete | Stedi event destinations send thin events. WardenX must verify the event, fetch the complete report, deduplicate it, and retain reconciliation polling. |
| One platform-level Stedi API key should be used | Questionable | Stedi recommends OAuth integrated accounts for new multi-tenant SaaS applications. |
| One NGS J6 enrollment per tenant is sufficient | Inaccurate or unproven | Enrollment is transaction-specific, and current Stedi payer information does not confirm support for these hospice transactions. |

## Existing Capabilities

### Workflow and Safety Controls

WardenX already has substantial billing workflow infrastructure:

- Claim, NOE, and NOTR state machines
- Submission queues
- Retry behavior
- Control-number generation
- NOE timeliness monitoring
- Submission and acknowledgment persistence
- Pre-submission validation
- Encrypted MAC credential storage
- An 835 remittance mapper
- Denial and remittance worklists

The validation registry currently contains 22 rules in [`packages/billing/src/rules/index.ts`](../../packages/billing/src/rules/index.ts).

### MBI Access

The previous MBI blocker has been addressed.

The [`MBI unlock reader`](../../apps/backend/src/modules/05-patient/mbi-unlock-reader.ts) decrypts the MBI under request context. The [`eligibility job`](../../apps/backend/src/modules/23-billing-medicare/jobs/hets-eligibility.ts) uses it to construct an eligibility request.

Eligibility still fails closed when no transport is configured, but MBI access itself is no longer a missing implementation.

### Existing Transmission Abstraction

A configurable HTTP [`launch gateway`](../../apps/backend/src/modules/23-billing-medicare/jobs/launch-gateway.ts) already supports operations such as:

- Generate 837I
- Generate NOE
- Generate NOTR
- Upload transactions
- Retrieve acknowledgments

The missing pieces are:

- A real Stedi implementation
- Valid production endpoints
- Authentication
- Enrollment configuration
- Response and event processing

## Claim-Assembly Blockers

### Missing Hospice Visit Lines

Current [`claim assembly`](../../packages/billing/src/claim-assembly.ts) creates hospice level-of-care lines using:

- `0651`
- `0652`
- `0655`
- `0656`

It does not create the required visit lines for disciplines such as:

- Skilled nursing
- Medical social work
- Hospice aide
- Physical therapy
- Occupational therapy
- Speech-language pathology

These lines require the appropriate revenue and HCPCS/G-code combinations.

This omission also prevents the MAC from calculating Service Intensity Add-on payments from eligible RN and medical social worker visits during the final seven days of life.

### Incorrect CHC Units

Continuous Home Care revenue code `0652` must be reported using 15-minute units.

The current assembly process assigns the number of days as the unit count, meaning a full CHC day may be emitted as one unit. That is not compliant with the CMS billing rules.

CMS documents the current hospice visit, CHC, SIA, NOE, NOTR, and value-code requirements in the [Medicare Claims Processing Manual, Chapter 11](https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/clm104c11.pdf).

### Incomplete Institutional Claim Document

The outbound [`claim document`](../../apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts) currently contains only a small subset of the information needed for an 837I.

A production claim document will also need:

- Patient demographics
- Subscriber information
- Medicare Beneficiary Identifier
- Billing provider information
- Submitter and receiver information
- Attending physician
- Certifying hospice physician
- Physician NPIs
- Principal diagnosis
- Additional diagnoses
- Value code `61` or `G8`
- Condition codes
- Occurrence codes
- Occurrence spans
- Patient discharge status
- Level-of-care service lines
- Visit service lines
- HCPCS/G-codes
- Line-level service dates
- Units
- Charges
- Noncovered charges
- Payer identifiers
- Claim frequency and adjustment information

The [`claim schema`](../../packages/db/src/schema/billing/claim.ts) now includes patient status, condition codes, occurrence codes, and occurrence spans. Nevertheless, diagnoses, physician references, value codes, and complete service-line information remain missing or disconnected from the outbound document.

### Internal HIPPS Placeholder

The internal HIPPS calculator produces placeholder values such as `R1000`.

These values are not currently sent to the gateway, so this is not an immediate transmission defect. However:

- They should be renamed to avoid implying that they are valid Medicare hospice HIPPS codes.
- They must never be mapped into Stedi's HIPPS field.
- Any internal case-mix or rate classification should remain separate from the institutional claim representation.

## Missing DDE Work Queue

The original assessment does not identify the absence of a complete DDE work queue.

The UI specification mentions manual DDE submission and receipt recording in [`WARDENX_UI_NOE_NOTR_CLAIM_OPS.md`](../design/screens/revenue/WARDENX_UI_NOE_NOTR_CLAIM_OPS.md), but no complete persistence model, API, or operational workflow exists.

A production DDE queue should support the following capabilities.

### Transaction Types

- NOE
- NOTR
- Original claim
- Adjustment
- Cancel
- Correction
- Reopening or follow-up work

### Workflow States

- Queued
- Assigned
- In progress
- Ready for submission
- Submitted through DDE
- Accepted
- Returned to provider
- ADR received
- Correction required
- Resubmitted
- Closed
- Cancelled

### Work-Management Fields

- Tenant and provider entity
- Patient
- Claim, NOE, or NOTR reference
- Assignee
- Priority
- Filing deadline
- NOE five-day deadline
- Submission attempt number
- DDE submission date
- Operator identity
- DCN, ICN, or receipt number
- RTP reason
- ADR due date
- Correction notes
- Evidence attachments
- Resolution history

### Security Controls

- Role and permission checks
- Step-up authentication for submission actions
- Tenant isolation
- PHI-safe structured logging
- Immutable audit events
- Attachment access controls
- Separation between preparation, submission, and review where required

## Stedi Integration Considerations

### Institutional Claims API

Stedi provides an [institutional claims API](https://www.stedi.com/docs/healthcare/submit-institutional-claims) that accepts JSON representations of 837I transactions.

The recommended implementation is to create a canonical WardenX institutional claim document first, then map that document to Stedi's JSON schema. Claim assembly should not directly construct Stedi-specific JSON.

### Acknowledgment Processing

The current WardenX claim workflow assumes:

1. Claim submission
2. A 999 acknowledgment
3. A 277CA acknowledgment

That assumption does not match Stedi's normal API workflow.

Stedi generally returns an initial 277CA from an API submission and makes later responses available asynchronously. See [Receiving claim responses](https://www.stedi.com/docs/healthcare/receive-claim-responses).

WardenX therefore needs to support:

- Direct processing of an initial 277CA
- Acceptance or rejection without first requiring a 999
- Asynchronous additional 277CA reports
- Duplicate event delivery
- Out-of-order event delivery
- Manual and scheduled reconciliation

### Event Destinations

Stedi event destinations should not be treated as complete acknowledgment payloads.

The integration should:

1. Receive the event.
2. Verify its authenticity.
3. Record an idempotency key.
4. Identify the Stedi report or transaction.
5. Fetch the complete 277CA or 835 report.
6. Map the report into the WardenX acknowledgment model.
7. Apply the corresponding state-machine transition.
8. Mark the event as processed.
9. Run periodic reconciliation for missed events.

### Multi-Tenant Authentication

A single shared platform API key is not necessarily appropriate for a new multi-tenant healthcare SaaS product.

Stedi documents an [integrated-account OAuth model](https://www.stedi.com/docs/healthcare/integrated-account-overview) intended for software platforms that connect multiple healthcare providers.

WardenX should confirm with Stedi whether it should use:

- One integrated account per tenant
- One integrated account per provider entity
- One shared platform account with tenant-specific enrollments
- Separate production accounts for organizations that control their own trading-partner relationships

### Eligibility

Stedi can be used as a CMS eligibility transport. The existing WardenX eligibility workflow can remain separate from the claim-submission adapter.

The adapter will need to follow Stedi's [eligibility requirements](https://www.stedi.com/docs/healthcare/send-eligibility-checks), including:

- CMS payer identification
- MBI submission
- Originating IP forwarding
- Request traceability
- Per-tenant authorization
- Safe storage of eligibility responses

### NOE and NOTR Support

CMS uses:

- `8xA` for NOE
- `8xB` for NOTR

WardenX should not assume that Stedi supports these transactions merely because they are represented as institutional transactions.

Before implementation, obtain written confirmation that Stedi supports:

- Hospice NOE submission
- Hospice NOTR submission
- The exact `8xA` and `8xB` transaction structures
- The relevant MAC and payer ID
- Required enrollments
- Acknowledgment delivery
- Testing and certification

## Critical Payer-Routing Risk

The current Stedi payer entry for National Government Services shows claims and eligibility as unsupported for that payer record: [NGS payer record](https://www.stedi.com/healthcare/network/MFPWU).

Stedi explains that transaction availability depends on the exact payer and transaction type in its [supported-payers documentation](https://www.stedi.com/docs/healthcare/supported-payers).

Before building the clearinghouse adapter, confirm:

- The current HH+H MAC for the applicable jurisdiction
- The correct payer ID
- Whether Stedi supports institutional hospice claims
- Whether `8xA` NOEs are supported
- Whether `8xB` NOTRs are supported
- Whether 277CA responses are available
- Whether 835 delivery is available
- Which enrollments are required
- Whether PTAN is required
- Whether enrollment is per NPI, provider entity, or tenant

If Stedi cannot route these transactions, the DDE queue must be treated as the primary submission workflow rather than merely as a fallback.

## Recommended Implementation Order

### Phase 1: Confirm Stedi and MAC Capabilities

Before writing the adapter:

1. Identify the exact production MAC and payer ID.
2. Confirm 837I hospice claim support.
3. Confirm NOE and NOTR support.
4. Confirm 277CA and 835 availability.
5. Confirm enrollment requirements.
6. Select the Stedi tenant-authentication model.
7. Document the supported and unsupported transaction paths.

### Phase 2: Build the DDE Work Queue

Implement:

- Queue persistence
- Assignment
- Deadlines
- DDE submission recording
- Receipt and control-number capture
- RTP and ADR handling
- Correction history
- Attachments
- Audit events
- Permissions and step-up authentication

This provides an operational submission path while clearinghouse enrollment is pending or unsupported.

### Phase 3: Define the Canonical Claim Document

Create a vendor-neutral institutional claim structure containing:

- Claim header
- Patient and subscriber
- Providers and physicians
- Diagnoses
- Condition, occurrence, and value codes
- Level-of-care lines
- Visit lines
- Charges and units
- Payer information
- Adjustment and replacement information

Both Stedi and any future clearinghouse adapter should consume this canonical representation.

### Phase 4: Complete Claim Assembly

Implement:

- Hospice visit lines
- Correct visit HCPCS/G-codes
- CHC 15-minute units
- Diagnosis sequencing
- Physician relationships and NPIs
- Value codes `61` and `G8`
- Complete service-line dates and charges
- Noncovered charges
- Required occurrence information
- Discharge and adjustment handling

### Phase 5: Build the Stedi Adapter

Implement:

- Canonical claim-to-Stedi mapping
- Stedi integrated-account authentication
- Transaction-specific enrollment selection
- Idempotent submission
- Safe retry behavior
- Initial 277CA processing
- Structured error mapping
- Submission attempt persistence

The idempotency key should be derived from stable WardenX identifiers such as:

```text
tenant + provider entity + claim control number + submission attempt
```

### Phase 6: Implement Event and Report Processing

Implement:

- Event-destination endpoint
- Authenticity verification
- Event deduplication
- Full-report retrieval
- 277CA mapping
- 835 mapping
- Out-of-order event handling
- Reconciliation polling
- Dead-letter and operator-review handling

### Phase 7: Connect Remittance Processing

Use the existing M25 remittance and denial infrastructure, but add:

- Stedi 835 retrieval
- Stedi JSON-to-canonical remittance mapping
- Payment and adjustment reconciliation
- Duplicate remittance protection
- Unmatched claim handling
- Operator review queues

### Phase 8: Connect Eligibility

Implement a separate Stedi CMS eligibility adapter using the existing MBI unlock and eligibility workflow.

### Phase 9: Testing and Certification

Testing should cover:

- Stedi JSON schema validation
- Initial 277CA acceptance and rejection
- Asynchronous 277CA delivery
- Duplicate events
- Out-of-order events
- Missed-event reconciliation
- 835 ingestion
- Tenant isolation
- Idempotent retries
- Visit-line construction
- CHC unit conversion
- NOE and NOTR structures
- DDE fallback workflows

Stedi test mode can prove payload and integration behavior. It cannot prove that the production MAC will accept hospice claims, NOEs, or NOTRs. Production certification must be coordinated with Stedi and the applicable MAC.

## Final Conclusion

The original assessment correctly identifies the most serious claim-assembly problems, especially:

- Missing visit lines
- Incorrect CHC units
- Incomplete 837I content
- Lack of a production clearinghouse connection

However, its proposed solution is too simple.

The recommended strategy is:

> Confirm payer support first, build the DDE work queue, create a complete vendor-neutral claim document, fix claim assembly, and then implement Stedi using its current API, OAuth, event-destination, and report-retrieval patterns.

The DDE queue should be treated as a first-class operational channel. It may be the primary submission path if Stedi does not support the applicable MAC's hospice claims, NOEs, or NOTRs.
