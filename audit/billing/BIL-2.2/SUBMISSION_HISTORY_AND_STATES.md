# Submission history and states

The claim detail history remains based on the existing read route `GET /api/v1/billing/claims/:id/submissions`. Its projection now includes `dispatchState` and the constrained `dispatchReasonCode` in addition to attempt index, outcome, safe outcome reason, generated file reference, and timestamps.

The timeline labels `sending` as a send in progress and `in_doubt` as an uncertain outcome requiring reconciliation. It does not label either as payer accepted. The existing `queued` outcome is retained for schema compatibility; consumers should use dispatch state to distinguish an attempt that is queued from a committed send reservation.

No patient/claim identifiers were added to metrics. Raw X12 and raw error messages are not added to the new state fields.
