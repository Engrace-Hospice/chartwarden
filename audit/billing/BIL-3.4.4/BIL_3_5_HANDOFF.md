# BIL-3.5 Handoff

Use synthetic stages and mocked external transport to validate the integrated ERA capture → ownership → matching → financial review → plan → approval → controlled execution → downstream outbox-consumer path. Keep the production gate off and test unsupported ERA shapes as held outcomes.

Before any activation discussion, independently certify real payer/account mapping, cross-source duplicate identity, operational recovery, downstream consumer behavior under deployment/restart, approval-role assignment, and production migration/deployment sequencing. Do not treat the successful M25 commit as bank settlement or authorize automatic posting.
