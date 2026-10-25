# Stedi sandbox contract run: results (TEMPLATE, copy per run)

Copy to `STEDI_SANDBOX_RESULTS_<YYYYMMDD>.md` and fill in. Synthetic data only; no key, no response body, no PHI.
Runbook: [`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md).

- **Run date / operator:**
- **Commit (git rev-parse --short HEAD):**
- **Account type** (production account with test key / sandbox): 
- **Stedi written answers on file** (Q14, Q32, Q16, Q17; link or date): 
- **`CLEARINGHOUSE_VENDOR` in the shell** (must be unset or `in_memory`): 

## Step results (paste `STEDI_CONTRACT_RESULTS_FILE`)

| Step | ok | Degraded code | Replayed | As expected? | Note |
|---|---|---|---|---|---|
| claim | | | | | |
| claim-replay | | | | | |
| claim-conflict | | | | | |
| noe | | | | | |
| production-isa15-refused | | | | | |
| adjustment-refused | | | | | |

## Observations to carry into `STEDI_TRANSPORT_CONTRACT_20261011.md` (mark observed or still unknown)

| Item | Observed | Date |
|---|---|---|
| Success body shape / vendor id field | | |
| Initial 277CA in the 200 body or later | | |
| Idempotency replay by Stedi (same key, same body) | | |
| Reused key with a different body (status) | | |
| `Authorization` bare key or `Key <key>` | | |
| Test claim visible via polling / report fetch | | |
| Stedi Test Payer 835 (needs production enrollment; separate step) | | |

## Decisions this run supports (fill after Stedi's written answers)

| Question | Stedi's written answer (link/date) | Effect |
|---|---|---|
| Q14 test claims | | |
| Q32 reseller account model (ADR-0053 D3) | | |
| Q16 enrollment | | |
| Q17 / Q28 frequency 7/8 | | |

Live sending remained disabled: yes / no (explain).
