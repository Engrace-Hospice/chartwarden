# PHI and secrets — always on

Agents working in this repo never see real patient data or live credentials. The hooks in
`scripts/harness/` enforce most of this; these are the rules behind them.

- **Synthetic data only.** Every SSN or MBI in code, tests, fixtures, seeds, docs and commit messages
  comes from `compliance/synthetic-identifiers.json`, or is an SSN with area 000/666/9xx. Names, DOBs
  and addresses in fixtures are invented. Never copy a value out of a production log, screenshot,
  support ticket or database, even if it is "only a test".
- **No secrets in reach.** Don't read `.env*` (except `.env.example`), keys, `deploy/production/*.env*`
  or database dumps, and don't dump the environment. To learn a config's shape, read `.env.example`.
  If you truly need a value, ask the human.
- **No production access from a session.** Don't `psql` or `ssh` to non-local hosts. Live suites run
  against a private `pgvector/pgvector:pg18` container on its own port (not 5432, and not AiSOC's 15432).
- **PHI never enters logs, errors, events or AI prompts unredacted.** New log lines carry ids, not
  names. Error envelopes carry codes, not record content. Outbox payloads go through the catalog-validating
  publisher. Anything sent to an LLM follows `docs/architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md`.
- **A blocked action is information.** When `[chartwarden-harness]` denies something, fix the cause.
  Don't route around it with a different command, `--no-verify` or `SKIP_FITNESS`.
- **A changed control updates the register.** If a change adds, weakens or removes a security
  control, update its row in `compliance/controls.yaml` in the same change (that file asks for human
  approval), and say so in the PR body.
