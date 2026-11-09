# Exception and nonposting review workflow

The matching response now includes explicit exception codes/severity, a read-only balance result, line-evidence limitation, duplicate classification and `canCompleteNonpostingReview`. Exceptions include held/duplicate ERA, claim identity conflict/unresolved, balance discrepancy/unavailable, missing original service-line evidence, reversal, and unsupported adjustment group.

The existing screen offers note, follow-up, claim reviewed, ERA review completion, and reopen actions to principals with `remittance.financial_review`. Completion is an audited nonposting disposition. It cannot change stage ownership or resolve missing source evidence. A completed review is not “approved for posting.”

The reviewer reason is required. A source fingerprint includes the immutable 835 digest, ownership resolution version, reviewed item facts, and current claim-match decision revision. A changed source marks the old decision stale; a new version is required.
