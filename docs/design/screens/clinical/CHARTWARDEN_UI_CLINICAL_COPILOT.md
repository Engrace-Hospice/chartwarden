# CHARTWARDEN_UI_CLINICAL_COPILOT

Version: 1.0
Status: Screen Specification
Module: Clinical Copilot & Semantic Chart Search (M32)

---

## Purpose

The Clinical Copilot is a conversational assistant grounded in the patient chart: ask
questions, summarize, and search the record semantically — always with citations to the
source and governed by the AI Platform. It augments clinicians; it never makes clinical
decisions or writes to the chart directly.

---

## Primary Users

- RN, LPN, MD, NP, MSW, Chaplain (per capability opt-in / opt-out)

---

## Layout Pattern

Use Assistant.

```text
Scope Bar (this patient · my caseload)
Conversation Thread (prompts + grounded answers with citations)
Suggested Follow-ups / Actions
Composer (Ask · Summarize · Find)
```

---

## Modes

- **Ask** — natural-language questions over the chart ("when was the last PPS, and the
  trend?").
- **Summarize** — visit, chart, or "since last IDG" summaries (drafts only).
- **Find** — semantic search across the record (`semantic_search_chart`).

Backed by AI Platform capabilities `copilot_clinical` and `semantic_search_chart`.

---

## Grounding & Guardrails

- Every answer **cites its sources** (links to the encounter / assessment / order / document
  it drew from); unsupported claims are flagged.
- **No clinical actions:** the copilot cannot place orders, prescribe, or sign — it can
  *suggest*, and the clinician acts. Hard-block categories (medication directives,
  code-status/advance-directive changes) are enforced per M32 governance.
- Augmentation-only disclosure; clinician opt-out honored; capability kill-switch and
  invocation audit apply.

---

## Human-in-the-Loop

Each answer supports **accept / edit / reject / flag** feedback (recorded as the M32 HITL
outcome). Summaries inserted into a note land as drafts in the encounter, never as signed
content.

---

## Statuses

- Capability (per tenant/user): `Enabled`, `Opted Out`, `Kill-switched`.
- Answer feedback: `Accepted`, `Edited`, `Rejected`, `Flagged`.

---

## Empty State

"Ask about this patient — e.g. recent symptom trend, last visit summary, active orders."
(Shows example prompts; notes that answers cite the chart.)

---

## Actions

- Ask · Summarize · Find
- Open a cited source
- Insert summary as draft
- Accept / edit / reject / flag answer
- Switch scope (patient / caseload)
- Opt out of capability

---

## Pencil Notes

Create versions for:

- Empty / example prompts
- Answer with citations
- Semantic search results
- Summary → insert-as-draft
- Hard-block / refusal state
- Opted-out / kill-switched state
