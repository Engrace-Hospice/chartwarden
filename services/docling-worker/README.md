# docling-worker

DocLens stage 2 (FastAPI + Docling parse/OCR, CPU-only). Tests: `pytest` (Docling is never imported by them).

## Dependencies are locked (#853)

`uv.lock` is committed and is the **exact** reviewed Python graph. The image (`Dockerfile`) copies
`pyproject.toml` + `uv.lock` and runs `uv sync --frozen --no-dev --extra docling`, then `uv pip check`
(the build fails on an incompatible graph). uv verifies the hashes recorded in the lock. torch/torchvision
come from the PyTorch CPU index (`[tool.uv.sources]`), so no CUDA wheels. The lock targets Linux
(x86_64, aarch64) only. The base image and uv are pinned by digest.

`bun run arch:docling-lock` (part of `arch:fitness`) runs `uv lock --check` and fails when `uv.lock` is stale vs
`pyproject.toml`.

Security floors (pillow >= 13, certifi, filelock, setuptools, wheel, jaraco.context) are ordinary dependencies in
`pyproject.toml`, so the lock records them. pillow 12.x has fixable HIGH/CRITICAL CVEs. Older docling releases capped
`pillow<13`; docling >= 2.143 does not. If an upgrade re-caps it, `uv lock` fails; then add
`[tool.uv] override-dependencies = ["pillow>=13.0.0,<14"]` with a comment naming the advisory, and remove it when
upstream lifts the cap.

## Updating (cadence: monthly, and on any Trivy finding in the release or `pr-image-gate` scan)

```sh
cd services/docling-worker
uv lock --upgrade            # or --upgrade-package <name> for a targeted security bump
git diff uv.lock             # review the changed versions
docker build -t dw-test .    # runs uv pip check
docker run --rm -u root -v "$PWD/tests:/srv/tests:ro" -v "$PWD/pyproject.toml:/srv/pyproject.toml:ro" \
  -v "$PWD/uv.lock:/srv/uv.lock:ro" dw-test sh -c \
  'uv sync --frozen --no-install-project --extra docling --extra test && python -m pytest -q'
```

Commit `pyproject.toml` and `uv.lock` together. Refresh the base-image digest (`docker pull python:3.12-slim`) in the
same pass.
