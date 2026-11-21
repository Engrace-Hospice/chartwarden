# Episode Alert clearinghouse adapter (#758, ADR-0053 / ADR-0103)

## Current status — 2026-11-18 (EPA-755-L3)

The original 2026-10-25 snapshot below is preserved as historical context; it has been superseded by #812 and EPA-755-L1/L3.
Current code has a separate fail-closed `ELIGIBILITY_VENDOR` registry, but no backend consumer. The eligibility environment
factory refuses the unverified wire/destination; test fixtures use `LocalFakeHttpClient` only. The DDE adapter remains a
fail-closed skeleton and is not registered in the backend composition root. Claim status and remittance methods remain
`CH_NOT_WIRED`. M23 eligibility remains on `M23_HETS_TRANSPORT`; manual DDE remains the operational baseline.

Public product pages advertise capabilities but do not establish the API schema, account authorization, test isolation, DDE
write support, or individual operator attribution. ADR-0103 D2 is a proposed platform credential model, not an approved account
arrangement. CMS requires an active HETS relationship for each NPI submitted through a third-party vendor since 2026-05-11.
Oregon HH+H is J6; current CMS sources identify Wellpoint Federal (formerly NGS) effective 2026-04-01. See
[`EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md`](../audits/clearinghouse-integration/EPISODE_ALERT_ARCHITECTURE_AND_EVIDENCE_20261118.md)
for reviewed sources, issue reconciliation, architecture options and blockers. Prepared questions are in
[`EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md`](../audits/clearinghouse-integration/EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md)
and have not been sent.

## Historical implementation snapshot — 2026-10-25

Statements below reflect the original implementation point. In particular, references to `allowTestUsage`, lack of an
eligibility registry, and the initial environment seam were superseded by later safety work and #812.

- **Built but not activated:** eligibility-only plumbing (`packages/x12-837-client/src/clearinghouse/episode-alert-transport.ts`, PR #769).
  The path, `Authorization` scheme, request body, guessed `EligibilityResponse` root and XML element names remain UNVERIFIED.
  The environment factory now refuses to bind until the wire contract and an exact approved API origin are reviewed in code;
  direct production calls return `CH_NOT_WIRED` before global `fetch`. M23 remains on `M23_HETS_TRANSPORT`.
- **Local response safety:** XML fixtures are parsed structurally with `saxes`, DTDs are rejected, nesting/node counts and input
  bytes are bounded, and duplicate, contradictory, malformed or unsupported fields never become positive eligibility. The
  guessed Part A fixture mapping is local test evidence only, not a vendor or hospice eligibility result. Response bodies are
  streamed through the shared byte-bounded reader; oversized, truncated and unreadable bodies degrade without exposing content.
- **Test isolation:** ordinary adapter construction has no injectable `fetch` or `allowTestUsage` switch. Test usage is refused
  unless a `LocalFakeHttpClient` is provided; that test-only client returns scripted `Response` objects and has no socket or
  global-fetch implementation. Environment variables cannot enable the fake path or vendor wire.
- **Claim status and remits stay `CH_NOT_WIRED`.** Episode Alert lists them publicly but publishes no request or response
  shape; the guide is given after signup. Inventing one would be a fabricated contract. What a trial must capture is in
  `docs/audits/clearinghouse-integration/EPISODE_ALERT_TRIAL_CAPTURE_RUNBOOK_20261025.md`.
- **Binding finding (review of 0882c4eb8, H1):** `CLEARINGHOUSE_VENDOR` is platform-wide and routes the M23 submit workers
  and acknowledgment crons, so an eligibility-only adapter bound there would stop claim submission. `transport-registry.ts`
  omits `episode_alert`; the separate `ELIGIBILITY_VENDOR` setting (`eligibility-vendor-registry.ts`, values `episode_alert`
  or `in_memory`, `in_memory` refused in production, submission vendors refused) binds it fail-closed.
- **Open:** no backend consumer calls `bindEligibilityTransport` yet; `ELIGIBILITY_VENDOR` is a registry seam, not an active
  backend binding. M23 Medicare eligibility still goes through
  `M23_HETS_TRANSPORT`. `ClearinghouseVendor` has no db/types/manifest mirror, so there is nothing to sync there.

## Safety and qualification update — 2026-11-18 (EPA-755-L1)

The Episode Alert DDE adapter remains an unverified skeleton. `EA_DDE_WIRE` is frozen with `verified: false`; the environment
factory rejects binding without both a verified wire and a source-approved API origin. No environment Boolean, trial key or
test usage flag can activate it. The contract test no longer reads credentials from process environment and is statically
skipped until a reviewed vendor contract and isolated test environment exist. Local plumbing tests use only
`LocalFakeHttpClient`; they do not qualify Episode Alert. No vendor call or real data was used in this lot.
