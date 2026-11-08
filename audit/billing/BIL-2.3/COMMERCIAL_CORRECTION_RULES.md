# Commercial Correction Rules

| Current condition | BIL-2.3 behavior |
|---|---|
| Draft | Edit the existing draft through normal M41 editing. No correction child is created. |
| Queued/sending/in doubt | No correction action. Existing M41 transport reconciliation remains authoritative; do not blindly resend. |
| Verified clearinghouse rejection with no payer response | Create one linked draft preserving the original claim frequency/TOB. The server verifies the latest attempt and its clearinghouse rejection. |
| Clearinghouse accepted or payer response exists | This flow is blocked. It does not infer a payer rejection or authorize replacement. |
| Payer accepted/paid/denied | Payer replacement, void, appeal and reconsideration remain plan-specific and unsupported here. Manual payer-guided handling is required. |
| Unknown status | No correction eligibility is inferred. |

The correction reason is a closed enum. It is audit metadata, not evidence that a payer accepts a transaction. The user corrects source records first; M41 reassembles a new claim using the current authorized clinical/coverage facts, while retaining the same tenant, patient, provider, plan, service period and clearinghouse route. The original claim is never edited by this operation.
