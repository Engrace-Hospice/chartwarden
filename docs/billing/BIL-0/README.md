# BIL-0 — Claim.MD shared-account audit

**NO-GO for shared-account production activation (source-audit verdict, 2026-11-06).** The adapter and billing modules are substantial, but inbound status and ERA handling are organized around provider-scoped polling while Claim.MD documents account-wide response and ERA cursors. The response adapter filters only `bill_npi`, discards unparseable statuses/entries, and advances a caller cursor; M41 drops unmatched events. ERA files are assigned to the polling provider and M25 posts all CLP lines under that provider. See [BIL0-001–004](FINDINGS.md). This is a credible missed-status or money-misposting risk, **not proof of a cross-tenant production incident**. No runtime, database, credential, deployment, or vendor transaction was inspected.

## Scope and answer

Fabrice already built a Claim.MD `ClearinghouseTransport` adapter, HTTP/form helpers, rate limiter, durable submission attempt and interchange-number stores, boot binding, tests, M23/M41 send and acknowledgment workers, M25 835 ingestion/posting, and billing screens. Reuse these; [INVENTORY](INVENTORY.md) locates them. M24 retains state-specific submission. The shared account is a platform credential; tenant staff remain in WardenX. [Claim.MD's quickstart](https://docs.claim.md/v1/docs/test-account-quickstart-guide) explicitly describes the no-provider-portal model and requires software to show rejections, denials, resubmission and ERA.

**First safe implementation PR:** add an account-scoped, usage-separated *durable inbound response capture* behind an inactive switch, with synthetic fixtures and no change to production consumers. Preserve the original vendor fields and raw response in a protected inbox, advance the cursor in the same transaction only after all page items are captured, and quarantine unresolved items. Then connect existing M23/M41 consumers in later PRs after dual-read parity. [ADR](ADR_CLAIMMD_SHARED_ACCOUNT.md), [roadmap](IMPLEMENTATION_ROADMAP.md).

| Component | Source verdict | Certification limit |
|---|---|---|
| Claim.MD boot/submit | Implemented | No deployment or live transaction proof |
| Account-wide acknowledgment capture | Missing | Current per-provider cursors cannot preserve every account item |
| M23/M41 status application | Partial | Strong local scope checks, lossy vendor fan-out |
| M25 parsing/posting | Partial | Transactional posting exists; mixed-identity ERA routing is not established |
| Commercial enrollment readiness | Partial | Local status is not vendor/payer activation evidence |
| M24 Claim.MD support | Unknown | State adapters are separate; no universal route established |
| Institutional hospice NOE/NOTR/transfer via Claim.MD | Unknown | Generic 837I support does not certify these transaction workflows |

Read-only inspection only. No tests, services, migrations, API calls, secret reads, or source changes were made. These nine documents are the sole artifacts. Source references use repository-relative `path:line`; external links identify published vendor contracts, not local runtime behavior.

## Blocking commercial/configuration questions for rollout

1. Which Claim.MD production and test accounts/keys, account number, authorized portal staff, transmit-approval setting, and SFTP/API access modes are contracted?
2. For each provider NPI/TIN and payer/transaction (837I claim, NOE, NOTR, transfer, 270/271, ERA), what written Claim.MD and payer activation evidence exists, including externally hosted enrollment links and portal-only steps?
3. What is the executed enterprise pricing schedule, especially incremental billing-provider Tax IDs and ERA/eligibility usage allocation?
4. What rollout tenants/providers, reconciliation owner, historical backfill window, vendor support path, and rollback authority are approved?
