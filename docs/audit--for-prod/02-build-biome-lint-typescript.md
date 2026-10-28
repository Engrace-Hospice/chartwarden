# 02 — Build, Biome, lint, and TypeScript

## Reproducible outcomes

| Check | Outcome |
|---|---|
| Frozen dependency install | PASS — 567 installs, 683 packages checked, lock unchanged |
| TypeScript | PASS — production references and both test programs |
| Root build | PASS |
| Web/admin/portal production builds | PASS, with web/admin chunk warnings |
| Biome/lint | FAIL — 1,108 errors, 5 warnings, 963 files |
| Architecture fitness | PASS — all 43 invoked gates |
| Non-live Vitest | PASS — 1,924 files/27,236 tests passed; 486 files/6,822 tests skipped; 15 todo |

Biome breakdown is preserved in `evidence/automated-verification-2026-10-27.md`. The largest groups
are 590 import-order and 456 formatting errors, but 23 semantic-accessibility, 9 exhaustive-hook,
4 array-index-key, and other correctness/suspicious diagnostics are mixed into that noise. This is
`CW-QA-0003`; formatting debt is not itself treated as a functional defect.

The TypeScript programs enable strict checking through the project graph, but successful typecheck
does not validate JSON, database content, external payloads, authorization, or date-range semantics.
Targeted searches covered explicit `any`, assertions, ignores/expect-errors, non-null assertions,
and external parsing; no separate confirmed defect was retained without a reachable runtime effect.

Bundle results: web 562.90 kB raw/171.02 kB gzip and admin 590.99/171.92 exceeded the configured
350 kB raw budgets (`CW-QA-0005`). Portal built 395.08/120.21, but its checker reported zero and
passed (`CW-QA-0004`).

Limitations: no production sourcemap disclosure test, browser execution, or cold-device timing was
available. Build output proves compilation and asset emission only.
