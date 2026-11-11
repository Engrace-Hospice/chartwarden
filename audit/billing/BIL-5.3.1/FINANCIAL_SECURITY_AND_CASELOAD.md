# Financial security and caseload

The new M41 detail route intersects `commercial_billing.read`, `remittance.read`, M41 provider-scope ABAC and M41 claim caseload ABAC. The M41 read service re-fetches its claim before M25 is queried. The M25 owner read uses organization context and the caller's server-issued provider scope, then constrains claim and payer identifiers. An absent M25 reader fails closed instead of returning zero.

These controls are source-reviewed and compile-tested. The required two-tenant/provider/caseload HTTP plus restricted-role PostgreSQL proof has not been executed; do not treat source checks as runtime RLS certification.
