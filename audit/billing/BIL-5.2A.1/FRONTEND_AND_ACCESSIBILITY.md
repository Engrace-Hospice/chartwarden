# Frontend

The existing responsive Billing Operations worklist now loads M23/M41 in-doubt pages independently from ordinary claim pages. Items show “Submission outcome in doubt”, attempt number, safe reason and the source claim link, with copy that the request may have reached the payer. The existing provider selection, per-source continuation and mobile card layout remain in use; no retry action was added.

Focused DOM tests cover the feed-specific labels and absence of retry controls. Browser-level narrow-screen validation was not added in this increment.
