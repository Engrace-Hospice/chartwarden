---
paths:
  - "packages/auth/**"
  - "packages/audit/**"
  - "packages/tenancy/**"
  - "apps/backend/src/**/auth*/**"
  - "apps/backend/src/**/*audit*"
  - "apps/backend/src/modules/02-*/**"
  - "apps/backend/src/modules/03-*/**"
  - "apps/backend/src/modules/04-*/**"
---
# Auth, authorization and audit (loaded only for these paths)

These modules carry HIPAA §164.312(a), (b) and (d), CW-AC-*, CW-AU-* and CW-IA-* in `compliance/controls.yaml`.

- Never decide authorization from an unverified header (`arch:request-header-auth`). Use
  `requireStepUp` / `stepUpFreshFor`.
- Every `requireAbac(_, name)` names a registered predicate. A new predicate is composed somewhere or
  goes in the reasoned allowlist (`arch:abac-predicates`, `arch:abac-composed`).
- A read-audit config needs a `resourceIdParam`, and the live suite asserts the read event lands.
- Auditor routes are gated on the active stage. The enrolment allowlist in `authenticate.ts` changes
  only deliberately.
- Before a PR that touches these paths, run `/ecc:security-scan`, then the `compliance-reviewer`
  agent, in that order.
