# BIL-2.4 — Medicaid preparation and safe routing

## Result

M24 remains the owner of Medicaid claims and state-specific workflow. This change makes route uncertainty explicit in the API and Billing UI, prevents caller-selected MCO/channel routing, and blocks all currently unverified electronic destinations before a submission row or outbox action is created. The worker independently rechecks route readiness before decrypting partner credentials or invoking an adapter.

Existing preparation, line assembly, validation, eligibility, claim history, and state adapter contracts are reused. No state transport was newly certified or activated. No migration was needed. Existing uncommitted BIL-2.1/2.2/2.3 changes in this worktree are outside the BIL-2.4 scope and were preserved.

## High-confidence disposition

- **Local preparation and existing validation:** available, subject to their existing reader/catalog dependencies and validation findings.
- **State/program attribution:** an MCO identifier is shown as an unverified assignment; missing MCO does not imply FFS. The repository has no authoritative M40 state Medicaid MCO catalog or coverage-to-program mapping to prove either route.
- **Electronic submission:** blocked for all current state/program combinations. Oregon's registered adapter is a local JSON reference envelope, not a certified OHA 837I transport; WA/ID/CA/NV adapters are deny stubs.
- **Claim.MD:** not used for M24 routing.

See [state capability matrix](STATE_AND_PROGRAM_CAPABILITIES.md), [requirements evidence](STATE_EDI_REQUIREMENTS.md), and [remaining external dependencies](EXTERNAL_DEPENDENCIES.md).

## Changes

Server-derived `routeReadiness` is added to claim reads. The M24 PATCH contract no longer accepts `mcoId`. Submission API and worker paths fail closed. The M24 screens now show “Program unresolved” or an explicitly unverified MCO assignment instead of inferring FFS from a null MCO.

## Validation

Focused results are recorded in [TEST_RESULTS.md](TEST_RESULTS.md). Static checks completed are reported separately from checks still running or blocked. Nothing in this phase activates state transmission.
