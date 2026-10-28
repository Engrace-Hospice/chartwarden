# 24 — Dependency and supply chain

`bun install --frozen-lockfile --ignore-scripts` passed without changing the lock. `bun run
audit:deps` reported no high-or-higher match and `bun audit --json` returned an empty advisory
object. Release builds include Trivy, SBOM generation, and cosign signing/verification for the three
application images.

Findings:

- `CW-QA-0009`: the Python worker ignores `uv.lock`, resolves broad live ranges, and overrides
  incompatible Pillow bounds with `--no-deps`.
- `CW-QA-0010`: its pytest suite is not mandatory CI.
- `CW-QA-0011`: Postgres, Valkey, MinIO, and ClamAV are tag-pinned rather than digest-pinned.
- `CW-QA-0002`: signed release artifacts can still bypass full behavioral CI.

No package was called vulnerable merely for age. Complete license compatibility, maintainer health,
typosquatting/dependency-confusion analysis, registry provenance attestations, and install-script
sandboxing were not fully verified. The Bun install suppressed lifecycle scripts for audit safety;
that does not prove the normal install path is harmless.
