# WardenX history & findings log

Moved out of the repo-root `CLAUDE.md` (which had reached ~436k chars). Not instructions to agents — the historical record of audit findings (F-0xx), #248 outbox rounds and per-gate incident history. Search by module or `F-NNN`.

| File | Contents |
|---|---|
| [`status-overview.md`](./status-overview.md) | Point-in-time module-status narrative (incl. the M30 HCI resolution) and the security/compliance audit remediation summary. |
| [`m28-fhir-gateway.md`](./m28-fhir-gateway.md) | Why the gateway 404'd every read, the three stacked dead ends, `SERVED_RESOURCES`, and the §164.528 disclosure ledger. |
| [`m23-claim-assembly-seams.md`](./m23-claim-assembly-seams.md) | F-119, F-121–F-128, F-209, F-210, F-211, F-212, F-213 and F-214: binding the `ClaimAssemblySeams` readers across M6/M8/M18/M38/M40, the Q-code defect, M25's 835 pipeline scoping, the tenant-entered hospice rate table (F-210), the tenant-entered wage index and CMS labor-share/hourly-CHC payment math (F-211), the append-only sequestration policy (F-212) and place of service via M5 residences + M40 facility kinds (F-213) and the 42 CFR Part 2 consent gate on claim diagnoses (F-214). |
| [`module-findings.md`](./module-findings.md) | F-112 (M8 Layer-3 gate), F-114 (#106 E2E/a11y), F-116 (M33 seeded dashboards), F-118 (M20 SOS escalation caller), F-217 (M6 F2F/CTI adequacy predicate + recert activation gate), F-223 (M6 binds `m11.order.recertification_signed`). |
| [`outbox-248-triage.md`](./outbox-248-triage.md) | Per-group, per-event checks of `outbox-deferred-consumers.ts`: F-115, F-117, F-129–F-149 (decide who really consumes each event; seam-pull vs push). |
| [`outbox-248-builds.md`](./outbox-248-builds.md) | F-120, F-150–F-171 and F-205–F-216: building real bindings, verification catches, coordination hazards, and the running pair count. |
| [`gates-tenancy-and-database.md`](./gates-tenancy-and-database.md) | Rationale and incident history for `check-tenancy` and `check-migration-numbering`, plus the kit overview. |
| [`gates-typecheck-and-hygiene.md`](./gates-typecheck-and-hygiene.md) | Rationale for `check-test-typecheck-coverage`, `check-manifest-mirror`, `check-merge-artifacts`, `check-live-suite-coverage`. |
| [`gates-authz-and-routes.md`](./gates-authz-and-routes.md) | Rationale for `check-abac-predicates` (incl. F-092/F-093/F-096/F-097), `check-request-header-auth`, `check-context-attributes` (F-029/F-030), `check-route-reachability` (F-090/F-091). |
| [`gates-outbox-bindings.md`](./gates-outbox-bindings.md) | Rationale and incident history for `check-outbox-bindings` (rules 1–6, F-020/F-043/F-094/F-095, and the M19/M20/M14/M15/M16/M23/M27/M36 binding findings). |
| [`gates-docs-and-openapi.md`](./gates-docs-and-openapi.md) | Rationale for the architecture/module/ADR doc gates, status matrix, OpenAPI provenance/coverage, UI parity and frame fidelity. |
