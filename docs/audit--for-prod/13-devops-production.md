# 13 — DevOps and production operations

The production path includes immutable application tags resolved to digests, Trivy scans, SBOMs,
keyless cosign signing/verification, environment validation, health checks, and post-deploy smoke.
Those are meaningful controls.

They are undermined by four retained findings:

- `CW-QA-0002` — full CI verification is commented out of release/deploy.
- `CW-QA-0011` — stateful/support images use mutable tags, including MinIO `latest`.
- `CW-QA-0012` — only ClamAV has explicit CPU/memory limits on the shared host.
- `CW-QA-0017` — a failed post-migration deploy can restart old code on new schema.

Disaster recovery is a separate P1 (`CW-QA-0013`): the checked-in drill explicitly describes demo
scale and says production has no object-store backup or coordinated database/object snapshot.

Container users, exposed ports, health checks, secret templates, migration/provision flow, nginx,
and workflows were inspected. Live production permissions, secret manager, firewall, alert delivery,
log retention, host hardening, branch protection, environment approvals, backup schedules, and
restore records were inaccessible and remain unverified.
