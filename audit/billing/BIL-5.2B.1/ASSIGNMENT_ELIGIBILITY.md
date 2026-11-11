# Assignment eligibility

The investigator query requires provider, source module, and source submission identity. Candidates come from the existing active-member and permission query. Before being returned or assigned, each candidate is checked for active membership, `billing.operations.triage`, the relevant source read permission, provider scope, and current source-owner access. M41's owner reader applies patient caseload rules. The live suite verifies that a random ineligible membership cannot be assigned and that a caseload-revoked user cannot read or list the case.

No role grants were changed. Assignment does not grant source access. Existing permissions remain `billing.operations.read`, `.triage`, `.assign`, and `.resolve`.

The live M41 tests cover a valid assignment, idempotent retry, competing revision updates, and access revocation by caseload removal. See [test results](TEST_RESULTS.md) for executed evidence.
