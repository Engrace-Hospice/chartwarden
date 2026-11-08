# BIL-1.1 response capture runtime

`CLAIMMD_RESPONSE_CAPTURE_ENABLED` is exact-string opt-in and defaults off. When enabled at a worker boot, composition requires Claim.MD binding, account reference/key, test/production usage, tenant and platform DB handles, inbox keyring, shared rate limiter, registered platform job, and an operator-bootstrapped account/environment stream. Schema/stream preflight runs under audited `withPlatformContext`; the existing encrypted inbox, account reader and store are reused. The non-overlapping worker is stopped on application close.

Credentials alone do not start capture. Capture does not turn on resolver, acknowledgment dispatcher, ERA capture/delivery, or posting. No live request was made. Deployment/runtime permissions and multi-process lease/rate-limit behavior remain uncertified.
