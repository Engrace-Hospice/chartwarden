# WardenX — Product Requirements Document (Retrospective Intent)

> **Status**: Retrospective intent record, written 2026-08-14, after the 40-module build reached
> feature-complete on `main`. A PRD is normally written *before* building; this one exists to make
> the product's intent explicit and challengeable — the problem, the bet, and the conditions under
> which we'd call the bet right or wrong — so the team can judge the product against its intent,
> not against its implementation.
>
> **Scope guard**: this document contains *product intent only*. Every engineering decision
> (stack, data model, security boundaries, testing architecture) lives in the authoritative
> architecture corpus — `docs/architecture/` (top authority: `WARDENX_ARCHITECTURE_v0_11.md`) and
> `docs/adr/`. Where this document and architecture conflict, **architecture wins**.

---

## 1. Problem Statement

Hospice organizations operate under the densest regulatory mesh in post-acute care — Medicare
Conditions of Participation (42 CFR 418), the HOPE assessment instrument, HQRP quality reporting,
EVV mandates, 42 CFR Part 2 confidentiality, the aggregate payment cap, and annual cost reports —
while their primary workforce documents care **in the field**, not at a desk.

Today's coping mechanisms treat compliance as *inspection after the fact*: legacy hospice EHRs
bolt compliance onto documentation as reports, checklists, and back-office scrubbing. The
consequences land on three groups:

- **RN case managers** (the primary user) carry the documentation burden home — late-entry
  charting, missed cosign windows, assessment timepoints tracked in side spreadsheets — because
  the system records what they type but doesn't *know the rules* they're being surveyed against.
- **Multi-site operators** discover compliance failures at survey, ADR audit, or claim-denial
  time — weeks to months after the fixable moment — and pay for it in deficiencies, denials,
  clawbacks, and cap liabilities that were structurally preventable.
- **De novo hospice operators** must assemble an EHR, a billing vendor, an EVV aggregator, a
  quality-reporting workflow, and a compliance program from separate parts before they can admit
  their first patient.

**Cost of not solving it**: survey deficiencies and condition-level citations, claim denials and
payment-integrity exposure, cap overpayment liabilities, and clinician burnout/turnover driven by
after-hours documentation — each individually survivable, together an existential drag on
mid-size operators and a wall in front of new ones.

*(Intent framing check: nothing above prescribes a solution — an incumbent could answer this
problem with services, a rules engine, or an AI layer. WardenX's answer is the thesis below.)*

## 2. Evidence

Honest accounting: this PRD is retrospective, and its **feasibility** leg is strongly evidenced
while its **value** leg is still mostly assumption.

| Claim | Status |
|---|---|
| The full hospice operational surface *can* be built as one compliance-native system | **Evidenced** — 40/40 modules implemented on `main`; per-module status in `audit/implementation-status/IMPLEMENTATION_STATUS.md`; cross-tenant isolation proven by executed live RLS suites |
| The regulatory mesh is real and codifiable (CoP timers, HOPE windows, five-rights, cap math, tighten-only floors) | **Evidenced** — the rules exist as enforced write-path code (see `docs/BUSINESS_LOGIC.md`), each traceable to a specific regulation |
| The HOPE transition and EVV enforcement broke legacy vendors' assessment/visit workflows | Assumption — validate via prospect interviews with hospices that lived through the Oct 2025 HOPE cutover |
| Clinicians lose meaningful after-hours time to documentation, and it drives turnover | Assumption — industry-reported pain; validate with time-in-system baselines at first pilot |
| Buyers will pay a premium for compliance-native depth (vs. treating it as parity) | Assumption — validate via pricing conversations; this is the riskiest value assumption |
| Mid-size operators will absorb migration cost to switch off an incumbent | Assumption — validate via pilot recruitment; switching friction is the known killer in this market |

## 3. Thesis — why build it

**Why this**: compliance in hospice is not a reporting problem, it is a *point-of-care* problem.
Every deficiency, denial, and cap surprise traces back to a moment where the system could have
known the rule and didn't. WardenX's bet is that encoding the regulatory mesh **into the write
path itself** — the visit can't publish without its gate, the med can't administer without five
rights, the meeting can't adjourn past a patient's review floor, the tenant can tighten a floor
but never loosen it — converts compliance from an audit finding into a non-event.

**Why it beats how they cope today** — four pillars, in priority order:

1. **Compliance-native depth**: CoP/HOPE/HQRP/EVV/Part-2 rules enforced at the moment of
   documentation, not discovered at survey. Incumbents retrofit rules as warnings; WardenX makes
   the compliant path the only path (with audited, step-up-gated overrides where clinical reality
   demands them).
2. **Full cycle in one tenant**: clinical documentation through claims, remittance, cap
   management, cost report, and quality submission in one system — no bolt-on billing vendor, no
   reconciliation seam where denials breed.
3. **Security & trust posture**: database-enforced tenant isolation, mandatory audit on every PHI
   write *and* read, formal break-glass, attribute-based authorization — a trust story that sells
   to the compliance officer and survives due diligence.
4. **AI-forward platform**: an AI layer with governance built in (ledger, encryption,
   human-in-the-loop) aimed squarely at the documentation burden — the pillar that attacks the RN
   case manager's pain directly.

**Why now**: the AI capability shift. LLMs made the clinician documentation burden addressable
for the first time — and governance-grade AI (auditable, consented, PHI-safe, human-supervised)
cannot be credibly retrofitted onto architectures that treat audit and access control as
afterthoughts. The window is the gap between AI being possible and incumbents making it safe.

**Who switches**: a barbell —

- **Mid–large multi-site operators**, who feel the compliance and revenue-cycle pain at scale and
  have the depth (IPU, cap management, multi-location ops) to use what WardenX built; and
- **De novo hospice operators**, who have no incumbent to displace and need the entire stack —
  EHR, billing, EVV, quality — on day one.

## 4. Hypothesis

```
We believe a hospice EHR that enforces the regulatory mesh in the write path — and uses
governed AI to cut documentation burden — will cause mid-size multi-site operators and de
novo hospices to run their full operation (clinical through claims) on WardenX, resulting
in fewer deficiencies/denials for the org and less after-hours charting for clinicians.

We'll know we're RIGHT if 1–3 pilot hospices go fully live — admissions through billed and
PAID claims, plus an accepted HOPE submission — within ~2 quarters of first go-live, and
the pilots renew.

We'll know we're WRONG if field clinicians route around the system — documenting in side
channels (paper, texts, the old system) beyond 90 days post go-live — regardless of how
the compliance and billing metrics look. Clinician adoption is the guardrail: green
back-office metrics with side-channel documentation is a failing state, not a mixed one.
```

## 5. Target User & JTBD

**Primary user — RN case manager** (field hospice nurse). Largest user population; carries
visits, encounters, HOPE assessments, eMAR, care-plan participation, and the documentation
burden. If this persona rejects the product, no buyer-level pillar survives (that is exactly the
"wrong" condition above).

> **JTBD**: *When I finish a patient visit in the field, I want my documentation, assessment,
> and medication administration captured correctly and compliantly the first time, so I can go
> home on time knowing nothing will bounce back on me at cosign, IDG, survey, or billing.*

**Secondary personas** (buyers and daily operators, not the anchor): clinical director / DON
(IDG cadence, supervisory compliance, survey readiness) · owner-administrator (census, cap
exposure, clean claims) · compliance officer (audit trails, Part-2, HQRP) · biller · platform
operator (WardenX's own tenant-ops staff).

**Non-users**: see Non-goals (§8).

## 6. MVP — the thinnest line that proves the hypothesis

The MVP is **not** "ship the 40 modules." It is **one pilot hospice tenant running the core
operating loop end to end**:

> referral → admission/election → care plan → scheduled visits with EVV → signed encounters →
> HOPE assessment submission → IDG review → claim → remittance/payment

…with real patients, real clinicians, and real Medicare money — instrumented well enough to read
both the RIGHT signal (paid claims + accepted HOPE submission within the window) and the WRONG
signal (side-channel documentation). Everything outside that loop (portal, AI assist beyond the
first documentation-burden slice, cost report, inpatient unit) is available but *not required*
to score the hypothesis.

**Door check** (informs sequencing, not engineering): the pilot itself is a two-way door — a
failed pilot costs a slice, not the product. The one-way doors — production go/no-go on the
open readiness backlog, data-migration commitments to a switching tenant, and pricing posture —
each deserve an explicit decision (spike/validate first), and are listed in Open Questions.

## 7. Success Metrics

Outcome-shaped, measured at the pilot(s); baselines to be captured at go-live.

| Metric | Target | How measured |
|---|---|---|
| Pilot tenants fully live on the core loop | 1–3 tenants within ~2 quarters of first go-live | Tenant runs admissions→claims→payment in WardenX only |
| First-pass claim acceptance ("clean claims") | ≥ the tenant's pre-WardenX baseline (target: exceed it) | MAC acceptance/denial rates from remittance data, vs. tenant's prior-system baseline |
| HOPE submission acceptance | Accepted CMS submission for the pilot cohort, on time | Submission status per timepoint cohort |
| Same-day documentation rate | Sustained increase over tenant baseline; late-entry tiers trend down | Encounter timestamps vs. visit times (the system already classifies late-entry tiers) |
| After-hours charting time | Measurable reduction vs. go-live baseline (target TBD with pilot) | Time-in-system telemetry outside scheduled hours |
| **Guardrail: side-channel documentation** | ~Zero beyond 90 days post go-live | Pilot-site observation + clinician interviews (cannot be measured from inside the system — plan for it explicitly) |
| Pilot renewal | Pilot converts/renews at term | Contract outcome |
| Cross-tenant data exposure incidents | Zero, always | Security monitoring + audit integrity reports |

## 8. Non-goals

- **Home health agencies** — skilled home health (OASIS, PDGM) is a different regulatory
  universe; explicitly out, even though incumbent vendors bundle it.
- **Palliative-only practices** — community palliative programs without a hospice benefit
  election are out of scope for this product generation.
- **Compliance as advice** — WardenX does not ship a rules engine that *suggests*; where a rule
  is a floor, it enforces (with audited overrides). "Warning fatigue parity" with incumbents is a
  non-goal.
- **Autonomous AI documentation** — AI that writes the chart without a human in the loop is
  explicitly not the product; the AI pillar is governed assistance.

*Deliberately undecided (not yet non-goals — see Open Questions): enterprise national chains;
non-US markets (the compliance core is CMS-specific, making this a de facto constraint today, but
it has not been declared a permanent non-goal).*

## 9. Open Questions

- [ ] **Barbell priority**: when pilot capacity forces a choice, does the first pilot come from
      the multi-site half or the de novo half of the ICP? (De novo is faster to live; multi-site
      proves the switch.)
- [ ] **Pricing & packaging**: premium on compliance depth vs. per-census parity pricing — the
      riskiest value assumption (§2) and untested. TBD — needs validation.
- [ ] **Migration path**: what does a switching tenant's data import actually require (patients,
      open admissions, med profiles, historical claims), and who does the work? One-way door;
      spike before committing to a multi-site pilot.
- [ ] **Incumbent baselines**: obtain a real prospect's denial rate, deficiency history, and
      documentation-time data to anchor the §7 targets. TBD — needs validation.
- [ ] **AI assist scope**: which single documentation-burden slice ships first in the pilot, and
      what consent/governance posture does the pilot tenant require for it?
- [ ] **Production go/no-go**: the open production-readiness backlog (tracked in `audit/` and the
      internal backlog) gates any real-PHI pilot; the pilot date is a function of that backlog,
      not the reverse.
- [ ] **Enterprise chains / non-US**: declare them permanent non-goals or future phases — leaving
      them ambiguous costs focus.
- [ ] **Guardrail instrumentation**: side-channel documentation can't be observed from inside the
      product; define the observation protocol (site visits, interviews, old-system access logs)
      before go-live, not after.

---

*Next step when acting on this document: the engineering decisions it deliberately leaves open
are already made and maintained in `docs/architecture/` + `docs/adr/` — challenge those there.
For any new slice this PRD motivates (e.g. the pilot's AI-assist scope), write its spec against
the architecture corpus rather than expanding this PRD.*
