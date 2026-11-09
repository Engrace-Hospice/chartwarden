# External certification backlog

These items are deferred from development integration, not waived for controlled activation or production:

## Medicare / Claim.MD

- Certify actual MAC/provider payer IDs and Claim.MD account/environment mappings with synthetic claims and approved test credentials.
- Exercise the complete response correlation and ERA capture/staging pipelines in a controlled shared-account test, including tenant collision cases.
- Certify multi-process worker fencing/recovery and production-safe operational monitoring.
- Verify hospice NOE/NOTR/transfer vendor transport support before enabling any notice upload.

## Commercial

- Obtain payer-specific documented replacement, void, appeal and original control-number requirements. Those paths remain unavailable when unverified.
- Complete payer enrollment and approved test-account route certification.

## Medicaid

- Establish a source-owned, effective-dated M5 coverage to M40 state-program/FFS/MCO attribution contract.
- Verify state companion-guide versions, provider enrollment/trading partner agreements, test authorization and transport for each state/program.
- Keep electronic submission unavailable until each state route is independently verified and certified.

## Release and financial operations

- Production deployment/migration sequencing rehearsal, exact rollback/forward-fix plan and operational alerts.
- Preserve M25 automatic financial posting as disabled until independent end-to-end idempotency and accounting certification plus authorization.
- Re-run full cumulative test selection on the exact candidate commit before any later release decision.
