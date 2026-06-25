# WARDENX_UI_FHIR_GATEWAY_CLIENTS

Version: 1.0
Status: Screen Specification
Module: FHIR Gateway — Clients & Monitoring (M28)

---

## Purpose

This screen manages **SMART-on-FHIR Backend Services clients** and monitors the FHIR API surface:
client registration (app, JWKS / redirect, allowed scopes, rate limits, IP allowlist, BAA
reference), the active-client roster, API metrics (requests/min, error rate, top endpoints),
consent-gated disclosure logs, and deprecated-version sunsetting.

It is the operator console for the gateway, distinct from the FHIR Interop API reference screen
(which documents the wire shape). Here an Org Admin and Compliance Officer onboard and govern the
external consumers — partner labs, referral platforms, state HIEs, research clients — that read
WardenX clinical data over FHIR R4. Every FHIR read is a HIPAA §164.528 disclosure, so this screen
binds client identity, scope, and BAA to a reproducible accounting trail.

---

## Primary Users

- Org Admin (client onboarding — dual approval)
- Compliance / Privacy Officer (BAA, disclosure accounting — dual approval)
- Platform / Interop Ops
- Integration Engineer (partner client configuration)

---

## Layout Pattern

Use Admin Settings Layout.

```text
Top Navigation
Page Header
Settings Sidebar (Clients · API Metrics · Disclosure Logs · Versions)  |  Settings Content  |  Right: Help / Impact Notes
```

---

## Settings Categories (Sidebar)

- **Clients** — registry of registered FHIR consumers
- **Registration** — onboarding workflow (dual approval)
- **API Metrics** — live utilization and error monitoring
- **Disclosure Logs** — consent-gated §164.528 accounting
- **Version Sunsetting** — deprecated FHIR-version deprecation

---

## Client Registry

Each external consumer is one `fhir_client` row. The client list + detail shows:

- Client id (UUID) and display name
- Type (`smart_backend_services` or `api_key`)
- JWKS URI (SMART) or credential fingerprint (API key)
- Allowed scopes (`system/Patient.read`, `system/Encounter.read`, …)
- Tier (`tier-1` partner / `tier-2` referral / `tier-3` research)
- Rate limit (RPS) + bulk-export concurrency cap
- IP allowlist
- BAA contract reference (join key into the contract catalog)
- Status (`active`, `suspended`, `revoked`)
- Approval record (Org Admin + Compliance Officer)

The right Impact Notes panel explains the consequence of each setting — e.g. narrowing scopes
revokes access on the next token mint; tightening the rate limit takes effect immediately on the
sliding window.

---

## Registration Workflow

Client onboarding requires **Org Admin + Compliance Officer dual approval**. The wizard captures
name, type, JWKS URI / API key, requested scopes (minimum-necessary), tier, rate limit, IP
allowlist, and the BAA contract reference. Revocation is one-click and audited.

---

## API Metrics

Live FHIR utilization (sourced from `FhirGatewayMetricsProvider`):

- Requests per minute (per client / aggregate)
- Error rate (`4xx` / `5xx`), with `429` rate-limit hits called out
- Top endpoints / resource types
- Bulk-export job counts + status
- Inbound-proposal review SLA
- Top clients by volume

---

## Disclosure Logs

Every FHIR read emits an `auditRead` row (the §164.528 right-to-an-accounting evidence). The log
view shows, per disclosure: consuming client id, resource type, query parameters, result count,
requesting IP, user-agent, timestamp, and the consent-gate outcome.

A SUD-redacted disclosure is flagged: when the consent gate is closed, the response is a redacted
Bundle with an `OperationOutcome` warning ("filtered for 42 CFR Part 2; consent absent") — the log
records the redaction so it is not mistaken for "no data."

---

## Version Sunsetting

R4 is live; R5 / R6 mappers are compile-shells returning `415 Unsupported Media Type`. This panel
surfaces the supported-version matrix and the deprecation schedule, so an operator can communicate
sunset timelines to partner clients and track which clients still call a deprecated path.

---

## Sensitivity & Guardrails

- Identifiers (client-id, JWKS thumbprint, NPI, BAA reference) render in IBM Plex Mono.
- Client secrets are encrypted at rest and denylisted from audit value capture; only the
  fingerprint displays.
- Consent-gated disclosure (M39 `ConsentEvaluator`) is enforced at egress, never at storage; SUD
  content is redacted by default.

Blocked actions show an explicit reason:

- Activating a client without dual approval → "Requires Org Admin + Compliance Officer approval."
- Activating a client with no BAA reference → "BAA contract reference required before activation."
- Granting a scope the BAA does not cover → "Scope exceeds the executed BAA."
- AI is **prohibited** from synthesizing, modifying, or redacting FHIR resources
  (`validateFhirAIBlock`); no AI affordance renders here. Projections are deterministic.

---

## Empty States

- No clients: "No FHIR clients registered." → Register Client.
- No metrics yet: "No FHIR traffic in the selected window."
- No disclosures: "No disclosures logged for this filter."

---

## Actions

- Register client (dual approval)
- Edit scopes / rate limit / IP allowlist
- Suspend / revoke client (audited)
- View disclosure log · export §164.528 accounting
- Regenerate CapabilityStatement
- Notify clients of version sunset

---

## Pencil Notes

Create versions for:

- Client registry list + detail
- Client registration wizard (dual approval)
- API metrics dashboard (req/min · error rate)
- Disclosure log (consent-gated, SUD-redaction flag)
- BAA / scope mismatch blocked state
- Version-sunsetting matrix
