# Raw sweep rows (exported from browser sessionStorage, page-text snippets removed)
Row: `p` requested path, `at` landed path, `h1`, `len` text length, `nApi` API calls, `bad` 4xx/5xx `[status,url]`, `deny` keyword heuristic (false positives; not coverage), `ts`.
Valid: administrator, clinician, orgadmin (178 each, corrected capture), run2-run5 (administrator, correct capture).
Partial: auditor-partial holds 60 rows only; the 178-route corrected auditor result in 00-executive-summary rests on the live run, and these rows are the retained subset.
INVALID (resource-timing buffer overflow, filter `/api/`): auditor-run1-invalid. Run1 files (clinician-run1, administrator-run1, run1-mixed) lack reliable 4xx capture; kept for traceability only.
