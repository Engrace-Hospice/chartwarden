# Audit baseline

Captured: 2026-10-26 (America/Los_Angeles)

| Item | Observed value |
|---|---|
| Git commit | `75e53c73c32396efaaf51bf03bf9c92597831069` |
| Branch | `fix/m22-disclosure-dialog-followups` |
| Upstream relation | `origin/fix/m22-disclosure-dialog-followups`, local branch reported 199 commits ahead |
| Operating system | macOS 26.6.2 (Darwin 25.6.0, arm64) |
| Bun | 1.3.5 |
| Default Node.js | 25.8.0 |
| Default npm | 11.11.0 |
| Repository-pinned Node.js | `.nvmrc`: 22; executed as v22.15.1 |
| Repository-pinned npm | 11.4.1 |
| Declared Bun engine | `>=1.3.0` |
| Declared Node tooling version | `.nvmrc` pins Node 22; automated verification uses the installed v22.15.1 runtime |
| Dependencies | `bun install --frozen-lockfile --ignore-scripts` passed without changing the lockfile |
| Secret handling | Only environment-variable names were inventoried; values were redacted and are not stored |

## Pre-existing working-tree state

The following was reported by `git status --short --branch` before any audit artifact was created:

```text
## fix/m22-disclosure-dialog-followups...origin/fix/m22-disclosure-dialog-followups [ahead 199]
 M apps/backend/src/index.ts
 M docs/design/chartwarden-P0-foundation.pen
 M packages/auth/src/identity/auth.ts
 M packages/auth/src/identity/credential-admin.ts
 M packages/auth/src/identity/password-verifier.ts
 M packages/auth/src/identity/webauthn-verifier.ts
?? apps/backend/__tests__/platform-pool-guard.test.ts
?? apps/backend/src/bootstrap/platform-pool-guard.ts
?? docs/audits/frontend-browser-forensic-audit/
?? docs/design/chartwarden-NEW-live-baseline.pen
?? docs/design/exports/
?? docs/reference/cms/R5P247i.pdf
?? image/
?? jar.txt
?? rita.jar
```

These paths are user-owned audit inputs. No conclusion will attribute their state to this audit.

## Concurrent checkout change

During final report validation, the shared checkout had moved—outside this audit's writes—to commit
`ac87c7b4c7b853041e1f43d63187171f7c74ea19` on branch `fix/platform-pool-guard`. The delta included
new migrations, HOPE/billing/clearinghouse work, authentication changes, and generated reports. The
audit did not rewrite its earlier runtime results as if they had executed on that later revision.

A final non-mutating `bun run arch:fitness` on the later checkout passed all 43 gates and reported
610 migrations, 2,427 typechecked test files, 264 reachable route registrars, 486 registered live
suites represented by 489 files, 1,883/1,883 enriched OpenAPI routes, and 570 org-scoped indexed
tables. This recheck is supplemental only; it is not a substitute for rerunning the full test/live/
browser audit on the later revision.

## Environment-variable names

The process environment was inventoried with values replaced by `<redacted>`. Credential-bearing
names were present, including a third-party API-key variable; no value was read or copied. The repo
also contains a root `.env`, which will not be printed or added to audit artifacts.

