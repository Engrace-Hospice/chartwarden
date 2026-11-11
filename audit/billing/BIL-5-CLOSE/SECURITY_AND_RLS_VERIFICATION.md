# Security and RLS verification

Tenant/provider/caseload checks are enforced by owner readers and M25/M41 routes. The private M41 suite exercised authorized and denied in-doubt, claim, reconciliation and investigation requests, including guessed identifiers and invalid cursors.

The BIL-5.5 private suite used the real provisioned platform login for central readers and confirmed direct `chartwarden_app` access to `claimmd_era_inbox` is denied with PostgreSQL `42501`. Tenant admins without platform permission receive denial; central responses expose no account or cursor token.

The test principal harness proves application authorization and RLS behavior, not deployed IdP certification.
