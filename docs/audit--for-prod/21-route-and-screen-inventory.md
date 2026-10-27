# 21 — Route and screen inventory

The complete machine-generated screen inventory is `audit/ui-parity/ui-parity.json`; its human view
is `audit/ui-parity/UI_PARITY.md`. It is incorporated by reference rather than copied, preventing a
second stale route list. At this baseline it contains 381 wired screens:

| App | Screens | Runtime audit |
|---|---:|---|
| web | 324 | Static inventory; browser blocked |
| admin | 39 | Static inventory; browser blocked |
| portal | 18 | Static inventory; browser blocked |

Each generated entry supplies app, module, stable screen id, path, and required permission. Component
ownership is resolved by the module `screens.ts` registry. Data dependencies/loading/error behavior
were reviewed at the critical workflows and otherwise remain source-trace-only; a complete runtime
response matrix was not fabricated.

Generated E2E coverage: 211 statically routable web screens, 26 reached by named E2E navigation and
199 reached by the axe walker. Not measured: 116 dynamic web routes and 47 admin/portal routes.
`audit/e2e-coverage/E2E_COVERAGE.md` provides the complete per-screen zero-coverage lists.

Authorization metadata is declarative navigation information, not server authorization proof. The
backend permission/ABAC/RLS layers remain authoritative.
