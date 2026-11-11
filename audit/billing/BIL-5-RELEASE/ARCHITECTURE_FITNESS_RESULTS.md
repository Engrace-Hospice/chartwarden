# Architecture fitness

Final `bun run arch:fitness`: **47/49 PASS**.

Remaining gates:

- `arch:docling-lock`: `uv` 0.9.x is not installed.
- `arch:parity`: existing manifest orphans `packages/domain` and `packages/admin-ui-shell`.

Status, UI parity, OpenAPI coverage, inject coverage and design-token findings were corrected and now pass.
