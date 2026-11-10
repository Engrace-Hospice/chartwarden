# Supported Posting Path

`buildDrizzleClaimMdEraReviewService` starts from a stage selected by organization and provider scope. It decrypts only the tenant-protected parsed transaction set, checks the stored content and trace digests, checks source ownership evidence and account/environment, and resolves the exact staged claim through the historical source-reader contract. It does not read the account-wide inbox or accept browser-supplied amounts.

The posting plan stores a versioned digest over stage/source digests, account/environment, ownership-evidence digest, claim-identity evidence digest, matching decisions, every latest financial-review revision, payer/claim identity, integer-cent effect, and the fixed accounting-rule version. Plans are immutable. Approval is bound to one plan digest and approval and execution require different memberships; execution also requires a distinct actor from the approver.

Eligibility is limited to one `M41` claim with a UUID payer route, status 1, positive claim payment equal to charge, zero patient responsibility, and payment total equal to the ERA BPR total. Service lines, CAS, remarks, PLB, unknown segments, reversal/recoupment, duplicate effects, unsupported ownership, or stale/incomplete review block the plan. No raw ERA, MBI, TIN, or credential enters the plan response.

The plan exposes the proposed claim-level payment in cents. It is a plan for the existing M25 remittance operation, not bank reconciliation and not proof of payer adjudication beyond the received ERA facts.
