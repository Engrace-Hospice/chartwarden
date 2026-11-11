# Static checks and lint

- `bun run openapi:emit` and `bun run client:gen`: PASS.
- `bun run openapi:check` and `bun run client:check`: PASS.
- `bun run build`: PASS, all 13 TypeScript project batches.
- Affected Node test-source TypeScript check (temporary focused config for M25 ingestion and M41 route suites): PASS.
- `bunx tsc -p tsconfig.tests.dom.json --pretty`: PASS.
- M41 claim detail and Billing Operations DOM tests: PASS, 21/21.
- Targeted Biome check on affected backend source, schemas and UI: PASS (13 files). `bun run lint` remains FAIL due formatting-only changes in the already-dirty M41 live investigation lifecycle test from prior BIL-5.2B.1 work; the live-suite-specific lint command was refused by the repository hook, and the unrelated formatting was not rewritten.
- Full Node test-source program remains unverified: default heap OOMed and the 8 GB attempt was interrupted; changed live suites have a passing focused check.
- `git diff --check`: PASS. `arch:tenancy`, `arch:tables`, `arch:migration-numbering`, and `arch:openapi-provenance`: PASS.

No aggregate `bun run lint` PASS is claimed.
