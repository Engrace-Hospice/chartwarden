# Clearinghouse integration

Everything about connecting ChartWarden to clearinghouses for the full claim cycle (eligibility → NOE → claim →
acks → 835 → posting → denials → NOTR).

| Document | What it is |
|---|---|
| [`ADAPTER_EXPANSION_PLAN_20261011.md`](./ADAPTER_EXPANSION_PLAN_20261011.md) | Plan: `ClearinghouseTransport` port, conformance suite, Stedi first, further clearinghouses after. |
| [`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md) | Historical questions/replies plus the current Q1–Q33 evidence matrix; statuses preserve provenance and the 2026-11-06 ADR-0053 tenant-choice decision. |
| [`STEDI_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./STEDI_ARCHITECTURE_AND_EVIDENCE_20261118.md) | 2026-11-18 consolidation of maintainer-reported answers, official sources, OAuth target, development/activation matrix, issue roadmap, and outstanding vendor/legal evidence. |
| [`STEDI_WRITTEN_MESSAGE_20261011.md`](./STEDI_WRITTEN_MESSAGE_20261011.md) | Send-ready written message to Stedi (blocking items first). Draft, not yet sent. |
| [`STEDI_SANDBOX_FINDINGS_20261009.md`](./STEDI_SANDBOX_FINDINGS_20261009.md) | Sandbox probe results (edit rules, payer records, error shapes), D/O/U-labelled answers. |
| [`STEDI_TRANSPORT_CONTRACT_20261011.md`](./STEDI_TRANSPORT_CONTRACT_20261011.md) | What the `StediTransport` adapter may rely on, by source, and what is still unverified. |
| [`CLAIMMD_TRANSPORT_CONTRACT_20261104.md`](./CLAIMMD_TRANSPORT_CONTRACT_20261104.md) | What the `ClaimMdTransport` adapter relies on (docs, portal observations, open items) and where the sandbox results go. |
| [`M23_DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_V1.md`](./M23_DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_V1.md) | Proposed, unimplemented external gateway v1 contract: durable idempotency, artifact/attempt correlation, lookup, acknowledgment provenance, security, and conformance requirements. |
| [`STEDI_QUESTIONS_TO_SEND_20261025.md`](./STEDI_QUESTIONS_TO_SEND_20261025.md) | Abbreviated, unsent follow-up questions for account authorization, OAuth/attribution, Medicare hospice enrollment, adjustments, agreements and billing. |
| [`EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md`](./EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md) | Paste-ready questions to Episode Alert and the MAC (DDE IDs, write endpoints, BAA), with what each blocks. Not sent (#762). |
| [`EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md`](./EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md) | Current prioritized, ready-to-send Episode Alert and applicable HH+H MAC questions; prepared only, not sent. Supersedes the older Oregon routing wording. |
| [`EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md`](./EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md) | Current public-source review, implementation/runtime inventory, account-model options, scoped capability pre-activation contract, issue matrix and capability blockers. |
| [`EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md`](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md) | Human checklist: trial, BAA gate before PHI, owner roles, what to attach, how to record answers (#762). |
| [`EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md`](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md) | Env names the Episode Alert adapter and `DDE_PROVIDER` read, where they live, rotation (#762). |
| [`EPISODE_ALERT_TRIAL_CAPTURE_RUNBOOK_20261025.md`](./EPISODE_ALERT_TRIAL_CAPTURE_RUNBOOK_20261025.md) | What a trial account must show before claim status and remits can be implemented (#758). |
| [`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md) | Gated synthetic contract run: distinguishes free Sandbox, Production account + Test key, Production credentials, and OAuth (which cannot use Test mode). |
| [`STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md`](./STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md) | Per-run template for account/key mode, commit/date, submission correlation, separate 277CA/835 evidence, retries, and unverified cases. |
| [`STEDI_CALL_AGENDA_20261009.md`](./STEDI_CALL_AGENDA_20261009.md) | 30-minute technical-call agenda. |
| [`DDE_STEDI_INTEGRATION_ASSESSMENT_20261008.md`](./DDE_STEDI_INTEGRATION_ASSESSMENT_20261008.md) | Assessment of the DDE queue + Stedi path against the code. |
| [`DDE_STEDI_PROMPT_ASSESSMENT.md`](./DDE_STEDI_PROMPT_ASSESSMENT.md) | The prompt the assessment answered. |
| [`DDE_STEDI_REVIEW_20261008.md`](./DDE_STEDI_REVIEW_20261008.md) | Review that fed ADR-0052. |

Per-tenant clearinghouse (2026-11-06): each tenant chooses `stedi`, `claimmd` or `outside` with its own sealed credential;
see the amendment of the same date in ADR-0053. The vendor connection test is the Claim.MD `uploadlist` probe (no PHI); Stedi has
no safe probe, so its verification is an attestation with evidence.

Decisions: [ADR-0052](../../adr/ADR-0052-dde-work-queue.md) (DDE work queue); ADR-0053 (clearinghouse
transport port) is the first item of the plan.
