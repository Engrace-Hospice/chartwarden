# BIL-3.3 — Financial Review Workspace

Status: source implementation complete; focused tests, private PostgreSQL/RLS validation, and migration-runner rehearsal completed for this worktree.

This phase extends the existing M25 Claim.MD ERA matching detail with a read-only financial projection and append-only reviewer decisions. Amounts are exposed as integer cents, claim/service-line/provider adjustments stay in separate scopes, and the API explicitly returns `financialPostingAuthorized: false`.

No payment allocation, ledger entry, balance update, posting event, Claim.MD request, or worker activation is introduced. The service-level decision transaction still needs a direct PostgreSQL-backed invocation test, and original submitted-line evidence is not available for financial line allocation. See [review design](FINANCIAL_REVIEW_AND_BALANCING.md), [security boundary](SECURITY_AND_POSTING_ISOLATION.md), and [test results](TEST_RESULTS.md).
