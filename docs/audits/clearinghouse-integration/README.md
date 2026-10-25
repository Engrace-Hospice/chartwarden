# Clearinghouse integration

Everything about connecting ChartWarden to clearinghouses for the full claim cycle (eligibility → NOE → claim →
acks → 835 → posting → denials → NOTR).

| Document | What it is |
|---|---|
| [`ADAPTER_EXPANSION_PLAN_20261011.md`](./ADAPTER_EXPANSION_PLAN_20261011.md) | Plan: `ClearinghouseTransport` port, conformance suite, Stedi first, further clearinghouses after. |
| [`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md) | Questions sent to Stedi, their answers (2026-10-09) and sandbox follow-ups Q14–Q19, build follow-ups Q20–Q31. |
| [`STEDI_WRITTEN_MESSAGE_20261011.md`](./STEDI_WRITTEN_MESSAGE_20261011.md) | Send-ready written message to Stedi (blocking items first). Draft, not yet sent. |
| [`STEDI_SANDBOX_FINDINGS_20261009.md`](./STEDI_SANDBOX_FINDINGS_20261009.md) | Sandbox probe results (edit rules, payer records, error shapes), D/O/U-labelled answers. |
| [`STEDI_TRANSPORT_CONTRACT_20261011.md`](./STEDI_TRANSPORT_CONTRACT_20261011.md) | What the `StediTransport` adapter may rely on, by source, and what is still unverified. |
| [`STEDI_QUESTIONS_TO_SEND_20261025.md`](./STEDI_QUESTIONS_TO_SEND_20261025.md) | Ready-to-send questions (Q14 test-key note, Q32 reseller model, enrollment, freq 7/8, BAA). Not sent (#727). |
| [`EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md`](./EPISODE_ALERT_QUESTIONS_TO_SEND_20261025.md) | Paste-ready questions to Episode Alert and the MAC (DDE IDs, write endpoints, BAA), with what each blocks. Not sent (#762). |
| [`EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md`](./EPISODE_ALERT_ONBOARDING_RUNBOOK_20261025.md) | Human checklist: trial, BAA gate before PHI, owner roles, what to attach, how to record answers (#762). |
| [`EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md`](./EPISODE_ALERT_SECRETS_RUNBOOK_20261025.md) | Env names the Episode Alert adapter and `DDE_PROVIDER` read, where they live, rotation (#762). |
| [`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md) | How to run the gated sandbox contract test (synthetic data, test key, live sending off). |
| [`STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md`](./STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md) | Results template to copy per run. |
| [`STEDI_CALL_AGENDA_20261009.md`](./STEDI_CALL_AGENDA_20261009.md) | 30-minute technical-call agenda. |
| [`DDE_STEDI_INTEGRATION_ASSESSMENT_20261008.md`](./DDE_STEDI_INTEGRATION_ASSESSMENT_20261008.md) | Assessment of the DDE queue + Stedi path against the code. |
| [`DDE_STEDI_PROMPT_ASSESSMENT.md`](./DDE_STEDI_PROMPT_ASSESSMENT.md) | The prompt the assessment answered. |
| [`DDE_STEDI_REVIEW_20261008.md`](./DDE_STEDI_REVIEW_20261008.md) | Review that fed ADR-0052. |

Decisions: [ADR-0052](../../adr/ADR-0052-dde-work-queue.md) (DDE work queue); ADR-0053 (clearinghouse
transport port) is the first item of the plan.
