# 08 — Clinical workflows

The lifecycle traced statically was Referral → Intake → Election → Admission → Episode/Benefit
Period → Assessments/HOPE → Visits/Notes → IDG/Care Plan → Recertification → Billing → Discharge →
Bereavement. M6 targeted live suites passed write, election guard, addendum, certification, and
readmission cases. That provides evidence for selected invariants, not a complete end-to-end patient
journey.

| Transition | Principal controls inspected | Audit status |
|---|---|---|
| Referral → intake | M6/M22 routes, document intake | Static; browser/vendor unverified |
| Intake → election/admission | prerequisites, dates, guards, RLS | Targeted live pass |
| Admission → episode/benefit | M6 state services | Targeted subset; concurrency unverified |
| Episode → assessment/HOPE | scheduling/recording/validation | HOPE targeted live pass; CW-QA-0006 |
| Visit → signed note/addendum | versioning, step-up, audit | Static; CW-QA-0014; concurrency unverified |
| IDG/care plan → recertification | module seams/events | Static/unit only in this audit |
| Billing eligibility | election/coverage seams | FAIL through CW-QA-0001 |
| Discharge → bereavement | state/event consumers | Static/unit only in this audit |

No evidence was found sufficient to claim that users can routinely admit without prerequisites,
silently rewrite signed records, or bypass tenant isolation. Those adversarial cases require the
isolated end-to-end and concurrent-write suite listed in report 20. The confirmed clinical-impact
risk is primarily workflow availability: current HOPE policy can block an LPN/LVN whom CMS permits
the hospice to designate for SFV.

42 CFR Part 418 was used as the primary CoP corpus; organizational compliance and clinical-policy
evidence were unavailable. Source: [42 CFR Part 418](https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-418).
