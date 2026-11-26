# End-to-end intake acceptance matrix

| Stage | Result | Evidence |
|---|---|---|
| Referral creation | PASS | Production HTTP route created synthetic referral. |
| Verified upload | PASS | Presign, checksum PUT, and completion returned document/version IDs. |
| Intake batch creation | PASS | Referral-linked batch created. |
| BullMQ enqueue | PASS | Route returned 202; worker consumed deterministic batch job. |
| Worker execution | PASS | One-page run reached `extraction_complete` in 40.9 seconds. |
| Docling parse/render | PASS | One-page parse and workspace page render path succeeded; independent 21-page parse/render also returned 21 pages before the later constrained-stack failure. |
| Classification | PASS | Real governed classifier completed and classification persisted. |
| Structured extraction | PASS | Real governed extractor completed. |
| Candidate persistence | PASS | 3 encrypted candidates; 0 plaintext candidate values. |
| Patient identity verification | PASS | Completion first failed `IDENTITY_UNRESOLVED`; synthetic reviewer resolved identity; batch became `match`. |
| Part 2/SUD safeguards | PASS | Governed detector ran; positive safeguard cases passed in F237. Real document was negative. |
| Human review | PASS | 3/3 per-field decisions persisted across authenticated requests. |
| Approved chart writeback | BLOCKED | All real candidates were medium risk; safety rule excluded them, leaving 0 provenance/commit events. |
| Audit trail | PASS | Intake batch/job/review/workspace read/write audit events persisted; AI disclosure ledger persisted encrypted payloads and model/token evidence. |
| Referral qualification | PASS | Referral reached `qualified`. |
| Admission conversion | PASS | Referral reached `converted`; admission created in `pending`. |
| Admission requirements | PASS | Readiness returned 9 blockers and `canActivate=false`; conversion did not activate services. |
| Full 21-page packet (isolated dev stack) | FAIL | Docling container exited 137; queue exhausted 3 attempts; no classification/job rows persisted. |
| Full 21-page packet (production 2 GiB/2 CPU envelope) | BLOCKED | Exact production resource envelope was not exercised. |

