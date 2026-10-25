# Episode Alert and MAC NSV enrollment: written questions to send (issue #762)

**Date:** 2026-10-25 · **Status:** ready to send, **not sent**. Nothing here is a vendor answer. Every statement about what
Episode Alert publishes comes from the tracking issue (#755, findings of 2026-10-24) and stays unverified until Episode Alert
or the MAC confirms it in writing. Onboarding steps: [`EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md`](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md).
Secrets: [`EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md`](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md).

A person sends both messages and files the replies (see "Recording answers" in the onboarding runbook). Do not paste any
patient, MBI or real claim into either message; nothing below is PHI.

## Message 1: Episode Alert (paste-ready)

Subject: ChartWarden (hospice EHR) - written answers needed before we build the Episode Alert integration

Hello,

We are a software vendor building hospice billing software and want to integrate Episode Alert for Medicare eligibility,
claim status, remittances and, if you support it, DDE work. Please answer in writing; items marked **blocking** gate our
build. We will use synthetic data only until a BAA is signed.

**A. Agreement and account**
1. (blocking) Is a BAA available, does it cover trial and test traffic, and who signs for Episode Alert?
2. May a software vendor hold ONE platform account for several hospice customers, or must each hospice have its own
   account? How is usage attributed to a hospice (billing NPI, a sub-account, a per-request field)?
3. What is the pricing model (per request, per provider, per user) and what does the 14-day trial include?

**B. The API (please send the API guide and sample calls)**
4. (blocking) Base URL, authentication scheme (header name, key or token, expiry), rate limits, and request and response
   schemas with XML samples, for eligibility (including the Hospice section), daily claim status and remittance retrieval.
5. Is there a sandbox or test mode? Can a test call be made without touching production data or CMS? If not, how do you
   recommend we test?
6. Are results pushed (webhook, with a signature scheme) or only polled (cursor, date range)? How long are results kept?

**C. DDE write operations (the answers decide whether we build this at all)**
7. (blocking) Do you expose NOE, NOTR, claim entry, RTP correction, cancel and adjustment as API operations? Please answer
   each one separately. If SmartDDE is a hosted screen and not an API, please say so.
8. (blocking) Whose DDE ID is used? DDE IDs are issued to individuals and cannot be shared. Can each of our customers'
   operators have their own DDE ID under your service, supplied per request through the API, so every action is attributable
   to one named person? Or do you act under one vendor-level or per-provider session? If the latter, we cannot use it for
   DDE writes.
9. How do you report the outcome of a keyed operation (accepted, returned to provider, rejected, with the MAC's reason
   codes and document control number)? Is there a daily change report we can pull by API, and in what format?
10. What happens when a write may have reached the MAC but you did not get a confirmation? Do you offer an idempotency key
    or a status lookup so we never key the same operation twice?
11. Which MACs and jurisdictions do you support for hospice (we start with the Oregon Part A MAC)?

**D. Security and data handling**
12. Where is beneficiary data stored, for how long, and can retention be set to zero for requests we send? Do you log
    request bodies?
13. IP allow-listing, TLS requirements, credential rotation without downtime (can two keys be valid at once?), and an
    incident contact.

Thank you.

## Message 2: the MAC (EDI and DDE enrollment)

Sent by the provider enrollment owner (not engineering) to each customer's Part A MAC EDI/enrollment desk, because the hospice
is the enrolled party. We do not know which of these the MAC treats as one form or several; ask and write down the form names.

Subject: DDE access and network service vendor use for a hospice provider

1. (blocking) May a hospice use a CMS-approved network service vendor (Episode Alert) to reach DDE and to receive
   eligibility, claim status and remittance data? What does the MAC need from the provider (EDI enrollment form names, a
   vendor authorization, a trading partner ID)?
2. (blocking) Are DDE IDs issued per individual? Can a vendor-hosted DDE session use each operator's own ID, or must the
   operator log in directly? Is a DDE ID issued to a vendor employee on a provider's behalf acceptable?
3. How long does DDE access take to issue, how often must passwords be reset, and what is the lockout rule when a vendor
   session logs in on a person's behalf?
4. Is there a hospice-specific rule for who may key NOE, NOTR, RTP corrections, adjustments and cancels, and any user role or
   access class we must request?
5. How are the provider's PTAN, CCN and NPI tied to the DDE ID and to the vendor's service?
6. Who do we contact to revoke a DDE ID within one business day when an operator leaves?

## What each unanswered question blocks

| Question | Blocks | Our default until answered |
|---|---|---|
| EA 1 (BAA) | Any real beneficiary data at the vendor, including a trial with real MBIs | Synthetic data only; no MBI leaves the platform |
| EA 4 (guide, auth, schemas) | Verifying `/eligibility`, the `Authorization` scheme and the XML element names in the #758 adapter; claim status and remittance methods | Adapter built, every vendor field marked UNVERIFIED; claim status and remittances answer `CH_NOT_WIRED` |
| EA 5 (sandbox) | Any test run; the port requires `usage: "test"` to reach only vendor test mode | `EpisodeAlertTransport` refuses `usage: "test"`; no live call |
| EA 6 (push or poll) | The shape of outcome ingestion in #760 (daily-change job or webhook route) | Poll-shaped cursor port (`fetchOutcomes`); no webhook route |
| EA 7 (write endpoints exist) | #759 (DDE write adapter), the "send via provider" parts of #760, #761 action | #759 stays an unbound skeleton; `DDE_PROVIDER` stays `manual`; the ADR-0103 D7 fallback applies (documented API only, through `ClearinghouseTransport`) |
| EA 8 / MAC 2 (per-operator DDE ID) | #759 and ADR-0103 D4; a "no" means that adapter is not accepted and #759 stops (the #759 instruction to revisit ADR-0054 D4 is this ADR-0103 D4) | `manual`; the ADR-0052 human queue is the only path |
| EA 9 (outcome reporting) | Provider-verified outcomes (ADR-0103 D5) and the new `payer_status_date` source value in #760 | Operator attestation (`record-acceptance`) only |
| EA 10 (idempotency, status lookup) | ADR-0103 D6 conformance for a real adapter; safe retry in #760 | Never auto-retry an in-doubt send (`DDE_IN_DOUBT`) |
| EA 2 (account model) | First production tenant on Episode Alert | Platform-held credential as ADR-0103 D2 says; a per-hospice-account answer needs an ADR amendment |
| EA 12 / 13 (retention, rotation) | BAA review; the rotation cadence in the secrets runbook | 90-day rotation proposed; no PHI sent |
| MAC 1 (NSV use, forms) | Production use for any customer | No enrollment attempted |
| MAC 4 (who may key what) | Permission wording in #760 | ADR-0052 D6 assignee ownership only |
| #766 (RTP status T, suspended S, adjustments, cancels have no electronic signal) | Only EA 9 (a daily change report) could supply such a signal | Stays manual and UI-driven per #766 scope item 1 |
| ADR-0052 open question 4 (do adjustments move to the electronic path) | Stedi Q17/Q28 first (see [`STEDI_QUESTIONS_TO_SEND_20261025.md`](./STEDI_QUESTIONS_TO_SEND_20261025.md)); EA 7 is a second route | Adjustments and cancels remain DDE queue work |
| #763 (conformance and status matrix for the real adapter) | EA 4, 7, 8 | Conformance runs against the in-memory reference only |
