# MBI disclosure and security

M5's closed disclosure-purpose allowlist now includes `claim_837i_preview`. The preview helper forces that purpose server-side; the ordinary submit loader continues to default to `claim_837i_submission`. M5 writes the PHI access audit at unlock and refuses the MBI read if the audit cannot be committed.

The preview projection does not contain subscriber identity, provider tax ID, parties, or the raw X12 string. Its failure projection contains field names and gap reasons only. The route remains tenant/provider/caseload authorized. Preview performs no claim submission, payment, or financial mutation.

Focused loader test asserts the distinct purpose, actor attribution, and absence of MBI/X12 in the returned object. Runtime RLS and HTTP authorization tests were not executed as part of this focused change; see `TEST_RESULTS.md`.
