# Cumulative Billing Regressions

Fresh run of `scripts/test-m25-835-ingestion-private.sh` passed:

| Suite | Result |
|---|---:|
| `m25-835-ingestion.live.test.ts` | 50/50 |
| `m25-835-golden.live.test.ts` | 21/21 |
| `f172-m24-remittance-feedback.live.test.ts` | 7/7 |
| `gap-038-cap-day-backfill.live.test.ts` | 4/4 |
| `m25-clearinghouse-pull.test.ts` | 15/15 |

Total: 97 tests passed across five suites. These cover the new M23-to-M25 read/review path, existing M41 controlled posting and duplicate safeguards, legacy/golden remittance processing, M23/M24 feedback, M26 CAP consumers and synthetic pull behavior. No live transport was used.

Focused nonlive checks: M25 web DOM test **11/11**; M25 backend review/financial assessment/policy tests **29/29**. OpenAPI emit, client generation and client consistency check passed. `bun run build` and final architecture checks are reported in the phase result; previous BIL-4.4 counts are not presented as rerun evidence.
