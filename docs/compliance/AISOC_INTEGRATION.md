# AiSOC alongside ChartWarden — integration plan

Status: **plan**. This document closes nothing until the work below lands. It is the evidence pointer
for control **CW-MON-01** (`compliance/controls.yaml`), which stays `gap` until detections and alert
routing are proven.

## What AiSOC is, and isn't, for us

[AiSOC](https://github.com/beenuar/AiSOC) (v20.1.0, MIT, one maintainer) is a self-hosted **runtime
security operations center**. It ingests events, normalizes them to OCSF, runs detection rules,
correlates alerts into incidents, has a local LLM triage them, and gates any response on human
approval. It ships **nothing for Claude Code**: no skills, hooks or plugin. So it does not overlap with
ECC or with `scripts/harness/`:

| Layer | Tool | Covers |
|---|---|---|
| Dev time (how code is written) | ECC + `.claude/` harness | TDD, review, PHI/secret guards, change-scoped gates |
| Build time (what reaches main) | `arch:fitness`, CI, pre-commit/pre-push | Tenancy, audit, ABAC, scanners, signed images |
| **Run time (what happens in production)** | **AiSOC** | Reviewing audit and auth events, detections, incidents (HIPAA §164.308(a)(1)(ii)(D), (a)(5)(ii)(C); SOC 2 CC7.2–CC7.3) |

That runtime row is the gap ChartWarden has today. M4 records audit events, but nothing reviews them.

## Ground rules (HIPAA)

1. **AiSOC sits inside the BAA boundary.** Run it on the OVH infrastructure, not a laptop or a third-party
   host. It will see usernames, IPs and resource ids, and possibly patient ids in audit events, so it
   is in scope.
2. **Send security metadata, not PHI.** Events carry actor, action, resource *type* and *id*, tenant,
   outcome, IP and user agent. They never carry names, note text, diagnoses or SSN/MBI. Apply the
   M4 redaction denylist before export (`arch:audit-denylist-sync`).
3. **Local model only.** Keep the bundled Ollama model and configure no hosted provider. AiSOC's
   egress pseudonymization has no PHI patterns, and its LiteLLM gateway is treated as "local", which
   skips pseudonymization. If a hosted model is ever enabled, set `AISOC_PSEUDONYMIZE_EGRESS=always`.
   Even then it is a new PHI vendor needing a BAA (CW-BA-01).
4. **Its compliance dashboards are not our evidence.** Several SOC 2 controls in AiSOC's compliance
   view are marked "collected" unconditionally, and they describe the SOC tool itself. Our evidence stays
   `compliance/controls.yaml`.
5. **Treat it as a dependency under review.** The project went through eight major versions in about three
   weeks. Pin the image digest, read the changelog before upgrading, and put its images through the
   same Trivy policy as ours.

## Ports (local evaluation next to the ChartWarden stack)

AiSOC's resolver already moves its services off ChartWarden's ports, so both stacks run side by
side with no collisions:

| Service | ChartWarden | AiSOC |
|---|---|---|
| Web / console | 3000 (web), 3001 (admin) | **15000** |
| Postgres | 5432 | **15432** |
| Redis | 6379 | **15379** |
| Object storage | 9000–9001 (MinIO) | — |
| Ollama | — | **15434** |

Two consequences for the agent harness:

- Live suites need a **private** Postgres on its own port. That port must not be 5432 (the shared
  cluster, whose roles get dropped) and must not be 15432 (AiSOC's database). `.claude/rules/phi-and-secrets.md` says so.
- The PreToolUse guard treats `localhost:*` as local, so an agent may query AiSOC's local API or
  database during evaluation. Use synthetic or demo data there (`make demo`), never a copy of
  production events.

## Phases

**Phase 0: evaluate locally (½ day).** Run `make up && make demo` in the AiSOC checkout, then
`make doctor`. Confirm the ports above, and that `make smoke` passes. Don't use ChartWarden data yet.

**Phase 1: ship events (2–3 days, ChartWarden side).**
- Emit an OCSF **API Activity (class 6003)** event per M4 audit row and per auth event: login success
  and failure, MFA challenge, step-up, break-glass grant, auditor activation, export, bulk read. Model
  it on AiSOC's `ai-runtime.yaml` mapping, not `generic-json.yaml`, which files everything as a
  Security Finding. Write it as `ehr-audit.yaml`.
- Transport: an outbox consumer posting to AiSOC `POST /v1/ingest/batch` with a Bearer
  `connector-push` token from OpenBao. Prefer that over `/v1/inbox/{token}`, which puts the token in the URL
  and stores it in plaintext. The consumer gets its own live suite proving no denylisted field
  leaves (the repo's standing rule).
- Also forward host and edge logs (Pangolin access logs, `auditd`/sshd from the OVH hosts, the GitHub
  org audit log through AiSOC's `github-audit` plugin).

**Phase 2: detections (2 days).** Add tenant rules for what an EHR needs:
- Repeated failed logins per account and per IP (`wd-brute-force-login` shape, re-keyed to our events).
- Impossible travel. AiSOC needs `geo_distance_km` and `minutes_between` **on the event**, and nothing in
  AiSOC computes them, so compute them in the exporter.
- Bulk PHI access: one actor reading more than N distinct patients in M minutes (`wd-high-rate-activity-per-actor`).
- Break-glass use, auditor-session activation, and tenant export approval. All are always-alert,
  low-volume events.
- Off-hours admin actions and new platform-role grants.
- Postgres: AiSOC ships **no** Postgres rules. Add pgaudit-based ones (role changes, `ALTER POLICY`,
  `DISABLE ROW LEVEL SECURITY`).

Each rule ships with a positive and a negative fixture (AiSOC's `detections/community/` convention).

**Phase 3: close CW-MON-01.** Route alerts to the on-call path, record a weekly review, and run
one tabletop incident (this also feeds CW-IR-01). Then flip CW-MON-01 to `implemented`, with evidence
pointing at the exporter's live suite and the detection fixtures.

## Optional: AiSOC's MCP server in Claude Code

`services/mcp` exposes 19 tools, read-only except `aisoc_run_investigation`, authorized by a
per-tenant `AISOC_API_KEY`. Use it for incident-response sessions, not everyday coding. Add it to a
**personal** `.mcp.json`, not the repo's: alert payloads can contain identifiers, and a coding session
shouldn't pull them in by default. Use the HTTP transport, because the stdio transport does not audit
read calls.

## Patterns borrowed from AiSOC's own CI

These are worth copying later (tracked under CW-VM-01):
- Pinned, checksummed Semgrep rule packs with a findings ratchet (`check_scanner_ratchet.py`).
- A route-tenant-scope gate: no route may accept a caller-supplied tenant id.
- A claim-to-gate matrix. `compliance/controls.yaml` + `arch:compliance` is our version of it.
