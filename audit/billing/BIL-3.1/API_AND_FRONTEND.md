# API and frontend

Existing list/detail APIs were extended; no parallel inbox was introduced. OpenAPI and generated client were regenerated. The Revenue Cycle screen submits payer/date/status filters to the server, resets paging on filter changes, supports reset/refresh/continued search, and displays durable processing history with partial/unavailable messaging. Detail fetch errors have a retry action. No payment, allocation, reconciliation, reversal or posting control exists.
