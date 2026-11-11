# Tenant versus account operator security

Tenant health begins at `claimmd_era_m25_stage` under `withOrgContext`, organization FORCE RLS, and provider scope. It never reads central stream, inbox, resolution, delivery, account, or cursor tables.

The account endpoint requires `billing.rule_config.platform_admin`, `platform_billing_scope`, and an authenticated platform-owned role. It returns bounded aggregates only. Account reference and cursor value are deliberately absent.

The private RLS suite proved that Tenant A sees its stage aggregates, Tenant B cannot see Tenant A's stage, and `chartwarden_app` cannot select central Claim.MD tables.
