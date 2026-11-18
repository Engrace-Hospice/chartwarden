# Stedi follow-up questions (unsent)

**Updated:** 2026-11-18. This abbreviated message replaces the longer 2026-10-25 draft for future use. It has not been sent. Responses must be retained with date, sender, and account/context reference and classified by evidence type; no answer is inferred from this document.

ChartWarden has a Stedi Production account (maintainer-reported). ADR-0053 selects tenant-owned clearinghouse relationships. We are preserving the existing API-key Test-mode contract path and evaluating OAuth/Integrated Accounts for customer onboarding. Please answer the account-specific questions below in writing and identify unsupported cases explicitly.

## Q14 — Test-mode authorization and response retrieval

1. Is ChartWarden's Production account authorized and provisioned for synthetic 837I submission using a Test-mode API key, for both JSON and raw-X12 routes? Are account settings or additional permissions required?
2. Do synthetic claim submissions return a stable receipt and synthetic 277CA through the documented response/retrieval path for this account? Is Test Payer enrollment unnecessary for this ordinary test-claim/277CA contract, and required only to generate/retrieve synthetic 835 ERA?
3. If testing ERA, what Test Payer provider registration/enrollment is required, which transaction must be enabled, and how can we verify it without changing any real Medicare enrollment or ERA destination?

## Q27/Q32 — OAuth, Integrated Accounts, tenant/provider scope

1. Is ChartWarden eligible to register and operate a Stedi OAuth partner app? Please provide the current integration guide, onboarding/approval steps, allowed redirect and app requirements, scopes, and supported test-safe qualification path.
2. Can one tenant-owned Stedi organization account represent multiple hospice provider entities? Which entity owns each provider record and transaction enrollment, and how are permissions scoped?
3. What stable account/provider identifiers are available in submission responses, callbacks/events, transaction polling, report retrieval and claim responses? How should a multi-tenant app verify account and provider attribution before applying an acknowledgment or ERA?
4. What happens to token access, pending submissions, events, polling history and previously submitted responses after uninstall, OAuth revocation, account closure or tenant clearinghouse switch? Which items can still be reconciled, and for how long?
5. Can synthetic Test-mode keys be used with an Integrated Account or OAuth app? If not, confirm the supported API-key route for contract testing and how it is isolated from customer OAuth and production credentials.

## Q16 — Medicare hospice routing and enrollment

1. For each applicable HH+H MAC, list the Stedi payer records and separately confirm support for 837I claims, NOE, NOTR, 835 ERA and 276/277 status. Please identify the correct Oregon hospice payer record; the historical `MDCKC` / `12M41` lookup is not treated as confirmation, and NGS `MFPWU` showed `NOT_SUPPORTED` for institutional claims in the historical payer search.
2. For each transaction, specify whether enrollment is required and the enrollment unit/identifiers: NPI, TIN, PTAN and/or CCN, provider organization, MAC, payer, account or transaction. Identify forms/attestations, provider actions, MAC approval and how to retrieve status. Do not provide one generic timeline if the actual workflow varies.
3. Are NOE/NOTR sent using the same 837I institutional endpoint and enrollment as claims? Please identify accepted raw-X12 segments/values (including BHT06 and applicable TOB variants) and whether the JSON API supports those notice formats.
4. How should an ERA transition be coordinated when a provider changes clearinghouses, including effective dates and pending ERAs at the former vendor?

## Q17/Q28 — rejected claim versus adjustment, cancellation and FISS/DDE

Please distinguish: (a) rejected before adjudication, (b) in adjudication, (c) processed/paid adjustment, (d) cancellation, and (e) external FISS/DDE correction. For Original Medicare hospice, are TOB 8x7/8x8 with frequency 7/8 supported through the Stedi API, and for which MACs? Stedi's generic guidance describes original-frequency Medicare resubmission, while CGS documents FISS/DDE 817/827 and 818/828 workflows; we do not infer that either establishes the other's API behavior. Please state what payer claim control number/reference is required in each case.

## Q33 / B5 — agreements, responsibility and billing

1. For a hospice-owned account and OAuth-connected app, who signs the Stedi BAA and service agreement? Does ChartWarden need a separate direct agreement/BAA as an application provider? Please identify applicable scope, PHI handling, retention/deletion, subprocessors, incident notice and audit terms.
2. Which party owns provider identity, enrollment, API credentials, revocation, and support authorization? What contractual responsibilities remain with the hospice versus ChartWarden?
3. Is billing per tenant account the supported initial arrangement? Is consolidated billing across tenant-owned Integrated Accounts available to ChartWarden, and under which commercial plan/contract?

Please reply inline, mark account- or MAC-dependent behavior explicitly, and provide current technical, payer/MAC, enrollment, and contractual references. We will record answers in the evidence matrix. Legal review, engineering readiness, Test-mode qualification, and production/MAC approval remain separate decisions.

## Internal gating summary

| Work | Current evidence | Gate that remains |
|---|---|---|
| Local code and synthetic fixtures | Continue with local/mocked tests | No vendor credentials or PHI required |
| Contract submission | Public docs describe Production account + Test key; no successful ChartWarden run | Written account applicability, independently verified Test key, explicit operator authorization, sanitized result artifact |
| Synthetic 835 | Public Test Payer flow | Separate Test Payer registration/enrollment and authorized receipt retrieval |
| Tenant OAuth onboarding | Internal target architecture; Stedi partner approval not established | OAuth app approval, complete integration guide, account/provider and response-attribution contract |
| Medicare hospice and NOE/NOTR | Jurisdiction/enrollment sources are general; no ChartWarden MAC qualification | Written payer-specific enrollment and workflow evidence plus MAC-specific qualification |
| Paid corrections/cancels | Stedi general guidance and CGS FISS/DDE material have different scopes | Written Stedi/API and applicable MAC decision; keep Stedi 7/8 disabled |
| Production PHI exchange | Not authorized by public docs or maintainer report alone | Applicable BAAs/contracts, compliance review, tenant enrollment, routing, response operations and explicit production activation |

See [`STEDI_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./STEDI_ARCHITECTURE_AND_EVIDENCE_20261118.md) for source provenance, the readiness matrix, and the proposed implementation roadmap.
