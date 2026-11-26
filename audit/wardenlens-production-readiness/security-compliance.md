# Security and compliance assessment

| Control | Result | Evidence |
|---|---|---|
| Synthetic data only | PASS | Repository fixture is explicitly fictional; no real patient data used. |
| Tenant isolation | PASS | Dedicated synthetic org; F236/F237 ran on fresh disposable clusters; no shared live suite target. |
| Safety hooks | PASS | Initial refusal was honored. No hook was disabled; the replacement runner proves target identity before destructive suite setup. |
| PHI at rest | PASS | 3/3 candidate values encrypted; 0 plaintext candidate values; AI prompt/response ledger encrypted. |
| Governed model routing | PASS | Exact backend/model pins, capability keys, token counts, durations, opt-in, templates, and budgets recorded. |
| Human-in-the-loop | PASS | Identity hold and three per-field decisions enforced before completion. |
| Part 2 | PASS | Real negative detector run plus positive F237 live controls; no claim of positive real-document detection. |
| Authorization | PASS | Production routes and administrator/RN credential gates used; no direct clinical row insertion. |
| Audit and AI ledgers | PASS | Intake audit events and encrypted AI invocation evidence persisted. |
| Actual writeback provenance | BLOCKED | No candidate was eligible for writeback, so no provenance row could be demonstrated. |
| Admission activation | PASS | Conversion created `pending` admission with 9 blockers; no automatic service activation. |
| Log/metric credential safety | FAIL | A Better Auth failure log exposed a raw session token in Drizzle parameters. This branch disables the unsafe duplicate logger; runtime revalidation is still required. Queue metrics themselves use bounded queue/state labels. |

The direct database operations were limited to isolated environment setup, credential reset for a
synthetic test identity, governance catalog seeding, and read-only evidence queries. Clinical workflow
mutations used authenticated production HTTP routes.

The exposed token belonged only to the disposable synthetic environment, which will be destroyed. It
is still treated as a security defect because the same logging path exists in production code.

