# Live PostgreSQL results

## Why F236/F237 were blocked

The safety hook correctly refused a direct live-suite command because those suites reset `public` and
drop the cluster-global `chartwarden_app` role. A caller-supplied URL could target the shared Docker
cluster, so presence of a “test” variable was insufficient proof of isolation.

## Safe execution design

`bun run test:wardenlens:isolated` now:

1. Builds the repository's production PostgreSQL image.
2. Rejects `DOCKER_HOST`/TLS overrides and proves the effective Docker context uses a local Unix or
   Windows named-pipe endpoint before the first image/container mutation.
3. Creates a separate labeled container per suite with a random `127.0.0.1` port.
4. Places PGDATA on `tmpfs` with no bind mounts or named volumes.
5. Verifies image, label, port binding, filesystem type, PostgreSQL 18, database/cluster name,
   system identifier, superuser identity, `max_locks_per_transaction=1024`, and a fresh two-database
   inventory before Vitest starts.
6. Supplies a minimal child environment and rejects empty/skipped suites.
7. Removes each container, JSON report directory, and test image.

No safety hook was disabled or weakened. The wrapper execution used the explicit escalated approval
for the disposable WardenLens live validation; the runner now independently rejects remote daemons.

| Suite | Result | Tests | Isolation |
|---|---|---:|---|
| F236 DocLens intake live | PASS | 13/13, 0 skipped | Dedicated disposable cluster |
| F237 DocLens review live | PASS | 16/16, 0 skipped | Different disposable cluster |

Post-run checks found no labeled test containers or `chartwarden-postgres:wardenlens-test-*` image.

