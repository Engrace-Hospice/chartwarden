# Cursor and request-budget visibility

The platform response exposes only whether a cursor record exists. It never exposes the cursor token. The schema does not durably record a cursor-advance timestamp independently from attempts, so no such timestamp is claimed.

Claim.MD request limits are enforced by the existing counter adapter, but observed usage/remaining budget is not a durable reader contract. The API returns `NO_DURABLE_REQUEST_BUDGET_OBSERVATION` rather than estimating a value.
