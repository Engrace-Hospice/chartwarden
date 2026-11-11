# Exception Review and Audit

The existing M25 detail API and `claimmd-era-review.tsx` now show provider-scoped PLB details, sign, masked provider identifier, source position/occurrence, fiscal date, reason/reference, balance status, missing-policy blocker and nonposting guidance.

Authorized reviewers can record a `follow_up` decision with a reason using the existing `remittance.financial_review` permission and append-only, versioned/idempotent review decision path. The ERA-level review item is used; review completion does not authorize financial action. Existing tenant/provider RLS and scope checks remain in force. No new review table or mutation endpoint was added.

The stage's durable history is exposed only from the authorized stage; raw account-wide inbox data and raw 835 are not returned. Ordinary reviewer actions cannot invoke posting, reversal, refund, write-off, or patient billing.
