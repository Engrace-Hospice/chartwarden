# BIL-5.2A.1 — Submission-first uncertainty feeds

This increment adds owner-controlled, cursor-paginated M23 and M41 reads that begin with durable `in_doubt` submission rows. Billing Operations keeps its existing claim, Medicaid and ERA worklists and additionally consumes independent M23/M41 submission pages. These reads are informational; they do not retry or replay submissions.

The M23 query binds organization, claim/provider agreement and server-derived provider scope. The M41 query binds organization/provider, joins the owner claim and applies the existing caseload seam before returning a row. Both use bounded pages, stable timestamp/UUID ordering and lower-bound loaded counts. M24 remains without an authoritative electronic in-doubt record contract.

See [reader contracts](M23_M41_SUBMISSION_FIRST_READERS.md), [pagination](CURSOR_COUNTS_AND_WORKLIST_INTEGRATION.md), [security tests](HTTP_POSTGRESQL_RLS_PROOF.md), and [remaining blockers](REMAINING_BLOCKERS.md).
