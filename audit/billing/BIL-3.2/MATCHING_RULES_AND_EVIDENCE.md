# Matching rules and evidence

The matching projection reads the existing staged transaction and its upstream `claimOutcomes`. A claim is labeled verified only when the outcome is exactly `verified`, a claim UUID is present, the patient control number equals the parsed ERA claim value, and the transaction-set control number equals the stage transaction set. Explicit upstream ambiguous/conflict/unmatched outcomes remain such; unsupported values stay unsupported.

No amount, name, payer ICN, date, provider profile, or reused PCN by itself creates a match. Current code does not compare correction-chain attempts, payer route/account/environment evidence, or identify an adjudicated attempt beyond the upstream correlation. Therefore the result is a display of upstream verified identity, not a new independently certified financial match.

Reviewer confirmation is allowed only for that verified identity. It records review acknowledgment; it cannot select a claim, override conflicts, change ERA ownership, match a line, or authorize reconciliation/posting. The stored source digest binds the decision to stage digest, resolution version, claim index and parsed/source identity; it is not exposed as an API token.
