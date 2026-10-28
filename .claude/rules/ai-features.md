---
paths:
  - "packages/ai-platform/**"
  - "packages/intake-extraction/**"
  - "apps/backend/src/modules/32-*/**"
  - "services/**"
---
# AI features (loaded only for these paths)

- `docs/architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md` is authoritative: vendor BAA plus Zero Data
  Retention before any PHI-bearing call, minimum-necessary prompt content, a kill switch, and a
  human in the loop for clinical output.
- Prefer the local model path (MedGemma on the rented GPU host) for PHI. Any new external model
  endpoint is a vendor change, so update CW-BA-01 in `compliance/controls.yaml`.
- Test prompts and evals use synthetic charts only. Never paste a real note into a fixture or a
  Claude Code session to "see what the model does".
- `arch:ai-governance` and `arch:ai-messaging-readonly` must stay green. The Stop hook runs them when
  these paths change.
