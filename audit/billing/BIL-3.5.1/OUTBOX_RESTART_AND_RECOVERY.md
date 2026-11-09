# Outbox restart and recovery

M25 financial rows and `m25.remittance.claim_paid` / `m25.remittance.advice_posted` events are committed in the posting transaction. An outbox row records a committed event; it does not mean a consumer finished processing or that cash settled at a bank.

The private integration test uses the real outbox dispatcher and the M41 remittance consumer. It simulates a dispatcher stop after an event is durably claimed by leaving the row `dispatching` past its visibility lease, then constructs a fresh dispatcher and verifies it reclaims the event. It also simulates the crash boundary after the M41 consumer transaction has committed but before a consumer receipt is durable: removing that receipt and retrying the stale dispatch causes the real M41 consumer to see the already-applied claim state. The claim history remains exactly one `submitted → paid` transition and the outbox records consumer receipts.

The private runner also executes the existing M23/M24 remittance-feedback and M26 CAP consumer suites against real application-role PostgreSQL. They remain separate consumer transactions; this task does not claim a process-level production restart or bank settlement certification.
