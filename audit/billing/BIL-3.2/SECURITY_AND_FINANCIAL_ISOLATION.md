# Security and financial isolation

- Reads start from an organization- and provider-scoped staged ERA row; inaccessible IDs return not-found through the existing route behavior.
- Decision writes re-read and lock that same stage under organization context and provider scope.
- Claim identity is taken only from the upstream verified outcome. A client cannot submit an arbitrary claim UUID or ownership values.
- `remittance.read` and `remittance.match_review` are distinct. The migration does not auto-grant matching rights based on legacy manual-match grants.
- The decision service imports no posting service, does not emit events, and does not call `receiveAdvice` or `postAdvice`.
- The balance operation is read-only and uses integer cents.
- Raw X12, key material, TIN and member identifiers are not returned by the matching projection.

Application-level tests cover route permission composition and nonposting response contracts. RLS and role behavior remain unverified at runtime because the configured test DB is a shared local PostgreSQL cluster, not disposable and isolated.
