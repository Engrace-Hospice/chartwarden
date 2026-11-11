---
name: soc2-evidence
description: Collect and refresh audit evidence for ChartWarden's HIPAA / SOC 2 control register (compliance/controls.yaml) — what each control's proof is, how to regenerate it, and how to close a gap row. Use when preparing for an audit, an observation window, a security questionnaire, or when asked "are we compliant with X".
disable-model-invocation: true
---
# Evidence collection

`compliance/controls.yaml` is the source of truth. `bun run arch:compliance` keeps every row's
evidence pointer valid. This skill turns those pointers into an auditor-ready packet.

1. Run `bun run arch:compliance` and fix any red rows first.
2. For each control, collect:
   - `script:` evidence comes from the latest **CI run on main** that executed it (link the run). Don't
     re-run it locally and call that evidence. Live suites only count from CI.
   - `ci:` evidence means the workflow file plus a recent run URL.
   - `file:` evidence means the file at the audited commit SHA.
   - Release evidence means the cosign signature and SPDX SBOM attestations on the deployed image
     digests (deploy.yml), and the Trivy result.
3. Write `audit/evidence/<YYYY-MM-DD>/INDEX.md` with columns control id, criterion, evidence links,
   commit SHA and collected-by. Don't copy logs that contain PHI into it.
4. For `partial` and `gap` rows, report them honestly with their reason and review date. A SOC 2
   auditor will find them anyway. Closing one means landing the automated proof and flipping the status
   in the same PR.
5. Remember what this repo can't prove: policies, workforce training, the signed risk analysis, BAAs
   on file, and access reviews of production systems. List those as "administrative evidence held
   outside the repo".

Never state that ChartWarden "is HIPAA compliant" or "is SOC 2 certified". Say which controls are
implemented and evidenced, and which are open.
