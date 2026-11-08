# BIL-2.5 handoff

## Reusable work

- Server-derived route-readiness DTO and stable reason codes.
- Fail-closed submit guard and durable worker recheck.
- Existing M24 line assembly and validation.
- UI state that distinguishes unresolved program, unverified MCO assignment, and configuration-only transport.

## Required next work

Resolve the M40/M5-owned payer/program source contract before attempting any state integration. Then select one state/program vertical slice with official companion-guide version, enrolled provider entity, approved trading-partner test credentials, and state test authorization. Implement a real claim format and transport only for that verified slice, followed by test acknowledgments, correction/retry semantics, tenant/role tests, and a UI status distinction between transport receipt and adjudication.

Do not re-enable the Oregon gateway merely by setting an environment variable. Re-readiness must become true only after independent route, format, enrollment, certification, and launch evidence exists.
