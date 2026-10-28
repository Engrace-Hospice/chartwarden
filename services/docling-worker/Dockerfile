# ChartWarden docling-worker — DocLens stage 2 (parse). CPU-only.
FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/models/hf DOCLING_ARTIFACTS_PATH=/opt/models/docling

# libcurl4t64 is named so the layer is rebuilt against the current security repo: tesseract pulls it in, and a
# cached older layer kept the vulnerable 8.14.1-2+deb13u5 (CVE-2026-8286, CVE-2026-8927; fixed in deb13u7).
# libexpat1 is named for the same reason: the base image ships 2.8.3-1~deb13u1 (CVE-2026-66046, -76956, -76957,
# -77214, -93990; fixed in 2.9.0-1~deb13u1), and naming it makes apt upgrade it in place.
# libbrotli1 is named for the same reason: the base image ships 1.1.0-2+b7 (CVE-2026-111497; fixed in 1.1.0-2+deb13u1).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libbrotli1 libcurl4t64 libexpat1 libgl1 libglib2.0-0 tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
# #853 — the Python graph is exactly uv.lock (hashes verified by uv), installed with `--frozen` so a stale lock
# fails the build instead of silently re-resolving. The lock is CPU-only (torch/torchvision come from the PyTorch
# CPU index, see [tool.uv.sources]) and floors pillow at 13 (see pyproject.toml), so there is no
# `--no-deps` step. Update procedure and cadence: README.md.
COPY --from=ghcr.io/astral-sh/uv@sha256:29bd45092ea8902c0bbb7f0a338f0494a382b1f4b18355df5be270ade679ff1d /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy UV_COMPILE_BYTECODE=0 PATH=/opt/venv/bin:$PATH
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --extra docling \
 && uv pip check --python /opt/venv/bin/python

# Bake the layout / table / OCR models into the image: a worker must not download models from the
# internet at request time (and must not need egress at all in production).
RUN docling-tools models download -o /opt/models/docling layout tableformer easyocr

COPY app ./app
# EasyOCR writes a per-user network dir under its module path at reader start-up; give it one.
ENV EASYOCR_MODULE_PATH=/opt/models/easyocr
RUN useradd --system --create-home --uid 10001 docling \
 && mkdir -p /opt/models/easyocr && chown -R docling /srv /opt/models
USER docling

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
