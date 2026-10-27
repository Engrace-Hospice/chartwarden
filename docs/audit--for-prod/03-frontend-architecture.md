# 03 — Frontend architecture

The three React/Vite applications register 381 screens: web 324, admin 39, portal 18. Canonical
route details are in report 21 and the generated UI-parity artifact. Shared shell/list CSS follows
the repository's stated package boundary; route registration and permission metadata are centrally
represented.

## Findings and observations

- The Medicare assembly screen preserves its in-progress form in process memory and maps server
  errors inline, but performs no payer preflight until the final mutation (`CW-QA-0007`). Data loss
  after this rejection was not confirmed.
- Step-up flows deliberately use `sessionStorage` for some redirect-surviving drafts. The addendum
  path includes clinical free text (`CW-QA-0014`); sign-out/screen-lock global clearing is wired, so
  the finding is about plaintext browser exposure rather than absent cleanup.
- Generated coverage shows only 26/211 static web screens directly reached by named E2E specs. The
  axe walker reaches 199/211 static web routes, not dynamic routes or the other SPAs (`CW-QA-0008`).
- Web and admin eagerly load more JavaScript than their budgets. The portal checker is invalid.
- No confirmed React memory leak, cross-patient cache collision, or unsafe `dangerouslySetInnerHTML`
  exploit survived adversarial review. Textual searches alone were not promoted to defects.

## State model

Server state is generally fetched through the typed API client; local component state and an
in-memory ceremony store cover forms; session storage is reserved for redirect recovery and UI
markers. No broad query-cache layer was found whose key isolation could be verified once for every
screen. Cross-patient and cross-tenant browser-state behavior therefore remains unverified at
runtime, particularly across back navigation, refresh, and concurrent tabs.

Recommended priority: fix the payer preflight and PHI-draft design, then provision multi-app
Playwright projects before broad component refactoring. Large components alone were not classified
as defects.
