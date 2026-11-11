# Remaining blockers

- The HTTP tests use the repository's synthetic authenticated test adapter, not an external deployment IdP; production IdP certification remains separate.
- The M41 caseload reader is bounded to 500 candidate submissions per request. Repeated keyset pages continue the bounded scan; no total backlog count is claimed.
- Repository-wide `tsconfig.tests.json` typechecking did not return a final status in this run. Application TypeScript project builds completed, live tests and lint passed, but test source typechecking remains unverified.
- M24 still has no authoritative durable electronic in-doubt transport contract, so no M24 uncertain item is synthesized.
- Source-level counts remain lower bounds rather than exact total queue counts.
