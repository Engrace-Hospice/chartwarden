# Worker concurrency certification

## Evidence already available

- M25 posting concurrency/cross-source live tests: 35/35 passed in the BIL-1.5B private PostgreSQL run.
- M23 response inbox real-role RLS and submission retry suites passed in BIL-1.5B; current serial M23/M25 RLS reruns passed 13/13 and 16/16.
- Focused ERA delivery regression tests passed 5/5, including preserving terminal delivery state and finalizing tenant staging after a central terminal receipt.
- The latest source fixes register the recovery job before store composition, use separate read-only metrics job IDs, and do not reset account cursors.

## Not certified

No two-process test with simultaneous leases and a deliberately stale fence was run for response capture or ERA discovery. No crash/restart was injected after inbox persistence, after tenant-stage commit, or between central delivery receipt and tenant-finalization commit against PostgreSQL. The targeted delivery test is not a replacement for the requested database crash test.

The authenticated recovery route test injects a trusted synthetic `request.context` and mocks the durable service. It verifies the route guards and server-derived actor contract, including tenant-admin denial, but is not a full authentication-plugin → route → PostgreSQL audit integration. Do not claim that full operator recovery authorization has been live-certified.

The production source remains disabled by default; no worker was activated in this phase.
