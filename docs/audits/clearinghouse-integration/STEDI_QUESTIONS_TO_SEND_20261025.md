# Stedi: written questions to send (issue #727)

**Date:** 2026-10-25 · **Status:** ready to send, **not sent**. No answer below is a vendor answer; every "documentation says"
line is quoted from Stedi's public pages (fetched 2026-10-25) and stays unverified until Stedi confirms it in writing.
Source of truth for the full list: [`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md) (Q1-Q33). File their
answers in that file under a new dated heading, then fill [`STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md`](./STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md)
after the runbook run ([`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md)).

Paste-ready message (synthetic data only; nothing here is PHI):

---

Subject: ChartWarden (hospice EHR) - written confirmation needed before we build further

Hello,

We are a software vendor integrating hospice institutional claims, notices of election/termination (TOB 81A/81B) and
Medicare remittances through Stedi for several hospice customers. Please answer in writing; items marked **blocking** gate
our build. We have read your test-claims, integrated-account and resubmission pages and cite them so you can see what we
are relying on.

**1. (blocking) Q14 - test claims.** Our sandbox key returns `ACCOUNT_NOT_PROVISIONED` (HTTP 400) on every 837I that passes
your edits, and on report and polling calls. Your test-claims page says sandbox accounts cannot submit test claims, test
claim workflows are only for production accounts, the mode is inferred from the API key type, and `usageIndicator` must be
`T` when present. Please confirm in writing: (a) the sandbox error is expected; (b) we need a production account with a
test API key; (c) a test key can never file a real claim, and a production key on a test endpoint returns 404; (d) test
claims to any payer ID return a test 277CA without payer enrollment. Is anything else needed (a signed agreement, BAA, a
payment method)?

**2. (blocking) Q32 - reseller account model.** We serve many hospices. May a software vendor use ONE platform Stedi account
holding provider records (NPI, tax id, enrollments) for all customers, or must each customer have its own integrated
account connected through an OAuth app? If one account is allowed: any limits on number of providers or enrollments, and
how do we attribute a 277CA or 835 to a provider (Q27: filter by billing NPI, or a per-provider identifier on each
report)? If integrated accounts are required: who signs the BAA and owns enrollments and billing, and how do test and
production keys work per integrated account? OAuth apps are described as private preview; how do we get access?

**3. (blocking) Q16 - Medicare Part A enrollment.** What does enrollment for Oregon Part A (`MDCKC` / `12M41`) require
(CCN, NPI, PTAN, signed forms), is it per NPI, per provider entity or per tax id, and how long does it take? Can we test
NOE/NOTR before it completes?

**4. (blocking) Q17 / Q28 - frequency 7 and 8.** Your resubmission page says Original Medicare does not accept claim
frequency codes 7 or 8 for resubmissions, yet your edit accepts them with `REF*F8` after `CL1`. Does the MAC accept
adjustments (7) and cancels (8) of PAID hospice claims through Stedi? If not, what is the supported path?

**5. Q33 - BAA.** Is a BAA available for the account type we would use, and does it cover test-mode traffic?

**6. Q21 - notices.** NOE/NOTR pass your edits with `BHT06 = RP`; `CH` with a $0 charge is rejected. Is `RP` the value a
Medicare MAC expects, or does it mean "not for adjudication" so the MAC may ignore the notice?

The remaining open items (Q15, Q18, Q20, Q22-Q27, Q29-Q31) are in the attached list.

Thank you.

---

## What stays open until Stedi answers

| Question | Blocks | Our default until answered |
|---|---|---|
| Q14 (test claims need a production account) | the sandbox contract run | Run nothing; live sending stays disabled |
| Q32 (reseller account model) | ADR-0053 D3, first production tenant | D3 stands as written; a "no" needs a new ADR (integrated account per customer) |
| Q16 (enrollment unit, lead time) | production, NOE/NOTR | None; no enrollment is attempted |
| Q17 / Q28 (frequency 7/8) | adjustments and cancels | The transport refuses adjustments; DDE handles them |
| Q33 (BAA) | any realistic data at the vendor | Synthetic data only |

Nothing in this repository sends this message; a person sends it and files the reply.
