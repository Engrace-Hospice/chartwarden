# M23 Direct-MAC Medicare Notice Gateway Contract v1

Status: **proposed external implementation contract; no gateway server is present or qualified in this repository**
WardenX constant: `m23-direct-mac-notice.v1`
Conformance suite: `m23-direct-mac-notice-conformance.v1`

This package specifies the trust boundary needed to move an immutable Medicare notice artifact from WardenX to a separately owned Direct-MAC gateway. It does not specify the gateway's downstream MAC protocol, prove EDI enrollment, authorize a transmission, or establish Medicare acceptance.

## Discovery classification

The repository contains only the legacy WardenX HTTP client in `jobs/launch-gateway.ts`. It posts inline X12 to `POST /uploads` and accepts `{ accepted, generatedFileUri }`. No server source, OpenAPI document, image, reverse-proxy route, deployment owner, or MAC connector implementing that endpoint was found. Production Compose contains no X12/MAC gateway service. The current integration is therefore category C: no server implementation or deployment target identified.

The paths below are proposed v1 paths for the external owner. They are not existing endpoints and WardenX does not construct this client in production.

## Authentication and transport

- HTTPS is mandatory. URLs containing user information are refused.
- Bearer authentication is supported by the WardenX client boundary; the server owner must define issuance, audience, rotation, revocation, and tenant/account authorization.
- Redirects are refused so authorization cannot be forwarded to another origin.
- WardenX uses bounded request timeouts and bounded JSON response bodies.
- The gateway must rate-limit by authenticated client and account without using X12 or beneficiary identifiers in telemetry.
- X12 may be handled only as encrypted restricted data. Encryption keys are never sent by WardenX.
- A gateway must not receive general access to WardenX tenant artifact storage. v1 uses the exact recovered inline X12 bytes.

## Proposed resources

| Method and path | Purpose |
|---|---|
| `GET /v1/medicare-notice/capabilities` | Declared contract/capabilities and conformance record reference |
| `POST /v1/medicare-notice/operations` | Durable, idempotent acceptance of one immutable dispatch |
| `POST /v1/medicare-notice/operations/lookup` | Lookup using the original dispatch identity and correlation fields in authenticated JSON, not an access-log URL |

The client does not treat a capability response as proof. Activation additionally requires an unexpired, locally approved conformance attestation matching the gateway instance, record, suite, version, and dates.

WardenX classifies observations as `gateway_unavailable`, `legacy_only`, `versioned_unverified`, `versioned_qualified`, or `capability_unverified`. The runtime readiness report separately exposes server identification, version compatibility, idempotency, receipt, lookup, acknowledgment correlation, MAC connector, EDI enrollment, app-role RLS, and transport authorization. It reports transport disabled unless every evidence item is current; it is not composed as a production enablement switch in this lot.

## Upload request

`DirectMacNoticeGatewayRequestV1` carries:

- `contractVersion`
- stable `clientDispatchId` from the committed WardenX dispatch fencing token
- opaque organization, provider, submission, render, and artifact references
- artifact SHA-256
- transaction `81A`, `81B`, `8XC`, or `8XD`
- historical MAC jurisdiction, account reference, and test/production usage
- original ISA13 and WardenX transaction/control identity
- exact UTF-8 X12 payload

The client tokenizes the recovered X12 without rewriting it and verifies that ISA13, GS06, ST02, BHT03, and CLM01 match the immutable render/dispatch identity. The request carries all four control values separately so the gateway can repeat the check before storage and before delivery.

The server must calculate a canonical request-identity fingerprint covering every field above. It must reject a repeated `clientDispatchId` whose fingerprint differs.

## Server persistence and idempotency

The external server must create one durable gateway operation per `clientDispatchId` with a database uniqueness constraint. In one transaction it must persist the request fingerprint, digest, historical routing/account identity, operation ID, state, and timestamps before returning durable acceptance.

Two concurrent identical requests must converge on that operation. A replay returns the original operation and `replayed: true`. A conflicting replay returns a typed rejection and must never update the original operation. An in-memory map is not sufficient.

Gateway Worker execution needs a separate durable claim/fencing transition. Before downstream I/O it commits a `delivery_started` boundary. A crash after that boundary becomes `downstream_outcome_unknown` unless the MAC channel supplies authoritative evidence. It must not automatically create another downstream send.

## Response and receipt stages

The response is either:

- `rejected_before_acceptance` with a closed, PHI-safe reason code; or
- a versioned state and a durable correlated receipt.

States are `durably_accepted`, `queued`, `mac_delivery_started`, `mac_transport_received`, `mac_transport_rejected`, `downstream_outcome_unknown`, or `reconciliation_required`.

The receipt binds gateway operation ID, client dispatch ID, artifact digest, historical account, jurisdiction, stage, time, and an optional safe evidence reference. It is evidence about a gateway/transport stage only. It is not Medicare acceptance.

Legacy `{ accepted, generatedFileUri }` output is explicitly rejected by the v1 client.

The client requires state and receipt stage to agree: accepted/queued maps to gateway durable acceptance; delivery-started maps to its own stage; transport received/rejected maps to the corresponding downstream stage; unknown/reconciliation maps only to an unknown receipt stage. The `receiptId` and operation ID are safe opaque references, not unfiltered response text.

## Lookup and reconciliation

Lookup is an authenticated JSON POST and requires the original dispatch ID plus the organization, provider, submission, render, artifact references, digest, historical account/usage/jurisdiction, and all original control values. The gateway must return those same values, its durable receipt, current operation state, last verified time, and—when available—typed downstream evidence:

- `known_not_transmitted`
- `transport_receipt`
- `transport_rejection`
- `outcome_unknown`

Current configuration must never replace historical account or jurisdiction values. WardenX lookup does not mutate an `in_doubt` attempt. A future authorized reconciliation operation must validate evidence and audit provenance explicitly.

## Acknowledgment provenance

An acknowledgment correlation record binds:

- acknowledgment and gateway operation IDs
- original client dispatch and artifact digest
- historical account and provider
- original ISA13
- `999` or `277CA`
- X12-processing or payer-processing stage
- disposition, timestamp, and restricted evidence reference

A 999 cannot be `partial`. A gateway durable receipt, a MAC transport receipt, an X12-processing acknowledgment, and notice acceptance/rejection are distinct evidence stages. Parser availability alone does not prove retrieval or correlation.

## WardenX state mapping

WardenX recovers and cryptographically verifies the finalized artifact before reservation. It commits `pending → sending` before external I/O. A definite pre-acceptance rejection becomes terminal known non-send. A correlated durable receipt can record transport submission without marking MAC acceptance. Timeout, malformed/conflicting response, connection loss, and downstream-unknown states become `in_doubt`. Redelivery of an existing `sending` or `in_doubt` reservation does not upload.

## Conformance qualification

Required automated categories:

1. version/shape/authentication and request-size validation;
2. identical replay, conflicting replay, and concurrent replay;
3. restart persistence and duplicate internal Worker execution;
4. crash before downstream I/O versus crash after `delivery_started`;
5. receipt correlation and conflicting receipt rejection;
6. lookup persistence, account isolation, and credential rotation;
7. acknowledgment correlation, duplicates, ordering, and mismatches;
8. no second downstream send after ambiguous recovery.

The repository's tests are client unit/contract-fixture tests only. A server owner must run the same fixtures against real durable server persistence with a mocked MAC connector. Separate MAC sandbox qualification is still required.

## CMS and MAC prerequisites

CMS states that the standard EDI enrollment form must be completed before submitting electronic media claims or other EDI transactions, including submissions made through a billing service or clearinghouse. A new electronic biller submits the form to its local MAC. CMS directs providers and intermediaries to their A/B MAC for first-line EDI support and MAC-specific requirements.

External decisions required for each provider/account are:

- correct HHH A/B MAC and jurisdiction;
- accepted hospice notice transaction types;
- approved connection mechanism and companion guide;
- provider EDI enrollment and submitter authorization;
- test/production credentials and endpoint separation;
- upload receipt and ambiguity-recovery procedure;
- 999/277CA or MAC-specific acknowledgment retrieval and matching;
- retention, encryption, incident response, and secure deletion ownership.

References:

- <https://www.cms.gov/medicare/coding-billing/electronic-billing/electronic-data-interchange-support>
- <https://www.cms.gov/medicare/coding-billing/electronic-billing/how-to-enroll-medicare-electronic-data-interchange>
- <https://www.cms.gov/medicare/coding-billing/electronic-billing/electronic-healthcare-claims>

## Deployment dependencies and activation

The missing external owner must supply server source, durable persistence, a deployed identity, authentication controls, a MAC-specific connector, enrollment evidence, and test results. Platform security must approve the conformance record. Operations must then perform a controlled non-production qualification and separately approve transmission activation.

Until those conditions exist, `M23_NOTICE_GATEWAY_ARTIFACT_CONTRACT_UNSUPPORTED` remains mandatory. Claim.MD and Stedi notice refusal is unchanged.
