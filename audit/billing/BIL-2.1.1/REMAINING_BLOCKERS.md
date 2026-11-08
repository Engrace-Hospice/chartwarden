# Remaining blockers

## P1 — Reviewed-source binding is absent

The current review is not bound to independently mutable coverage/provider/admission/rendering sources through submit and queued-worker execution. Implement a short-lived signed/opaque preview token based on canonical renderer business input, persist it on the original attempt/outbox, and revalidate immediately before send. On mismatch, hold the existing attempt with a stable stale-source code. Do not auto-reserve a second attempt.

## P1 — Verification incomplete

Backend typecheck did not finish, and the modified preparation route has no focused integration test proving tenant/provider denial, MBI audit, no raw output, or no submission side effect. Add those tests, then run architecture/tenancy and the affected M23 route/worker regressions.

## P2 — Generated client workaround remains

The web editor still casts the preparation request through `never` due the inherited generated-client type-depth issue. Replace the workaround with a typed client helper or fix the generated contract typing, and add frontend states for refresh/retry and a stale submit response once the token contract exists.

No external vendor issue was needed for this source-level preview; Claim.MD route certification and activation remain governed by BIL-1 gates.
