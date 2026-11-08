# ChartWarden docling-worker — DocLens stage 2 (parse). CPU-only.
#
# Wolfi (Chainguard's minimal glibc distro) instead of Debian: the image is the one that parses uploaded documents,
# so it carries as little OS as possible. glibc matters: torch, easyocr and opencv ship manylinux (glibc) wheels
# only, so musl/Alpine is not an option. Two stages: the venv and models are built with uv on Wolfi, then copied
# into a runtime that adds only python-3.12 and the tesseract CLI (the default OCR engine, app/main.py).
# wolfi-base publishes `latest` only, so it is pinned by digest; bump the digest to pick up OS fixes.
ARG WOLFI_BASE=cgr.dev/chainguard/wolfi-base@sha256:8509ee4351a2e501b7f98201f2e2642396e82020c61a589cacdcfe74b9de46c1

FROM ${WOLFI_BASE} AS build
RUN apk add --no-cache python-3.12
WORKDIR /srv
# #853 — the Python graph is exactly uv.lock (hashes verified by uv), installed with `--frozen` so a stale lock
# fails the build instead of silently re-resolving. The lock is CPU-only (torch/torchvision come from the PyTorch
# CPU index, see [tool.uv.sources]) and floors pillow at 13 (see pyproject.toml), so there is no
# `--no-deps` step. Update procedure and cadence: README.md.
# uv 0.9.10 (verified: `uv --version` on this digest); keep the ci.yml pin in step.
COPY --from=ghcr.io/astral-sh/uv@sha256:29bd45092ea8902c0bbb7f0a338f0494a382b1f4b18355df5be270ade679ff1d /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy UV_COMPILE_BYTECODE=0 UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/bin/python3.12 PATH=/opt/venv/bin:$PATH \
    HF_HOME=/opt/models/hf DOCLING_ARTIFACTS_PATH=/opt/models/docling
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --extra docling \
 && uv pip check --python /opt/venv/bin/python
# Bake the layout / table / OCR models into the image: a worker must not download models from the
# internet at request time (and must not need egress at all in production).
RUN docling-tools models download -o /opt/models/docling layout tableformer easyocr

FROM ${WOLFI_BASE}
# python-3.12 at the same path the venv was built against (/usr/bin/python3.12); tesseract + English and OSD data for
# TesseractCliOcrOptions. No libGL/glib: the lock carries opencv-python-headless only.
RUN apk add --no-cache python-3.12 tesseract tesseract-eng tesseract-osd \
 && adduser -D -u 10001 docling
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH \
    HF_HOME=/opt/models/hf DOCLING_ARTIFACTS_PATH=/opt/models/docling \
    EASYOCR_MODULE_PATH=/opt/models/easyocr
WORKDIR /srv
COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=docling /opt/models /opt/models
COPY --chown=docling app ./app
# EasyOCR writes a per-user network dir under its module path at reader start-up; give it one.
RUN mkdir -p /opt/models/easyocr && chown docling /opt/models/easyocr /srv
USER docling

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
